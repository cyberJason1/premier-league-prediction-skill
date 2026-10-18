const CACHE_VERSION = 'v16.1'; // v16.1 改动：bump 版本，强制旧缓存清退
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
    // 页面兜底：优先 index.html，全 miss 返回明确 503
    return caches.match('./index.html').then(c => c || new Response('Offline', {
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
        event.respondWith(
            // v16.1 改动：加 cache:'no-store'，绕过浏览器 HTTP 缓存，真正每次问服务器
            fetch(req, { cache: 'no-store' }).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    // cache.put 放到 waitUntil 里，避免 SW 提前终止导致缓存不完整
                    event.waitUntil(
                        caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone))
                    );
                }
                return res;
            }).catch(() => {
                // 全 miss 时返回明确 503，而不是 undefined 或 HTML
                return caches.match(cacheKey).then(c => c || offlineFallback(url.pathname));
            })
        );
        return;
    }
});