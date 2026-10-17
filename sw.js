const CACHE_VERSION = 'v15.0';
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

    // 1. 接口和图片：完全不拦截，直接走网络（保证永远拿最新鲜的数据）
    if (url.hostname.includes('groq.com') ||
        url.hostname.includes('football-data.org') ||
        url.hostname.includes('premierleague.com') ||
        url.hostname.includes('espncdn.com') ||
        url.hostname.includes('thesportsdb.com')) {
        return;
    }

    // 2. 静态页面：优先网络，断网了才用缓存
    if (url.origin === self.location.origin) {
        event.respondWith(fetch(req).then(res => {
            if (res && res.status === 200) { const clone = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(req, clone)); }
            return res;
        }).catch(() => caches.match(req).then(c => c || caches.match('./index.html'))));
        return;
    }
});