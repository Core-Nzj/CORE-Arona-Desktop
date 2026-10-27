'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// A small ChatGPT DOM simulator that also models asynchronous hydration on F5.
function makeReader({ history = [], userKeys = [], generating = false } = {}) {
  let now = 1000;
  let scan;
  let onStorageChanged;
  let onContentMessage;
  const sent = [];
  const events = {};
  const windowEvents = {};

  class FakeElement {
    constructor({ kind = '', text = '', key = '', parent = null, testId = '', aria = '' } = {}) {
      Object.assign(this, { kind, textContent: text, key, parent, testId, aria });
      this.title = '';
    }
    matches(selector) {
      if (selector.includes('.sr-only')) return false;
      return (selector === '[data-turn-key]' && this.kind === 'group') ||
        (selector === '[data-content-search-unit-key$=":assistant"]' && this.kind === 'assistant');
    }
    closest(selector) {
      if (this.kind === 'editor' && selector.includes('textarea')) return this;
      if (this.kind === 'button' && selector === 'button') return this;
      if (this.parent && selector.includes('[data-turn-key]')) return this.parent;
      return null;
    }
    getAttribute(name) {
      if (name === 'data-turn-key' || name === 'data-content-search-unit-key') return this.key;
      if (name === 'data-testid') return this.testId || null;
      if (name === 'aria-label') return this.aria || null;
      return null;
    }
    querySelector(selector) {
      return this.kind === 'group' && selector.includes('assistant') ? this.assistant : null;
    }
    querySelectorAll(selector) {
      if (this.kind === 'group' && selector.includes(':assistant')) return [this.assistant];
      if (this.kind === 'assistant' && selector.includes('.markdown')) return [this.body];
      return [];
    }
    cloneNode() { return { querySelectorAll: () => [], textContent: this.textContent }; }
    contains(node) { return node === this.assistant || node === this.body; }
  }
  const group = (text, key) => {
    const root = new FakeElement({ kind: 'group', key });
    const assistant = new FakeElement({ kind: 'assistant', parent: root });
    assistant.body = new FakeElement({ kind: 'body', text, parent: assistant });
    root.assistant = assistant;
    return root;
  };
  const user = key => new FakeElement({ kind: 'user', key });
  const groups = history.map(([text, key]) => group(text, key));
  const users = userKeys.map(user);
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('data-turn-key') && selector.includes('article[data-turn')) return groups;
      if (selector.includes(':user') || selector.includes('message-author-role="user"')) return users;
      return [];
    },
    querySelector: () => generating ? {} : null,
    addEventListener: (type, callback) => { events[type] = callback; },
    createTextNode: value => value,
    hasFocus: () => true
  };
  const chrome = {
    runtime: {
      sendMessage: async message => { sent.push(message); return { ok: true }; },
      onMessage: { addListener: callback => { onContentMessage = callback; } }
    },
    storage: { onChanged: { addListener: callback => { onStorageChanged = callback; } } }
  };
  const source = readFileSync(join(__dirname, '../browser-extension/content.js'), 'utf8');
  runInNewContext(source, {
    document, chrome,
    window: {
      getSelection: () => ({ toString: () => '' }),
      addEventListener: (type, callback) => { windowEvents[type] = callback; }
    },
    location: { href: 'https://chatgpt.com/c/1', origin: 'https://chatgpt.com', pathname: '/c/1' },
    setInterval: callback => { scan = callback; },
    Date: { now: () => now }, Math, Element: FakeElement, console
  });
  return {
    sent, events, windowEvents, groups, users, group, user,
    scan: () => scan(),
    advance: ms => { now += ms; },
    setGenerating: value => { generating = value; },
    enter: () => events.keydown({
      key: 'Enter', shiftKey: false, isComposing: false,
      target: new FakeElement({ kind: 'editor' })
    }),
    click: testId => events.click({
      target: new FakeElement({ kind: 'button', testId })
    }),
    manualStop: () => onStorageChanged({ manualStopToken: { newValue: 'stop' } }, 'local'),
    pagehide: () => windowEvents.pagehide(),
    contentCommand: message => new Promise(resolve => {
      onContentMessage(message, {}, resolve);
    })
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const chunks = reader => reader.sent.filter(message => message.type === 'STREAM_APPEND')
  .map(message => message.text);

test('new Enter submission speaks incremental text, but manual STOP silences until the next send', async () => {
  const reader = makeReader({
    history: [['前の回答です。', 'old']], userKeys: ['user0']
  });
  reader.enter();
  reader.groups.push(reader.group('新しい回答です。', 'new'));
  reader.users.push(reader.user('user1'));
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['新しい回答です。']);
  assert.equal(reader.sent.filter(message => message.type === 'STOP').length, 1);

  reader.manualStop();
  reader.groups[1].assistant.body.textContent = '新しい回答です。続きを読みます。';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['新しい回答です。']);

  reader.advance(2000);
  reader.enter();
  reader.groups.push(reader.group('さらに次の回答です。', 'third'));
  reader.users.push(reader.user('user2'));
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['新しい回答です。', 'さらに次の回答です。']);
});

