/* ============================================================================
   sw.js — service worker
   ----------------------------------------------------------------------------
   Kept deliberately small and conservative:
     - Only caches this app's OWN static files (HTML/CSS/JS/icons/map image),
       so the app shell loads instantly and still opens if the network is
       briefly unavailable.
     - Never touches Supabase (Auth/Postgres/Storage/Realtime) requests, live
       GPS, or anything cross-origin — those need to always hit the real
       network so login, the live map, comments, and likes stay correct and
       real-time. (A service worker that "helpfully" cached an API response
       would silently show stale classmates/positions — worse than no cache.)
   ========================================================================== */

// Bump this string every time ANY file in APP_SHELL changes content —
// that's what makes the browser treat the worker as updated and refetch
// everything into a fresh cache. Only a byte-for-byte change to THIS FILE
// triggers that check, so a change to (say) app.js alone is invisible to
// the update mechanism unless this version string also changes.
const CACHE_NAME = "campus-connect-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/constants.js",
  "./js/config.js",
  "./js/profanity.js",
  "./js/store.supabase.js",
  "./js/geo.js",
  "./js/app.js",
  "./manifest.json",
  "./assets/campus-map.jpg",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  // js/supabase-config.js is deliberately NOT precached (see fetch handler
  // below) — it holds the anon key, and a stale cached copy after a key
  // rotation caused silent 401s on every Supabase Auth call.
];
const NEVER_CACHE = ["./js/supabase-config.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only ever handle our own same-origin, GET requests. Everything else
  // (Supabase, Google Fonts, OAuth redirects, POST/PUT calls) goes
  // straight to the network, untouched.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Config file: always go to the network first so a rotated/changed anon
  // key is picked up on the very next load, not "whenever the cache
  // happens to get busted." Cache is only a last-resort offline fallback.
  if (NEVER_CACHE.some((p) => url.pathname.endsWith(p.replace("./", "/")))) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached); // offline — fall back to whatever's cached
      return cached || network;
    })
  );
});
