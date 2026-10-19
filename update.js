#!/usr/bin/env node
/**
 * update.js — v17
 *
 * v17 前端（index.html）的 loadData() 只消费 data.json 中的：
 *   { season, currentRound, teams[], fixtures[] }
 *
 * 其中：
 *   teams[]    = { id, name, short, fplId, badge, strAtt, strDef }
 *   fixtures[] = { round, home, away, homeGoals, awayGoals, finished, kickoff }
 *                home/away 必须是 teams[].id（数字），不是队名
 *
 * 数据源：FPL 官方 bootstrap-static + fixtures。无需任何 Token。
 * 可选输出：fpl.json（players + nextEvent + teams），供外部工具使用，前端不读。
 *
 * 用法：
 *   node update.js            本地模式：只写文件，不推送
 *   node update.js --push     写文件 + git push
 *   CI=1 node update.js       等同 --push
 */
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

async function fetchJSON(url, timeout = 20000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: UA });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally { clearTimeout(timer); }
}
function readIfExists(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function avg(a, b) {
    const v = [a, b].filter(x => typeof x === 'number');
    return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 3;
}

/* 从 FPL events 推断赛季标签，例如 2026/27 */
function seasonFromEvents(events) {
    const now = new Date();
    let first = null;
    if (Array.isArray(events) && events.length && events[0].deadline_time) {
        const d = new Date(events[0].deadline_time);
        if (!isNaN(d)) first = d;
    }
    const base = first || now;
    const y = base.getMonth() >= 7 ? base.getFullYear() : base.getFullYear() - 1;
    return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

/* teams[]：id 直接用 FPL team id（1..20），name 保持 FPL 原名
   这样 v17 前端 applyFPLToTeams() 里的 normalizeName 匹配天然成立 */
function buildTeams(boot) {
    return boot.teams.map(t => ({
        id: t.id,
        name: t.name,
        short: t.short_name,
        fplId: t.id,
        badge: BADGE(t.id),
        strAtt: avg(t.strength_attack_home, t.strength_attack_away),
        strDef: avg(t.strength_defence_home, t.strength_defence_away)
    }));
}

/* fixtures[]：扁平数组，home/away 用 FPL team id */
function buildFixtures(rawFixtures) {
    const out = [];
    for (const f of rawFixtures) {
        if (!f.event) continue;            // 未排期（event 为 null）
        if (f.event < 1 || f.event > 38) continue;
        const finished = !!f.finished;
        out.push({
            round: f.event,
            home: f.team_h,
            away: f.team_a,
            homeGoals: finished ? (f.team_h_score ?? null) : null,
            awayGoals: finished ? (f.team_a_score ?? null) : null,
            finished,
            kickoff: f.kickoff_time || null  // 未定时间时为 null，前端容忍
        });
    }
    out.sort((a, b) => a.round - b.round || (new Date(a.kickoff || 0) - new Date(b.kickoff || 0)));
    return out;
}

/* currentRound 语义与前端一致：优先「正在进行但未结束」的轮次 */
function computeCurrentRound(boot, fixtures) {
    const cur  = boot.events.find(e => e.is_current);
    const next = boot.events.find(e => e.is_next);
    if (cur && !cur.finished) return cur.id;
    if (next) return next.id;
    const done = fixtures.filter(f => f.finished).map(f => f.round);
    return done.length ? Math.max(...done) + 1 : 1;
}

/* 精简 fpl.json：仅保留 players + nextEvent + teams
   （v17 前端不读它；保留是为了外部工具 / 调试） */
function buildFplSnapshot(boot, rawFixtures) {
    const teamMap = {};
    boot.teams.forEach(t => { teamMap[t.id] = t.short_name; });

    const nextEvent = boot.events.find(e => e.is_next) || boot.events.find(e => e.is_current) || boot.events[0];
    const nextGWFixtures = {};
    rawFixtures.filter(f => f.event === nextEvent.id).forEach(f => {
        nextGWFixtures[f.team_h] = { opponent: teamMap[f.team_a], isHome: true,  difficulty: f.team_h_difficulty };
        nextGWFixtures[f.team_a] = { opponent: teamMap[f.team_h], isHome: false, difficulty: f.team_a_difficulty };
    });

    const players = boot.elements.map(p => ({
        id: p.id,
        code: p.code,
        name: p.web_name,
        fullName: `${p.first_name} ${p.second_name}`,
        team: teamMap[p.team],
        teamId: p.team,
        position: p.element_type,
        cost: p.now_cost / 10,
        form: parseFloat(p.form) || 0,
        totalPoints: p.total_points || 0,
        ppg: parseFloat(p.points_per_game) || 0,
        ict: parseFloat(p.ict_index) || 0,
        xG: parseFloat(p.expected_goals) || 0,
        xA: parseFloat(p.expected_assists) || 0,
        xGI: parseFloat(p.expected_goal_involvements) || 0,
        minutes: p.minutes || 0,
        status: p.status,
        chanceNext: p.chance_of_playing_next_round,
        news: p.news || '',
        nextFixture: nextGWFixtures[p.team] || null
    }));

    return {
        nextEvent: { id: nextEvent.id, name: nextEvent.name, deadline: nextEvent.deadline_time },
        teams: boot.teams.map(t => ({ id: t.id, name: t.name, short: t.short_name })),
        players
    };
}

function pushDataFiles() {
    try {
        execSync('git add data.json fpl.json', { stdio: 'inherit' });
        const status = execSync('git status --short data.json fpl.json').toString().trim();
        if (!status) { console.log('无变化，跳过推送'); return; }
        execSync('git commit -m "auto: update data & fpl"', { stdio: 'inherit' });
        execSync('git pull --rebase origin main', { stdio: 'inherit' });
        execSync('git push origin main', { stdio: 'inherit' });
    } catch (e) {
        try { execSync('git rebase --abort', { stdio: 'ignore' }); } catch {}
        try { execSync('git pull --rebase origin main', { stdio: 'inherit' }); execSync('git push origin main', { stdio: 'inherit' }); } catch (e2) {}
    }
}

async function main() {
    const oldData = readIfExists(DATA_FILE);
    const health = {};

    console.log('📡 拉取 FPL bootstrap-static…');
    let boot = null;
    try { boot = await fetchJSON(FPL_BOOT, 25000); health.fpl_boot = 'ok'; }
    catch (e) { health.fpl_boot = 'fail'; console.error('  ✗', e.message); }

    console.log('📅 拉取 FPL fixtures…');
    let rawFixtures = null;
    try { rawFixtures = await fetchJSON(FPL_FIXTURES, 25000); health.fpl_fixtures = 'ok'; }
    catch (e) { health.fpl_fixtures = 'fail'; console.error('  ✗', e.message); }

    if (!boot || !Array.isArray(boot.teams) || !boot.teams.length || !Array.isArray(rawFixtures) || !rawFixtures.length) {
        console.error('❌ FPL 数据不完整，保留旧 data.json 不覆盖');
        if (!oldData) { console.error('   且旧 data.json 不存在，无法降级'); process.exit(1); }
        process.exit(0);
    }

    const teams      = buildTeams(boot);
    const fixtures   = buildFixtures(rawFixtures);
    const currentRnd = computeCurrentRound(boot, fixtures);
    const season     = seasonFromEvents(boot.events);

    if (fixtures.length < 100) {
        console.warn(`⚠️ fixtures 只有 ${fixtures.length} 场，疑似 FPL 数据异常`);
    }
    const finishedCount = fixtures.filter(f => f.finished).length;
    console.log(`✅ teams ${teams.length} · fixtures ${fixtures.length}（完赛 ${finishedCount}）· 当前第 ${currentRnd} 轮 · ${season}`);

    const dataOut = {
        updatedAt: new Date().toISOString(),
        meta: {
            updatedAt: new Date().toISOString(),
            source: 'FPL',
            version: 'v17',
            health
        },
        season,
        currentRound: currentRnd,
        teams,
        fixtures
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataOut, null, 2), 'utf8');
    console.log('💾 已写入 data.json');

    if (Array.isArray(boot.elements) && boot.elements.length) {
        const fpl = buildFplSnapshot(boot, rawFixtures);
        fs.writeFileSync(FPL_FILE, JSON.stringify({
            updatedAt: new Date().toISOString(),
            meta: { updatedAt: new Date().toISOString(), health: { fpl: 'ok' }, note: 'v17 前端不读取此文件' },
            ...fpl
        }, null, 2), 'utf8');
        console.log('💾 已写入 fpl.json（可选附属文件）');
    }

    if (!IS_CI && process.platform === 'win32') {
        try { exec(`explorer /select,"${path.resolve(DATA_FILE).replace(/\//g, '\\')}"`); } catch (e) {}
    }
    if (SHOULD_PUSH) pushDataFiles();
    else console.log('本地模式：已写入文件，未推送');
}

main().catch(e => { console.error(e); process.exit(1); });