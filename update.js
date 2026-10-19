#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

if (typeof fetch !== 'function') { console.error('❌ 需要 Node 18+'); process.exit(1); }

const IS_CI = !!process.env.CI;
const SHOULD_PUSH = IS_CI || process.argv.includes('--push');

(function loadEnv(){
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return;
        const i = t.indexOf('=');
        if (i < 0) return;
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
    });
})();

const DATA_FILE = path.join(__dirname, 'data.json');
const FPL_FILE  = path.join(__dirname, 'fpl.json');

const FPL_BOOT     = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FPL_FIXTURES = 'https://fantasy.premierleague.com/api/fixtures/';
const BADGE = id => `https://resources.premierleague.com/premierleague/badges/70/t${id}.png`;
const UA = { 'User-Agent': 'PL-Prediction-Engine/1.0' };

const CLUBELO_MAP = {
    'Arsenal': 'Arsenal', 'Aston Villa': 'AstonVilla', 'Bournemouth': 'Bournemouth',
    'Brentford': 'Brentford', 'Brighton': 'Brighton', 'Chelsea': 'Chelsea',
    'Crystal Palace': 'CrystalPalace', 'Everton': 'Everton', 'Fulham': 'Fulham',
    'Leeds': 'Leeds', 'Liverpool': 'Liverpool', 'Man City': 'ManCity',
    'Man Utd': 'ManUnited', 'Newcastle': 'Newcastle', 'Nott\'m Forest': 'Forest',
    'Sunderland': 'Sunderland', 'Spurs': 'Tottenham', 'West Ham': 'WestHam',
    'Wolves': 'Wolves', 'Burnley': 'Burnley'
};

async function fetchJSON(url, timeout = 20000, extraHeaders = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { ...UA, ...extraHeaders } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally { clearTimeout(timer); }
}

