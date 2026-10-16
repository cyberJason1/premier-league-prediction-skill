// ============================================================
// 英超预测引擎 Service Worker · v13.1.0
// ============================================================
// 缓存策略总览：
//   1. Groq / football-data API    → 完全不缓存（每次实时）
//   2. Google Fonts                → cache-first（字体不变，离线可用）
//   3. 队徽 / 球员照片 CDN          → stale-while-revalidate
//   4. 同源静态文件（HTML/JSON/MD）  → network-first + 缓存回退
// ============================================================

const CACHE_VERSION = 'v13.1.0';
const CACHE_NAME = `pl-cache-${CACHE_VERSION}`;

// App Shell：首次安装时预缓存
const APP_SHELL = [
    './',
    './index.html',
    './skill.md',
    './data.json',
    './about.html'
];

// ---------- 安装：预缓存 App Shell ----------
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                // 逐个 add，避免单个文件失败导致整体失败
                return Promise.allSettled(
                    APP_SHELL.map(url => cache.add(url).catch(() => null))
                );
            })
    );
    // 不自动 skipWaiting，等用户点击"刷新"再激活
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

    // ============================================================
    // 1. API 请求：完全不缓存（Groq、football-data）
    //    预测结果必须实时，缓存会造成数据陈旧
    // ============================================================
    if (url.hostname.includes('groq.com') ||
        url.hostname.includes('football-data.org')) {
        return; // 走默认网络请求
    }

    // ============================================================
    // 2. Google Fonts：cache-first
    //    字体文件 URL 带 hash，内容永不改变 → 命中率极高
    //    离线时直接从缓存返回，避免中文回退成方块
    // ============================================================
    if (url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com')) {
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

    // ============================================================
    // 3. 队徽/球员照片 CDN：stale-while-revalidate
    //    先返回缓存（秒出），后台静默更新
    // ============================================================
    if (url.hostname.includes('espncdn.com') ||
        url.hostname.includes('thesportsdb.com') ||
        url.hostname.includes('r2.thesportsdb.com') ||
        url.hostname.includes('bzzoiro.com')) {
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

    // ============================================================
    // 4. 同源静态文件（index.html、about.html、skill.md、data.json）
    //    network-first：优先拿最新，失败才用缓存
    //    同时清理同路径带 ?v= 的旧缓存，避免无限增长
    // ============================================================
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(async cache => {
                            try {
                                // 先删除同路径的其他缓存（忽略 query 参数）
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
                            } catch(e) { /* 忽略清理错误 */ }
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

    // ============================================================
    // 5. 其他请求：走默认网络
    // ============================================================
});