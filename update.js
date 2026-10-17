#!/usr/bin/env node
/**
 * 英超预测引擎 - 数据自动更新
 * v15.1：
 *   ★ 新增 FPL 官方高清球员半身像字段 (photo)
 *   ★ 本地只写不推，CI 才推（根治 Git 冲突）
 *   ★ 所有请求带超时
 *   ★ 数据源失败自动沿用旧文件
 *   ★ 写入 meta.health 健康状态
 *   ★ 推送健壮化（pull --rebase + 失败回滚）
 *   ★ CI 环境不执行 explorer
 */

const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

// 检查 Node 版本（需要 18+ 才有全局 fetch）
if (typeof fetch !== 'function') {
    console.error('❌ 当前 Node 版本过低，请升级到 Node 18 或以上');
    process.exit(1);
}

// 环境判断：CI=true 或显式 --push 才推送
const IS_CI = !!process.env.CI;
const SHOULD_PUSH = IS_CI || process.argv.includes('--push');

// 从同目录 .env 读取 token
(function loadEnv(){
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i < 0) continue;
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
    }
})();

const DATA_FILE = path.join(__dirname, 'data.json');
const FPL_FILE = path.join(__dirname, 'fpl.json');
const SPORTSDB_KEY = '3';

const TEAM_MAP = {
    'Arsenal':'阿森纳','Manchester City':'曼城','Liverpool':'利物浦','Chelsea':'切尔西',
    'Tottenham Hotspur':'热刺','Aston Villa':'阿斯顿维拉','Newcastle United':'纽卡斯尔联',
    'Manchester United':'曼联','Brighton':'布莱顿','Crystal Palace':'水晶宫',
    'Everton':'埃弗顿','Fulham':'富勒姆','Brentford':'布伦特福德',
    'Nottingham Forest':'诺丁汉森林','Bournemouth':'伯恩茅斯',
    'Leeds United':'利兹联','Sunderland':'桑德兰',
    'Coventry City':'考文垂城','Hull City':'赫尔城','Ipswich Town':'伊普斯维奇镇'
};

const PLAYER_NAME_MAP = {
    '萨卡': 'Bukayo Saka', '厄德高': 'Martin Odegaard', '热苏斯': 'Gabriel Jesus',
    '哈兰德': 'Erling Haaland', '谢尔基': 'Rayan Cherki', '罗德里': 'Rodri',
    '萨拉赫': 'Mohamed Salah', '伊萨克': 'Alexander Isak', '加克波': 'Cody Gakpo',
    '若昂·佩德罗': 'João Pedro', '摩根·罗杰斯': 'Morgan Rogers', '帕尔默': 'Cole Palmer',
    '麦迪逊': 'James Maddison', 'B费': 'Bruno Fernandes', '拉什福德': 'Marcus Rashford',
    '吉马良斯': 'Bruno Guimaraes', '沃特金斯': 'Ollie Watkins', '麦金': 'John McGinn',
    '三笘薰': 'Kaoru Mitoma', '维尔贝克': 'Danny Welbeck',
    '卡尔弗特-勒温': 'Dominic Calvert-Lewin', '蒂耶尔诺·巴里': 'Thierno Barry',
    '塔科夫斯基': 'James Tarkowski', '皮克福德': 'Jordan Pickford',
    '希门尼斯': 'Raul Jimenez', '埃泽': 'Eberechi Eze', '马特塔': 'Jean-Philippe Mateta',
    '姆贝乌莫': 'Bryan Mbeumo', '维萨': 'Yoane Wissa',
    '索兰克': 'Dominic Solanke', '塞梅尼奥': 'Antoine Semenyo',
    '伍德': 'Chris Wood', '吉布斯-怀特': 'Morgan Gibbs-White',
    '皮罗': 'Joel Piroe', '尼奥托': 'Wilfried Gnonto',
    '布罗比': 'Brian Brobbey', '伊西多': 'Wilson Isidor',
    '哈吉·赖特': 'Haji Wright', '杰克·鲁多尼': 'Jack Rudoni',
    '贝卢米': 'Mohamed Belloumi', 'Tzolakis': 'Konstantinos Tzolakis',
    '杰克·克拉克': 'Jack Clarke'
};

// ================= 通用工具函数 =================

