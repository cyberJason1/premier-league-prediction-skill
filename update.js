#!/usr/bin/env node
/**
 * 英超预测引擎 - 真实数据自动更新 + 球员照片拉取 + 历史交锋
 * 数据写入独立的 data.json
 * 用法：在文件旁建一个 .env，写好 FD_TOKEN 和 BZZOIRO_KEY，然后 node update.js
 *
 * 最后更新：2026-10-16
 * 特性：断点续传 + 429 自动等待 + 单次批量限制 + 历史赛季拉取 + .env 读取
 * v13.2：fixtures 新增 kickoff（ISO 时间）+ status 字段
 * v13.2.1：TheSportsDB 名字规范化 + 精确匹配
 * v13.2.2：删除 FALLBACK_PHOTOS、TEAM_MAP 去重、playerPhotos 仅保留中文 key
 */

const fs = require('fs');
const path = require('path');

// ★ 从同目录 .env 读取 token（不用再手打 $env:FD_TOKEN=...）
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
const SPORTSDB_KEY = '3';

const TEAM_MAP = {
    'Arsenal':'阿森纳','Manchester City':'曼城','Liverpool':'利物浦','Chelsea':'切尔西',
    'Tottenham Hotspur':'热刺','Aston Villa':'阿斯顿维拉','Newcastle United':'纽卡斯尔联',
    'Manchester United':'曼联','Brighton':'布莱顿','Crystal Palace':'水晶宫',
    'Everton':'埃弗顿','Fulham':'富勒姆','Brentford':'布伦特福德',
    'Nottingham Forest':'诺丁汉森林','Bournemouth':'伯恩茅斯',
    'Leeds United':'利兹联','Sunderland':'桑德兰',
    'Coventry City':'考文垂城',
    'Hull City':'赫尔城',
    'Ipswich Town':'伊普斯维奇镇'
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

function toChinese(name){
    if (!name) return null;
    if (TEAM_MAP[name]) return TEAM_MAP[name];
    for (const [en, zh] of Object.entries(TEAM_MAP)) {
        if (name.toLowerCase().includes(en.toLowerCase())) return zh;
    }
    return null;
}

// ★ 名字规范化：去音标 + 去符号 + 小写
function normalizeName(s){
    return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // ã→a, ç→c, é→e ...
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

// ─────────────────────────────────────────────
// 当前赛季（fixtures / results / standings）
// ─────────────────────────────────────────────
async function fetchFromApi(token){
    const headers = { 'X-Auth-Token': token };
    const base = 'https://api.football-data.org/v4/competitions/PL';

    const sRes = await fetch(base + '/standings', { headers });
    if (!sRes.ok) throw new Error(`Standings API ${sRes.status}`);
    const sData = await sRes.json();
    if (!sData.standings || !sData.standings[0] || !Array.isArray(sData.standings[0].table)) {
        throw new Error('Standings 返回格式异常');
    }
    const standings = sData.standings[0].table.map(row => {
        const zh = toChinese(row.team.name);
        if (!zh) { console.warn('⚠️ 未知球队：' + row.team.name); return null; }
        return {
            rank: row.position, team: zh,
            played: row.playedGames, won: row.won, drawn: row.draw, lost: row.lost,
            gf: row.goalsFor, ga: row.goalsAgainst, gd: row.goalDifference, points: row.points
        };
    }).filter(Boolean);

    const mRes = await fetch(base + '/matches', { headers });
    if (!mRes.ok) throw new Error(`Matches API ${mRes.status}`);
    const mData = await mRes.json();
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
            fixtures[md - 1].push({
                home: h,
                away: a,
                kickoff: m.utcDate || null,
                status: m.status || 'SCHEDULED'
            });
        }
        if (m.status === 'FINISHED' && m.score && m.score.fullTime) {
            if (!results[md]) results[md] = {};
            results[md][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
        }
    });

    return { standings, results, fixtures };
}

