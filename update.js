#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// 读取环境变量
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
        const [k, ...v] = line.split('=');
        if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    });
}

const FD_TOKEN = process.env.FD_TOKEN;
const BZZ_KEY = process.env.BZZOIRO_KEY;

if (!FD_TOKEN || !BZZ_KEY) {
    console.error('❌ 缺少环境变量！请在 .env 中配置 FD_TOKEN 和 BZZOIRO_KEY');
    process.exit(1);
}

const DATA_FILE = path.join(__dirname, 'data.json');

// 队名中英映射（用于匹配两家数据源）
const TEAM_MAP = {
    'Arsenal':'阿森纳','Manchester City':'曼城','Liverpool':'利物浦','Chelsea':'切尔西',
    'Tottenham Hotspur':'热刺','Aston Villa':'阿斯顿维拉','Newcastle United':'纽卡斯尔联',
    'Manchester United':'曼联','Brighton':'布莱顿','Crystal Palace':'水晶宫','Everton':'埃弗顿',
    'Fulham':'富勒姆','Brentford':'布伦特福德','Nottingham Forest':'诺丁汉森林',
    'Bournemouth':'伯恩茅斯','Leeds United':'利兹联','Sunderland':'桑德兰','Burnley':'伯恩利',
    'Wolves':'狼队','West Ham':'西汉姆联'
};

function toChinese(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    for (const [en, zh] of Object.entries(TEAM_MAP)) {
        if (lower.includes(en.toLowerCase())) return zh;
    }
    return null;
}

async function fetchJSON(url, headers = {}) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
    return await res.json();
}

// ================== 核心 Dixon-Coles 模型实现 ==================
// 修正低级比分（0-0, 1-0, 0-1, 1-1）的概率依赖
function dixonColesTau(x, y, lambda, mu, rho) {
    if (x === 0 && y === 0) return 1 - lambda * mu * rho;
    if (x === 0 && y === 1) return 1 + lambda * rho;
    if (x === 1 && y === 0) return 1 + mu * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
}

// 计算 Poisson 概率
function poissonPMF(k, lambda) {
    let p = Math.exp(-lambda);
    for (let i = 1; i <= k; i++) p *= lambda / i;
    return p;
}

// 构建比分概率网格
function buildScoreGrid(lambdaHome, lambdaAway, rho = -0.06) {
    const grid = [];
    let totalProb = 0;
    for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
            let prob = poissonPMF(h, lambdaHome) * poissonPMF(a, lambdaAway) * dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
            if (prob < 0) prob = 0;
            grid.push({ h, a, prob });
            totalProb += prob;
        }
    }
    // 归一化
    return grid.map(item => ({ ...item, prob: item.prob / totalProb }));
}

// 从网格中提取市场概率
function extractMarketProbs(grid) {
    let homeWin = 0, draw = 0, awayWin = 0, btts = 0, over25 = 0;
    for (const { h, a, prob } of grid) {
        if (h > a) homeWin += prob;
        else if (h === a) draw += prob;
        else awayWin += prob;
        if (h > 0 && a > 0) btts += prob;
        if (h + a > 2.5) over25 += prob;
    }
    // 找出最可能比分
    const sorted = [...grid].sort((x, y) => y.prob - x.prob);
    const mostLikely = sorted[0];
    return { homeWin, draw, awayWin, btts, over25, score: `${mostLikely.h}-${mostLikely.a}` };
}
// ================================================================