// 带超时的 JSON 请求
async function fetchJSON(url, opts = {}, timeout = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        if (!res.ok) {
            const err = new Error('HTTP ' + res.status);
            err.status = res.status;
            throw err;
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// 读取旧文件（不存在或损坏返回 null）
function readIfExists(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

// 给任意 Promise 加超时
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error((label || '任务') + ' 超时')), ms))
    ]);
}

// ================= 通用工具结束 =================

function toChinese(name){
    if (!name) return null;
    if (TEAM_MAP[name]) return TEAM_MAP[name];
    for (const [en, zh] of Object.entries(TEAM_MAP)) {
        if (name.toLowerCase().includes(en.toLowerCase())) return zh;
    }
    return null;
}

function normalizeName(s){
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchFromApi(token){
    const headers = { 'X-Auth-Token': token };
    const base = 'https://api.football-data.org/v4/competitions/PL';
    const sData = await fetchJSON(base + '/standings', { headers }, 15000);
    if (!sData.standings || !sData.standings[0] || !Array.isArray(sData.standings[0].table)) throw new Error('Standings 返回格式异常');
    const standings = sData.standings[0].table.map(row => {
        const zh = toChinese(row.team.name);
        if (!zh) { console.warn('⚠️ 未知球队：' + row.team.name); return null; }
        return { rank: row.position, team: zh, played: row.playedGames, won: row.won, drawn: row.draw, lost: row.lost, gf: row.goalsFor, ga: row.goalsAgainst, gd: row.goalDifference, points: row.points };
    }).filter(Boolean);

    const mData = await fetchJSON(base + '/matches', { headers }, 15000);
    if (!Array.isArray(mData.matches)) throw new Error('Matches 返回格式异常');
    const fixtures = [];
    for (let i = 0; i < 38; i++) fixtures.push([]);
    const results = {};
    mData.matches.forEach(m => {
        const h = toChinese(m.homeTeam.name);
        const a = toChinese(m.awayTeam.name);
        if (!h || !a) return;
        const md = m.matchday;
        if (md >= 1 && md <= 38) {
            fixtures[md - 1].push({ home: h, away: a, kickoff: m.utcDate || null, status: m.status || 'SCHEDULED' });
        }
        if (m.status === 'FINISHED' && m.score && m.score.fullTime) {
            if (!results[md]) results[md] = {};
            results[md][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
        }
    });
    return { standings, results, fixtures };
}

async function fetchHistoricalSeasons(token){
    console.log('📅 拉取历史赛季交锋数据…');
    const headers = { 'X-Auth-Token': token };
    const historicalResults = {};
    const now = new Date();
    const currentSeason = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const years = [currentSeason - 1, currentSeason - 2];
    for (const year of years) {
        try {
            const url = `https://api.football-data.org/v4/competitions/PL/matches?season=${year}`;
            const data = await fetchJSON(url, { headers }, 30000);
            if (!Array.isArray(data.matches)) continue;
            const seasonKey = String(year);
            historicalResults[seasonKey] = {};
            let count = 0;
            data.matches.forEach(m => {
                if (m.status !== 'FINISHED' || !m.score || !m.score.fullTime) return;
                const h = toChinese(m.homeTeam.name);
                const a = toChinese(m.awayTeam.name);
                if (!h || !a) return;
                historicalResults[seasonKey][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
                count++;
            });
            console.log(`  ✅ ${year}-${String(year+1).slice(2)} 赛季：${count} 场`);
        } catch(e) { console.warn(`  ⚠️ ${year} 赛季拉取失败：${e.message}`); }
        await new Promise(r => setTimeout(r, 1500));
    }
    return historicalResults;
}

async function fetchFPLData(){
    console.log('📸 从 FPL 官方 API 拉取球员数据…');
    const UA = { 'User-Agent': 'PL-Prediction-Engine/1.0' };
    const boot = await fetchJSON('https://fantasy.premierleague.com/api/bootstrap-static/', { headers: UA }, 25000);

    let fixtures = [];
    try { fixtures = await fetchJSON('https://fantasy.premierleague.com/api/fixtures/', { headers: UA }, 20000); }
    catch(e) { console.warn('  ⚠️ FPL fixtures 拉取失败，赛程难度因子失效：', e.message); }

    const currentEvent = boot.events.find(e => e.is_current) || boot.events.find(e => e.is_next) || boot.events[0];
    const nextEvent = boot.events.find(e => e.is_next) || currentEvent;
    const teamMap = {};
    boot.teams.forEach(t => { teamMap[t.id] = t.short_name; });

    const nextGWFixtures = {};
    fixtures.filter(f => f.event === nextEvent.id).forEach(f => {
        nextGWFixtures[f.team_h] = { opponent: teamMap[f.team_a], isHome: true, difficulty: f.team_h_difficulty };
        nextGWFixtures[f.team_a] = { opponent: teamMap[f.team_h], isHome: false, difficulty: f.team_a_difficulty };
    });

    const players = boot.elements.map(p => ({
        id: p.id,
        name: p.web_name,
        fullName: `${p.first_name} ${p.second_name}`,
        // ★★★ 新增：拼接 FPL 官方高清半身像 CDN 地址 ★★★
        photo: p.photo ? `https://resources.premierleague.com/premierleague/photos/players/250x250/${p.photo.replace('.jpg', '.png')}` : null,
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
        selectedBy: parseFloat(p.selected_by_percent) || 0,
        status: p.status,
        chanceNext: p.chance_of_playing_next_round,
        news: p.news || '',
        nextFixture: nextGWFixtures[p.team] || null
    }));
    players.forEach(p => { p.xPts = computeXPts(p); });
    console.log(`✅ FPL 球员：${players.length} 位 · 下一轮：GW${nextEvent.id} · 截止：${nextEvent.deadline_time}`);
    return {
        players,
        nextEvent: { id: nextEvent.id, name: nextEvent.name, deadline: nextEvent.deadline_time },
        teams: boot.teams.map(t => ({ id: t.id, name: t.name, short: t.short_name }))
    };
}

function computeXPts(p){
    if (p.status !== 'a' && p.status !== 'd') return 0;
    let base = 0;
    base += p.form * 0.40;
    base += p.ppg * 0.30;
    base += (p.xGI * 2) * 0.20;
    base += (p.ict / 20) * 0.10;
    const minutesFactor = Math.min(1, p.minutes / 900);
    let fixtureFactor = 1;
    if (p.nextFixture) {
        const d = p.nextFixture.difficulty;
        fixtureFactor = d === 1 ? 1.30 : d === 2 ? 1.15 : d === 3 ? 1.00 : d === 4 ? 0.85 : 0.70;
        if (p.nextFixture.isHome) fixtureFactor += 0.10;
    }
    let mult = 1;
    if (p.status === 'd') mult = (p.chanceNext ?? 50) / 100;
    return base * minutesFactor * fixtureFactor * mult;
}

function optimizeSquad(players, budget = 100){
    const pools = {
        1: players.filter(p => p.position === 1 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts),
        2: players.filter(p => p.position === 2 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts),
        3: players.filter(p => p.position === 3 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts),
        4: players.filter(p => p.position === 4 && p.xPts > 0).sort((a,b) => b.xPts - a.xPts)
    };
    const quotas = { 1: 2, 2: 5, 3: 5, 4: 3 };
    let squad = [], teamCount = {}, spent = 0;
    for (const pos of [1, 2, 3, 4]) {
        let added = 0;
        for (const p of pools[pos]) {
            if (added >= quotas[pos]) break;
            if (spent + p.cost > budget) continue;
            if ((teamCount[p.teamId] || 0) >= 3) continue;
            squad.push(p); spent += p.cost;
            teamCount[p.teamId] = (teamCount[p.teamId] || 0) + 1;
            added++;
        }
    }
    let improved = true, iter = 0;
    while (improved && iter < 200) {
        improved = false; iter++;
        for (let i = 0; i < squad.length; i++) {
            const cur = squad[i];
            for (const alt of pools[cur.position]) {
                if (squad.some(s => s.id === alt.id)) continue;
                if (spent - cur.cost + alt.cost > budget) continue;
                const newCount = (teamCount[alt.teamId] || 0) + (alt.teamId === cur.teamId ? 0 : 1);
                if (newCount > 3) continue;
                if (alt.xPts > cur.xPts + 0.01) {
                    spent = spent - cur.cost + alt.cost;
                    teamCount[cur.teamId]--;
                    teamCount[alt.teamId] = (teamCount[alt.teamId] || 0) + 1;
                    squad[i] = alt;
                    improved = true; break;
                }
            }
            if (improved) break;
        }
    }
    const byPos = { 1: [], 2: [], 3: [], 4: [] };
    squad.forEach(p => byPos[p.position].push(p));
    Object.keys(byPos).forEach(k => byPos[k].sort((a,b) => b.xPts - a.xPts));
    const formations = [
        { 1: 1, 2: 3, 3: 4, 4: 3 }, { 1: 1, 2: 3, 3: 5, 4: 2 },
        { 1: 1, 2: 4, 3: 3, 4: 3 }, { 1: 1, 2: 4, 3: 4, 4: 2 },
        { 1: 1, 2: 4, 3: 5, 4: 1 }, { 1: 1, 2: 5, 3: 3, 4: 2 },
        { 1: 1, 2: 5, 3: 4, 4: 1 }
    ];
    let bestF = null, bestScore = -1, bestStarters = null;
    for (const f of formations) {
        const starters = [];
        let ok = true;
        for (const pos of [1, 2, 3, 4]) {
            const avail = byPos[pos].slice(0, f[pos]);
            if (avail.length < f[pos]) { ok = false; break; }
            starters.push(...avail);
        }
        if (!ok) continue;
        const score = starters.reduce((s, p) => s + p.xPts, 0);
        if (score > bestScore) { bestScore = score; bestF = f; bestStarters = starters; }
    }
    if (!bestStarters) return null;
    const starterIds = new Set(bestStarters.map(p => p.id));
    const bench = squad.filter(p => !starterIds.has(p.id)).sort((a,b) => a.position - b.position || b.xPts - a.xPts);
    const sorted = [...bestStarters].sort((a,b) => b.xPts - a.xPts);
    const captain = sorted[0];
    const vice = sorted.find(p => p.id !== captain.id);
    return {
        starters: bestStarters,
        bench,
        captain,
        vice,
        formation: bestF,
        totalCost: parseFloat(squad.reduce((s, p) => s + p.cost, 0).toFixed(1)),
        totalXPts: parseFloat(bestScore.toFixed(1))
    };
}

async function fetchBzzoiroPhotos(apiKey){
    console.log('📸 从 Bzzoiro Sports Data 拉取球员照片…');
    const photos = {};
    const headers = { 'Authorization': `Token ${apiKey}` };
    let leagueId = null;
    try {
        const lRes = await fetch('https://sports.bzzoiro.com/api/v2/leagues/?country=England', { headers });
        if (lRes.ok) { const lData = await lRes.json(); const pl = (lData.results || []).find(l => l.name === 'Premier League'); if (pl) leagueId = pl.id; }
    } catch(e) { console.warn('⚠️ Bzzoiro 联赛列表获取失败'); }
    if (!leagueId) { console.warn('⚠️ 未找到英超联赛 ID，跳过 Bzzoiro'); return photos; }
    const teamIds = [];
    try {
        const tRes = await fetch(`https://sports.bzzoiro.com/api/v2/teams/?league_id=${leagueId}`, { headers });
        if (tRes.ok) { const tData = await tRes.json(); (tData.results || []).forEach(t => { if (t.id) teamIds.push({ id: t.id, name: t.name }); }); }
    } catch(e) { console.warn('⚠️ Bzzoiro 球队列表获取失败'); }
    for (const team of teamIds) {
        try {
            const pRes = await fetch(`https://sports.bzzoiro.com/api/v2/players/?team_id=${team.id}`, { headers });
            if (!pRes.ok) continue;
            const pData = await pRes.json();
            (pData.results || []).forEach(p => {
                if (!p.name || !p.id) return;
                let zhName = null;
                for (const [zh, en] of Object.entries(PLAYER_NAME_MAP)) {
                    if (normalizeName(en) === normalizeName(p.name)) { zhName = zh; break; }
                }
                if (!zhName) return;
                photos[zhName] = `https://sports.bzzoiro.com/img/player/${p.id}/?sor=true&bg=transparent`;
            });
        } catch(e) {}
        await new Promise(r => setTimeout(r, 500));
    }
    console.log(`📸 Bzzoiro 共获取 ${Object.keys(photos).length} 张`);
    return photos;
}

async function fetchTheSportsDBPhotos(existingPhotos){
    const photos = { ...existingPhotos };
    const missing = Object.entries(PLAYER_NAME_MAP).filter(([zh]) => !photos[zh]);
    if (!missing.length) return photos;
    for (const [zhName, enName] of missing) {
        const candidates = [enName, enName.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), enName.replace(/-/g, ' ')];
        const uniq = [...new Set(candidates)];
        let found = false;
        for (const cand of uniq) {
            if (found) break;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchplayers.php?p=${encodeURIComponent(cand)}`;
                    const res = await fetch(url, { headers: { 'User-Agent': 'PL-Prediction-Engine/1.0' } });
                    if (res.status === 429) { await new Promise(r => setTimeout(r, 30000)); continue; }
                    if (!res.ok) { found = true; break; }
                    const data = await res.json();
                    const list = data.player || [];
                    const want = normalizeName(cand);
                    let best = list.find(p => normalizeName(p.strPlayer) === want);
                    if (!best) best = list.find(p => normalizeName(p.strPlayer).startsWith(want));
                    if (best) {
                        const photoUrl = best.strCutout || best.strRender || best.strThumb || null;
                        if (photoUrl) photos[zhName] = photoUrl;
                    }
                    found = true; break;
                } catch(e) { await new Promise(r => setTimeout(r, 5000)); }
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return photos;
}

// ================= 推送 =================
function pushDataFiles() {
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('🚀 推送数据文件');
    console.log('═══════════════════════════════════');
    try {
        execSync('git add data.json fpl.json', { stdio: 'inherit' });

        const status = execSync('git status --short').toString().trim();
        if (!status) {
            console.log('[git] 数据无变化，跳过推送');
            return;
        }
        console.log('[git] 变更文件：\n' + status);

        execSync(`git commit -m "auto: update data ${new Date().toISOString()}"`, { stdio: 'inherit' });
        execSync('git pull --rebase origin main', { stdio: 'inherit' });
        execSync('git push origin main', { stdio: 'inherit' });
        console.log('[git] ✅ 推送成功');
    } catch (e) {
        console.error('[git] ❌ 推送失败：' + e.message);
        console.error('[git] 正在尝试自动恢复…');
        try { execSync('git rebase --abort', { stdio: 'ignore' }); } catch {}
        try {
            execSync('git pull --rebase origin main', { stdio: 'inherit' });
            execSync('git push origin main', { stdio: 'inherit' });
            console.log('[git] ✅ 恢复后推送成功');
        } catch (e2) {
            console.error('[git] ❌ 二次推送也失败，请手动处理。数据已写好，本地可预览。');
            console.error('[git] 手动排查命令：git status');
        }
    }
}

async function main(){
    const fdToken = process.env.FD_TOKEN;
    const bzKey = process.env.BZZOIRO_KEY;
    if (!fdToken) { console.error('❌ 请设置 FD_TOKEN'); process.exit(1); }

    const oldData = readIfExists(DATA_FILE) || {};
    const oldFpl = readIfExists(FPL_FILE);
    const health = {};

    // 1. 拉 PL 数据
    let apiData;
    try {
        console.log('📡 从 football-data.org 拉取当前赛季…');
        apiData = await fetchFromApi(fdToken);
        health.pl = 'ok';
        console.log(`✅ 积分榜：${apiData.standings.length} 队`);
        console.log(`✅ 赛程：${apiData.fixtures.filter(f => f.length).length} 轮`);
    } catch (e) {
        health.pl = 'fail';
        console.warn('⚠️ PL 数据拉取失败，沿用旧数据：' + e.message);
        apiData = {
            standings: oldData.standings || [],
            results: oldData.results || {},
            fixtures: oldData.fixtures || []
        };
    }

    // 2. 历史交锋
    let historicalResults = oldData.historicalResults || {};
    try {
        const fresh = await fetchHistoricalSeasons(fdToken);
        if (Object.keys(fresh).length) { historicalResults = fresh; health.history = 'ok'; }
        else health.history = 'fail';
    } catch (e) {
        health.history = 'fail';
        console.warn('⚠️ 历史赛季失败，沿用旧数据：' + e.message);
    }

    // 3. 球员照片
    let playerPhotos = oldData.playerPhotos || {};
    if (bzKey) {
        try {
            const photos = await withTimeout(fetchBzzoiroPhotos(bzKey), 120000, 'Bzzoiro 照片');
            if (Object.keys(photos).length) playerPhotos = photos;
            health.bzzoiro = Object.keys(photos).length ? 'ok' : 'fail';
        } catch (e) { health.bzzoiro = 'fail'; console.warn('⚠️ Bzzoiro 失败：' + e.message); }

        try {
            const merged = await withTimeout(fetchTheSportsDBPhotos(playerPhotos), 180000, 'TheSportsDB 照片');
            playerPhotos = merged;
            health.sportsdb = 'ok';
        } catch (e) { health.sportsdb = 'fail'; console.warn('⚠️ TheSportsDB 失败：' + e.message); }
    } else {
        health.bzzoiro = 'skip';
        health.sportsdb = 'skip';
    }

    // 4. FPL
    let fplData = null;
    try {
        fplData = await fetchFPLData();
        health.fpl = 'ok';
    } catch (e) {
        health.fpl = 'fail';
        console.warn('⚠️ FPL 数据拉取失败，保留旧 fpl.json：' + e.message);
    }

    // 5. 写 data.json
    const payload = {
        updatedAt: new Date().toISOString(),
        meta: { updatedAt: new Date().toISOString(), health },
        fixtures: apiData.fixtures,
        results: apiData.results,
        standings: apiData.standings,
        playerPhotos,
        historicalResults
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('🎉 已写入 data.json');
    console.log('   健康状态：' + JSON.stringify(health));

    // 6. 写 fpl.json
    if (fplData && fplData.players.length) {
        const squad = optimizeSquad(fplData.players);
        if (squad) {
            const fplPayload = {
                updatedAt: new Date().toISOString(),
                meta: { updatedAt: new Date().toISOString(), health: { fpl: 'ok' } },
                nextEvent: fplData.nextEvent,
                teams: fplData.teams,
                recommendedSquad: squad,
                allPlayers: fplData.players
            };
            fs.writeFileSync(FPL_FILE, JSON.stringify(fplPayload, null, 2), 'utf8');
            console.log('');
            console.log('═══════════════════════════════════');
            console.log('📸 FPL 梦幻英超数据');
            console.log('═══════════════════════════════════');
            console.log(`🎉 已写入 fpl.json`);
            console.log(`   下一轮：GW${fplData.nextEvent.id}`);
            console.log(`   推荐阵型：${Object.entries(squad.formation).map(([k,v]) => v + ['','GK','DEF','MID','FWD'][k]).join('-')}`);
            console.log(`   预测总分：${squad.totalXPts} 分`);
            console.log(`   总花费：£${squad.totalCost}m / £100m`);
            console.log(`   队长：${squad.captain.name}（${squad.captain.team}） · 预测 ${squad.captain.xPts.toFixed(1)} 分`);
            console.log(`   副队长：${squad.vice.name}（${squad.vice.team}） · 预测 ${squad.vice.xPts.toFixed(1)} 分`);
        } else {
            console.warn('⚠️ 阵容优化失败，fpl.json 未更新');
        }
    } else if (oldFpl) {
        console.log('ℹ️ 保留旧 fpl.json（更新时间：' + (oldFpl.updatedAt || '未知') + '）');
    }

    // 7. 自动打开文件夹（仅本地）
    if (!IS_CI && process.platform === 'win32') {
        try {
            const fullPath = path.resolve(FPL_FILE);
            console.log(`\n👉 文件路径: ${fullPath}`);
            exec(`explorer /select,"${fullPath.replace(/\//g, '\\')}"`);
        } catch (e) {
            console.warn('⚠️ 打开文件夹失败：' + e.message);
        }
    }

    // 8. 推送
    if (SHOULD_PUSH) {
        pushDataFiles();
    } else {
        console.log('');
        console.log('═══════════════════════════════════');
        console.log('ℹ️ 本地模式：已写入文件，未推送');
        console.log('═══════════════════════════════════');
        console.log('   · 想预览：直接刷新本地 index.html');
        console.log('   · 想发布：去 GitHub Actions 点 Run workflow');
        console.log('   · 或本地强制推：node update.js --push');
    }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });