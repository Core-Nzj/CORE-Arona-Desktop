'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..',
  'experiments/vision-chrome-receiver/chatgpt-send.js'), 'utf8');
const URL = 'https://chatgpt.com/c/frame-test';

function rig({ hostname = 'chatgpt.com', text = '', existingFile = false,
  ownPng = true, sendEnabled = true, hasForm = true, url = URL,
  newThumbnailAfter = null, uploadingFor = 0, baselineThumbnail = false } = {}) {
  let clicked = 0;
  let clock = 0;
  let imageChecks = 0;
  const sendButton = {
    disabled: !sendEnabled,
    isConnected: true,
    getAttribute() { return null; },
    click() { clicked++; }
  };
  const textarea = { value: '' };
  const form = {
    querySelector(selector) {
      if (selector.includes('send-button')) return sendButton;
      if (selector.includes('progressbar') || selector.includes('upload-progress')) {
        return imageChecks <= uploadingFor ? { getAttribute: () => 'loading' } : null;
      }
      if (selector.includes('attachment') || selector.includes('file-chip')) {
        return existingFile ? { getAttribute: () => 'other.png' } : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'textarea') return [textarea];
      if (selector === '[role="group"][aria-label]') {
        return ownPng ? [{ getAttribute: () => 'FRAME-vision.png' }] : [];
      }
      if (selector === 'img') {
        imageChecks++;
        const source = baselineThumbnail ? 'blob:before' :
          newThumbnailAfter !== null && imageChecks >= newThumbnailAfter ?
            'blob:frame-upload' : null;
        return source ? [{
          currentSrc: source, complete: true, naturalWidth: 480,
          closest: () => null, getAttribute: () => source
        }] : [];
      }
      return [];
    }
  };
  const editor = {
    innerText: text,
    textContent: text,
    closest(selector) { return selector === 'form' && hasForm ? form : null; }
  };
  const files = existingFile ? [{ name: 'previous.png', type: 'image/png' }] :
    ownPng ? [{ name: 'FRAME-vision.png', type: 'image/png' }] : [];
  const document = {
    querySelector(selector) {
      if (selector === '#prompt-textarea') return editor;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') {
        return [{ files }];
      }
      return [];
    }
  };
  const location = { protocol: 'https:', hostname, href: url };
  const DateFake = { now() { return clock += 5000; } };
  const sandbox = {
    location, document, Date: DateFake,
    setTimeout(callback) { Promise.resolve().then(callback); },
    module: { exports: {} }
  };
  vm.runInNewContext(source, sandbox, { filename: 'chatgpt-send.js' });
  return {
    funcs: sandbox.module.exports, location,
    getClicks: () => clicked
  };
}

test('no existing draft permits an explicit image-only send', async () => {
  // Before uploading, there must be no file in the composer.
  const before = rig({ ownPng: false, sendEnabled: false });
  assert.equal(before.funcs.frameVerifyEmptyChatGPTComposer().ok, true);

  const after = rig();
  const result = await after.funcs.frameSendPreparedImageToChatGPT(URL);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'send-clicked');
  assert.equal(after.getClicks(), 1);
});

test('preflight refuses existing text and attachment', () => {
  const text = rig({ text: 'ユーザーの未送信メッセージ' });
  assert.equal(text.funcs.frameVerifyEmptyChatGPTComposer().reason, 'existing-text');
  const file = rig({ existingFile: true });
  assert.equal(file.funcs.frameVerifyEmptyChatGPTComposer().reason, 'existing-attachment');
  assert.equal(text.getClicks() + file.getClicks(), 0);
});

test('send refuses typed draft appearing after attachment', async () => {
  const rigged = rig({ text: 'later message' });
  const response = await rigged.funcs.frameSendPreparedImageToChatGPT(URL);
  assert.equal(response.reason, 'text-added');
  assert.equal(rigged.getClicks(), 0);
});

test('another attachment added after preflight blocks image send', async () => {
  const rigged = rig({ existingFile: true });
  const response = await rigged.funcs.frameSendPreparedImageToChatGPT(URL);
  assert.equal(response.reason, 'other-attachment-added');
  assert.equal(rigged.getClicks(), 0);
});

test('no matching file and no enabled send button means no click', async () => {
  const rigged = rig({ ownPng: false, sendEnabled: false });
  const response = await rigged.funcs.frameSendPreparedImageToChatGPT(URL);
  assert.equal(response.reason, 'attachment-not-ready');
  assert.equal(rigged.getClicks(), 0);
});

test('late ChatGPT thumbnail after cleared input is eventually accepted', async () => {
  const rigged = rig({ ownPng: false, sendEnabled: true, newThumbnailAfter: 3 });
  const result = await rigged.funcs.frameSendPreparedImageToChatGPT(URL, []);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'send-clicked');
  assert.equal(rigged.getClicks(), 1);
});

test('unchanged pre-existing image is not mistaken for our attachment', async () => {
  const rigged = rig({ ownPng: false, sendEnabled: true, baselineThumbnail: true });
  const result = await rigged.funcs.frameSendPreparedImageToChatGPT(URL, ['blob:before']);
  assert.equal(result.reason, 'attachment-not-ready');
  assert.equal(result.diagnostics.imageDetected, false);
  assert.equal(rigged.getClicks(), 0);
});

test('progress indicator blocks premature send despite an enabled button', async () => {
  const rigged = rig({ ownPng: false, sendEnabled: true,
    newThumbnailAfter: 1, uploadingFor: 100 });
  const result = await rigged.funcs.frameSendPreparedImageToChatGPT(URL, []);
  assert.equal(result.reason, 'attachment-not-ready');
  assert.equal(result.diagnostics.imageDetected, true);
  assert.equal(result.diagnostics.uploading, true);
  assert.equal(rigged.getClicks(), 0);
});

test('a changed conversation or foreign site never receives a click', async () => {
  const changed = rig({ url: 'https://chatgpt.com/c/other' });
  const res = await changed.funcs.frameSendPreparedImageToChatGPT(URL);
  assert.equal(res.reason, 'conversation-changed');
  assert.equal(changed.getClicks(), 0);

  const foreign = rig({ hostname: 'example.org', url: 'https://example.org' });
  const denied = await foreign.funcs.frameSendPreparedImageToChatGPT('https://example.org');
  assert.equal(denied.reason, 'wrong-origin');
  assert.equal(foreign.getClicks(), 0);
});

test('HTML and popup require a separate send confirmation, without Enter fallback', () => {
  const folder = path.join(__dirname, '..', 'experiments/vision-chrome-receiver');
  const html = fs.readFileSync(path.join(folder, 'popup.html'), 'utf8');
  const popup = fs.readFileSync(path.join(folder, 'popup.js'), 'utf8');
  assert.match(html, /id="send-consent"/);
  assert.match(html, /id="send-image"/);
  assert.match(html, /src="chatgpt-send\.js"/);
  assert.match(popup, /sendButton\.addEventListener\('click'/);
  assert.match(popup, /!imageBlob \|\| !sendConsent\.checked/);
  assert.match(popup, /func: frameVerifyEmptyChatGPTComposer/);
  assert.match(popup, /func: frameSendPreparedImageToChatGPT/);
  assert.doesNotMatch(source, /dispatchEvent\(new KeyboardEvent/);
  assert.doesNotMatch(source, /form\.submit\(/);
});
