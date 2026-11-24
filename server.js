// Self-hosted pairing site.
//
//   POST /api/pair                { method: "code" | "qr", number, number2, devices }  -> { job, batch }
//   GET  /api/job/<job>          -> state, code, qr, secondsLeft, sessionId, idSecondsLeft, downloads...
//   GET  /api/batch/<batch>      -> every number in the attempt, and the session IDs once all are linked
//   POST /api/batch/<batch>/retry -> start the number that failed again (the linked ones are kept)
//   GET  /api/bundle/<batch>/index.js -> the installable index.js with the session IDs inside it
//   POST /api/cancel/<job|batch> -> { ok: true }
//   GET  /api/session/<ID>       -> the creds object itself, repeatedly, for 5 minutes
//   GET  /healthz                -> { ok: true }   (cheap, for uptime pings)
//
// The bot only calls /api/session/<ID>, from Node (server-to-server), so that
// handler is a map lookup plus JSON. Pairing work happens before an ID exists.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Vault, canonical } = require('./lib/vault');
const { PairingSite } = require('./lib/pairing');
const { Batcher } = require('./lib/batch');
const { renderIndex, FILENAME } = require('./lib/index-template');
const { whatsappConnector } = require('./lib/connector');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
};

const PAIR_LIMIT = 8; // pairing attempts per address...
const PAIR_WINDOW = 10 * 60 * 1000; // ...in ten minutes
const SESSION_LIMIT = 20; // session downloads per address per minute (retries included)
const SESSION_WINDOW = 60 * 1000;
const MAX_JOBS = 40;

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  const file = path.join(PUBLIC, name);
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream',
    'Cache-Control': name === 'index.html' ? 'no-store' : 'public, max-age=300',
  });
  res.end(data);
  return true;
}

// masks an ID for logs: enough to correlate, not enough to use
const mask = (id) => (id ? `${id.slice(0, 8)}…` : '-');