function readIfExists(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function avg(a, b) { const v = [a, b].filter(x => typeof x === 'number'); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 3; }
function seasonFromEvents(events) {
    let first = null;
    if (Array.isArray(events) && events.length && events[0].deadline_time) {
        const d = new Date(events[0].deadline_time);
        if (!isNaN(d)) first = d;
    }
    const base = first || new Date();
    const y = base.getMonth() >= 7 ? base.getFullYear() : base.getFullYear() - 1;
    return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

async function fetchUnderstatXG(seasonYear) {
    const url = `https://understat.com/getLeagueData/EPL/${seasonYear}`;
    const headers = { 'X-Requested-With': 'XMLHttpRequest', 'Referer': `https://understat.com/league/EPL/${seasonYear}` };
    try {
        await fetch(`https://understat.com/league/EPL/${seasonYear}`, { headers: UA });
        const data = await fetchJSON(url, 25000, headers);
        const teamsRaw = data.teams || {};
        const out = {};
        for (const [teamKey, info] of Object.entries(teamsRaw)) {
            const matches = Object.values(info.history || {});
            if (matches.length < 3) continue;
            const lastN = matches.slice(-5);
            const avgXG = lastN.reduce((s, m) => s + parseFloat(m.xG || 0), 0) / lastN.length;
            const avgXGA = lastN.reduce((s, m) => s + parseFloat(m.xGA || 0), 0) / lastN.length;
            out[teamKey.replace(/_/g, ' ').toLowerCase()] = { xG: +avgXG.toFixed(3), xGA: +avgXGA.toFixed(3), xGMatches: lastN.length };
        }
        return out;
    } catch (e) { return null; }
}

async function fetchClubElo(teams) {
    const out = {};
    for (const t of teams) {
        const eloName = CLUBELO_MAP[t.name];
        if (!eloName) { out[t.id] = null; continue; }
        try {
            const res = await fetch(`http://api.clubelo.com/${encodeURIComponent(eloName)}`, { headers: UA });
            if (!res.ok) { out[t.id] = null; continue; }
            const lines = (await res.text()).trim().split('\n');
            if (lines.length < 2) { out[t.id] = null; continue; }
            const elo = parseFloat(lines[lines.length - 1].split(',')[4]);
            out[t.id] = isNaN(elo) ? null : elo;
        } catch { out[t.id] = null; }
        await new Promise(r => setTimeout(r, 200));
    }
    return out;
}

function matchUnderstatToTeam(teamName, understatMap) {
    const norm = s => s.toLowerCase().replace(/[^a-z]/g, '');
    const target = norm(teamName);
    for (const [usKey, val] of Object.entries(understatMap)) {
        if (norm(usKey) === target || norm(usKey).includes(target) || target.includes(norm(usKey))) return val;
    }
    return null;
}

function buildTeams(boot, understatXG, clubElo) {
    return boot.teams.map(t => {
        const xg = understatXG ? matchUnderstatToTeam(t.name, understatXG) : null;
        return {
            id: t.id, name: t.name, short: t.short_name, fplId: t.id, badge: BADGE(t.id),
            strAtt: avg(t.strength_attack_home, t.strength_attack_away),
            strDef: avg(t.strength_defence_home, t.strength_defence_away),
            xG: xg ? xg.xG : null, xGA: xg ? xg.xGA : null, xGMatches: xg ? xg.xGMatches : 0,
            elo: clubElo ? clubElo[t.id] : null
        };
    });
}

function buildFixtures(rawFixtures) {
    return rawFixtures
        .filter(f => f.event >= 1 && f.event <= 38)
        .map(f => ({
            round: f.event, home: f.team_h, away: f.team_a,
            homeGoals: f.finished ? f.team_h_score : null, awayGoals: f.finished ? f.team_a_score : null,
            finished: !!f.finished, kickoff: f.kickoff_time || null
        }))
        .sort((a, b) => a.round - b.round || new Date(a.kickoff || 0) - new Date(b.kickoff || 0));
}

function computeCurrentRound(boot, fixtures) {
    const cur  = boot.events.find(e => e.is_current);
    const next = boot.events.find(e => e.is_next);
    if (cur && !cur.finished) return cur.id;
    if (next) return next.id;
    const done = fixtures.filter(f => f.finished).map(f => f.round);
    return done.length ? Math.max(...done) + 1 : 1;
}

function pushDataFiles() {
    try {
        execSync('git add data.json fpl.json', { stdio: 'inherit' });
        if (!execSync('git status --short data.json fpl.json').toString().trim()) return;
        execSync('git commit -m "auto: update data & fpl (xG/Elo)"', { stdio: 'inherit' });
        execSync('git pull --rebase origin main', { stdio: 'inherit' });
        execSync('git push origin main', { stdio: 'inherit' });
    } catch (e) {
        try { execSync('git rebase --abort', { stdio: 'ignore' }); } catch {}
        try { execSync('git pull --rebase origin main', { stdio: 'inherit' }); execSync('git push origin main', { stdio: 'inherit' }); } catch {}
    }
}

async function main() {
    console.log('📡 拉取 FPL 数据…');
    const boot = await fetchJSON(FPL_BOOT, 25000);
    const rawFixtures = await fetchJSON(FPL_FIXTURES, 25000);
    const season = seasonFromEvents(boot.events);
    const seasonStartYear = parseInt(season.split('/')[0], 10);

    console.log('🎯 拉取 xG 数据…');
    const understatXG = await fetchUnderstatXG(seasonStartYear);
    if (understatXG) console.log(`✅ xG 覆盖：${Object.keys(understatXG).length} 队`);
    else console.warn('⚠️ xG 抓取失败，前端将降级处理');

    const fplTeams = boot.teams.map(t => ({ id: t.id, name: t.name }));
    console.log('📈 拉取 Elo 评级…');
    const clubElo = await fetchClubElo(fplTeams);
    const eloCover = Object.values(clubElo).filter(v => v != null).length;
    if (eloCover) console.log(`✅ Elo 覆盖：${eloCover}/${fplTeams.length} 队`);
    else console.warn('⚠️ Elo 抓取失败，前端将降级处理');

    const teams = buildTeams(boot, understatXG, clubElo);
    const fixtures = buildFixtures(rawFixtures);
    const currentRound = computeCurrentRound(boot, fixtures);

    fs.writeFileSync(DATA_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        season, currentRound, teams, fixtures
    }, null, 2), 'utf8');
    console.log('💾 data.json 已写入');

    // fpl.json
    const teamMap = {};
    boot.teams.forEach(t => { teamMap[t.id] = t.short_name; });
    const nextEvent = boot.events.find(e => e.is_next) || boot.events[0];
    const players = boot.elements.map(p => ({
        id: p.id, code: p.code, name: p.web_name, fullName: `${p.first_name} ${p.second_name}`,
        team: teamMap[p.team], teamId: p.team, position: p.element_type, cost: p.now_cost / 10,
        form: parseFloat(p.form) || 0, totalPoints: p.total_points || 0, ppg: parseFloat(p.points_per_game) || 0,
        status: p.status, chanceNext: p.chance_of_playing_next_round, news: p.news || ''
    }));
    fs.writeFileSync(FPL_FILE, JSON.stringify({ nextEvent, teams: boot.teams, players }, null, 2), 'utf8');
    console.log('💾 fpl.json 已写入');

    if (SHOULD_PUSH) pushDataFiles();
}

main().catch(e => { console.error(e); process.exit(1); });