// Pairing jobs: one job = one attempt to link a number.
//
// states: starting -> code | qr -> linking -> linked | failed
// The page polls /api/job/<id> and reads exactly the fields below.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ATTEMPT_MS = 4 * 60 * 1000; // how long a code/QR stays usable
const KEEP_LINKED_MS = 15 * 60 * 1000; // keep a finished job so the page can still poll it

class PairingSite {
  constructor({ vault, connector, log = console.log, attemptMs = ATTEMPT_MS }) {
    this.vault = vault;
    this.connector = connector;
    this.log = log;
    this.attemptMs = attemptMs;
    this.jobs = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref?.();
  }

  async start({ method, number }) {
    const id = crypto.randomBytes(9).toString('base64url');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfx-pair-'));
    const job = {
      id,
      method: method === 'qr' ? 'qr' : 'code',
      number: String(number || '').replace(/\D/g, ''),
      state: 'starting',
      code: null,
      qr: null,
      note: null,
      error: null,
      sessionId: null,
      sessionExpiresAt: 0,
      dm: null,
      dir,
      handle: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.attemptMs,
      timer: null,
    };
    this.jobs.set(id, job);
    job.timer = setTimeout(() => {
      if (job.state !== 'linked') this.fail(job, 'This attempt expired. Press Try again to get a new one.');
    }, this.attemptMs);
    job.timer.unref?.();

    try {
      job.handle = await this.connector(job, this.handlers(job));
    } catch (err) {
      this.fail(job, err && err.message ? err.message : 'Could not start pairing.');
    }
    return job;
  }

  handlers(job) {
    return {
      onCode: (code) => {
        if (job.state === 'linked' || job.state === 'linking') return;
        job.code = code;
        job.state = 'code';
      },
      onQr: (dataUrl) => {
        if (job.state === 'linked' || job.state === 'linking') return;
        job.qr = dataUrl;
        job.state = 'qr';
      },
      onNote: (note) => {
        job.note = note;
      },
      onLinking: () => {
        if (job.state === 'linked') return;
        job.state = 'linking';
        job.code = null;
        job.qr = null;
        clearTimeout(job.timer);
      },
      onLinked: (creds) => {
        if (job.state === 'linked') return job.sessionId;
        const { id, expiresAt } = this.vault.put(creds);
        job.sessionId = id;
        job.sessionExpiresAt = expiresAt;
        job.state = 'linked';
        job.code = null;
        job.qr = null;
        clearTimeout(job.timer);
        job.timer = setTimeout(() => this.jobs.delete(job.id), KEEP_LINKED_MS);
        job.timer.unref?.();
        this.log(`[pair] linked ${creds && creds.me ? creds.me.id : 'a number'} -> ${id}`);
        return id;
      },
      onDm: (ok) => {
        job.dm = !!ok;
      },
      onError: (message) => this.fail(job, message),
    };
  }

  fail(job, message) {
    if (job.state === 'linked') return;
    job.state = 'failed';
    job.error = message || 'Something went wrong. Press Try again.';
    job.code = null;
    job.qr = null;
    clearTimeout(job.timer);
    try {
      if (job.handle) job.handle.cancel();
    } catch (err) {
      // already closed
    }
    job.handle = null;
    this.cleanupDir(job);
    job.timer = setTimeout(() => this.jobs.delete(job.id), 2 * 60 * 1000);
    job.timer.unref?.();
    this.log(`[pair] failed: ${job.error}`);
  }

  get(id) {
    return this.jobs.get(String(id || '')) || null;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return false;
    try {
      if (job.handle) job.handle.cancel();
    } catch (err) {
      // already closed
    }
    job.handle = null;
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    this.cleanupDir(job);
    return true;
  }

  // exactly the shape the pairing page and the bot's own client expect
  status(job) {
    const now = Date.now();
    const out = { state: job.state };
    if (job.code) out.code = job.code;
    if (job.qr) out.qr = job.qr;
    if (job.note) out.note = job.note;

    if (job.state === 'starting' || job.state === 'code' || job.state === 'qr' || job.state === 'linking') {
      out.secondsLeft = Math.max(0, Math.ceil((job.expiresAt - now) / 1000));
    }

    if (job.state === 'linked') {
      const st = this.vault.status(job.sessionId);
      out.sessionId = job.sessionId;
      out.idSecondsLeft = st.secondsLeft;
      out.downloads = st.downloads;
      out.expired = !st.exists || st.expired;
      out.dm = job.dm;
    } else if (job.state === 'failed') {
      out.error = job.error;
    }
    return out;
  }

  cleanupDir(job) {
    if (!job.dir) return;
    try {
      fs.rmSync(job.dir, { recursive: true, force: true });
    } catch (err) {
      // Windows may still hold a file for a moment
    }
    job.dir = null;
  }

  sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const done = job.state === 'linked' || job.state === 'failed';
      if (done && now - job.createdAt > KEEP_LINKED_MS + 5 * 60 * 1000) this.jobs.delete(id);
    }
    this.vault.sweep();
  }

  stop() {
    clearInterval(this.sweeper);
    for (const id of [...this.jobs.keys()]) this.cancel(id);
    this.vault.clear(); // never keep creds past shutdown
  }
}

module.exports = { PairingSite };