async function main() {
    console.log('🚀 开始拉取双源数据并进行深度建模...');

    // 1. 抓取 Football-Data 基础赛程
    console.log('⚽ 拉取 Football-Data 赛程...');
    const fdMatches = await fetchJSON('https://api.football-data.org/v4/competitions/PL/matches', { 'X-Auth-Token': FD_TOKEN });

    const fixtures = fdMatches.matches.map(m => {
        const hZh = toChinese(m.homeTeam.name);
        const aZh = toChinese(m.awayTeam.name);
        return {
            id: m.id,
            round: m.matchday,
            home: hZh || m.homeTeam.name,
            away: aZh || m.awayTeam.name,
            kickoff: m.utcDate,
            finished: m.status === 'FINISHED',
            homeGoals: m.score.fullTime.home,
            awayGoals: m.score.fullTime.away,
            predictions: null
        };
    }).filter(f => f.home && f.away);

    // 2. 抓取 Bzzorio 深度数据
    console.log('🧠 拉取 Bzzorio 深度数据（xG, ELO, CatBoost 预测）...');
    const lRes = await fetchJSON('https://sports.bzzoiro.com/api/v2/leagues/?country=England', { 'Authorization': `Token ${BZZ_KEY}` });
    const pl = lRes.results.find(l => l.name === 'Premier League');
    if (!pl) throw new Error('Bzzorio: 找不到英超联赛');

    const mRes = await fetchJSON(`https://sports.bzzoiro.com/api/v2/matches/?league_id=${pl.id}`, { 'Authorization': `Token ${BZZ_KEY}` });

    // 3. 融合与建模
    let enrichedCount = 0;
    mRes.results.forEach(bzzMatch => {
        const fdMatch = fixtures.find(f =>
            (f.home.includes(bzzMatch.home_team.name) || bzzMatch.home_team.name.includes(f.home)) &&
            (f.away.includes(bzzMatch.away_team.name) || bzzMatch.away_team.name.includes(f.away))
        );

        if (fdMatch) {
            let prediction = null;

            // 优先使用 Bzzorio 提供的原始 xG 数据来驱动我们的 Dixon-Coles 模型
            if (bzzMatch.predictions && bzzMatch.predictions.xg_home != null && bzzMatch.predictions.xg_away != null) {
                const lambdaHome = bzzMatch.predictions.xg_home;
                const lambdaAway = bzzMatch.predictions.xg_away;
                const grid = buildScoreGrid(lambdaHome, lambdaAway);
                const markets = extractMarketProbs(grid);

                prediction = {
                    homeWin: Math.round(markets.homeWin * 100),
                    draw: Math.round(markets.draw * 100),
                    awayWin: Math.round(markets.awayWin * 100),
                    score: markets.score,
                    btts: Math.round(markets.btts * 100),
                    over25: Math.round(markets.over25 * 100),
                    xgHome: lambdaHome.toFixed(2),
                    xgAway: lambdaAway.toFixed(2),
                    factors: [
                        'xG 驱动的 Dixon-Coles 模型',
                        '低比分修正 (ρ = -0.06)',
                        `主队预期进球: ${lambdaHome.toFixed(2)}`,
                        `客队预期进球: ${lambdaAway.toFixed(2)}`
                    ],
                    analysis: '基于 Bzzorio 的实时 xG 数据，通过 Dixon-Coles 双泊松模型重新构建了完整的比分概率网格，以校正市场概率。'
                };
            }
            // 降级：如果 Bzzorio 只提供了 CatBoost 的预测结果，直接使用
            else if (bzzMatch.predictions && bzzMatch.predictions.prob_home) {
                const pred = bzzMatch.predictions;
                prediction = {
                    homeWin: Math.round(pred.prob_home * 100),
                    draw: Math.round(pred.prob_draw * 100),
                    awayWin: Math.round(pred.prob_away * 100),
                    score: pred.score || '1-0',
                    xgHome: pred.xg_home ? pred.xg_home.toFixed(2) : null,
                    xgAway: pred.xg_away ? pred.xg_away.toFixed(2) : null,
                    factors: ['Bzzorio CatBoost ML 模型'],
                    analysis: '基于 Bzzorio 的 CatBoost 机器学习模型预测。'
                };
            }

            if (prediction) {
                fdMatch.predictions = prediction;
                enrichedCount++;
            }
        }
    });

    console.log(`✅ 成功为 ${enrichedCount} 场比赛生成了深度模型预测！`);

    // 4. 写入 data.json
    const finalData = {
        updatedAt: new Date().toISOString(),
        fixtures: fixtures,
        predictions: fixtures.filter(f => f.predictions).map(f => ({
            home: f.home,
            away: f.away,
            ...f.predictions
        }))
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(finalData, null, 2), 'utf8');
    console.log('💾 data.json 写入成功！请刷新网页查看深度结果。');
}

main().catch(console.error);