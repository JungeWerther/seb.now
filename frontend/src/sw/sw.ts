// seb.now's service worker, compiled by tsc (src/sw/tsconfig.json, WebWorker
// lib) to src/seb_now/templates/sw.js, which seb_now.pwa fills and writes to
// dist/sw.js. It only makes the site installable and readable offline; the
// page never depends on it.
//
// What it handles, by request:
// - a navigation to one of the page's own routes (APP_ROUTE_PREFIXES): the
//   network first, the last page it fetched when offline. Every route is the
//   same catch-all document, so one copy (keyed SHELL_PATH) serves them all.
// - a precached file (the icons and manifest) or a pinned cross-origin file
//   (supabase-js, whose SRI hash pins its bytes): the cache first.
// - a font from a STALE_ORIGINS origin: the cache, refreshed behind it.
// Everything else (Supabase's API, covers, favicons, posts, the OAuth consent
// and connect pages, the MCP and ActivityPub routes) passes straight through.
// The cache is named by the build's version, so a deploy drops the old one.

// The WebWorker lib types `self` as any worker; this one is a service worker.
const worker = self as unknown as ServiceWorkerGlobalScope;

// Filled by seb_now.pwa at build time, as JSON literals.
declare const __SW_VERSION__: string;
declare const __SW_APP_ROUTE_PREFIXES__: readonly string[];
declare const __SW_PRECACHE__: readonly string[];
declare const __SW_PINNED__: readonly string[];
declare const __SW_STALE_ORIGINS__: readonly string[];

const CACHE_PREFIX = "seb-now-";
const CACHE_NAME = `${CACHE_PREFIX}${__SW_VERSION__}`;
const SHELL_PATH = "/";
const APP_ROUTE_PREFIXES = __SW_APP_ROUTE_PREFIXES__;
const PRECACHE = new Set(__SW_PRECACHE__);
const PINNED = new Set(__SW_PINNED__);
const STALE_ORIGINS = new Set(__SW_STALE_ORIGINS__);
const GET = "GET";
const NAVIGATE = "navigate";
const OFFLINE = new Response(null, { status: 503, statusText: "Offline" });

type Strategy = (request: Request) => Promise<Response>;

const isAppRoute = (url: URL): boolean =>
  url.origin === worker.location.origin
  && (url.pathname === SHELL_PATH || APP_ROUTE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)));

const store = async (key: RequestInfo, response: Response): Promise<Response> => {
  if (response.ok) await (await caches.open(CACHE_NAME)).put(key, response.clone());
  return response;
};

const cached = async (key: RequestInfo): Promise<Response | undefined> =>
  (await caches.open(CACHE_NAME)).match(key);

const networkFirstShell: Strategy = async (request) => {
  try {
    return await store(SHELL_PATH, await fetch(request));
  } catch {
    return (await cached(SHELL_PATH)) ?? OFFLINE.clone();
  }
};

const cacheFirst: Strategy = async (request) =>
  (await cached(request)) ?? store(request, await fetch(request));

const staleWhileRevalidate: Strategy = async (request) => {
  const refreshed = fetch(request).then((response) => store(request, response));
  const hit = await cached(request);
  if (hit === undefined) return refreshed;
  refreshed.catch(() => undefined);
  return hit;
};

// Which strategy a request gets, first match wins; none means the browser's own.
const strategyByRequest: readonly (readonly [(request: Request, url: URL) => boolean, Strategy])[] = [
  [(request, url) => request.mode === NAVIGATE && isAppRoute(url), networkFirstShell],
  [(_, url) => url.origin === worker.location.origin && PRECACHE.has(url.pathname), cacheFirst],
  [(_, url) => PINNED.has(url.href), cacheFirst],
  [(_, url) => STALE_ORIGINS.has(url.origin), staleWhileRevalidate],
];

worker.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([SHELL_PATH, ...PRECACHE]))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
      ))
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== GET) return;
  const url = new URL(request.url);
  const strategy = strategyByRequest.find(([applies]) => applies(request, url))?.[1];
  if (strategy !== undefined) event.respondWith(strategy(request));
});
