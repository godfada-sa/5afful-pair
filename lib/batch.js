// A pairing batch: one person, one or two numbers.
//
// The numbers are paired one after the other. Slot 0 gets its code/QR first;
// the moment it links, slot 1 starts. That order matters: a person can only
// hold one phone at a time, and a pairing code that sits unused for four
// minutes is a code that expires.
//
// The session IDs are handed out at the END, in one go. A first number linked
// four minutes ago would have one minute left on its ID, and the index.js
// bundle would carry an ID that is already dying. So the batch keeps the
// creds of every slot and calls vault.put() for all of them at the same
// moment: one bundle, two IDs, a full five minutes on both.
'use strict';

const crypto = require('crypto');

const KEEP_MS = 30 * 60 * 1000; // a finished batch stays readable this long (the IDs die at 5 min)
const MAX_SLOTS = 2;

class Batch {
  constructor({ site, vault, log = console.log, method, numbers, devices }) {
    this.site = site;
    this.vault = vault;
    this.log = log;
    this.id = crypto.randomBytes(9).toString('base64url');
    this.method = method === 'qr' ? 'qr' : 'code';
    this.devices = devices === 2 ? 2 : 1;
    this.numbers = numbers.slice(0, MAX_SLOTS);
    this.slots = this.numbers.map((number, index) => ({
      index,
      number,
      jobId: null,
      state: 'queued',
      code: null,
      qr: null,
      note: null,
      error: null,
      creds: null,
      sessionId: null,
      dm: null,
      startedAt: 0,
      linkedAt: 0,
    }));
    this.state = 'starting';
    this.sessionIds = [];
    this.failedSlot = null;
    this.error = null;
    this.createdAt = Date.now();
    this.readyAt = 0;
    this.timer = null;
  }

  async start() {
    await this.openSlot(0);
    return this;
  }

  // open one slot's pairing attempt; slot 0 on create, slot 1 when slot 0 links,
  // and the failed slot again when the person presses "Try again"
  async openSlot(index) {
    const slot = this.slots[index];
    if (!slot) return null;
    if (slot.state === 'linked') return null;

    // a code that is still on screen is replaced, not left running: one attempt per slot
    if (slot.jobId) {
      const old = this.site.get(slot.jobId);
      if (old && old.state !== 'linked') {
        try {
          this.site.cancel(slot.jobId);
        } catch (err) {
          // already gone
        }
      }
      slot.jobId = null;
    }

    slot.state = 'starting';
    slot.error = null;
    slot.startedAt = Date.now();
    this.failedSlot = null;
    this.error = null;
    this.state = 'starting';

    let job = null;
    try {
      job = await this.site.start({
        method: this.method,
        number: slot.number,
        observer: {
          onLinked: (info) => this.slotLinked(slot, info),
          onFailed: (info) => this.slotFailed(slot, info),
        },
      });
    } catch (err) {
      this.slotFailed(slot, { message: err && err.message ? err.message : 'Could not start pairing.' });
      return null;
    }

    if (job) {
      slot.jobId = job.id;
      if (slot.state === 'starting') slot.state = job.state;
    }
    return job;
  }

  slotLinked(slot, info) {
    if (slot.state === 'linked') return;
    if (info && info.job) slot.jobId = info.job.id;
    slot.state = 'linked';
    slot.creds = info && info.creds ? info.creds : null;
    slot.sessionId = info && info.sessionId ? info.sessionId : null;
    slot.code = null;
    slot.qr = null;
    slot.linkedAt = Date.now();
    this.log(`[pair] batch ${this.id.slice(0, 6)}… number ${slot.index + 1}/${this.devices} linked`);

    const next = slot.index + 1;
    if (next < this.devices) {
      this.state = 'starting';
      this.openSlot(next).catch((err) => {
        this.slotFailed(this.slots[next], { message: err && err.message ? err.message : 'Could not start pairing.' });
      });
      return;
    }
    this.finish();
  }

  slotFailed(slot, info) {
    if (slot.state === 'linked') return;
    slot.state = 'failed';
    slot.error = (info && info.message) || 'Something went wrong. Press Try again.';
    slot.code = null;
    slot.qr = null;
    this.state = 'failed';
    this.failedSlot = slot.index;
    this.error = this.devices > 1
      ? `Number ${slot.index + 1}: ${slot.error}`
      : slot.error;
    this.log(`[pair] batch ${this.id.slice(0, 6)}… number ${slot.index + 1} failed: ${slot.error}`);
  }

