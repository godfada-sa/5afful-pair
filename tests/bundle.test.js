'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { renderIndex, template, MARKER } = require('../lib/index-template');

const A = '5AFFUL-K7M2-9QXA-4BNP';
const B = '5AFFUL-AB2C-DE3F-GH4J';

function script(text) {
  // the shebang is legal in a file Node runs, but vm.Script wants it gone
  return new vm.Script(text.replace(/^#![^\n]*\n/, ''), { filename: 'index.js' });
}

test('the template has the marker exactly once', () => {
  const text = template();
  assert.strictEqual(text.split(MARKER).length - 1, 1);
  assert.match(text, /const SESSION_IDS = `\n__5AFFUL_SESSION_IDS__\n`;/);
});

test('one ID goes into the SESSION_IDS block, with the one comment for device 2', () => {
  const out = renderIndex({ ids: [A] });
  assert.ok(!out.includes(MARKER));
  assert.match(out, /const SESSION_IDS = `\n {2}5AFFUL-K7M2-9QXA-4BNP\n {2}\/\/put device 2 session here\n`;/);
  // the installer itself is untouched
  assert.match(out, /function startBot\(\)/);
  assert.match(out, /process\.argv\.includes\('--update'\)/);
});

test('the top of the file is code, not a wall of comments', () => {
  for (const ids of [[A], [A, B]]) {
    const out = renderIndex({ ids });
    const head = out.split('const SESSION_IDS')[0];
    assert.ok(!head.includes('//'), 'no comment line before the SESSION_IDS block');
    assert.match(head, /^#!\/usr\/bin\/env node\n'use strict';\n\n$/);
    assert.strictEqual((out.match(/\/\/put device 2 session here/g) || []).length, ids.length === 1 ? 1 : 0);
  }
});

test('two IDs go in on two lines, in the order they were paired', () => {
  const out = renderIndex({ ids: [A, B] });
  assert.match(out, /const SESSION_IDS = `\n {2}5AFFUL-K7M2-9QXA-4BNP\n {2}5AFFUL-AB2C-DE3F-GH4J\n`;/);
});

test('the generated file is valid JavaScript', () => {
  assert.doesNotThrow(() => script(renderIndex({ ids: [A] })));
  assert.doesNotThrow(() => script(renderIndex({ ids: [A, B] })));
});

test('the generated file turns the notification guard on for the bot it starts', () => {
  const out = renderIndex({ ids: [A] });
  assert.match(out, /process\.env\.SAFFUL_PRESERVE_DM_NOTIFICATIONS = 'true'/);
  assert.match(out, /process\.env\.SAFFUL_PRESENCE_REASSERT_MS = '60000'/);
});

test('it refuses anything that is not one or two real session IDs', () => {
  assert.throws(() => renderIndex({ ids: [] }), /one or two/);
  assert.throws(() => renderIndex({ ids: [A, B, A] }), /one or two/);
  assert.throws(() => renderIndex({}), /one or two/);
  assert.throws(() => renderIndex({ ids: ['5AFFUL-0000-0000-0000'] }), /not a session ID/);
  assert.throws(() => renderIndex({ ids: ['nope'] }), /not a session ID/);
});
