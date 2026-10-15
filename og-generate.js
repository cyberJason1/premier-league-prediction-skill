#!/usr/bin/env node
/**
 * 生成 og.png（1200×630 @2x）
 * 用法：node og-generate.js
 * 依赖：npm i -D puppeteer
 *
 * 会自动按以下顺序找 Chrome：
 *   1. 环境变量 PUPPETEER_EXECUTABLE_PATH
 *   2. 系统常见路径（Windows / macOS / Linux）
 *   3. Puppeteer 自带下载的 Chrome
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

/** 查找系统 Chrome */
function findSystemChrome() {
    const platform = os.platform();
    const candidates = [];

    if (platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        candidates.push(
            path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
        );
    } else if (platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        );
    } else {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
        );
    }

    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

(async () => {
    const src = path.resolve(__dirname, 'og-source.html');
    const out = path.resolve(__dirname, 'og.png');
    if (!fs.existsSync(src)) {
        console.error('❌ 找不到 og-source.html');
        process.exit(1);
    }

    // 按优先级决定用哪个 Chrome
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const sysPath = findSystemChrome();
    const executablePath = envPath || sysPath || undefined;

    if (executablePath) {
        console.log(`✅ 使用 Chrome：${executablePath}`);
    } else {
        console.log('⚠️  未找到系统 Chrome，使用 Puppeteer 内置版本');
    }

    console.log('🚀 启动无头浏览器…');
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });

    console.log('📄 加载 og-source.html…');
    await page.goto('file://' + src, { waitUntil: 'networkidle0' });

    // 等待所有字体加载完成（关键：否则中文可能渲染成 fallback）
    await page.evaluate(async () => {
        await document.fonts.ready;
        const fonts = ['Playfair Display', 'Inter', 'Noto Serif SC', 'Noto Sans SC'];
        for (const f of fonts) {
            try { await document.fonts.load(`16px "${f}"`); } catch (e) {}
        }
    });

    // 额外保险：多等 300ms 让动画/渲染稳定
    await new Promise(r => setTimeout(r, 300));

    console.log('📸 截图…');
    const el = await page.$('#og');
    await el.screenshot({ path: out, type: 'png', omitBackground: false });

    await browser.close();
    const size = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`✅ 已生成 og.png（1200×630 @2x · ${size} KB）`);
})().catch(err => {
    console.error('❌ 生成失败：', err.message);
    process.exit(1);
});