  // every slot is linked: hand out all the IDs together, so they all start their
  // five minutes now and the bundle is never already half expired
  //
  // Each slot already has an ID: the pairing job minted it the moment the number
  // linked and sent that same ID to the person on WhatsApp. Re-storing the creds
  // would mint a SECOND id for the same login (a dead duplicate in the vault, and
  // a WhatsApp message pointing at an entry nothing reads). refresh() restarts the
  // clock on the ID that is already in their chat, and only a slot that somehow
  // linked without an ID falls back to a fresh put().
  finish() {
    this.sessionIds = [];
    for (const slot of this.slots) {
      if (!slot.creds) continue;
      const fresh = slot.sessionId ? this.vault.refresh(slot.sessionId) : null;
      const made = fresh || this.vault.put(slot.creds);
      slot.sessionId = made.id;
      slot.idSecondsLeft = Math.max(0, Math.ceil((made.expiresAt - Date.now()) / 1000));
      this.sessionIds.push(made.id);
    }
    this.readyAt = Date.now();
    this.state = 'ready';
    this.error = null;
    this.failedSlot = null;
    this.log(`[pair] batch ${this.id.slice(0, 6)}… ready with ${this.sessionIds.length} session ID(s)`);
  }

  activeSlot() {
    for (const slot of this.slots) {
      if (slot.state !== 'linked') return slot.index;
    }
    return this.slots.length - 1;
  }

  slotStatus(slot) {
    const job = slot.jobId ? this.site.get(slot.jobId) : null;
    const live = job ? this.site.status(job) : null;
    const out = {
      index: slot.index,
      number: slot.number,
      state: live && slot.state !== 'failed' ? live.state : slot.state,
    };
    if (live) {
      if (live.code) out.code = live.code;
      if (live.qr) out.qr = live.qr;
      if (live.note) out.note = live.note;
      if (typeof live.secondsLeft === 'number') out.secondsLeft = live.secondsLeft;
      if (typeof live.dm !== 'undefined') out.dm = live.dm;
    }
    if (slot.state === 'failed') {
      out.state = 'failed';
      out.error = slot.error;
    }
    if (slot.state === 'linked') {
      out.state = 'linked';
      if (this.state === 'ready') out.sessionId = slot.sessionId;
    }
    return out;
  }

  status() {
    const out = {
      id: this.id,
      state: this.state,
      devices: this.devices,
      method: this.method,
      slot: this.activeSlot(),
      numbers: this.numbers,
      slots: this.slots.map((slot) => this.slotStatus(slot)),
      sessionIds: this.state === 'ready' ? this.sessionIds.slice() : [],
    };

    if (this.state === 'ready') {
      const left = this.sessionIds.map((id) => this.vault.status(id).secondsLeft);
      out.idSecondsLeft = left.length ? Math.min(...left) : 0;
      out.expired = out.idSecondsLeft <= 0;
      if (!out.expired) {
        out.bundle = `/api/bundle/${this.id}/index.js`;
        out.bundleName = 'index.js';
      }
      const dms = this.slots.map((slot) => slot.dm);
      out.dm = dms.every((value) => value === true) ? true : dms.some((value) => value === false) ? false : null;
    }

    if (this.state === 'failed') {
      out.error = this.error;
      out.failedSlot = this.failedSlot;
    }

    return out;
  }

  // the finished file, or null while it does not exist yet
  bundle() {
    if (this.state !== 'ready') return null;
    const live = this.sessionIds.filter((id) => this.vault.status(id).secondsLeft > 0);
    if (!live.length) return null;
    return { ids: live };
  }

  cancel() {
    for (const slot of this.slots) {
      if (!slot.jobId) continue;
      try {
        this.site.cancel(slot.jobId);
      } catch (err) {
        // already gone
      }
    }
    this.state = 'failed';
    this.error = 'This attempt was stopped.';
  }
}

class Batcher {
  constructor({ site, vault, log = console.log, keepMs = KEEP_MS }) {
    this.site = site;
    this.vault = vault;
    this.log = log;
    this.keepMs = keepMs;
    this.batches = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref?.();
  }

  async create({ method, numbers, devices }) {
    const batch = new Batch({ site: this.site, vault: this.vault, log: this.log, method, numbers, devices });
    this.batches.set(batch.id, batch);
    await batch.start();
    return batch;
  }

  get(id) {
    return this.batches.get(String(id || '')) || null;
  }

  status(id) {
    const batch = this.get(id);
    return batch ? batch.status() : null;
  }

  // retry only the number that failed; the ones already linked keep their login
  async retry(id) {
    const batch = this.get(id);
    if (!batch) return null;
    if (batch.state === 'ready') return batch.status();
    const index = typeof batch.failedSlot === 'number' ? batch.failedSlot : batch.activeSlot();
    await batch.openSlot(index);
    return batch.status();
  }

  cancel(id) {
    const batch = this.get(id);
    if (!batch) return false;
    batch.cancel();
    this.batches.delete(batch.id);
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [id, batch] of this.batches) {
      if (now - batch.createdAt > this.keepMs) this.batches.delete(id);
    }
  }

  stop() {
    clearInterval(this.sweeper);
    for (const id of [...this.batches.keys()]) this.cancel(id);
  }

  get size() {
    return this.batches.size;
  }
}

module.exports = { Batch, Batcher, MAX_SLOTS };
