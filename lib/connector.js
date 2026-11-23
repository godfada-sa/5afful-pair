// The real WhatsApp side of a pairing attempt: it opens a WhatsApp Web socket,
// shows a pairing code or a QR code, and hands the finished login back to the site.
'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const { installRefreshFix } = require('./refreshfix');

// Baileys ships as an ES module. Newer Node can require() it; on Node 20 it has
// to be imported, so load it lazily instead of at the top of the file.
let baileysLib = null;
async function loadBaileys() {
  if (baileysLib) return baileysLib;
  try {
    baileysLib = require('@whiskeysockets/baileys');
  } catch (err) {
    baileysLib = await import('@whiskeysockets/baileys');
  }
  return baileysLib;
}

const logger = pino({ level: 'silent' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(message || 'timed out')), ms)),
  ]);
}

function qrImage(raw) {
  return QRCode.toDataURL(String(raw), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#0b1220', light: '#ffffff' },
  });
}

function readCreds(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
  } catch (err) {
    return null;
  }
}

async function whatsappConnector(job, h) {
  const {
    makeWASocket,
    useMultiFileAuthState,
    Browsers,
    fetchLatestWaWebVersion,
    fetchLatestBaileysVersion,
    DisconnectReason,
  } = await loadBaileys();

  let sock = null;
  let cancelled = false;
  let closing = false;
  let completing = false;
  let attempts = 0;
  let qrLatest = null;
  let pairingAsked = false;
  let iqError = null;
  let fix = null;

  const cleanupDir = () => {
    if (!job.dir) return;
    try {
      fs.rmSync(job.dir, { recursive: true, force: true });
    } catch (err) {
      // the file may still be open for a moment; Windows releases it by itself
    }
  };

  const dropSock = () => {
    const current = sock;
    sock = null;
    if (!current) return;
    try {
      current.ev.removeAllListeners();
    } catch (err) {
      // already gone
    }
    try {
      current.end(undefined);
    } catch (err) {
      // already closed
    }
  };

  const showQr = async (raw) => {
    if (!raw || cancelled) return;
    const dataUrl = await qrImage(fix ? fix.fixQr(raw) : raw);
    h.onQr(dataUrl);
  };

  async function askCode(rawQr) {
    pairingAsked = true;
    const asked = Date.now();
    try {
      const raw = await sock.requestPairingCode(job.number);
      await delay(2500); // WhatsApp's refusal/answer arrives just after the code is made
      if (cancelled) return;
      if (iqError && iqError.at >= asked - 500) {
        h.onNote(
          `WhatsApp refused the pairing code${iqError.text ? ` (${iqError.text})` : ''}. Scan this QR code instead.`
        );
        job.method = 'qr';
        await showQr(rawQr);
        return;
      }
      h.onCode(raw && String(raw).match(/.{1,4}/g) ? String(raw).match(/.{1,4}/g).join('-') : raw);
    } catch (err) {
      if (cancelled) return;
      h.onNote(`WhatsApp could not make a pairing code (${err.message}). Scan this QR code instead.`);
      job.method = 'qr';
      await showQr(rawQr);
    }
  }

  async function complete() {
    if (completing || cancelled) return;
    completing = true;
    closing = true;
    h.onLinking();

    let creds = readCreds(job.dir);
    for (let i = 0; i < 6 && !(creds && creds.me && creds.me.id); i += 1) {
      await delay(600);
      creds = readCreds(job.dir);
    }
    if (!(creds && creds.me && creds.me.id)) {
      h.onError('WhatsApp linked, but its login could not be read. Please try again.');
      dropSock();
      cleanupDir();
      return;
    }

    creds.registered = true;
    const sessionId = h.onLinked(creds);

    // a copy in the person's own WhatsApp chat, so the ID is not lost
    try {
      await timeout(
        sock.sendMessage(creds.me.id, {
          text:
            `Your 5AFFUL session ID\n\nSESSION_ID=${sessionId}\n\n` +
            'It works once and expires in 5 minutes. Paste it after SESSION_ID= in ' +
            'session_id.txt in the bot folder, save the file and restart the bot.',
        }),
        8000,
        'sending the copy timed out'
      );
      h.onDm(true);
    } catch (err) {
      h.onDm(false);
    }

    dropSock();
    setTimeout(cleanupDir, 1500);
  }

  async function onUpdate(update) {
    if (cancelled) return;
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      qrLatest = qr;
      if (job.method === 'qr') {
        await showQr(qr);
      } else if (!pairingAsked) {
        await askCode(qr);
      }
    }

    if (connection === 'open') {
      await complete();
      return;
    }

    if (connection === 'close') {
      if (closing || cancelled) return;
      const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;
      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
        h.onError('WhatsApp refused this attempt. Press Try again.');
        cleanupDir();
        return;
      }
      if (attempts >= 3) {
        h.onError('Could not stay connected to WhatsApp. Check the internet connection and press Try again.');
        cleanupDir();
        return;
      }
      attempts += 1;
      dropSock();
      setTimeout(() => {
        if (cancelled) return;
        open().catch((err) => h.onError(err.message || 'Could not reach WhatsApp.'));
      }, 1200 * attempts);
    }
  }

  async function open() {
    const { state, saveCreds } = await useMultiFileAuthState(job.dir);

    // An outdated WhatsApp Web version makes WhatsApp refuse the link.
    let versionOpt = {};
    try {
      const fetcher = fetchLatestWaWebVersion || fetchLatestBaileysVersion;
      if (fetcher) {
        const found = await timeout(fetcher(), 10000, 'version lookup timed out');
        if (found && Array.isArray(found.version) && found.version.length) versionOpt = { version: found.version };
      }
    } catch (err) {
      // the built-in version still works most of the time
    }
    if (cancelled) return;

    sock = makeWASocket({
      auth: { creds: state.creds, keys: state.keys },
      logger,
      ...versionOpt,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    fix = installRefreshFix(sock);
    fix.onRefresh((qr) => {
      if (!cancelled && job.method === 'qr') showQr(qr).catch(() => {});
    });

    sock.ev.on('creds.update', () => {
      Promise.resolve(saveCreds()).catch(() => {});
    });

    // WhatsApp answers a pairing-code request with an iq error when it refuses it
    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('CB:iq,type:error', (node) => {
        const err = Array.isArray(node && node.content) ? node.content.find((c) => c && c.tag === 'error') : null;
        iqError = { at: Date.now(), code: err && err.attrs && err.attrs.code, text: err && err.attrs && err.attrs.text };
      });
    }

    sock.ev.on('connection.update', (update) => {
      onUpdate(update).catch((err) => h.onError(err.message || 'WhatsApp connection problem.'));
    });
  }

  await open();

  return {
    cancel() {
      cancelled = true;
      closing = true;
      dropSock();
      setTimeout(cleanupDir, 800);
    },
  };
}

module.exports = { whatsappConnector, qrImage, readCreds, loadBaileys };
