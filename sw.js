// ============================================================
// 英超预测引擎 Service Worker
// 版本号：改这个数字会触发更新（重要）
// ============================================================
const CACHE_VERSION = 'v7.1.0';
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

// App Shell：首次安装时预缓存
const APP_SHELL = [
    './',
    './index.html',
    './skill.md'
];

// ---------- 安装 ----------
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                // 逐个 add，避免某个文件失败导致整体失败
                return Promise.allSettled(
                    APP_SHELL.map(url => cache.add(url).catch(() => null))
                );
            })
    );
    // 不自动 skipWaiting，等用户确认后再激活
});

// ---------- 激活 ----------
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

// ---------- 消息：用户点击"刷新"时激活新版本 ----------
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

    // 1. API 请求：完全不缓存（Groq、football-data）
    if (url.hostname.includes('groq.com') ||
        url.hostname.includes('football-data.org')) {
        return; // 走默认网络请求
    }

    // 2. 队徽 CDN：stale-while-revalidate（先给缓存，同时后台更新）
    if (url.hostname.includes('espncdn.com') ||
        url.hostname.includes('thesportsdb.com')) {
        event.respondWith(
            caches.open(CACHE_NAME).then(cache =>
                cache.match(req).then(cached => {
                    const fetchPromise = fetch(req)
                        .then(res => {
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

    // 3. 同源静态文件（index.html、skill.md）：network-first（保证拿到最新）
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, clone));
                    }
                    return res;
                })
                .catch(() =>
                    caches.match(req).then(c => c || caches.match('./index.html'))
                )
        );
        return;
    }

    // 4. 其他请求：走默认
});