// ─────────────────────────────────────────────
// 历史赛季拉取（过去 2 个赛季）
// ─────────────────────────────────────────────
async function fetchHistoricalSeasons(token){
    console.log('📅 拉取历史赛季交锋数据…');
    const headers = { 'X-Auth-Token': token };
    const historicalResults = {};
    const now = new Date();
    const currentSeason = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    // 2025 表示 2025-26 赛季
    const years = [currentSeason - 1, currentSeason - 2];

    for (const year of years) {
        try {
            const url = `https://api.football-data.org/v4/competitions/PL/matches?season=${year}`;
            const res = await fetch(url, { headers });
            if (!res.ok) {
                console.warn(`  ⚠️ ${year}-${String(year+1).slice(2)} 赛季拉取失败：HTTP ${res.status}`);
                continue;
            }
            const data = await res.json();
            if (!Array.isArray(data.matches)) continue;

            const seasonKey = String(year);
            historicalResults[seasonKey] = {};
            let count = 0;
            data.matches.forEach(m => {
                if (m.status !== 'FINISHED' || !m.score || !m.score.fullTime) return;
                const h = toChinese(m.homeTeam.name);
                const a = toChinese(m.awayTeam.name);
                if (!h || !a) return;
                historicalResults[seasonKey][`${h}|${a}`] = [
                    m.score.fullTime.home,
                    m.score.fullTime.away
                ];
                count++;
            });
            console.log(`  ✅ ${year}-${String(year+1).slice(2)} 赛季：${count} 场`);
        } catch(e) {
            console.warn(`  ⚠️ ${year} 赛季拉取失败：${e.message}`);
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    return historicalResults;
}

// ─────────────────────────────────────────────
// 球员照片（Bzzoiro + TheSportsDB）
// ─────────────────────────────────────────────
async function fetchBzzoiroPhotos(apiKey){
    console.log('📸 从 Bzzoiro Sports Data 拉取球员照片…');
    const photos = {};
    const headers = { 'Authorization': `Token ${apiKey}` };

    let leagueId = null;
    try {
        const lRes = await fetch('https://sports.bzzoiro.com/api/v2/leagues/?country=England', { headers });
        if (lRes.ok) {
            const lData = await lRes.json();
            const pl = (lData.results || []).find(l => l.name === 'Premier League');
            if (pl) leagueId = pl.id;
        }
    } catch(e) { console.warn('⚠️ Bzzoiro 联赛列表获取失败'); }
    if (!leagueId) { console.warn('⚠️ 未找到英超联赛 ID，跳过 Bzzoiro'); return photos; }
    console.log(`✅ 英超联赛 ID: ${leagueId}`);

    const teamIds = [];
    try {
        const tRes = await fetch(`https://sports.bzzoiro.com/api/v2/teams/?league_id=${leagueId}`, { headers });
        if (tRes.ok) {
            const tData = await tRes.json();
            (tData.results || []).forEach(t => { if (t.id) teamIds.push({ id: t.id, name: t.name }); });
        }
    } catch(e) { console.warn('⚠️ Bzzoiro 球队列表获取失败'); }
    if (!teamIds.length) { console.warn('⚠️ 未找到球队，跳过 Bzzoiro'); return photos; }
    console.log(`✅ 找到 ${teamIds.length} 支球队`);

    for (const team of teamIds) {
        try {
            const pRes = await fetch(`https://sports.bzzoiro.com/api/v2/players/?team_id=${team.id}`, { headers });
            if (!pRes.ok) { console.warn(`  ⚠️ ${team.name} HTTP ${pRes.status}`); continue; }
            const pData = await pRes.json();
            const players = pData.results || [];
            let matched = 0;
            players.forEach(p => {
                if (p.name && p.id) {
                    let zhName = null;
                    for (const [zh, en] of Object.entries(PLAYER_NAME_MAP)) {
                        if (normalizeName(en) === normalizeName(p.name)) { zhName = zh; break; }
                    }
                    // ★ 不在定义名单里的，直接跳过，不写进 data.json
                    if (!zhName) return;
                    photos[zhName] = `https://sports.bzzoiro.com/img/player/${p.id}/?sor=true&bg=transparent`;
                    matched++;
                }
            });
            console.log(`  ✅ ${team.name} (${players.length} 人，命中 ${matched})`);
        } catch(e) { console.warn(`  ⚠️ ${team.name} 拉取失败：${e.message}`); }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log(`📸 Bzzoiro 共获取 ${Object.keys(photos).length} 位球员照片（仅保留中文明单球员）`);
    return photos;
}

async function fetchTheSportsDBPhotos(existingPhotos){
    console.log('📸 从 TheSportsDB 补充缺失球员…');
    const photos = { ...existingPhotos };
    const missing = Object.entries(PLAYER_NAME_MAP).filter(([zh]) => !photos[zh]);
    console.log(`📸 待补充 ${missing.length} 位`);
    if (!missing.length) { console.log('✅ 所有球员照片已齐，跳过 TheSportsDB'); return photos; }

    let okCount = 0, missCount = 0, errCount = 0;

    for (const [zhName, enName] of missing) {
        // ★ 生成多个候选搜索词
        const candidates = [
            enName,                                                    // 原名：João Pedro
            enName.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),   // 去音标：Joao Pedro
            enName.replace(/-/g, ' ')                                  // 连字符换空格：Calvert Lewin
        ];
        const uniq = [...new Set(candidates)];

        let found = false;
        for (const cand of uniq) {
            if (found) break;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchplayers.php?p=${encodeURIComponent(cand)}`;
                    const res = await fetch(url, { headers: { 'User-Agent': 'PL-Prediction-Engine/1.0' } });
                    if (res.status === 429) {
                        console.log(`  ⏸ ${zhName} 被限速，等待 30 秒…`);
                        await new Promise(r => setTimeout(r, 30000));
                        continue;
                    }
                    if (!res.ok) { errCount++; found = true; break; }

                    const data = await res.json();
                    const list = data.player || [];

                    // ★ 优先精确匹配（规范化后对比）
                    const want = normalizeName(cand);
                    let best = list.find(p => normalizeName(p.strPlayer) === want);
                    // 退而求其次：前缀匹配
                    if (!best) best = list.find(p => normalizeName(p.strPlayer).startsWith(want));
                    // 最后兜底：第一个
                    if (!best && list.length) best = list[0];

                    if (best) {
                        const photoUrl = best.strCutout || best.strRender || best.strThumb || null;
                        if (photoUrl) {
                            photos[zhName] = photoUrl;
                            okCount++;
                            console.log(`  ✅ ${zhName} ← "${best.strPlayer}"（搜"${cand}"）`);
                        } else {
                            missCount++;
                            console.log(`  ⚠️ ${zhName}（匹配到"${best.strPlayer}"但无照片字段）`);
                        }
                    } else {
                        missCount++;
                        console.log(`  ⚠️ ${zhName} 未找到（搜"${cand}"）`);
                    }
                    found = true;
                    break;
                } catch(e) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`📸 TheSportsDB 补充：成功 ${okCount} · 未找到 ${missCount} · 错误 ${errCount}`);
    return photos;
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────
async function main(){
    const fdToken = process.env.FD_TOKEN;
    const bzKey = process.env.BZZOIRO_KEY;
    if (!fdToken) { console.error('❌ 请设置 FD_TOKEN（在 .env 里写 FD_TOKEN=xxx）'); process.exit(1); }
    if (!bzKey) { console.error('❌ 请设置 BZZOIRO_KEY（在 .env 里写 BZZOIRO_KEY=xxx）'); process.exit(1); }

    console.log('📡 从 football-data.org 拉取当前赛季…');
    const { standings, results, fixtures } = await fetchFromApi(fdToken);
    console.log(`✅ 积分榜：${standings.length} 队`);
    console.log(`✅ 赛程：${fixtures.filter(f => f.length).length} 轮`);
    console.log(`✅ 已完赛：${Object.keys(results).length} 轮`);

    if (standings.length === 0) { console.error('❌ 积分榜为空，拒绝写入'); process.exit(1); }
    if (fixtures.filter(f => f.length).length === 0) { console.error('❌ 赛程为空，拒绝写入'); process.exit(1); }

    // 历史赛季
    let historicalResults = {};
    try { historicalResults = await fetchHistoricalSeasons(fdToken); }
    catch(e) { console.warn('⚠️ 历史赛季整体失败：', e.message); }

    // 球员照片
    let playerPhotos = {};
    try { playerPhotos = await fetchBzzoiroPhotos(bzKey); } catch(e) { console.warn('⚠️ Bzzoiro 失败：', e.message); }
    try { playerPhotos = await fetchTheSportsDBPhotos(playerPhotos); } catch(e) { console.warn('⚠️ TheSportsDB 失败：', e.message); }

    const payload = {
        updatedAt: new Date().toISOString(),
        fixtures,
        results,
        standings,
        playerPhotos,
        historicalResults
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('');
    console.log('🎉 已写入 data.json');
    console.log(`   球员照片：${Object.keys(playerPhotos).length} 张`);
    console.log(`   历史赛季：${Object.keys(historicalResults).length} 个`);
    console.log('下一步：');
    console.log('  git add data.json update.js');
    console.log('  git commit -m "Update PL data + historical results"');
    console.log('  git push origin main');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });