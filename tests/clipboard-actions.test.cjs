'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSpeechText, copySpeechToken, MAX_SPEECH_TEXT_LENGTH } =
  require('../electron/clipboard-actions.cjs');

test('awaits an asynchronous Electron clipboard read and trims the result', async () => {
  let resolved = false;
  const clipboard = { readText: async () => { resolved = true; return '  先生、こんにちは！  '; } };
  assert.equal(await readSpeechText(clipboard), '先生、こんにちは！');
  assert.equal(resolved, true);
});

test('also handles synchronous clipboard implementations', async () => {
  assert.equal(await readSpeechText({ readText: () => '  テスト  ' }), 'テスト');
});

test('empty and oversized clipboard text are handled safely', async () => {
  assert.equal(await readSpeechText({ readText: async () => '   ' }), '');
  const result = await readSpeechText({ readText: async () => 'あ'.repeat(600) });
  assert.equal(result.length, MAX_SPEECH_TEXT_LENGTH);
});

test('rejects unexpected clipboard data and propagates read errors', async () => {
  await assert.rejects(readSpeechText({ readText: async () => ({}) }), /文字列/);
  await assert.rejects(readSpeechText({ readText: async () => { throw Error('read denied'); } }), /read denied/);
  await assert.rejects(readSpeechText({}), /読み取り機能/);
});

test('awaits the asynchronous clipboard write before completing', async () => {
  const token = 'a'.repeat(64);
  let release;
  let completed = false;
  const clipboard = { writeText: () => new Promise(resolve => { release = resolve; }) };
  const action = copySpeechToken(clipboard, token).then(() => { completed = true; });
  assert.equal(completed, false);
  assert.equal(typeof release, 'function');
  release();
  await action;
  assert.equal(completed, true);
});

test('writes the exact token and propagates errors without leaking it', async () => {
  const token = 'b'.repeat(64);
  let written;
  await copySpeechToken({ writeText: async text => { written = text; } }, token);
  assert.equal(written, token);
  await assert.rejects(copySpeechToken({ writeText: async () => { throw Error('write denied'); } }, token), /write denied/);
  await assert.rejects(copySpeechToken({ writeText: async () => {} }, 'invalid'), /準備/);
  await assert.rejects(copySpeechToken({}, token), /書き込み機能/);
});
