#!/usr/bin/env node
'use strict';

// Read-only offline lab: loopback binding, explicit static allowlist, no APIs or account data.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const ENTRY = '/experiments/long-neural/index.html';
const FILES = Object.freeze({
  [ENTRY]: { file: 'experiments/long-neural/index.html', type: 'text/html; charset=utf-8' },
  '/experiments/long-neural/demo.js': { file: 'experiments/long-neural/demo.js', type: 'text/javascript; charset=utf-8' },
  '/experiments/long-neural/demo.css': { file: 'experiments/long-neural/demo.css', type: 'text/css; charset=utf-8' },
  '/game.js': { file: 'game.js', type: 'text/javascript; charset=utf-8' },
  '/lib/long-bot-neural.js': { file: 'lib/long-bot-neural.js', type: 'text/javascript; charset=utf-8' },
});
const HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
});

function requestHandler(request, response) {
  const send = (status, text, headers = {}) => {
    response.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    response.end(request.method === 'HEAD' ? undefined : text);
  };
  if (!['GET', 'HEAD'].includes(request.method)) { send(405, 'Method not allowed', { Allow: 'GET, HEAD' }); return; }
  let pathname;
  try { pathname = new URL(request.url, 'http://127.0.0.1').pathname; }
  catch { send(400, 'Invalid path'); return; }
  if (pathname === '/') { send(302, 'Offline neural laboratory', { Location: ENTRY }); return; }
  if (!Object.hasOwn(FILES, pathname)) { send(404, 'Not found'); return; }
  const entry = FILES[pathname];
  // The path comes only from FILES, never from the request or an uploaded model.
  fs.readFile(path.join(ROOT, entry.file), (error, bytes) => {
    if (error) { send(503, 'Offline laboratory file unavailable'); return; }
    response.writeHead(200, { ...HEADERS, 'Content-Type': entry.type, 'Content-Length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
}

function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length === 0) return { port: 3909 };
  if (argv.length !== 2 || argv[0] !== '--port' || !/^[0-9]{1,5}$/.test(argv[1])) {
    throw new Error('Usage: node scripts/serve-long-bot-neural-demo.js [--port 3909]');
  }
  const port = Number(argv[1]);
  if (port < 1 || port > 65535) throw new Error('Port must be from 1 to 65535');
  return { port };
}

function createDemoServer() { return http.createServer(requestHandler); }
function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log('Offline neural laboratory: node scripts/serve-long-bot-neural-demo.js [--port 3909]');
    return null;
  }
  const server = createDemoServer();
  server.on('error', error => { console.error(`Offline laboratory server: ${error.code || 'start failed'}`); process.exitCode = 2; });
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`Offline long neural laboratory: http://127.0.0.1:${options.port}${ENTRY}`);
    console.log('Only five public laboratory files are served; models stay in your browser.');
  });
  return server;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
module.exports = { FILES, HEADERS, ENTRY, requestHandler, parseOptions, createDemoServer, main };
