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
const FPL_FILE = path.join(__dirname, 'fpl.json');
const SPORTSDB_KEY = '3';

const TEAM_MAP = { 'Arsenal':'阿森纳','Manchester City':'曼城','Liverpool':'利物浦','Chelsea':'切尔西','Tottenham Hotspur':'热刺','Aston Villa':'阿斯顿维拉','Newcastle United':'纽卡斯尔联','Manchester United':'曼联','Brighton':'布莱顿','Crystal Palace':'水晶宫','Everton':'埃弗顿','Fulham':'富勒姆','Brentford':'布伦特福德','Nottingham Forest':'诺丁汉森林','Bournemouth':'伯恩茅斯','Leeds United':'利兹联','Sunderland':'桑德兰','Coventry City':'考文垂城','Hull City':'赫尔城','Ipswich Town':'伊普斯维奇镇' };

const PLAYER_NAME_MAP = { '萨卡': 'Bukayo Saka', '厄德高': 'Martin Odegaard', '热苏斯': 'Gabriel Jesus', '哈兰德': 'Erling Haaland', '谢尔基': 'Rayan Cherki', '罗德里': 'Rodri', '萨拉赫': 'Mohamed Salah', '伊萨克': 'Alexander Isak', '加克波': 'Cody Gakpo', '若昂·佩德罗': 'João Pedro', '摩根·罗杰斯': 'Morgan Rogers', '帕尔默': 'Cole Palmer', '麦迪逊': 'James Maddison', 'B费': 'Bruno Fernandes', '拉什福德': 'Marcus Rashford', '吉马良斯': 'Bruno Guimaraes', '沃特金斯': 'Ollie Watkins', '麦金': 'John McGinn', '三笘薰': 'Kaoru Mitoma', '维尔贝克': 'Danny Welbeck', '卡尔弗特-勒温': 'Dominic Calvert-Lewin', '蒂耶尔诺·巴里': 'Thierno Barry', '塔科夫斯基': 'James Tarkowski', '皮克福德': 'Jordan Pickford', '希门尼斯': 'Raul Jimenez', '埃泽': 'Eberechi Eze', '马特塔': 'Jean-Philippe Mateta', '姆贝乌莫': 'Bryan Mbeumo', '维萨': 'Yoane Wissa', '索兰克': 'Dominic Solanke', '塞梅尼奥': 'Antoine Semenyo', '伍德': 'Chris Wood', '吉布斯-怀特': 'Morgan Gibbs-White', '皮罗': 'Joel Piroe', '尼奥托': 'Wilfried Gnonto', '布罗比': 'Brian Brobbey', '伊西多': 'Wilson Isidor', '哈吉·赖特': 'Haji Wright', '杰克·鲁多尼': 'Jack Rudoni', '贝卢米': 'Mohamed Belloumi', 'Tzolakis': 'Konstantinos Tzolakis', '杰克·克拉克': 'Jack Clarke' };

