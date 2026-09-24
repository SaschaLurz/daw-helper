/*
 * sw.js — lets the app start without a network connection.
 *
 * Network first: while online every request goes to the server as usual, so
 * changes (and `npm start` during development) show up straight away, and each
 * response refreshes the cache. Offline, the cached copy is used.
 *
 * FILES must list everything the page loads; test/pwa.test.js checks that.
 */
'use strict';

const CACHE = 'daw-helper-v2';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'pitch.js',
  'tempo.js',
  'metronome.js',
  'analysis.js',
  'analysis-worker.js',
  'report.js',
  'recorder.js',
  'recorder-worklet.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    })
    .catch(() => caches.match(request, { ignoreSearch: true })
      .then((hit) => hit || (request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
