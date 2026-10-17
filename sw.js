const CACHE_VERSION = 'v15.1';
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

const APP_SHELL = [
    './', './index.html', './skill.md', './data.json', './fpl.json', './about.html'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(url).catch(() => null)))));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('pl-cache-') && k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // 1. API 请求不缓存
    if (url.hostname.includes('groq.com') || url.hostname.includes('football-data.org')) return;

    // 2. 球员高清照片强制走网络，完全不走 SW 缓存（解决图片不够新的问题！）
    if (url.hostname.includes('premierleague.com') || url.hostname.includes('espncdn.com') || url.hostname.includes('thesportsdb.com')) {
        return; // 放行，走浏览器默认网络请求
    }

    // 3. 字体缓存
    if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(caches.open(CACHE_NAME).then(cache => cache.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(res => { if (res && res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => cached);
        })));
        return;
    }

    // 4. 本地静态文件 Network First
    if (url.origin === self.location.origin) {
        event.respondWith(fetch(req).then(res => {
            if (res && res.status === 200) { const clone = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(req, clone)); }
            return res;
        }).catch(() => caches.match(req).then(c => c || caches.match('./index.html'))));
        return;
    }
});