async function fetchJSON(url, opts = {}, timeout = 12000) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeout);
    try { const res = await fetch(url, { ...opts, signal: ctrl.signal }); if (!res.ok) throw new Error('HTTP ' + res.status); return await res.json(); } finally { clearTimeout(timer); }
}
function readIfExists(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function toChinese(name) { if (!name) return null; if (TEAM_MAP[name]) return TEAM_MAP[name]; for (const [en, zh] of Object.entries(TEAM_MAP)) { if (name.toLowerCase().includes(en.toLowerCase())) return zh; } return null; }
function normalizeName(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function fetchFromApi(token) {
    const headers = { 'X-Auth-Token': token }; const base = 'https://api.football-data.org/v4/competitions/PL';
    const sData = await fetchJSON(base + '/standings', { headers }, 15000);
    const standings = sData.standings[0].table.map(row => { const zh = toChinese(row.team.name); return zh ? { rank: row.position, team: zh, played: row.playedGames, won: row.won, drawn: row.draw, lost: row.lost, gf: row.goalsFor, ga: row.goalsAgainst, gd: row.goalDifference, points: row.points } : null; }).filter(Boolean);
    const mData = await fetchJSON(base + '/matches', { headers }, 15000);
    const fixtures = Array(38).fill(0).map(() => []); const results = {};
    mData.matches.forEach(m => {
        const h = toChinese(m.homeTeam.name), a = toChinese(m.awayTeam.name); if (!h || !a) return;
        if (m.matchday >= 1 && m.matchday <= 38) fixtures[m.matchday - 1].push({ home: h, away: a, kickoff: m.utcDate || null, status: m.status || 'SCHEDULED' });
        if (m.status === 'FINISHED' && m.score?.fullTime) { if (!results[m.matchday]) results[m.matchday] = {}; results[m.matchday][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away]; }
    });
    return { standings, results, fixtures };
}

async function fetchFPLData() {
    console.log('📸 从 FPL 拉取数据…');
    const UA = { 'User-Agent': 'PL-Prediction-Engine/1.0' };
    const boot = await fetchJSON('https://fantasy.premierleague.com/api/bootstrap-static/', { headers: UA }, 25000);
    let fixtures = [];
    try { fixtures = await fetchJSON('https://fantasy.premierleague.com/api/fixtures/', { headers: UA }, 20000); } catch(e) {}
    const currentEvent = boot.events.find(e => e.is_current) || boot.events.find(e => e.is_next) || boot.events[0];
    const nextEvent = boot.events.find(e => e.is_next) || currentEvent;
    const teamMap = {}; boot.teams.forEach(t => { teamMap[t.id] = t.short_name; });
    const nextGWFixtures = {};
    fixtures.filter(f => f.event === nextEvent.id).forEach(f => {
        nextGWFixtures[f.team_h] = { opponent: teamMap[f.team_a], isHome: true, difficulty: f.team_h_difficulty };
        nextGWFixtures[f.team_a] = { opponent: teamMap[f.team_h], isHome: false, difficulty: f.team_a_difficulty };
    });
    const players = boot.elements.map(p => ({
        id: p.id, code: p.code, name: p.web_name, fullName: `${p.first_name} ${p.second_name}`,
        photo: p.photo ? `https://resources.premierleague.com/premierleague/photos/players/110x140/${p.photo}` : null,
        team: teamMap[p.team], teamId: p.team, position: p.element_type, cost: p.now_cost / 10,
        form: parseFloat(p.form) || 0, totalPoints: p.total_points || 0, ppg: parseFloat(p.points_per_game) || 0,
        ict: parseFloat(p.ict_index) || 0, xG: parseFloat(p.expected_goals) || 0, xA: parseFloat(p.expected_assists) || 0,
        xGI: parseFloat(p.expected_goal_involvements) || 0, minutes: p.minutes || 0, selectedBy: parseFloat(p.selected_by_percent) || 0,
        status: p.status, chanceNext: p.chance_of_playing_next_round, news: p.news || '', nextFixture: nextGWFixtures[p.team] || null
    }));
    players.forEach(p => { p.xPts = computeXPts(p); });
    return { players, nextEvent: { id: nextEvent.id, name: nextEvent.name, deadline: nextEvent.deadline_time }, teams: boot.teams.map(t => ({ id: t.id, name: t.name, short: t.short_name })) };
}

function computeXPts(p) {
    if (p.status !== 'a' && p.status !== 'd') return 0;
    let base = p.form * 0.40 + p.ppg * 0.30 + (p.xGI * 2) * 0.20 + (p.ict / 20) * 0.10;
    const minutesFactor = Math.min(1, p.minutes / 900); let fixtureFactor = 1;
    if (p.nextFixture) { const d = p.nextFixture.difficulty; fixtureFactor = d === 1 ? 1.30 : d === 2 ? 1.15 : d === 3 ? 1.00 : d === 4 ? 0.85 : 0.70; if (p.nextFixture.isHome) fixtureFactor += 0.10; }
    const mult = p.status === 'd' ? (p.chanceNext ?? 50) / 100 : 1;
    return base * minutesFactor * fixtureFactor * mult;
}

function optimizeSquad(players, budget = 100) {
    const pools = { 1: players.filter(p => p.position === 1 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts), 2: players.filter(p => p.position === 2 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts), 3: players.filter(p => p.position === 3 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts), 4: players.filter(p => p.position === 4 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts) };
    const quotas = { 1: 2, 2: 5, 3: 5, 4: 3 };
    let squad = [], teamCount = {}, spent = 0;
    for (const pos of [1, 2, 3, 4]) { let added = 0; for (const p of pools[pos]) { if (added >= quotas[pos] || spent + p.cost > budget || (teamCount[p.teamId] || 0) >= 3) continue; squad.push(p); spent += p.cost; teamCount[p.teamId] = (teamCount[p.teamId] || 0) + 1; added++; } }
    let improved = true, iter = 0;
    while (improved && iter < 200) {
        improved = false; iter++;
        for (let i = 0; i < squad.length; i++) {
            const cur = squad[i];
            for (const alt of pools[cur.position]) {
                if (squad.some(s => s.id === alt.id) || spent - cur.cost + alt.cost > budget || (teamCount[alt.teamId] || 0) + (alt.teamId === cur.teamId ? 0 : 1) > 3) continue;
                if (alt.xPts > cur.xPts + 0.01) { spent = spent - cur.cost + alt.cost; teamCount[cur.teamId]--; teamCount[alt.teamId] = (teamCount[alt.teamId] || 0) + 1; squad[i] = alt; improved = true; break; }
            }
            if (improved) break;
        }
    }
    const byPos = { 1: [], 2: [], 3: [], 4: [] }; squad.forEach(p => byPos[p.position].push(p)); Object.keys(byPos).forEach(k => byPos[k].sort((a,b) => b.xPts - a.xPts));
    const formations = [ { 1: 1, 2: 3, 3: 4, 4: 3 }, { 1: 1, 2: 3, 3: 5, 4: 2 }, { 1: 1, 2: 4, 3: 3, 4: 3 }, { 1: 1, 2: 4, 3: 4, 4: 2 }, { 1: 1, 2: 4, 3: 5, 4: 1 }, { 1: 1, 2: 5, 3: 3, 4: 2 }, { 1: 1, 2: 5, 3: 4, 4: 1 } ];
    let bestF = null, bestScore = -1, bestStarters = null;
    for (const f of formations) { const starters = []; let ok = true; for (const pos of [1, 2, 3, 4]) { const avail = byPos[pos].slice(0, f[pos]); if (avail.length < f[pos]) { ok = false; break; } starters.push(...avail); } if (!ok) continue; const score = starters.reduce((s, p) => s + p.xPts, 0); if (score > bestScore) { bestScore = score; bestF = f; bestStarters = starters; } }
    const starterIds = new Set(bestStarters.map(p => p.id)); const bench = squad.filter(p => !starterIds.has(p.id)).sort((a,b) => a.position - b.position || b.xPts - a.xPts);
    const sorted = [...bestStarters].sort((a,b) => b.xPts - a.xPts);
    return { starters: bestStarters, bench, captain: sorted[0], vice: sorted.find(p => p.id !== sorted[0].id), formation: bestF, totalCost: parseFloat(squad.reduce((s, p) => s + p.cost, 0).toFixed(1)), totalXPts: parseFloat(bestScore.toFixed(1)) };
}

async function fetchBzzoiroPhotos(apiKey) {
    const photos = {}; const headers = { 'Authorization': `Token ${apiKey}` }; let leagueId = null;
    try { const lRes = await fetch('https://sports.bzzoiro.com/api/v2/leagues/?country=England', { headers }); if (lRes.ok) { const lData = await lRes.json(); const pl = (lData.results || []).find(l => l.name === 'Premier League'); if (pl) leagueId = pl.id; } } catch(e) {}
    if (!leagueId) return photos;
    const teamIds = [];
    try { const tRes = await fetch(`https://sports.bzzoiro.com/api/v2/teams/?league_id=${leagueId}`, { headers }); if (tRes.ok) { const tData = await tRes.json(); (tData.results || []).forEach(t => { if (t.id) teamIds.push({ id: t.id, name: t.name }); }); } } catch(e) {}
    for (const team of teamIds) {
        try { const pRes = await fetch(`https://sports.bzzoiro.com/api/v2/players/?team_id=${team.id}`, { headers }); if (!pRes.ok) continue; const pData = await pRes.json(); (pData.results || []).forEach(p => { if (!p.name || !p.id) return; let zhName = null; for (const [zh, en] of Object.entries(PLAYER_NAME_MAP)) { if (normalizeName(en) === normalizeName(p.name)) { zhName = zh; break; } } if (zhName) photos[zhName] = `https://sports.bzzoiro.com/img/player/${p.id}/?sor=true&bg=transparent`; }); } catch(e) {}
        await new Promise(r => setTimeout(r, 500));
    }
    return photos;
}

async function fetchTheSportsDBPhotos(existingPhotos) {
    const photos = { ...existingPhotos }; const missing = Object.entries(PLAYER_NAME_MAP).filter(([zh]) => !photos[zh]); if (!missing.length) return photos;
    for (const [zhName, enName] of missing) {
        const candidates = [enName, enName.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), enName.replace(/-/g, ' ')]; let found = false;
        for (const cand of [...new Set(candidates)]) { if (found) break; for (let attempt = 1; attempt <= 3; attempt++) { try { const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchplayers.php?p=${encodeURIComponent(cand)}`, { headers: { 'User-Agent': 'PL-Prediction-Engine/1.0' } }); if (res.status === 429) { await new Promise(r => setTimeout(r, 30000)); continue; } if (!res.ok) { found = true; break; } const data = await res.json(); const list = data.player || []; const want = normalizeName(cand); let best = list.find(p => normalizeName(p.strPlayer) === want) || list.find(p => normalizeName(p.strPlayer).startsWith(want)); if (best) { const url = best.strCutout || best.strRender || best.strThumb; if (url) photos[zhName] = url; } found = true; break; } catch(e) { await new Promise(r => setTimeout(r, 5000)); } } }
        await new Promise(r => setTimeout(r, 2000));
    }
    return photos;
}

async function fetchHistoricalSeasons(token) {
    const out = {}; const headers = { 'X-Auth-Token': token };
    try {
        const seasonsRes = await fetchJSON('https://api.football-data.org/v4/competitions/PL/seasons', { headers }, 15000);
        const nowY = new Date().getFullYear();
        const pastSeasons = (seasonsRes.seasons || []).map(s => s.startDate.slice(0, 4)).filter(y => +y >= nowY - 3 && +y < nowY).slice(-2);
        for (const y of pastSeasons) {
            try {
                const mRes = await fetchJSON(`https://api.football-data.org/v4/competitions/PL/matches?season=${y}`, { headers }, 20000);
                const bucket = {};
                (mRes.matches || []).forEach(m => {
                    if (m.status !== 'FINISHED' || !m.score?.fullTime) return;
                    const h = toChinese(m.homeTeam.name), a = toChinese(m.awayTeam.name);
                    if (!h || !a) return;
                    bucket[`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
                });
                if (Object.keys(bucket).length) out[y] = bucket;
            } catch (e) {}
        }
    } catch (e) {}
    return out;
}

function pushDataFiles() {
    try {
        execSync('git add data.json fpl.json', { stdio: 'inherit' });
        const status = execSync('git status --short data.json fpl.json').toString().trim();
        if (!status) return;
        execSync(`git commit -m "auto: update data"`, { stdio: 'inherit' });
        execSync('git pull --rebase origin main', { stdio: 'inherit' });
        execSync('git push origin main', { stdio: 'inherit' });
    } catch (e) {
        try { execSync('git rebase --abort', { stdio: 'ignore' }); } catch {}
        try { execSync('git pull --rebase origin main', { stdio: 'inherit' }); execSync('git push origin main', { stdio: 'inherit' }); } catch(e2) {}
    }
}

async function main() {
    const fdToken = process.env.FD_TOKEN; const bzKey = process.env.BZZOIRO_KEY;
    if (!fdToken) {
        console.error('❌ 缺少 FD_TOKEN 环境变量，请在 .env 或 GitHub Secrets 中配置');
        process.exit(1);
    }
    const oldData = readIfExists(DATA_FILE) || {}; const oldFpl = readIfExists(FPL_FILE); const health = {};
    let apiData;
    try { apiData = await fetchFromApi(fdToken); health.pl = 'ok'; } catch (e) { health.pl = 'fail'; apiData = { standings: oldData.standings || [], results: oldData.results || {}, fixtures: oldData.fixtures || [] }; }
    let historicalResults = oldData.historicalResults || {};
    try { const fresh = await fetchHistoricalSeasons(fdToken); if (Object.keys(fresh).length) historicalResults = fresh; } catch(e) {}
    let playerPhotos = oldData.playerPhotos || {};
    if (bzKey) {
        try { const photos = await fetchBzzoiroPhotos(bzKey); if (Object.keys(photos).length) playerPhotos = photos; } catch(e) {}
        try { playerPhotos = await fetchTheSportsDBPhotos(playerPhotos); } catch(e) {}
    }
    let fplData = null;
    try { fplData = await fetchFPLData(); health.fpl = 'ok'; } catch (e) { health.fpl = 'fail'; }
    fs.writeFileSync(DATA_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), meta: { updatedAt: new Date().toISOString(), health }, fixtures: apiData.fixtures, results: apiData.results, standings: apiData.standings, playerPhotos, historicalResults }, null, 2), 'utf8');
    if (fplData && fplData.players.length) {
        const squad = optimizeSquad(fplData.players);
        if (squad) fs.writeFileSync(FPL_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), meta: { updatedAt: new Date().toISOString(), health: { fpl: 'ok' } }, nextEvent: fplData.nextEvent, teams: fplData.teams, recommendedSquad: squad, allPlayers: fplData.players }, null, 2), 'utf8');
    } else if (oldFpl) { console.log('保留旧 fpl.json'); }
    if (!IS_CI && process.platform === 'win32') { try { exec(`explorer /select,"${path.resolve(FPL_FILE).replace(/\//g, '\\')}"`); } catch(e) {} }
    if (SHOULD_PUSH) pushDataFiles();
    else console.log('本地模式：已写入文件，未推送');
}
main().catch(e => process.exit(1));