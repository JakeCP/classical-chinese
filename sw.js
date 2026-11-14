// Service worker: precache the shell and all data, serve cache-first.
// The data build rewrites the VERSION line with a content hash; that byte
// change is what makes phones install a new worker and pick up new content.
const VERSION = "ea977259cad1";
const CACHE = "analects-reader-" + VERSION;
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "style.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "version.json",
  "data/books.json",
  "data/chars.json",
  "data/modern-words.json",
];

// Bypass the HTTP cache so a new worker never precaches stale files.
const fresh = (url) => new Request(url, { cache: "reload" });

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL.map(fresh));
  const res = await cache.match("data/books.json");
  const { books } = await res.json();
  await cache.addAll(books.map((b) => fresh(b.file)));
}

self.addEventListener("install", (event) => {
  // No skipWaiting here: the page asks for it when the reader taps "Update ready".
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("analects-reader-") && k !== CACHE)
          .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(respond(req));
});

async function respond(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  if (req.mode === "navigate") {
    const shell = await cache.match("index.html");
    if (shell) return shell;
  }
  return fetch(req);
}