function createServer({ connector = whatsappConnector, log = console.log, sessionTtlMs = 5 * 60 * 1000 } = {}) {
  const vault = new Vault({ ttlMs: sessionTtlMs });
  const site = new PairingSite({ vault, connector, log });
  const batcher = new Batcher({ site, vault, log });
  const pairHits = new Map();
  const sessionHits = new Map();

  function limited(map, address, limit, windowMs) {
    const now = Date.now();
    const list = (map.get(address) || []).filter((at) => now - at < windowMs);
    if (list.length >= limit) {
      map.set(address, list);
      return true;
    }
    list.push(now);
    map.set(address, list);
    return false;
  }

  // keep the maps from growing without bound
  const janitor = setInterval(() => {
    const now = Date.now();
    for (const [key, list] of pairHits) {
      const kept = list.filter((at) => now - at < PAIR_WINDOW);
      if (kept.length) pairHits.set(key, kept);
      else pairHits.delete(key);
    }
    for (const [key, list] of sessionHits) {
      const kept = list.filter((at) => now - at < SESSION_WINDOW);
      if (kept.length) sessionHits.set(key, kept);
      else sessionHits.delete(key);
    }
    vault.sweep();
  }, 60 * 1000);
  janitor.unref?.();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const address = (req.socket && req.socket.remoteAddress) || 'unknown';

    try {
      if (pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/health') {
        // the page reads this to say how long a session ID lasts
        return sendJson(res, 200, { ok: true, sessionMinutes: Math.round(vault.ttlMs / 60000) });
      }
      if (pathname === '/api/status') {
        // the page's live badge: no maintenance mode, no announcement
        return sendJson(res, 200, { maintenance: { on: false, message: '' }, announcement: null });
      }

      if (pathname === '/api/pair' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (err) {
          return sendJson(res, 400, { error: 'Send a JSON body.' });
        }
        const method = body.method === 'qr' ? 'qr' : 'code';
        const devices = body.devices === 2 || body.devices === '2' ? 2 : 1;
        const number = String(body.number || '').replace(/\D/g, '');
        const number2 = String(body.number2 || '').replace(/\D/g, '');
        if (method === 'code' && !/^\d{8,15}$/.test(number)) {
          return sendJson(res, 400, { error: 'Enter the number with its country code, digits only (8 to 15 digits).' });
        }
        if (devices === 2 && method === 'code' && !/^\d{8,15}$/.test(number2)) {
          return sendJson(res, 400, { error: 'Enter the second number with its country code, digits only (8 to 15 digits).' });
        }
        if (devices === 2 && number2 && number2 === number) {
          return sendJson(res, 400, { error: 'That is the same number twice. Use a different number for the second one.' });
        }
        if (site.jobs.size + batcher.size >= MAX_JOBS) {
          return sendJson(res, 503, { error: 'The site is busy. Wait a minute and try again.' });
        }
        if (limited(pairHits, address, PAIR_LIMIT, PAIR_WINDOW)) {
          return sendJson(res, 429, { error: 'Too many attempts from this connection. Wait a few minutes.' });
        }
        const numbers = devices === 2 ? [number, number2] : [number];
        const batch = await batcher.create({ method, numbers, devices });
        const first = batch.slots[0];
        return sendJson(res, 200, {
          job: first && first.jobId ? first.jobId : null,
          batch: batch.id,
          devices,
        });
      }

      const jobMatch = pathname.match(/^\/api\/job\/([A-Za-z0-9_-]{4,64})$/);
      if (jobMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const job = site.get(jobMatch[1]);
        if (!job) return sendJson(res, 404, {});
        return sendJson(res, 200, site.status(job));
      }

      // every number of one attempt, in order, plus the IDs once they are all linked
      const batchMatch = pathname.match(/^\/api\/batch\/([A-Za-z0-9_-]{4,64})(\/retry)?$/);
      if (batchMatch && !batchMatch[2] && (req.method === 'GET' || req.method === 'HEAD')) {
        const status = batcher.status(batchMatch[1]);
        if (!status) return sendJson(res, 404, {});
        return sendJson(res, 200, status);
      }
      if (batchMatch && batchMatch[2] && req.method === 'POST') {
        const status = await batcher.retry(batchMatch[1]);
        if (!status) return sendJson(res, 404, {});
        return sendJson(res, 200, status);
      }

      // the installable file: the bot's own index.js with the session IDs inside
      const bundleMatch = pathname.match(/^\/api\/bundle\/([A-Za-z0-9_-]{4,64})\/index\.js$/);
      if (bundleMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        if (limited(sessionHits, address, SESSION_LIMIT, SESSION_WINDOW)) {
          return sendJson(res, 429, { error: 'Too many requests. Try again shortly.' });
        }
        const batch = batcher.get(bundleMatch[1]);
        const ready = batch ? batch.bundle() : null;
        if (!ready) return sendJson(res, 404, { error: 'link the number(s) first: there is no index.js for that attempt yet' });
        let body = '';
        try {
          body = renderIndex({ ids: ready.ids });
        } catch (err) {
          log(`[pair] bundle error: ${err.message}`);
          return sendJson(res, 500, { error: 'The file could not be built. Link the number again.' });
        }
        log(`[pair] index.js downloaded (${ready.ids.length} ID${ready.ids.length === 1 ? '' : 's'})`);
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Disposition': `attachment; filename="${FILENAME}"`,
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(body);
      }

      const cancelMatch = pathname.match(/^\/api\/cancel\/([A-Za-z0-9_-]{4,64})$/);
      if (cancelMatch && req.method === 'POST') {
        if (!site.cancel(cancelMatch[1])) batcher.cancel(cancelMatch[1]);
        return sendJson(res, 200, { ok: true });
      }

      // the one endpoint the bot calls
      const sessionMatch = pathname.match(/^\/api\/session\/(.+)$/);
      if (sessionMatch) {
        if (limited(sessionHits, address, SESSION_LIMIT, SESSION_WINDOW)) {
          return sendJson(res, 429, { error: 'Too many requests. Try again shortly.' });
        }
        let raw = '';
        try {
          raw = decodeURIComponent(sessionMatch[1]);
        } catch (err) {
          raw = '';
        }
        // canonical() handles lowercase, missing dashes and a missing or old prefix
        const got = vault.read(raw);
        if (got.status !== 200) return sendJson(res, 404, { error: 'unknown or expired session ID' });
        log(`[pair] session downloaded (${mask(got.id)})`);
        return sendJson(res, 200, got.creds);
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        // the boot page and its asset URLs come from the original pair page
        if (pathname === '/pair' || pathname === '/pair/') {
          if (serveStatic(res, '/index.html')) return undefined;
        }
        if (serveStatic(res, pathname)) return undefined;
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      log(`[pair] request error: ${err.message}`);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: 'The site could not handle that. Try again.' });
      return undefined;
    }
  });

  server.on('close', () => {
    clearInterval(janitor);
    batcher.stop();
    site.stop();
  });
  return { server, site, vault, batcher };
}

// exposed for the brief's acceptance check: unknown/malformed IDs are 404, not 400
function isSessionId(value) {
  return !!canonical(value);
}

if (require.main === module) {
  // PORT=0 means "any free port" to Node, which is never what someone wants here
  const wanted = Number(process.env.PORT);
  const port = Number.isInteger(wanted) && wanted > 0 ? wanted : 3000;
  const host = process.env.HOST || '0.0.0.0';
  const { server } = createServer();
  server.listen(port, host, () => {
    console.log(`5AFFUL pairing site on http://localhost:${port}`);
    console.log('Pair a number, then point the bot at this address with PAIR_SITE_URL.');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, isSessionId };
