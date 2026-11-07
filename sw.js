'use strict';

const CACHE_PREFIX = 'flourich-pos-';
const CACHE_NAME = 'flourich-pos-v99';
const APP_ROOT = new URL('./', self.registration.scope);
const APP_URL = APP_ROOT.href;
const APP_PATH = APP_ROOT.pathname;
const INDEX_PATH = new URL('index.html', APP_ROOT).pathname;
const STATIC_CACHE_URLS = [
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'flourich_logo.png'
].map((path) => new URL(path, APP_ROOT).href);
const QR_URL = new URL('qris-flourich.png', APP_ROOT).href;
const PRECACHE_URLS = [APP_URL, ...STATIC_CACHE_URLS, QR_URL];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response);
      } catch (error) {
        console.warn('[PWA] Precache dilewati:', url, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin ||
      url.searchParams.has('_v') ||
      !url.pathname.startsWith(APP_PATH)) return;

  const cacheFirstAsset = STATIC_CACHE_URLS.includes(url.href);
  if (cacheFirstAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url.href);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) await cache.put(url.href, response.clone());
      return response;
    })());
    return;
  }

  const isQr = url.href === QR_URL;
  const isAppNavigation = request.mode === 'navigate' &&
    (url.pathname === APP_PATH || url.pathname === INDEX_PATH);
  if (!isQr && !isAppNavigation) return;

  const cacheKey = isQr ? url.href : APP_URL;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response.ok) await cache.put(cacheKey, response.clone());
      return response;
    } catch (error) {
      const fallback = await cache.match(cacheKey);
      if (fallback) return fallback;
      return Response.error();
    }
  })());
});