test('F5 with an existing answer does not read it or issue a STOP', async () => {
  const reader = makeReader({
    history: [['再読み込み前の回答です。', 'prior']], userKeys: ['prior-user'],
    generating: true
  });
  reader.scan();
  reader.advance(2000);
  reader.scan();
  await settle();
  assert.equal(reader.sent.length, 0);
  assert.deepEqual(chunks(reader), []);
});

test('F5 hydration from an empty DOM does not arm speech, even with new user nodes and a generating indicator', async () => {
  const reader = makeReader();
  reader.scan();
  reader.setGenerating(true);
  reader.users.push(reader.user('prior-user'));
  reader.groups.push(reader.group('読み込み直した古い回答です。', 'old'));
  reader.scan();
  reader.advance(3000);
  reader.scan();
  await settle();
  assert.equal(reader.sent.length, 0);
  assert.deepEqual(chunks(reader), []);

  // A new, genuine submission on the same hydrated page must still work.
  reader.click('send-button');
  reader.users.push(reader.user('fresh-user'));
  reader.groups.push(reader.group('今の回答です。', 'fresh'));
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['今の回答です。']);
});

test('DOM changes without a send or regenerate never start speech', async () => {
  const reader = makeReader({
    history: [['もとの回答です。', 'old']], userKeys: ['user0'],
    generating: true
  });
  reader.groups[0].assistant.body.textContent = 'もとの回答です。画面更新で追加された内容。';
  reader.users.push(reader.user('hydrated-user'));
  reader.scan();
  await settle();
  assert.equal(reader.sent.length, 0);
});

test('explicit regenerate button reads the regenerated reply', async () => {
  const reader = makeReader({
    history: [['古い回答です。', 'reply']], userKeys: ['user0']
  });
  reader.click('regenerate-button');
  reader.groups[0].assistant.body.textContent = '再生成した回答です。';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['再生成した回答です。']);
});

test('pagehide cancels an active stream and does not replay it after hydration', async () => {
  const reader = makeReader();
  reader.enter();
  reader.groups.push(reader.group('読み上げ中です。', 'active'));
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['読み上げ中です。']);

  reader.pagehide();
  await settle();
  assert.equal(reader.sent.filter(message => message.type === 'STOP').length, 2);
  reader.groups[0].assistant.body.textContent = '読み上げ中です。再読み込み後のテキスト。';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['読み上げ中です。']);
});

test('manual read of the last answer remains available without automatic arming', async () => {
  const reader = makeReader({ history: [['過去の回答です。', 'prior']] });
  const response = await reader.contentCommand({ type: 'READ_LAST' });
  assert.equal(response.ok, true);
  assert.equal(reader.sent.length, 1);
  assert.equal(reader.sent[0].type, 'SPEAK');
  assert.equal(reader.sent[0].text, '過去の回答です。');
});
