'use strict';
// End-to-end over real HTTP, the way the page and the panel actually use it.
//
//   node tests/e2e.js
//
// Part 1 boots the real entry point (`node server.js`) as a child process and
// checks the pages and routes that need no WhatsApp connection.
// Part 2 boots the same server with a scripted connector and walks the whole
// two-number flow exactly like the browser: create -> poll -> download -> use.

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createServer } = require('../server');

const CREDS_A = {
  registrationId: 12345,
  advSecretKey: 'e2e-secret-a',
  me: { id: '27821234567:12@s.whatsapp.net', name: 'Owner' },
  platform: 'android',
  registered: true,
};
const CREDS_B = {
  registrationId: 67890,
  advSecretKey: 'e2e-secret-b',
  me: { id: '2348012345678:7@s.whatsapp.net', name: 'Second' },
  platform: 'android',
  registered: true,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (what) => console.log(`  ok ${++step}. ${what}`);

// ---------- part 1: the real process ----------
async function part1() {
  const port = 37000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  try {
    // wait for the listen line, not a fixed sleep
    for (let i = 0; i < 100 && !log.includes('pairing site on'); i += 1) await sleep(50);
    assert.ok(log.includes('pairing site on'), `the server never started:\n${log}`);

    const health = await fetch(`${base}/healthz`);
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true });
    ok('healthz answers on the real process');

    const page = await fetch(`${base}/`);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    for (const id of ['dsel', 'numwrap2', 'number2', 'sidlist', 'dl', 'dlwait', 'dlhint']) {
      assert.ok(html.includes(`id="${id}"`), `the served page has no #${id}`);
    }
    assert.ok(html.includes('1 number') && html.includes('2 numbers'), 'the 1/2 choice is on the page');
    ok('the served page carries the 1-or-2 choice, the ID list and the download');

    const css = await fetch(`${base}/tf2-pair.css`);
    assert.strictEqual(css.status, 200);
    const sheet = await css.text();
    assert.ok(sheet.includes('.dsel') && sheet.includes('a.cta') && sheet.includes('.sidlist'));
    ok('the new styles are served');

    const js = await fetch(`${base}/app.js`);
    assert.strictEqual(js.status, 200);
    assert.ok((await js.text()).includes('/api/batch/'), 'app.js polls the batch endpoint');
    ok('app.js is served with the batch polling');

    const noBundle = await fetch(`${base}/api/bundle/nosuchbatch/index.js`);
    assert.strictEqual(noBundle.status, 404);
    ok('an unknown bundle is 404, never a file');

    const bad = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'code', number: '12' }),
    });
    assert.strictEqual(bad.status, 400);
    ok('a short number is refused before any WhatsApp work');

    const same = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'code', number: '27821234567', number2: '27821234567', devices: 2 }),
    });
    assert.strictEqual(same.status, 400);
    assert.match((await same.json()).error, /same number/);
    ok('the same number twice is refused');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

// ---------- part 2: the whole two-number flow ----------
async function part2() {
  let calls = 0;
  const connector = async (job, h) => {
    calls += 1;
    const mine = calls;
    h.onCode(`E2E-${String(mine).padStart(4, '0')}`);
    setTimeout(() => {
      h.onLinking();
      h.onLinked(mine === 1 ? CREDS_A : CREDS_B);
      h.onDm(true);
    }, 30);
    return { cancel() {} };
  };

  const app = createServer({ connector, log: () => {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const getJson = async (url) => (await fetch(base + url)).json();

  try {
    const created = await (await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'code', number: '27821234567', number2: '2348012345678', devices: 2 }),
    })).json();
    assert.ok(created.batch && created.job);
    ok('two numbers create one batch');

    let status = null;
    for (let i = 0; i < 300; i += 1) {
      status = await getJson(`/api/batch/${created.batch}`);
      if (status.state === 'ready' || status.state === 'failed') break;
      await sleep(20);
    }
    assert.strictEqual(status.state, 'ready', `the batch ended as ${status.state}: ${status.error || ''}`);
    assert.strictEqual(status.sessionIds.length, 2);
    ok('both numbers linked and both IDs were handed out');

    // the countdown the page shows must be a full 5 minutes on BOTH ids
    assert.ok(status.idSecondsLeft > 240, `only ${status.idSecondsLeft}s left`);
    for (const id of status.sessionIds) {
      const s = await getJson(`/api/session/${id}`);
      assert.ok(s && s.me, 'the bot can still download the creds');
    }
    ok('both IDs are live at the same moment and the bot can download each');

    // the download: headers the browser needs to save it, body with both IDs
    const res = await fetch(base + status.bundle);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename="index.js"');
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const file = await res.text();
    ok('the bundle downloads as an attachment named index.js');

    assert.ok(file.startsWith('#!/usr/bin/env node'), 'still the bot bootstrap');
    assert.ok(file.includes(status.sessionIds[0]) && file.includes(status.sessionIds[1]));
    assert.ok(!file.includes('__5AFFUL_SESSION_IDS__'), 'the marker was replaced');
    assert.ok(file.includes("process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS = 'true'"));
    ok('the file carries both IDs in order and turns the notification guard on');

    // it must be a file Node will accept, and the SESSION_IDS block must read back
    const tmp = path.join(os.tmpdir(), `e2e-index-${Date.now()}.js`);
    fs.writeFileSync(tmp, file);
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    const block = file.match(/const SESSION_IDS = `\n([\s\S]*?)`;/);
    assert.ok(block, 'the SESSION_IDS block is intact');
    const inside = block[1].split('\n').map((l) => l.trim()).filter(Boolean);
    assert.deepStrictEqual(inside, status.sessionIds);
    fs.unlinkSync(tmp);
    ok('node --check accepts it and SESSION_IDS holds exactly the two IDs');

    // the older single-job endpoint still answers, for a page that has not reloaded
    const job = await getJson(`/api/job/${created.job}`);
    assert.strictEqual(job.state, 'linked');
    ok('the single-job endpoint still works for an old tab');

    // and one number on its own
    const single = await (await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'code', number: '27821234567', devices: 1 }),
    })).json();
    let one = null;
    for (let i = 0; i < 300; i += 1) {
      one = await getJson(`/api/batch/${single.batch}`);
      if (one.state === 'ready' || one.state === 'failed') break;
      await sleep(20);
    }
    assert.strictEqual(one.state, 'ready');
    assert.strictEqual(one.sessionIds.length, 1);
    const oneFile = await (await fetch(base + one.bundle)).text();
    const oneBlock = oneFile.match(/const SESSION_IDS = `\n([\s\S]*?)`;/);
    assert.ok(oneBlock, 'the SESSION_IDS block is intact');
    const oneInside = oneBlock[1].split('\n').map((l) => l.trim()).filter(Boolean);
    assert.deepStrictEqual(oneInside, one.sessionIds);
    ok('one number produces a file with exactly one ID');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
}

(async () => {
  console.log('part 1 — the real server process');
  await part1();
  console.log('part 2 — the two-number flow end to end');
  await part2();
  console.log(`\nE2E PASS (${step} checks)`);
})().catch((err) => {
  console.error(`\nE2E FAIL at check ${step + 1}: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
