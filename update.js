#!/usr/bin/env node
/**
 * 英超预测引擎 - 真实数据自动更新
 * 数据写入独立的 data.json，不再碰 index.html
 * 用法：FD_TOKEN=你的密钥 node update.js
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

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

function toChinese(name){
    if(!name) return null;
    if(TEAM_MAP[name]) return TEAM_MAP[name];
    for(const [en,zh] of Object.entries(TEAM_MAP)){
        if(name.toLowerCase().includes(en.toLowerCase())) return zh;
    }
    return null;
}

async function fetchFromApi(token){
    const headers = { 'X-Auth-Token': token };
    const base = 'https://api.football-data.org/v4/competitions/PL';

    const sRes = await fetch(base + '/standings', { headers });
    if(!sRes.ok) throw new Error(`Standings API ${sRes.status}：${await sRes.text()}`);
    const sData = await sRes.json();

    if (!sData.standings || !sData.standings[0] || !Array.isArray(sData.standings[0].table)) {
        throw new Error('Standings 返回格式异常：缺少 standings[0].table');
    }

    const standings = sData.standings[0].table.map(row => {
        const zh = toChinese(row.team.name);
        if(!zh){ console.warn('⚠️ 未知球队：' + row.team.name); return null; }
        return {
            rank: row.position, team: zh,
            played: row.playedGames, won: row.won, drawn: row.draw, lost: row.lost,
            gf: row.goalsFor, ga: row.goalsAgainst, gd: row.goalDifference, points: row.points
        };
    }).filter(Boolean);

    if (standings.length !== 20) {
        console.warn(`⚠️ 积分榜返回 ${standings.length} 队（预期 20），可能有球队名未映射`);
    }

    const mRes = await fetch(base + '/matches', { headers });
    if(!mRes.ok) throw new Error(`Matches API ${mRes.status}：${await mRes.text()}`);
    const mData = await mRes.json();

    if (!Array.isArray(mData.matches)) {
        throw new Error('Matches 返回格式异常：缺少 matches 数组');
    }

    // fixtures: 数组，index 0 = 第 1 轮
    const fixtures = [];
    for (let i = 0; i < 38; i++) fixtures.push([]);

    // results: 对象 { "1": { "阿森纳|利兹联": [3,0] }, ... }
    const results = {};

    let skipped = 0;
    mData.matches.forEach(m => {
        const h = toChinese(m.homeTeam.name);
        const a = toChinese(m.awayTeam.name);
        if(!h || !a){ skipped++; return; }
        const md = m.matchday;
        if (md >= 1 && md <= 38) {
            fixtures[md - 1].push({ home: h, away: a });
        }
        if(m.status === 'FINISHED' && m.score && m.score.fullTime){
            if (!results[md]) results[md] = {};
            results[md][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
        }
    });

    if (skipped > 0) console.warn(`⚠️ 跳过 ${skipped} 场（球队名未映射）`);

    const filledRounds = fixtures.filter(f => f.length).length;
    if (filledRounds < 38) {
        console.warn(`⚠️ 只有 ${filledRounds}/38 轮有赛程，可能赛季尚未完全排期`);
    }

    return { standings, results, fixtures };
}

async function main(){
    const token = process.env.FD_TOKEN;
    if(!token){
        console.error('❌ 请设置 FD_TOKEN 环境变量');
        console.error('   Windows: set FD_TOKEN=你的密钥 && node update.js');
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

    const payload = {
        updatedAt: new Date().toISOString(),
        fixtures,
        results,
        standings
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('');
    console.log('🎉 已写入 data.json');
    console.log('下一步：');
    console.log('  git add data.json');
    console.log('  git commit -m "Update PL data"');
    console.log('  git push origin main');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });