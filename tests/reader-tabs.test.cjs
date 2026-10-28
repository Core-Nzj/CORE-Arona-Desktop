'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// The service-worker mock tests real gating, serialization and tab cleanup.
function readerWorker({ mode = 'all', selected = [], legacy = false } = {}) {
  const local = { token: 'a'.repeat(64), readingMode: legacy ? null : mode,
    enabled: true, autoRead: true, voice: null, voiceProfiles: {} };
  const session = { selectedTabIds: selected };
  const commands = [];
  let listener;
  let onRemoved;
  const store = data => ({
    get: async keys => typeof keys === 'string'
      ? { [keys]: data[keys] }
      : Object.fromEntries(Object.entries(keys).map(([k, fallback]) => [
        k, data[k] === undefined ? fallback : data[k]
      ])),
    set: async values => { Object.assign(data, values); }
  });
  const chrome = {
    storage: { local: store(local), session: store(session) },
    tabs: { onRemoved: { addListener: fn => { onRemoved = fn; } } },
    runtime: { onMessage: { addListener: fn => { listener = fn; } } }
  };
  const script = readFileSync(join(__dirname, '../browser-extension/background.js'), 'utf8');
  runInNewContext(script, {
    chrome, URL, Date, Math, AbortSignal,
    fetch: async (_url, options) => {
      commands.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  const tab = id => ({ tab: { id, url: 'https://chatgpt.com/c/123' },
    url: 'https://chatgpt.com/c/123' });
  return {
    local, session, commands,
    send: (request, id = 1) => new Promise(resolve => {
      listener({ target: 'worker', ...request }, tab(id), resolve);
    }),
    popup: request => new Promise(resolve => {
      listener({ target: 'worker', ...request }, {}, resolve);
    }),
    removed: async id => {
      onRemoved(id);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
}
const kinds = worker => worker.commands.map(command => command.type);

test('all / selected one or many / off affect only the chosen tabs', async () => {
  const worker = readerWorker();
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'a' }, 1)).ok, true);
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'b' }, 2)).ok, true);
  worker.local.readingMode = 'selected';
  worker.session.selectedTabIds = [1];
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'c' }, 2)).skipped, true);
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'd' }, 1)).ok, true);
  worker.session.selectedTabIds = [1, 2];
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'e' }, 2)).ok, true);
  worker.local.readingMode = 'off';
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'f' }, 1)).skipped, true);
  assert.deepEqual(kinds(worker), ['STREAM_START', 'STREAM_START', 'STREAM_START', 'STREAM_START']);
});

test('disabled tab cannot interrupt the current speaking tab', async () => {
  const worker = readerWorker({ mode: 'selected', selected: [1] });
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'one' }, 1)).ok, true);
  assert.equal((await worker.send({ type: 'STREAM_APPEND', streamId: 'one', seq: 0, text: '一つ目。' }, 1)).ok, true);
  assert.equal((await worker.send({ type: 'STREAM_START', streamId: 'two' }, 2)).skipped, true);
  assert.equal((await worker.send({ type: 'STOP' }, 2)).skipped, true);
  assert.deepEqual(kinds(worker), ['STREAM_START', 'STREAM_APPEND']);
  worker.session.selectedTabIds = [1, 2];
  await worker.send({ type: 'STREAM_START', streamId: 'two' }, 2);
  assert.equal((await worker.send({ type: 'STOP' }, 1)).skipped, true);
  assert.deepEqual(kinds(worker), ['STREAM_START', 'STREAM_APPEND', 'STREAM_START']);
  // Page refresh from the actual audible tab retains the old F5 stop behavior.
  assert.equal((await worker.send({ type: 'STOP' }, 2)).ok, true);
  assert.deepEqual(kinds(worker), ['STREAM_START', 'STREAM_APPEND', 'STREAM_START', 'STOP']);
});

test('turning a selected tab off stops future chunks without a global STOP', async () => {
  const worker = readerWorker({ mode: 'selected', selected: [1, 2] });
  await worker.send({ type: 'STREAM_START', streamId: 'one' }, 1);
  await worker.send({ type: 'STREAM_APPEND', streamId: 'one', seq: 0, text: '一。' }, 1);
  worker.session.selectedTabIds = [2];
  assert.equal((await worker.send({ type: 'STREAM_APPEND', streamId: 'one', seq: 1, text: '二。' }, 1)).skipped, true);
  assert.equal((await worker.send({ type: 'STREAM_END', streamId: 'one' }, 1)).skipped, true);
  await worker.send({ type: 'STREAM_START', streamId: 'two' }, 2);
  assert.deepEqual(kinds(worker), ['STREAM_START', 'STREAM_APPEND', 'STREAM_START']);
});

test('tab closure removes its selected ID and never interrupts another tab', async () => {
  const worker = readerWorker({ mode: 'selected', selected: [1, 2] });
  await worker.send({ type: 'STREAM_START', streamId: 'one' }, 1);
  await worker.send({ type: 'STREAM_START', streamId: 'two' }, 2);
  await worker.removed(1);
  assert.deepEqual(worker.session.selectedTabIds, [2]);
  assert.equal((await worker.send({ type: 'STREAM_APPEND', streamId: 'one', seq: 1, text: '古い。' }, 1)).skipped, true);
  assert.deepEqual(kinds(worker), ['STREAM_START', 'STREAM_START']);
});

test('manual speak bypasses selection and legacy global preference stays supported', async () => {
  const worker = readerWorker({ mode: 'off' });
  assert.equal((await worker.send({ type: 'SPEAK', manual: false, text: '自動。' }, 1)).skipped, true);
  assert.equal((await worker.send({ type: 'SPEAK', manual: true, text: '手動。' }, 1)).ok, true);
  assert.deepEqual(kinds(worker), ['SPEAK']);
  const legacy = readerWorker({ legacy: true });
  assert.equal((await legacy.send({ type: 'STREAM_START', streamId: 'old' }, 1)).ok, true);
  legacy.local.enabled = false;
  assert.equal((await legacy.send({ type: 'STREAM_START', streamId: 'ignored' }, 1)).skipped, true);
});
