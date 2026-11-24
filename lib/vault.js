// Session IDs for the bot.
//
// The bot downloads GET /api/session/<ID> once and saves the answer as
// session/creds.json. Per the contract the ID is NOT one-use: for its whole
// 5-minute life it must return the same creds, byte for byte, because the bot
// may legitimately ask twice (a dropped response, or a crash before saving).
// After the TTL the creds are wiped and the ID answers 404.
'use strict';

const crypto = require('crypto');

// The alphabet the bot accepts: no I, O, 0 or 1 (look-alikes).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BODY_RE = /^[A-HJ-NP-Z2-9]{12}$/;

// The brand in front of every session ID, then three blocks: 5AFFUL-K7M2-9QXA-4BNP
const PREFIX = '5AFFUL';
// IDs handed out by older versions of this site had this prefix. They are only
// good for 5 minutes, but a code copied seconds before an update still works.
const OLD_PREFIXES = ['TFX'];

function randomBlock() {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function newSessionId() {
  return `${PREFIX}-${randomBlock()}-${randomBlock()}-${randomBlock()}`;
}

// Takes what a person pasted (lowercase, missing dashes, missing or old prefix)
// and gives back the canonical ID, or null when it cannot be a session ID at all.
function canonical(raw) {
  let value = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // only treat a leading word as the prefix when the 12-character body follows it,
  // so an ID typed without a prefix is never trimmed
  const heads = [PREFIX, ...OLD_PREFIXES];
  for (const head of heads) {
    if (value.length === head.length + 12 && value.startsWith(head)) {
      value = value.slice(head.length);
      break;
    }
  }
  if (!BODY_RE.test(value)) return null;
  return `${PREFIX}-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

class Vault {
  constructor({ ttlMs = 5 * 60 * 1000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();
  }

  // stores a login and returns its ID
  put(creds) {
    this.sweep();
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    let id = newSessionId();
    for (let i = 0; i < 10 && this.entries.has(id); i += 1) id = newSessionId();
    const expiresAt = Date.now() + this.ttlMs;
    this.entries.set(id, { creds, expiresAt, downloads: 0 });
    return { id, expiresAt };
  }

  // the only read path: cheap map lookup, same answer every time until expiry
  read(rawId) {
    const id = canonical(rawId);
    if (!id) return { status: 404 };
    const entry = this.entries.get(id);
    if (!entry) return { status: 404 };
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(id); // TTL over: the creds are wiped
      return { status: 404 };
    }
    entry.downloads += 1;
    return { status: 200, creds: entry.creds, id };
  }

  status(id) {
    const entry = this.entries.get(canonical(id) || '');
    if (!entry) return { exists: false, expired: true, secondsLeft: 0, downloads: 0 };
    const secondsLeft = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    return { exists: true, expired: secondsLeft === 0, secondsLeft, downloads: entry.downloads };
  }

  sweep() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(id); // wipe expired creds
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { Vault, canonical, newSessionId };
