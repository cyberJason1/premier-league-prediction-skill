const CACHE_VERSION = 'v16.3'; // v16.2 改动：bump 版本，强制旧缓存清退
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

const APP_SHELL = [
    './', './index.html', './skill.md', './data.json', './fpl.json', './about.html'
];

// 数据类文件：离线兜底绝不能返回 index.html
// 否则前端会把 HTML 当 JSON / skill 用，导致解析失败或 prompt 污染
const DATA_FILES = new Set(['/data.json', '/fpl.json', '/skill.md']);

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => Promise.allSettled(
                APP_SHELL.map(url => cache.add(url).catch(() => null))
            ))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k.startsWith('pl-cache-') && k !== CACHE_NAME)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// 防御性：兼容 index.html 里 reg.waiting.postMessage({type:'SKIP_WAITING'})
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

function offlineFallback(pathname) {
    // 数据文件离线时返回明确 503，让前端走 fallback 分支
    if (DATA_FILES.has(pathname)) {
        return new Response(
            JSON.stringify({ error: 'offline', message: '离线且无缓存' }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
    }
    // 页面兜底：用注册 scope 下的绝对 URL 匹配，避免相对路径 key 不匹配
    const indexUrl = new URL('./index.html', self.registration.scope).href;
    return caches.match(indexUrl).then(c => c || new Response('Offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    }));
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // 1. 接口和图片：完全不拦截，直接走网络保证最新鲜
    if (url.hostname.includes('groq.com') ||
        url.hostname.includes('football-data.org') ||
        url.hostname.includes('premierleague.com') ||
        url.hostname.includes('espncdn.com') ||
        url.hostname.includes('thesportsdb.com')) {
        return;
    }

    // 2. 同源静态资源：网络优先，缓存兜底（缓存 key 去 query）
    if (url.origin === self.location.origin) {
        const cacheKey = new Request(url.origin + url.pathname);

        // v16.2 修复：用 async 包裹，await 缓存写入完成，避免 waitUntil 时序问题
        event.respondWith((async () => {
            try {
                const res = await fetch(req, { cache: 'no-store' });
                if (res && res.status === 200) {
                    const clone = res.clone();
                    // await 缓存写入，确保 SW 不会在 put 完成前被终止
                    await caches.open(CACHE_NAME)
                        .then(cache => cache.put(cacheKey, clone))
                        .catch(() => {});
                }
                return res;
            } catch (e) {
                // 全 miss 时返回明确 503，而不是 undefined 或 HTML
                const cached = await caches.match(cacheKey);
                return cached || offlineFallback(url.pathname);
            }
        })());
        return;
    }
});