#!/usr/bin/env node
/**
 * 英超预测引擎 - 真实数据自动更新 + 球员照片拉取
 * 数据写入独立的 data.json
 * 用法：FD_TOKEN=你的密钥 node update.js
 *
 * 最后更新：2026-10-14
 * 特性：断点续传 + 429 自动等待 + 单次批量限制
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
// 核心球员中文名 → 英文名映射（2026-27 赛季最新）
// 已移除：孙兴慜（2026年8月转会洛杉矶 FC）
// ─────────────────────────────────────────────
const PLAYER_NAME_MAP = {
    // 阿森纳
    '萨卡': 'Bukayo Saka',
    '厄德高': 'Martin Odegaard',
    '热苏斯': 'Gabriel Jesus',
    // 曼城
    '哈兰德': 'Erling Haaland',
    '谢尔基': 'Rayan Cherki',
    '罗德里': 'Rodri',
    // 利物浦
    '萨拉赫': 'Mohamed Salah',
    '伊萨克': 'Alexander Isak',
    '加克波': 'Cody Gakpo',
    // 切尔西
    '若昂·佩德罗': 'Joao Pedro',
    '摩根·罗杰斯': 'Morgan Rogers',
    '帕尔默': 'Cole Palmer',
    // 热刺
    '麦迪逊': 'James Maddison',
    // 曼联
    'B费': 'Bruno Fernandes',
    '拉什福德': 'Marcus Rashford',
    // 纽卡
    '吉马良斯': 'Bruno Guimaraes',
    // 维拉
    '沃特金斯': 'Ollie Watkins',
    '麦金': 'John McGinn',
    // 布莱顿
    '三笘薰': 'Kaoru Mitoma',
    '维尔贝克': 'Danny Welbeck',
    // 埃弗顿
    '卡尔弗特-勒温': 'Dominic Calvert-Lewin',
    '蒂耶尔诺·巴里': 'Thierno Barry',
    '塔科夫斯基': 'James Tarkowski',
    // 富勒姆
    '希门尼斯': 'Raul Jimenez',
    // 水晶宫
    '埃泽': 'Eberechi Eze',
    '马特塔': 'Jean-Philippe Mateta',
    // 布伦特福德
    '姆贝乌莫': 'Bryan Mbeumo',
    '维萨': 'Yoane Wissa',
    // 伯恩茅斯
    '索兰克': 'Dominic Solanke',
    '塞梅尼奥': 'Antoine Semenyo',
    // 诺丁汉森林
    '伍德': 'Chris Wood',
    '吉布斯-怀特': 'Morgan Gibbs-White',
    // 利兹联
    '皮罗': 'Joel Piroe',
    '尼奥托': 'Wilfried Gnonto',
    // 桑德兰
    '布罗比': 'Brian Brobbey',
    '伊西多': 'Wilson Isidor',
    // 考文垂城
    '哈吉·赖特': 'Haji Wright',
    '杰克·鲁多尼': 'Jack Rudoni',
    // 赫尔城
    '贝卢米': 'Mohamed Belloumi',
    'Tzolakis': 'Konstantinos Tzolakis',
    // 伊普斯维奇
    '杰克·克拉克': 'Jack Clarke'
};

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
        if (md >= 1 && md <= 38) {
            fixtures[md - 1].push({ home: h, away: a });
        }
        if (m.status === 'FINISHED' && m.score && m.score.fullTime) {
            if (!results[md]) results[md] = {};
            results[md][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
        }
    });

    return { standings, results, fixtures };
}

// ─────────────────────────────────────────────
// TheSportsDB 球员照片拉取（断点续传 + 限速保护）
// ─────────────────────────────────────────────
async function fetchPlayerPhotos(){
    // 1. 读取现有缓存（断点续传）
    let existingPhotos = {};
    try {
        const oldRaw = fs.readFileSync(DATA_FILE, 'utf8');
        const oldData = JSON.parse(oldRaw);
        if (oldData.playerPhotos && typeof oldData.playerPhotos === 'object') {
            existingPhotos = oldData.playerPhotos;
        }
    } catch (e) { /* 首次运行，无旧文件 */ }

    const photos = { ...existingPhotos };
    const allEntries = Object.entries(PLAYER_NAME_MAP);
    const missing = allEntries.filter(([zh]) => !photos[zh]);

    console.log(`📸 已有 ${Object.keys(existingPhotos).length} 张，待拉取 ${missing.length} 张`);

    if (missing.length === 0) {
        console.log('✅ 所有球员照片已缓存，跳过拉取');
        return photos;
    }

    // 2. 单次最多拉 15 个（避免连续触发 429）
    const BATCH_LIMIT = 15;
    const batch = missing.slice(0, BATCH_LIMIT);
    if (missing.length > BATCH_LIMIT) {
        console.log(`⚠️ 本次只拉 ${BATCH_LIMIT} 个（剩 ${missing.length - BATCH_LIMIT} 个下次再拉）`);
    }

    let okCount = 0, missCount = 0, errCount = 0;

    for (const [zhName, enName] of batch) {
        let success = false;
        let attempts = 0;

        while (attempts < 3) {
            attempts++;
            try {
                const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchplayers.php?p=${encodeURIComponent(enName)}`;
                const res = await fetch(url, {
                    headers: { 'User-Agent': 'PL-Prediction-Engine/1.0' }
                });

                // 429：等待 30 秒后重试
                if (res.status === 429) {
                    console.log(`  ⏸ ${zhName} 被限速，等待 30 秒…`);
                    await new Promise(r => setTimeout(r, 30000));
                    continue;
                }

                if (!res.ok) {
                    console.warn(`  ⚠️ ${zhName} HTTP ${res.status}`);
                    errCount++;
                    success = true; // 不重试非 429 错误
                    break;
                }

                const data = await res.json();
                if (data.player && data.player.length > 0) {
                    const p = data.player[0];
                    const photoUrl = p.strCutout || p.strRender || p.strThumb || null;
                    if (photoUrl) {
                        photos[zhName] = photoUrl;
                        console.log(`  ✅ ${zhName}`);
                        okCount++;
                    } else {
                        console.log(`  ⚠️ ${zhName} 无照片字段`);
                        missCount++;
                    }
                } else {
                    console.log(`  ⚠️ ${zhName} 未找到`);
                    missCount++;
                }
                success = true;
                break;
            } catch (e) {
                console.warn(`  ⚠️ ${zhName} 请求失败：${e.message}`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (!success) {
            console.warn(`  ❌ ${zhName} 重试 3 次仍失败，跳过`);
            errCount++;
        }

        // 每请求间隔 2 秒
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('');
    console.log(`📸 本次汇总：成功 ${okCount} · 未找到 ${missCount} · 错误 ${errCount}`);
    console.log(`📸 累计已有 ${Object.keys(photos).length} / ${allEntries.length} 张`);

    if (Object.keys(photos).length < allEntries.length) {
        console.log(`💡 还有 ${allEntries.length - Object.keys(photos).length} 张未拉取，再跑一次 node update.js 继续`);
    } else {
        console.log('🎉 全部球员照片已拉齐');
    }

    return photos;
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────
async function main(){
    const token = process.env.FD_TOKEN;
    if (!token) {
        console.error('❌ 请设置 FD_TOKEN 环境变量');
        console.error('   PowerShell: $env:FD_TOKEN="你的密钥"');
        console.error('   CMD:        set FD_TOKEN=你的密钥');
        console.error('   然后运行:   node update.js');
        process.exit(1);
    }

    console.log('📡 从 football-data.org 拉取…');
    const { standings, results, fixtures } = await fetchFromApi(token);
    console.log(`✅ 积分榜：${standings.length} 队`);
    console.log(`✅ 赛程：${fixtures.filter(f => f.length).length} 轮`);
    console.log(`✅ 已完赛：${Object.keys(results).length} 轮`);

    if (standings.length === 0) {
        console.error('❌ 积分榜为空，拒绝写入，避免覆盖已有数据');
        process.exit(1);
    }
    if (fixtures.filter(f => f.length).length === 0) {
        console.error('❌ 赛程为空，拒绝写入，避免覆盖已有数据');
        process.exit(1);
    }

    // 拉取球员照片
    let playerPhotos = {};
    try {
        playerPhotos = await fetchPlayerPhotos();
    } catch (e) {
        console.warn('⚠️ 球员照片整体失败，跳过：', e.message);
    }

    const payload = {
        updatedAt: new Date().toISOString(),
        fixtures,
        results,
        standings,
        playerPhotos
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('');
    console.log('🎉 已写入 data.json');
    console.log(`   球员照片：${Object.keys(playerPhotos).length} 张`);
    console.log('下一步：');
    console.log('  git add data.json update.js');
    console.log('  git commit -m "Update PL data + player photos"');
    console.log('  git push origin main');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });