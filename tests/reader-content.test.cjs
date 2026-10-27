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
    constructor({ kind = '', text = '', key = '', parent = null, testId = '', aria = '',
      tone = '', modelSlug = true } = {}) {
      Object.assign(this, { kind, textContent: text, key, parent, testId, aria, tone, modelSlug });
      this.title = '';
    }
    matches(selector) {
      if (selector.includes('.sr-only')) return false;
      return (selector === '[data-turn-key]' && this.kind === 'group') ||
        (selector === '[data-content-search-unit-key$=":assistant"]' && this.kind === 'assistant') ||
        (selector === '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])' &&
         ['body', 'thinking', 'progress', 'summary'].includes(this.kind) && this.tone !== 'tertiary');
    }
    closest(selector) {
      if (this.kind === 'editor' && selector.includes('textarea')) return this;
      if (this.kind === 'button' && selector === 'button') return this;
      if (this.kind === 'thinking' && selector.includes('[data-testid*="thinking"]')) return this;
      if (this.kind === 'progress' && selector.includes('[data-testid*="progress"]')) return this;
      if (this.tone === 'tertiary' && selector.includes('[data-markdown-text-tone="tertiary"]')) return this;
      if (selector.includes('[data-message-author-role="assistant"]')) {
        let owner = this;
        while (owner) {
          if (owner.kind === 'assistant') return owner;
          owner = owner.parent;
        }
      }
      if (this.parent && selector.includes('[data-turn-key]')) return this.parent;
      return null;
    }
    hasAttribute(name) {
      return name === 'data-message-model-slug' && this.kind === 'assistant' && this.modelSlug;
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
      if (selector === '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])' &&
          ['group', 'assistant'].includes(this.kind)) {
        const owner = this.kind === 'group' ? this.assistant : this;
        return [owner?.thinking, owner?.progress, owner?.summary,
          owner?.body].filter(node => node?.matches(selector));
      }
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
    // Even if status widgets contain "markdown", they must never be spoken.
    assistant.thinking = new FakeElement({
      kind: 'thinking', text: '', parent: assistant
    });
    assistant.progress = new FakeElement({
      kind: 'progress', text: '', parent: assistant
    });
    assistant.summary = new FakeElement({
      kind: 'summary', text: '', parent: assistant, tone: 'tertiary'
    });
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


test('thinking-stage headings with assistant-message style but tertiary tone are silent', async () => {
  const reader = makeReader({ generating: true });
  reader.enter();
  const entry = reader.group('', 'reply');
  reader.groups.push(entry);
  entry.assistant.summary.textContent = '原因を切り分ける';
  reader.scan();
  reader.advance(7000);
  entry.assistant.summary.textContent = '実装方針を考える';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), []);
  assert.equal(reader.sent.filter(m => m.type === 'STREAM_START').length, 0);

  entry.assistant.body.textContent = '先生、回答本文はここからです。';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['先生、回答本文はここからです。']);
});

test('legacy assistant thinking pseudo-message without model slug is never spoken', async () => {
  const reader = makeReader({ generating: true });
  reader.enter();
  const entry = reader.group('原因を切り分ける', 'pseudo');
  entry.assistant.modelSlug = false;
  reader.groups.push(entry);
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), []);
  entry.assistant.modelSlug = true;
  entry.assistant.body.textContent = '本文が表示されました。';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['本文が表示されました。']);
});

test('sending a new message does not STOP speech already playing', async () => {
  const reader = makeReader();
  reader.enter();
  reader.groups.push(reader.group('前の回答をまだ読み上げています。', 'old'));
  reader.scan();
  await settle();
  assert.equal(reader.sent.filter(m => m.type === 'STREAM_START').length, 1);
  assert.equal(reader.sent.filter(m => m.type === 'STOP').length, 0);
  reader.advance(2000);
  reader.enter();
  await settle();
  assert.equal(reader.sent.filter(m => m.type === 'STOP').length, 0);
  assert.equal(reader.sent.filter(m => m.type === 'STREAM_START').length, 1);

  const newTurn = reader.group('', 'new');
  reader.groups.push(newTurn);
  newTurn.assistant.summary.textContent = '原因を切り分ける';
  reader.scan();
  await settle();
  assert.equal(reader.sent.filter(m => m.type === 'STREAM_START').length, 1);

  newTurn.assistant.body.textContent = 'ここから新しい回答です。';
  reader.scan();
  await settle();
  assert.equal(reader.sent.filter(m => m.type === 'STREAM_START').length, 2);
  assert.equal(reader.sent.filter(m => m.type === 'STOP').length, 0);
});

test('reasoning and progress updates remain silent until final answer prose appears', async () => {
  const reader = makeReader({ history: [['古い回答です。', 'old']], generating: true });
  reader.enter();
  const active = reader.group('', 'new');
  reader.groups.push(active);

  active.assistant.thinking.textContent = 'Implementing Explicit User-Armed Reader Activation';
  active.assistant.progress.textContent = '実装を進め確認と補強を行い内容を確定した';
  reader.scan();
  reader.advance(4000);
  active.assistant.thinking.textContent = '検討した事項を更新しています';
  active.assistant.progress.textContent = '進捗が更新されました';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), []);
  assert.equal(reader.sent.filter(message => message.type === 'STREAM_START').length, 0);

  active.assistant.body.textContent = '了解です、先生！ 本文だけを読み上げます。';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['了解です、先生！', '本文だけを読み上げます。']);
  assert.equal(chunks(reader).some(text => /Implementing|進捗|検討/.test(text)), false);
});

test('intermediate thinking never flushes an unfinished final-answer fragment', async () => {
  const reader = makeReader({ generating: true });
  reader.enter();
  const active = reader.group('回答の一文です。未完成', 'new');
  reader.groups.push(active);
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['回答の一文です。']);

  // Only reasoning changes, so the incomplete final text must not be flushed.
  active.assistant.thinking.textContent = 'Implementing the next update';
  active.assistant.progress.textContent = '処理を続行しています';
  reader.advance(4500);
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['回答の一文です。']);

  // Only an actual change to final prose is allowed to advance playback.
  active.assistant.body.textContent = '回答の一文です。未完成だった続きです。';
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), ['回答の一文です。', '未完成だった続きです。']);
});

test('generic thinking markdown without a final-response marker fails closed', async () => {
  const reader = makeReader({ generating: true });
  reader.enter();
  const active = reader.group('この文章は思考メモです。', 'reasoning-only');
  active.assistant.body.kind = 'unmarked';
  active.assistant.thinking.textContent = '内部思考を文章にしています。';
  reader.groups.push(active);
  reader.scan();
  reader.advance(4500);
  reader.scan();
  await settle();
  assert.deepEqual(chunks(reader), []);
});

test('manual last-response reading excludes reasoning and progress metadata', async () => {
  const reader = makeReader({
    history: [['先生、こんにちは。', 'old']]
  });
  reader.groups[0].assistant.thinking.textContent = 'Implementing a plan';
  reader.groups[0].assistant.progress.textContent = '実装中です。';
  const result = await reader.contentCommand({ type: 'READ_LAST' });
  assert.equal(result.ok, true);
  assert.equal(reader.sent[0].type, 'SPEAK');
  assert.equal(reader.sent[0].text, '先生、こんにちは。');
});

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
  assert.equal(reader.sent.filter(message => message.type === 'STOP').length, 0);

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
  assert.equal(reader.sent.filter(message => message.type === 'STOP').length, 1);
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
