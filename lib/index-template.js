// The downloadable index.js.
//
// The file handed to a person is the bot's own bootstrap (the same file that
// installs and starts 5AFFUL V6 on a fresh panel), with the SESSION_IDS block
// already filled in with the ID(s) they just paired. Nothing else changes, so
// `node index.js` still installs, `--update` still works and session/, data/,
// accounts/ and session_id.txt are still protected from the download.
//
// The template lives in lib/template/index.js.tpl and is a verbatim copy of
// 5AFFUL-V6/index.js with one marker line where the IDs go. renderIndex()
// refuses to build anything when that marker is not exactly once in the file,
// so a broken template can never ship a file that silently loses the IDs.
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'template', 'index.js.tpl');

// the line inside the SESSION_IDS backticks that is replaced by the real IDs
const MARKER = '__5AFFUL_SESSION_IDS__';

// what the bot accepts: 5AFFUL-XXXX-XXXX-XXXX (no I, O, 0 or 1)
const ID_RE = /^5AFFUL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

let cached = null;

// read once; the template never changes while the process runs
function template() {
  if (cached === null) cached = fs.readFileSync(TEMPLATE, 'utf8');
  return cached;
}

// one or two IDs in, a complete index.js out
function renderIndex({ ids } = {}) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);

  if (list.length < 1 || list.length > 2) {
    throw new Error(`index.js needs one or two session IDs (got ${list.length})`);
  }
  for (const id of list) {
    if (!ID_RE.test(id)) throw new Error(`not a session ID: ${id}`);
  }

  const text = template();
  const parts = text.split(MARKER);
  if (parts.length !== 2) {
    throw new Error(`the index.js template must contain ${MARKER} exactly once (found ${parts.length - 1})`);
  }

  // two spaces of indent, one ID per line, exactly like a hand-pasted block.
  // With one device the second line stays empty and keeps the single comment
  // that says where another device's session goes; the bot skips // lines.
  const body = list.map((id) => `  ${id}`).join('\n');
  const second = list.length === 1 ? '\n  //put device 2 session here' : '';
  return parts[0] + body + second + parts[1];
}

// the file name the browser saves it as
const FILENAME = 'index.js';

module.exports = { renderIndex, template, MARKER, ID_RE, TEMPLATE, FILENAME };
