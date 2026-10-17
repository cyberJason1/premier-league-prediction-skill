const CACHE_VERSION = 'v16.0';
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

const APP_SHELL = [
    './', './index.html', './skill.md', './data.json', './fpl.json', './about.html'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(url).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k.startsWith('pl-cache-') && k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

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
            fetch(req).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone));
                }
                return res;
            }).catch(() => caches.match(cacheKey).then(c => c || caches.match('./index.html')))
        );
        return;
    }
});