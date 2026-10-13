// ============================================================
// 英超预测引擎 Service Worker
// 每次改 index.html / skill.md / data.json 后，把版本号 +1
// ============================================================
const CACHE_VERSION = 'v7.0.0';
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

const APP_SHELL = [
    './',
    './index.html',
    './skill.md',
    './data.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.allSettled(APP_SHELL.map(url => cache.add(url).catch(() => null)))
        )
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k.startsWith('pl-cache-') && k !== CACHE_NAME)
                .map(k => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // 1. API 请求：不缓存
    if (url.hostname.includes('groq.com') || url.hostname.includes('football-data.org')) return;

    // 2. 队徽 CDN：stale-while-revalidate
    if (url.hostname.includes('espncdn.com') || url.hostname.includes('thesportsdb.com')) {
        event.respondWith(
            caches.open(CACHE_NAME).then(cache =>
                cache.match(req).then(cached => {
                    const fetchPromise = fetch(req).then(res => {
                        if (res && res.status === 200) cache.put(req, res.clone());
                        return res;
                    }).catch(() => cached);
                    return cached || fetchPromise;
                })
            )
        );
        return;
    }

    // 3. data.json：network-first（保证拿到最新数据）
    if (url.pathname.endsWith('/data.json')) {
        event.respondWith(
            fetch(req).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, clone));
                }
                return res;
            }).catch(() => caches.match(req))
        );
        return;
    }

    // 4. 同源静态文件：network-first
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(req).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, clone));
                }
                return res;
            }).catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
        );
        return;
    }
});