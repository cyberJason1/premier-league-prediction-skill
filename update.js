#!/usr/bin/env node
/**
 * 英超预测引擎 - 真实数据自动更新
 * 用法：FD_TOKEN=你的密钥 node update.js
 * Windows：set FD_TOKEN=你的密钥 && node update.js
 */

const fs = require('fs');
const path = require('path');

const INDEX_FILE = path.join(__dirname, 'index.html');
const BACKUP_FILE = path.join(__dirname, 'index.html.bak');

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

    const standings = sData.standings[0].table.map(row => {
        const zh = toChinese(row.team.name);
        if(!zh){ console.warn('⚠️ 未知球队：' + row.team.name); return null; }
        return {
            rank: row.position, team: zh,
            played: row.playedGames, won: row.won, drawn: row.draw, lost: row.lost,
            gf: row.goalsFor, ga: row.goalsAgainst, gd: row.goalDifference, points: row.points
        };
    }).filter(Boolean);

    const mRes = await fetch(base + '/matches', { headers });
    if(!mRes.ok) throw new Error(`Matches API ${mRes.status}：${await mRes.text()}`);
    const mData = await mRes.json();

    const results = {};
    const fixtures = {};

    mData.matches.forEach(m => {
        const h = toChinese(m.homeTeam.name);
        const a = toChinese(m.awayTeam.name);
        if(!h || !a) return;
        const rk = String(m.matchday);
        if(!fixtures[rk]) fixtures[rk] = [];
        fixtures[rk].push({ home: h, away: a });
        if(m.status === 'FINISHED' && m.score?.fullTime){
            if(!results[rk]) results[rk] = {};
            results[rk][`${h}|${a}`] = [m.score.fullTime.home, m.score.fullTime.away];
        }
    });

    return { standings, results, fixtures };
}

function buildFixtures(fixtures){
    const lines = ['const FIXTURES = ['];
    const rounds = Object.keys(fixtures).sort((a,b)=>Number(a)-Number(b));
    rounds.forEach((r, i) => {
        const ms = fixtures[r].map(m => `{home:'${m.home}',away:'${m.away}'}`);
        lines.push(`  [${ms.join(',')}]${i < rounds.length-1 ? ',' : ''}`);
    });
    lines.push('];');
    return lines.join('\n');
}

function buildResults(results){
    const lines = ['const RESULTS = {'];
    const rounds = Object.keys(results).sort((a,b)=>Number(a)-Number(b));
    if(rounds.length === 0){
        lines.push('};');
        return lines.join('\n');
    }
    rounds.forEach((r, i) => {
        const entries = Object.entries(results[r]).map(([k,s]) => `'${k}':[${s[0]},${s[1]}]`);
        lines.push(`  '${r}':{${entries.join(',')}}${i < rounds.length-1 ? ',' : ''}`);
    });
    lines.push('};');
    return lines.join('\n');
}

function buildStandings(standings){
    const lines = ['const STATIC_STANDINGS=['];
    standings.forEach((r, i) => {
        lines.push(`  {rank:${r.rank},team:'${r.team}',played:${r.played},won:${r.won},drawn:${r.drawn},lost:${r.lost},gf:${r.gf},ga:${r.ga},gd:${r.gd},points:${r.points}}${i < standings.length-1 ? ',' : ''}`);
    });
    lines.push('];');
    return lines.join('\n');
}

async function main(){
    const token = process.env.FD_TOKEN;
    if(!token){
        console.error('❌ 请设置 FD_TOKEN 环境变量');
        console.error('   Windows: set FD_TOKEN=你的密钥 && node update.js');
        console.error('   Mac/Linux: FD_TOKEN=你的密钥 node update.js');
        process.exit(1);
    }

    console.log('📡 从 football-data.org 拉取…');
    const { standings, results, fixtures } = await fetchFromApi(token);
    console.log(`✅ 积分榜：${standings.length} 队`);
    console.log(`✅ 赛程：${Object.keys(fixtures).length} 轮`);
    console.log(`✅ 已完赛：${Object.keys(results).length} 轮`);

    const original = fs.readFileSync(INDEX_FILE, 'utf8');
    fs.writeFileSync(BACKUP_FILE, original, 'utf8');
    console.log('💾 已备份 index.html.bak');

    let html = original;

    const r1 = html.match(/const FIXTURES\s*=\s*\[[\s\S]*?\];/);
    if(!r1) throw new Error('未找到 FIXTURES 块');
    html = html.replace(r1[0], buildFixtures(fixtures));

    const r2 = html.match(/const RESULTS\s*=\s*\{[\s\S]*?\};/);
    if(!r2) throw new Error('未找到 RESULTS 块');
    html = html.replace(r2[0], buildResults(results));

    const r3 = html.match(/const STATIC_STANDINGS\s*=\s*\[[\s\S]*?\];/);
    if(!r3) throw new Error('未找到 STATIC_STANDINGS 块');
    html = html.replace(r3[0], buildStandings(standings));

    fs.writeFileSync(INDEX_FILE, html, 'utf8');
    console.log('');
    console.log('🎉 完成！下一步：');
    console.log('  git add .');
    console.log('  git commit -m "Update PL data"');
    console.log('  git push origin main');
    console.log('');
    console.log('回滚：cp index.html.bak index.html');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });