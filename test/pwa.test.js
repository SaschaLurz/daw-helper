'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// The service worker's precache list, read straight from sw.js.
function precached() {
  const m = /const FILES = \[([\s\S]*?)\];/.exec(read('sw.js'));
  assert.ok(m, 'FILES list not found in sw.js');
  return Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1]);
}

// Every local file the page, the manifest and the worker load.
function loaded() {
  const html = read('index.html');
  const refs = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), (x) => x[1])
    .filter((ref) => !/^(data:|https?:|#)/.test(ref));
  const manifest = JSON.parse(read('manifest.webmanifest'));
  manifest.icons.forEach((icon) => refs.push(icon.src));
  const worker = /importScripts\(([^)]*)\)/.exec(read('analysis-worker.js'));
  Array.from(worker[1].matchAll(/'([^']+)'/g), (x) => refs.push(x[1]));
  refs.push('analysis-worker.js');       // started with new Worker() from app.js
  return Array.from(new Set(refs));
}

test('everything the app loads is precached for offline use', () => {
  const files = precached();
  const missing = loaded().filter((ref) => !files.includes(ref));
  assert.deepEqual(missing, []);
});

test('every precached file exists', () => {
  const absent = precached().filter((file) => file !== './' && !fs.existsSync(path.join(ROOT, file)));
  assert.deepEqual(absent, []);
});

test('the manifest has what browsers need to offer installation', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.display, 'standalone');
  const sizes = manifest.icons.filter((i) => i.type === 'image/png').map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
});
