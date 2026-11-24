'use strict';

// One person, one or two numbers: the batch, the sequencing and the bundle.

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server');

const CREDS_A = {
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
  return { app, base, close: () => new Promise((resolve) => app.server.close(resolve)) };
}

async function post(base, body) {
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const getJson = async (url) => (await fetch(url)).json();

async function waitState(base, id, wanted, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    const b = await getJson(`${base}/api/batch/${id}`);
    if (wanted.includes(b.state)) return b;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the batch never reached ${wanted.join(' / ')}`);
}

// links the numbers in the order they are started
function sequentialConnector(delayMs = 40) {
  let calls = 0;
  return async (job, h) => {
    calls += 1;
    const mine = calls;
    h.onCode(`CODE-000${mine}`);
    setTimeout(() => {
      h.onLinking();
      h.onLinked(mine === 1 ? CREDS_A : CREDS_B);
      h.onDm(mine === 1);
    }, delayMs);
    return { cancel() {} };
  };
}

test('one number: the finished bundle carries that session ID', async () => {
  const site = await start(sequentialConnector(15));
  try {
    const created = await post(site.base, { method: 'code', number: '27821234567', devices: 1 });
    assert.strictEqual(created.status, 200);
    assert.match(created.body.batch, /^[A-Za-z0-9_-]{6,64}$/);
    assert.match(created.body.job, /^[A-Za-z0-9_-]{6,64}$/);

    const done = await waitState(site.base, created.body.batch, ['ready']);
    assert.strictEqual(done.devices, 1);
    assert.strictEqual(done.slots.length, 1);
    assert.strictEqual(done.sessionIds.length, 1);
    assert.match(done.sessionIds[0], /^5AFFUL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(done.idSecondsLeft > 0 && done.idSecondsLeft <= 300);
    assert.strictEqual(done.bundle, `/api/bundle/${created.body.batch}/index.js`);

    const res = await fetch(site.base + done.bundle);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename="index.js"');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.ok(body.includes(done.sessionIds[0]), 'the ID is inside the file');
    assert.ok(!body.includes('__5AFFUL_SESSION_IDS__'), 'the marker is gone');
  } finally {
    await site.close();
  }
});

test('two numbers: the second starts when the first links, and the bundle has both', async () => {
  const order = [];
  let calls = 0;
  const connector = async (job, h) => {
    calls += 1;
    const mine = calls;
    order.push(`start-${mine}`);
    h.onCode(`CODE-000${mine}`);
    setTimeout(() => {
      order.push(`link-${mine}`);
      h.onLinking();
      h.onLinked(mine === 1 ? CREDS_A : CREDS_B);
      h.onDm(true);
    }, 60);
    return { cancel() {} };
  };
  const site = await start(connector);
  try {
    const created = await post(site.base, {
      method: 'code',
      number: '27821234567',
      number2: '2348012345678',
      devices: 2,
    });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.devices, 2);

    // while the first number waits, the second has not been touched
    const first = await getJson(`${site.base}/api/batch/${created.body.batch}`);
    assert.strictEqual(first.devices, 2);
    assert.strictEqual(first.slots.length, 2);
    assert.strictEqual(first.slots[1].state, 'queued');
    assert.deepStrictEqual(first.sessionIds, []);

    const done = await waitState(site.base, created.body.batch, ['ready']);
    assert.strictEqual(done.sessionIds.length, 2);
    assert.notStrictEqual(done.sessionIds[0], done.sessionIds[1]);
    assert.deepStrictEqual(order.slice(0, 4), ['start-1', 'link-1', 'start-2', 'link-2']);

    // both IDs are live at the same moment: the first one is not already expiring
    for (const id of done.sessionIds) {
      const res = await fetch(`${site.base}/api/session/${id}`);
      assert.strictEqual(res.status, 200);
    }

    const body = await (await fetch(site.base + done.bundle)).text();
    assert.ok(body.includes(done.sessionIds[0]));
    assert.ok(body.includes(done.sessionIds[1]));
    assert.ok(body.indexOf(done.sessionIds[0]) < body.indexOf(done.sessionIds[1]), 'main bot first');

    // the single-job endpoint the older page used still answers for number 1
    const job = await getJson(`${site.base}/api/job/${created.body.job}`);
    assert.strictEqual(job.state, 'linked');
    assert.match(job.sessionId, /^5AFFUL-/);
  } finally {
    await site.close();
  }
});

test('the bundle is 404 until every number is linked', async () => {
  const site = await start(async (job, h) => {
    h.onCode('WAIT-0001');
    return { cancel() {} };
  });
  try {
    const created = await post(site.base, { method: 'code', number: '27821234567', devices: 1 });
    const res = await fetch(`${site.base}/api/bundle/${created.body.batch}/index.js`);
    assert.strictEqual(res.status, 404);

    const unknown = await fetch(`${site.base}/api/bundle/nosuchbatch/index.js`);
    assert.strictEqual(unknown.status, 404);
    const noBatch = await fetch(`${site.base}/api/batch/nosuchbatch`);
    assert.strictEqual(noBatch.status, 404);
  } finally {
    await site.close();
  }
});

test('a failed second number is retried alone: the first stays linked', async () => {
  let calls = 0;
  const connector = async (job, h) => {
    calls += 1;
    const mine = calls;
    setTimeout(() => {
      if (mine === 2) return h.onError('WhatsApp refused this attempt.');
      h.onLinking();
      h.onLinked(mine === 1 ? CREDS_A : CREDS_B);
      h.onDm(false);
    }, 20);
    return { cancel() {} };
  };
  const site = await start(connector);
  try {
    const created = await post(site.base, {
      method: 'code',
      number: '27821234567',
      number2: '2348012345678',
      devices: 2,
    });
    const failed = await waitState(site.base, created.body.batch, ['failed']);
    assert.strictEqual(failed.failedSlot, 1);
    assert.strictEqual(failed.slots[0].state, 'linked');
    assert.match(failed.error, /Number 2/);

    const again = await fetch(`${site.base}/api/batch/${created.body.batch}/retry`, { method: 'POST' });
    assert.strictEqual(again.status, 200);

    const done = await waitState(site.base, created.body.batch, ['ready']);
    assert.strictEqual(done.sessionIds.length, 2);
    assert.strictEqual(calls, 3, 'number 1 was never started again');
  } finally {
    await site.close();
  }
});

test('two numbers need two different valid numbers', async () => {
  const site = await start(sequentialConnector(15));
  try {
    const short = await post(site.base, { method: 'code', number: '27821234567', number2: '123', devices: 2 });
    assert.strictEqual(short.status, 400);
    assert.match(short.body.error, /second number/);

    const missing = await post(site.base, { method: 'code', number: '27821234567', devices: 2 });
    assert.strictEqual(missing.status, 400);

    const same = await post(site.base, {
      method: 'code',
      number: '27821234567',
      number2: '27821234567',
      devices: 2,
    });
    assert.strictEqual(same.status, 400);
    assert.match(same.body.error, /same number/);

    // a QR code needs no number at all, so two QRs are allowed
    const qr = await post(site.base, { method: 'qr', devices: 2 });
    assert.strictEqual(qr.status, 200);
    assert.strictEqual(qr.body.devices, 2);
  } finally {
    await site.close();
  }
});

test('cancelling a batch stops every attempt it started', async () => {
  let cancelled = 0;
  const site = await start(async (job, h) => {
    h.onCode('STOP-0001');
    return { cancel() { cancelled += 1; } };
  });
  try {
    const created = await post(site.base, { method: 'code', number: '27821234567', devices: 1 });
    const res = await fetch(`${site.base}/api/cancel/${created.body.batch}`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.ok(cancelled >= 1);
    const gone = await fetch(`${site.base}/api/batch/${created.body.batch}`);
    assert.strictEqual(gone.status, 404);
  } finally {
    await site.close();
  }
});
