// WhatsApp retires the secret carried by a QR code as soon as the phone scans it
// (a "companion_reg_refresh" notice) and then waits for a QR carrying the NEW
// secret. The WhatsApp library ignores that notice, so the link never finishes
// and the phone says "Couldn't link device".
//
// Fix (same as Baileys PR 2765): when the notice arrives, make a new advSecretKey,
// save it, and show the SAME QR again carrying the new secret.
'use strict';

const crypto = require('crypto');

function installRefreshFix(sock) {
  const ws = sock.ws;
  let rotated = false;
  let lastQr = null;
  let onRefresh = null;
  const creds = () => sock.authState && sock.authState.creds;

  // a QR is "reference,noise key,identity key,secret": the 4th part is the current secret
  const fixQr = (qr) => {
    lastQr = qr;
    if (!rotated) return qr;
    const parts = String(qr).split(',');
    const adv = creds() && creds().advSecretKey;
    if (parts.length >= 4 && adv) parts[3] = adv;
    return parts.join(',');
  };

  if (ws && typeof ws.on === 'function') {
    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
      const c = creds();
      if (!c || c.registered) return;
      const kids = Array.isArray(node && node.content) ? node.content.map((k) => k && k.tag) : [];
      if (!kids.some((t) => t === 'companion_reg_refresh' || t === 'pair-device-rotate-qr')) return;
      const adv = crypto.randomBytes(32).toString('base64');
      c.advSecretKey = adv;
      try {
        sock.ev.emit('creds.update', { advSecretKey: adv });
      } catch (err) {
        // the secret is already set on the login itself
      }
      rotated = true;
      if (lastQr && onRefresh) onRefresh(fixQr(lastQr));
    });
  }

  return { fixQr, onRefresh: (fn) => { onRefresh = fn; } };
}

module.exports = { installRefreshFix };
