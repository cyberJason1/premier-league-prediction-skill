// ============================================================
// 英超预测引擎 Service Worker · v15.0
// ============================================================

const CACHE_VERSION = 'v15.0';
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

// App Shell：首次安装时预缓存
const APP_SHELL = [
    './',
    './index.html',
    './skill.md',
    './data.json',
    './fpl.json',
    './about.html'
];

// ---------- 安装：预缓存 App Shell ----------
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return Promise.allSettled(
                    APP_SHELL.map(url => cache.add(url).catch(() => null))
                );
            })
    );
    // 强制立即接管，不等待
    self.skipWaiting();
});

// ---------- 激活：清掉所有旧版本缓存 ----------
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => k.startsWith('pl-cache-') && k !== CACHE_NAME)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ---------- 消息：用户点击"新版本就绪"时立即切换 ----------
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ---------- 请求拦截 ----------
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // 1. API 请求：完全不缓存
    if (url.hostname.includes('groq.com') || url.hostname.includes('football-data.org')) {
        return;
    }

    // 2. Google Fonts：cache-first
    if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(
            caches.open(CACHE_NAME).then(cache =>
                cache.match(req).then(cached => {
                    if (cached) return cached;
                    return fetch(req).then(res => {
                        if (res && res.status === 200) cache.put(req, res.clone());
                        return res;
                    }).catch(() => cached);
                })
            )
        );
        return;
    }

    // 3. 队徽/球员照片 CDN：stale-while-revalidate (加强版)
    if (url.hostname.includes('espncdn.com') || url.hostname.includes('thesportsdb.com') || url.hostname.includes('bzzoiro.com') || url.hostname.includes('premierleague.com')) {
        event.respondWith(
            caches.open(CACHE_NAME).then(cache =>
                cache.match(req).then(cached => {
                    const fetchPromise = fetch(req)
                        .then(res => {
                            // 只有成功状态才更新缓存
                            if (res && res.status === 200) cache.put(req, res.clone());
                            return res;
                        })
                        .catch(() => cached);
                    return cached || fetchPromise;
                })
            )
        );
        return;
    }

    // 4. 同源静态文件（index.html、data.json、fpl.json 等）：network-first
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(async cache => {
                            try {
                                const keys = await cache.keys();
                                const bare = url.origin + url.pathname;
                                await Promise.all(
                                    keys.filter(k => {
                                        try {
                                            const ku = new URL(k.url);
                                            return ku.origin + ku.pathname === bare && k.url !== req.url;
                                        } catch { return false; }
                                    }).map(k => cache.delete(k))
                                );
                            } catch(e) {}
                            cache.put(req, clone);
                        });
                    }
                    return res;
                })
                .catch(() =>
                    caches.match(req).then(c => c || caches.match('./index.html'))
                )
        );
        return;
    }
});