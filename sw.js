const SHELL_CACHE = "investment-helper-shell-v9";
const DATA_CACHE = "investment-helper-data-v3";
const shell = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/app-icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(shell)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => ![SHELL_CACHE, DATA_CACHE].includes(key)).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/data/status.enc.json")) {
    if (url.searchParams.has("fresh")) {
      event.respondWith(fetch(event.request, { cache: "no-store" }));
      return;
    }
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put("./data/status.enc.json", copy));
          }
          return response;
        })
        .catch(() => caches.open(DATA_CACHE).then((cache) => cache.match("./data/status.enc.json"))),
    );
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          if (response.ok && event.request.method === "GET") {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }
  event.respondWith(fetch(event.request));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_error) {
    data = { title: "투자 가격 알림", body: event.data ? event.data.text() : "새 알림이 있습니다." };
  }
  event.waitUntil(self.registration.showNotification(data.title || "투자 가격 알림", {
    body: data.body || "앱에서 내용을 확인하세요.",
    icon: "./icons/app-icon.svg",
    badge: "./icons/app-icon.svg",
    tag: data.tag || "investment-price-watch",
    renotify: false,
    data: { url: data.url || "./", order_allowed: false },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        if ("navigate" in client) client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
