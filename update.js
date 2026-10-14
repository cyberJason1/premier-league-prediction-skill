#!/usr/bin/env node
/**
 * 英超预测引擎 - 真实数据自动更新 + 球员照片拉取（双源合并版）
 * 数据源：football-data.org + Bzzoiro + TheSportsDB
 * 用法：FD_TOKEN=你的密钥 BZZOIRO_KEY=你的密钥 node update.js
 *
 * 最后更新：2026-10-14
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const SPORTSDB_KEY = '3';

// ─────────────────────────────────────────────
// 球队英文名 → 中文名映射
// ─────────────────────────────────────────────
const TEAM_MAP = {
    'Arsenal':'阿森纳','Manchester City':'曼城','Liverpool':'利物浦','Chelsea':'切尔西',
    'Tottenham Hotspur':'热刺','Aston Villa':'阿斯顿维拉','Newcastle United':'纽卡斯尔联',
    'Manchester United':'曼联','Brighton & Hove Albion':'布莱顿','Crystal Palace':'水晶宫',
    'Everton':'埃弗顿','Fulham':'富勒姆','Brentford':'布伦特福德',
    'Nottingham Forest':'诺丁汉森林','AFC Bournemouth':'伯恩茅斯','Bournemouth':'伯恩茅斯',
    'Leeds United':'利兹联','Sunderland':'桑德兰',
    'Coventry City FC':'考文垂城','Coventry City':'考文垂城',
    'Hull City AFC':'赫尔城','Hull City':'赫尔城',
    'Ipswich Town FC':'伊普斯维奇镇','Ipswich Town':'伊普斯维奇镇'
};

// ─────────────────────────────────────────────
// 中文名 → 英文名映射（LLM 输出中文，API 需要英文）
// ─────────────────────────────────────────────
const PLAYER_NAME_MAP = {
    '萨卡': 'Bukayo Saka','厄德高': 'Martin Odegaard','热苏斯': 'Gabriel Jesus',
    '哈兰德': 'Erling Haaland','谢尔基': 'Rayan Cherki','罗德里': 'Rodri',
    '萨拉赫': 'Mohamed Salah','伊萨克': 'Alexander Isak','加克波': 'Cody Gakpo',
    '若昂·佩德罗': 'Joao Pedro','摩根·罗杰斯': 'Morgan Rogers','帕尔默': 'Cole Palmer',
    '麦迪逊': 'James Maddison','B费': 'Bruno Fernandes','拉什福德': 'Marcus Rashford',
    '吉马良斯': 'Bruno Guimaraes','沃特金斯': 'Ollie Watkins','麦金': 'John McGinn',
    '三笘薰': 'Kaoru Mitoma','维尔贝克': 'Danny Welbeck',
    '卡尔弗特-勒温': 'Dominic Calvert-Lewin','蒂耶尔诺·巴里': 'Thierno Barry',
    '塔科夫斯基': 'James Tarkowski','皮克福德': 'Jordan Pickford',
    '希门尼斯': 'Raul Jimenez','埃泽': 'Eberechi Eze','马特塔': 'Jean-Philippe Mateta',
    '姆贝乌莫': 'Bryan Mbeumo','维萨': 'Yoane Wissa',
    '索兰克': 'Dominic Solanke','塞梅尼奥': 'Antoine Semenyo',
    '伍德': 'Chris Wood','吉布斯-怀特': 'Morgan Gibbs-White',
    '皮罗': 'Joel Piroe','尼奥托': 'Wilfried Gnonto',
    '布罗比': 'Brian Brobbey','伊西多': 'Wilson Isidor',
    '哈吉·赖特': 'Haji Wright','杰克·鲁多尼': 'Jack Rudoni',
    '贝卢米': 'Mohamed Belloumi','Tzolakis': 'Konstantinos Tzolakis',
    '杰克·克拉克': 'Jack Clarke'
};

// ─────────────────────────────────────────────
// 手动补照片（最后保底，两个源都找不到时用）
// ─────────────────────────────────────────────
const FALLBACK_PHOTOS = {};

// ─────────────────────────────────────────────
// 球队名转换
// ─────────────────────────────────────────────
function toChinese(name){
    if (!name) return null;
    if (TEAM_MAP[name]) return TEAM_MAP[name];
    for (const [en, zh] of Object.entries(TEAM_MAP)) {
        if (name.toLowerCase().includes(en.toLowerCase())) return zh;
    }
    return null;
}

// ─────────────────────────────────────────────
// football-data.org 拉取
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
        if (md >= 1 && md <= 38) fixtures[md - 1].push({ home: h, away: a });
        if (m.status === 'FINISHED' && m.score && m.score.fullTime) {
            if (!results[md]) results[md] = {};
            results[md][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
        }
    });

    return { standings, results, fixtures };
}

// ─────────────────────────────────────────────
// Bzzoiro Sports Data 拉取（主数据源）
// ─────────────────────────────────────────────
async function fetchBzzoiroPhotos(apiKey){
    console.log('📸 从 Bzzoiro Sports Data 拉取球员照片…');
    const photos = {};
    const headers = { 'Authorization': `Token ${apiKey}` };

    // 1. 获取英超联赛 ID
    let leagueId = null;
    try {
        const lRes = await fetch('https://sports.bzzoiro.com/api/v2/leagues/?country=England', { headers });
        if (lRes.ok) {
            const lData = await lRes.json();
            const pl = (lData.results || []).find(l => l.name === 'Premier League');
            if (pl) leagueId = pl.id;
        }
    } catch(e) { console.warn('⚠️ Bzzoiro 联赛列表获取失败'); }

    if (!leagueId) {
        console.warn('⚠️ 未找到英超联赛 ID，跳过 Bzzoiro');
        return photos;
    }
    console.log(`✅ 英超联赛 ID: ${leagueId}`);

    // 2. 获取英超所有球队
    const teamIds = [];
    try {
        const tRes = await fetch(`https://sports.bzzoiro.com/api/v2/teams/?league_id=${leagueId}`, { headers });
        if (tRes.ok) {
            const tData = await tRes.json();
            (tData.results || []).forEach(t => {
                if (t.id) teamIds.push({ id: t.id, name: t.name });
            });
        }
    } catch(e) { console.warn('⚠️ Bzzoiro 球队列表获取失败'); }

    if (!teamIds.length) {
        console.warn('⚠️ 未找到球队，跳过 Bzzoiro');
        return photos;
    }
    console.log(`✅ 找到 ${teamIds.length} 支球队`);

    // 3. 逐队拉取球员
    let teamCount = 0;
    for (const team of teamIds) {
        teamCount++;
        try {
            const pRes = await fetch(`https://sports.bzzoiro.com/api/v2/players/?team_id=${team.id}`, { headers });
            if (!pRes.ok) { console.warn(`  ⚠️ ${team.name} HTTP ${pRes.status}`); continue; }
            const pData = await pRes.json();
            const players = pData.results || [];
            players.forEach(p => {
                if (p.name && p.id) {
                    // 建立中英文映射
                    let zhName = null;
                    for (const [zh, en] of Object.entries(PLAYER_NAME_MAP)) {
                        if (en.toLowerCase() === p.name.toLowerCase()) { zhName = zh; break; }
                    }
                    if (!zhName) zhName = p.name; // 没映射就用英文名
                    photos[zhName] = `https://sports.bzzoiro.com/img/player/${p.id}/?sor=true&bg=transparent`;
                }
            });
            console.log(`  ✅ ${team.name} (${players.length} 人)`);
        } catch(e) {
            console.warn(`  ⚠️ ${team.name} 拉取失败：${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`📸 Bzzoiro 共获取 ${Object.keys(photos).length} 位球员照片`);
    return photos;
}

// ─────────────────────────────────────────────
// TheSportsDB 补充（Bzzoiro 缺失的球员）
// ─────────────────────────────────────────────
async function fetchTheSportsDBPhotos(existingPhotos){
    console.log('📸 从 TheSportsDB 补充缺失球员…');
    const photos = { ...existingPhotos };
    const missing = Object.entries(PLAYER_NAME_MAP).filter(([zh]) => !photos[zh]);

    console.log(`📸 待补充 ${missing.length} 位`);

    if (!missing.length) {
        console.log('✅ 所有球员照片已齐，跳过 TheSportsDB');
        return photos;
    }

    const BATCH_LIMIT = 15;
    const batch = missing.slice(0, BATCH_LIMIT);
    let okCount = 0, missCount = 0, errCount = 0;

    for (const [zhName, enName] of batch) {
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchplayers.php?p=${encodeURIComponent(enName)}`;
                const res = await fetch(url, { headers: { 'User-Agent': 'PL-Prediction-Engine/1.0' } });
                if (res.status === 429) {
                    console.log(`  ⏸ ${zhName} 被限速，等待 30 秒…`);
                    await new Promise(r => setTimeout(r, 30000));
                    continue;
                }
                if (!res.ok) { errCount++; success = true; break; }
                const data = await res.json();
                if (data.player && data.player.length > 0) {
                    const p = data.player[0];
                    const photoUrl = p.strCutout || p.strRender || p.strThumb || null;
                    if (photoUrl) { photos[zhName] = photoUrl; okCount++; console.log(`  ✅ ${zhName}`); }
                    else { missCount++; console.log(`  ⚠️ ${zhName} 无照片字段`); }
                } else { missCount++; console.log(`  ⚠️ ${zhName} 未找到`); }
                success = true; break;
            } catch(e) { await new Promise(r => setTimeout(r, 5000)); }
        }
        if (!success) { errCount++; }
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

    if (!fdToken) { console.error('❌ 请设置 FD_TOKEN'); process.exit(1); }
    if (!bzKey) { console.error('❌ 请设置 BZZOIRO_KEY'); process.exit(1); }

    // 1. 拉取比赛数据
    console.log('📡 从 football-data.org 拉取…');
    const { standings, results, fixtures } = await fetchFromApi(fdToken);
    console.log(`✅ 积分榜：${standings.length} 队`);
    console.log(`✅ 赛程：${fixtures.filter(f => f.length).length} 轮`);
    console.log(`✅ 已完赛：${Object.keys(results).length} 轮`);

    if (!standings.length || !fixtures.filter(f => f.length).length) {
        console.error('❌ 数据为空，拒绝写入'); process.exit(1);
    }

    // 2. 双源拉取照片
    let playerPhotos = {};
    try { playerPhotos = await fetchBzzoiroPhotos(bzKey); } catch(e) { console.warn('⚠️ Bzzoiro 失败：', e.message); }
    try { playerPhotos = await fetchTheSportsDBPhotos(playerPhotos); } catch(e) { console.warn('⚠️ TheSportsDB 失败：', e.message); }

    // 3. 合并手动补的照片（最高优先级）
    Object.assign(playerPhotos, FALLBACK_PHOTOS);

    const payload = { updatedAt: new Date().toISOString(), fixtures, results, standings, playerPhotos };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');

    console.log('');
    console.log('🎉 已写入 data.json');
    console.log(`   球员照片：${Object.keys(playerPhotos).length} 张`);
    console.log('下一步：');
    console.log('  git add data.json update.js');
    console.log('  git commit -m "v8.4.2: 双源球员照片 (Bzzoiro + TheSportsDB)"');
    console.log('  git push origin main');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });