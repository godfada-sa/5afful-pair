'use strict';
// Static wiring check: every id the page script touches exists in the HTML.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const ids = ['dsel', 'numwrap2', 'number2', 'numerr2', 'numhint2', 'sidlist', 'dl', 'dlwait', 'dlhint', 'copy'];
let bad = 0;
for (const id of ids) {
  if (!html.includes(`id="${id}"`)) { console.log(`MISSING in html: #${id}`); bad += 1; }
  if (!app.includes(`#${id}`) && !app.includes(`'${id}'`)) { console.log(`UNUSED by app.js: #${id}`); bad += 1; }
}

// every getElementById in app.js must resolve, or the page dies on the first tap
const refs = [...app.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
for (const id of new Set(refs)) {
  if (!html.includes(`id="${id}"`)) { console.log(`app.js asks for #${id}, html has no such element`); bad += 1; }
}
console.log(bad === 0 ? `OK: ${new Set(refs).size} element ids all present` : `${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
