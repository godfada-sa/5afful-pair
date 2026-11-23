'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server');

const CREDS_A = {
  noiseKey: { type: 'Buffer', data: [1, 2, 3] },
  signedIdentityKey: { type: 'Buffer', data: [4, 5] },
  registrationId: 12345,
  advSecretKey: 'secret-a',
  me: { id: '27821234567:12@s.whatsapp.net', name: 'Owner' },
  platform: 'android',
  registered: true,
};

const CREDS_B = {
  registrationId: 67890,
  advSecretKey: 'secret-b',
  me: { id: '2348012345678:7@s.whatsapp.net', name: 'Second' },
  platform: 'android',
  registered: true,
};

async function start(connector, opts = {}) {
  const app = createServer({ connector, log: () => {}, ...opts });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    base,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

const linkedConnector = (creds, delayMs = 10) => async (job, h) => {
  h.onCode('ABCD-EFGH');
  setTimeout(() => {
    h.onLinking();
    h.onLinked(creds);
    h.onDm(false);
  }, delayMs);
  return { cancel() {} };
};

async function pair(base, body) {
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitLinked(base, id) {
  for (let i = 0; i < 100; i += 1) {
    const job = await (await fetch(`${base}/api/job/${id}`)).json();
    if (job.state === 'linked' || job.state === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the pairing job never finished');
}

test('a pairing code job turns into a session ID the bot can download', async () => {
  const site = await start(linkedConnector(CREDS_A));
  try {
    const created = await pair(site.base, { method: 'code', number: '27821234567' });
    assert.strictEqual(created.status, 200);
    assert.match(created.body.job, /^[A-Za-z0-9_-]{6,64}$/);

    const job = await waitLinked(site.base, created.body.job);
    assert.strictEqual(job.state, 'linked');
    assert.match(job.sessionId, /^TFX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(job.idSecondsLeft > 0 && job.idSecondsLeft <= 300);

    const first = await fetch(`${site.base}/api/session/${encodeURIComponent(job.sessionId)}`);
    const firstBody = await first.text();
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.strictEqual(first.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(JSON.parse(firstBody), CREDS_A);

    // the bot may legitimately ask twice: same answer, byte for byte
    const second = await fetch(`${site.base}/api/session/${job.sessionId}`);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(await second.text(), firstBody);
  } finally {
    await site.close();
  }
});

test('a hand-typed ID (lowercase, no dashes, no TFX) still works', async () => {
  const site = await start(linkedConnector(CREDS_A));
  try {
    const created = await pair(site.base, { method: 'code', number: '27821234567' });
    const job = await waitLinked(site.base, created.body.job);
    const sloppy = job.sessionId.replace(/^TFX-/, '').replace(/-/g, '').toLowerCase();

    const res = await fetch(`${site.base}/api/session/${encodeURIComponent(sloppy)}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).me.id, CREDS_A.me.id);
  } finally {
    await site.close();
  }
});

test('unknown and malformed IDs are 404, never 200 or a redirect', async () => {
  const site = await start(linkedConnector(CREDS_A));
  try {
    for (const id of ['TFX-UNKNOWN-0000-0000', 'not-an-id', 'TFX-AAAA-BBBB-CCCC']) {
      const res = await fetch(`${site.base}/api/session/${encodeURIComponent(id)}`, { redirect: 'manual' });
      assert.strictEqual(res.status, 404, id);
    }
  } finally {
    await site.close();
  }
});

test('after the TTL the creds are wiped and the ID is 404', async () => {
  const site = await start(linkedConnector(CREDS_A), { sessionTtlMs: 120 });
  try {
    const created = await pair(site.base, { method: 'code', number: '27821234567' });
    const job = await waitLinked(site.base, created.body.job);

    const fresh = await fetch(`${site.base}/api/session/${job.sessionId}`);
    assert.strictEqual(fresh.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 220));
    const stale = await fetch(`${site.base}/api/session/${job.sessionId}`);
    assert.strictEqual(stale.status, 404);
    assert.strictEqual(site.app.vault.size, 0);
  } finally {
    await site.close();
  }
});

test('two numbers pair at the same time and both logins download concurrently', async () => {
  let calls = 0;
  const connector = async (job, h) => {
    calls += 1;
    const creds = calls === 1 ? CREDS_A : CREDS_B;
    setTimeout(() => {
      h.onLinking();
      h.onLinked(creds);
      h.onDm(false);
    }, 10);
    return { cancel() {} };
  };
  const site = await start(connector);
  try {
    const one = await pair(site.base, { method: 'code', number: '27821234567' });
    const two = await pair(site.base, { method: 'code', number: '2348012345678' });
    const jobs = await Promise.all([waitLinked(site.base, one.body.job), waitLinked(site.base, two.body.job)]);
    assert.notStrictEqual(jobs[0].sessionId, jobs[1].sessionId);

    const [a, b] = await Promise.all([
      fetch(`${site.base}/api/session/${jobs[0].sessionId}`).then((r) => r.json()),
      fetch(`${site.base}/api/session/${jobs[1].sessionId}`).then((r) => r.json()),
    ]);
    assert.strictEqual(a.me.id, CREDS_A.me.id);
    assert.strictEqual(b.me.id, CREDS_B.me.id);
  } finally {
    await site.close();
  }
});

test('job control, validation and the pairing page', async () => {
  const site = await start(async (job, h) => {
    h.onCode('WXYZ-1234');
    return { cancel() {} };
  });
  try {
    const bad = await pair(site.base, { method: 'code', number: '123' });
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.body.error);

    const missing = await fetch(`${site.base}/api/job/does-not-exist`);
    assert.strictEqual(missing.status, 404);

    const created = await pair(site.base, { method: 'code', number: '27821234567' });
    const job = await (await fetch(`${site.base}/api/job/${created.body.job}`)).json();
    assert.strictEqual(job.state, 'code');
    assert.strictEqual(job.code, 'WXYZ-1234');

    const cancelled = await fetch(`${site.base}/api/cancel/${created.body.job}`, { method: 'POST' });
    assert.strictEqual(cancelled.status, 200);
    assert.strictEqual((await fetch(`${site.base}/api/job/${created.body.job}`)).status, 404);

    const health = await fetch(`${site.base}/healthz`);
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true });

    // the page's live badge reads these two
    const live = await (await fetch(`${site.base}/health`)).json();
    assert.strictEqual(live.ok, true);
    assert.strictEqual(live.sessionMinutes, 5);
    const status = await (await fetch(`${site.base}/api/status`)).json();
    assert.strictEqual(status.maintenance.on, false);

    const page = await fetch(`${site.base}/pair`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Pair WhatsApp/);

    const css = await fetch(`${site.base}/tf2-pair.css`);
    assert.strictEqual(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const logo = await fetch(`${site.base}/logo-f.png`);
    assert.strictEqual(logo.status, 200);
    assert.strictEqual(logo.headers.get('content-type'), 'image/png');
  } finally {
    await site.close();
  }
});
