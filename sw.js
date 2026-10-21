const CACHE_VERSION = 'v17.1-pro'; // 强制清退旧缓存
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

// 离线应用壳：包括主页、关于页和两个核心数据文件
const APP_SHELL = [
    './', './index.html', './data.json', './fpl.json', './about.html'
];

// 数据文件离线时绝不能返回 index.html，否则 JSON 解析会报错
const DATA_FILES = new Set(['/data.json', '/fpl.json']);

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

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

function offlineFallback(pathname) {
    if (DATA_FILES.has(pathname)) {
        return new Response(
            JSON.stringify({ error: 'offline', message: '离线且无缓存' }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
    }
    const indexUrl = new URL('./index.html', self.registration.scope).href;
    return caches.match(indexUrl).then(c => c || new Response('Offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    }));
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return; // 只拦截 GET 请求
    const url = new URL(req.url);

    // 1. 外部接口和图片：完全不拦截，直接走网络
    // 包含：FPL 官方、英超 CDN、AI 接口
    if (url.hostname.includes('fantasy.premierleague.com') ||
        url.hostname.includes('premierleague.com') ||
        url.hostname.includes('api.groq.com')) {
        return;
    }

    // 2. 字体资源走网络，不占用本地缓存
    if (url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com')) {
        return;
    }

    // 3. 同源静态资源：网络优先，缓存兜底
    if (url.origin === self.location.origin) {
        const cacheKey = new Request(url.origin + url.pathname);

        event.respondWith((async () => {
            try {
                const res = await fetch(req, { cache: 'no-store' });
                if (res && res.status === 200) {
                    const clone = res.clone();
                    await caches.open(CACHE_NAME)
                        .then(cache => cache.put(cacheKey, clone))
                        .catch(() => {});
                }
                return res;
            } catch (e) {
                const cached = await caches.match(cacheKey);
                return cached || offlineFallback(url.pathname);
            }
        })());
        return;
    }
});