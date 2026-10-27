'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

test('v0.7 detector only sends newly submitted assistant answers and honors manual stop', async () => {
  let groups = [], users = [], now = 1000, scan, changed;
  const sent = [], events = {};

  class FakeElement {
    constructor({kind='',text='',key='',parent=null}={}) {
      Object.assign(this, {kind,textContent:text,key,parent});
    }
    matches(selector) {
      if (selector.includes('.sr-only')) return false;
      return selector === '[data-turn-key]' && this.kind === 'group' ||
        selector === '[data-content-search-unit-key$=":assistant"]' && this.kind === 'assistant';
    }
    closest(selector) {
      if (this.kind === 'editor' && selector.includes('textarea')) return this;
      if (this.parent && selector.includes('[data-turn-key]')) return this.parent;
      return null;
    }
    getAttribute(name) {
      return name === 'data-turn-key' || name === 'data-content-search-unit-key' ? this.key : null;
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
  const user = key => new FakeElement({kind:'user',key});
  groups = [group('前の回答です。', 'old')];
  users = [user('user0')];
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('data-turn-key') && selector.includes('article[data-turn')) return groups;
      if (selector.includes(':user') || selector.includes('message-author-role="user"')) return users;
      return [];
    },
    querySelector: () => null,
    addEventListener: (type, callback) => { events[type] = callback; },
    createTextNode: value => value,
    hasFocus: () => true,
    getSelection: () => ({ toString: () => '' })
  };
  const chrome = {
    runtime: {
      sendMessage: async message => { sent.push(message); return {ok:true}; },
      onMessage: { addListener: () => {} }
    },
    storage: { onChanged: { addListener: callback => { changed = callback; } } }
  };
  const source = readFileSync(join(__dirname, '../browser-extension/content.js'), 'utf8');
  runInNewContext(source, {
    document, chrome, window: { getSelection: () => ({toString: () => ''}) },
    location: { href:'https://chatgpt.com/c/1', origin:'https://chatgpt.com', pathname:'/c/1' },
    setInterval: callback => { scan = callback; },
    Date: { now: () => now }, Math, Element: FakeElement, console
  });

  const enter = () => events.keydown({
    key:'Enter', shiftKey:false, isComposing:false,
    target:new FakeElement({kind:'editor'})
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 25));

  enter();
  groups.push(group('新しい回答です。', 'new'));
  users.push(user('user1'));
  scan();
  await settle();
  assert.deepEqual(sent.filter(message => message.type === 'STREAM_APPEND')
    .map(message => message.text), ['新しい回答です。']);
  assert.equal(sent.filter(message => message.type === 'STOP').length, 1);

  changed({manualStopToken:{newValue:'stop'}}, 'local');
  groups[1].assistant.body.textContent = '新しい回答です。続きを読みます。';
  scan();
  await settle();
  assert.equal(sent.filter(message => message.type === 'STREAM_APPEND').length, 1);

  now += 2000;
  enter();
  groups.push(group('さらに次の回答です。', 'third'));
  users.push(user('user2'));
  scan();
  await settle();
  assert.deepEqual(sent.filter(message => message.type === 'STREAM_APPEND')
    .map(message => message.text), ['新しい回答です。', 'さらに次の回答です。']);
});
