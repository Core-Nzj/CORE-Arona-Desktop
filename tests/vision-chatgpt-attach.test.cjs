'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..',
  'experiments/vision-chrome-receiver/chatgpt-attach.js'), 'utf8');
const validPng = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8aUUAAAAASUVORK5CYII=';

function runAttachment({ hostname = 'chatgpt.com', editorPresent = true,
  uploadInputs = 1, imageData = validPng } = {}) {
  const events = [];
  const inputNodes = Array.from({ length: uploadInputs }, () => ({
    disabled: false, accept: 'image/png',
    files: null, dispatchEvent(event) { events.push(event.type); }
  }));
  const form = {
    contains: node => inputNodes.includes(node),
    dispatchEvent(event) { events.push(event.type); }
  };
  const editor = {
    closest: name => name === 'form' ? form : null,
    dispatchEvent(event) { events.push(event.type); }
  };
  const sandbox = {
    location: { protocol: 'https:', hostname },
    document: {
      querySelector: query => editorPresent && query === '#prompt-textarea' ? editor : null,
      querySelectorAll: query => query === 'input[type="file"]' ? inputNodes : []
    },
    atob,
    Uint8Array,
    File: class TestFile {
      constructor(parts, name, options) {
        this.parts = parts;
        this.name = name;
        this.type = options.type;
      }
    },
    DataTransfer: class TestTransfer {
      constructor() {
        const items = [];
        this.items = { add: value => { items.push(value); } };
        this.files = items;
      }
    },
    Event: class TestEvent { constructor(type) { this.type = type; } },
    DragEvent: class TestDragEvent { constructor(type) { this.type = type; } },
    module: { exports: {} }
  };
  vm.runInNewContext(source, sandbox, { filename: 'chatgpt-attach.js' });
  const response = sandbox.module.exports.frameAttachPngToChatGPT(imageData);
  return { response, events, inputNodes };
}

test('rejects foreign sites before constructing an image file', () => {
  const { response, events } = runAttachment({ hostname: 'example.com' });
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'wrong-origin');
  assert.deepEqual(events, []);
});

test('rejects when the ChatGPT composer is not present', () => {
  const { response, events } = runAttachment({ editorPresent: false });
  assert.equal(response.reason, 'composer-not-found');
  assert.deepEqual(events, []);
});

test('attaches a RAM-backed PNG via the composer file input without sending', () => {
  const { response, events, inputNodes } = runAttachment();
  assert.equal(response.ok, true);
  assert.equal(response.mode, 'file-input');
  assert.equal(response.confirmed, false);
  assert.deepEqual(events, ['change']);
  const file = inputNodes[0].files[0];
  assert.equal(file.name, 'FRAME-vision.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.parts[0].length > 32, true);
});

test('ambiguous inputs use one drop attempt rather than changing an unrelated form', () => {
  const { response, events, inputNodes } = runAttachment({ uploadInputs: 2 });
  assert.equal(response.mode, 'drop-attempt');
  assert.deepEqual(events, ['dragenter', 'dragover', 'drop']);
  assert.equal(inputNodes.every(node => node.files === null), true);
});

test('invalid PNG is rejected without dispatching DOM events', () => {
  const { response, events } = runAttachment({ imageData: 'data:image/png;base64,AAAA' });
  assert.equal(response.reason, 'invalid-png-file');
  assert.deepEqual(events, []);
});

test('Chrome receiver requires a user gesture and restricts injection to the active tab', () => {
  const folder = path.join(__dirname, '..', 'experiments/vision-chrome-receiver');
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.equal(manifest.content_scripts, undefined);

  const popup = fs.readFileSync(path.join(folder, 'popup.js'), 'utf8');
  assert.match(popup, /attachButton\.addEventListener\('click'/);
  assert.match(popup, /if \(!imageBlob \|\| !attachConsent\.checked/);
  assert.match(popup, /target: \{ tabId: tab\.id, allFrames: false \}/);
  assert.doesNotMatch(popup, /chrome\.storage\.(local|sync)/);
  assert.doesNotMatch(popup, /clipboard\.write/);
  const page = fs.readFileSync(path.join(folder, 'popup.html'), 'utf8');
  assert.match(page, /stylesheet" href="popup\.css"/);
  assert.doesNotMatch(page, /<style>/);
});
