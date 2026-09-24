#!/usr/bin/env node
/*
 * serve.js — serves the tuner on http://localhost and opens it in the browser.
 * No dependencies. Browsers only allow audio-input access from a secure
 * context, and localhost counts as one.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4321;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) {
    port += 1; // that port is taken (maybe another tuner) — try the next one
    server.listen(port, '127.0.0.1');
    return;
  }
  throw err;
});
server.on('listening', () => {
  const url = `http://localhost:${port}/`;
  console.log(`Tuner running at ${url}  (Ctrl+C to quit)`);
  if (!process.argv.includes('--no-open')) openBrowser(url);
});
server.listen(port, '127.0.0.1');

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
