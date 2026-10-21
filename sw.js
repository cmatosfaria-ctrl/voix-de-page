// Everything the app needs lives on the same origin, so one cache-first list covers it.
const VERSION = "vdp-1";
const FILES = [
  "./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/tesseract/tesseract.min.js", "vendor/tesseract/worker.min.js",
  "vendor/core/tesseract-core-lstm.wasm.js", "vendor/core/tesseract-core-simd-lstm.wasm.js",
  "lang/fra.traineddata.gz", "lang/deu.traineddata.gz", "lang/eng.traineddata.gz",
  "lang/spa.traineddata.gz", "lang/ita.traineddata.gz", "lang/por.traineddata.gz"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
    for (const c of await self.clients.matchAll()) c.postMessage("cached");
  })());
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request)));
});
