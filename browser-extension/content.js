'use strict';

// CORE VoiSona Reader v0.7 answer detector, carried into CORE-Arona-Desktop.
// Only the service-worker/player transport changes. Never read user prompts.
const ASSISTANT_UNIT = '[data-content-search-unit-key$=":assistant"]';
const CONTENT = [
  '.markdown', '.prose', '[data-testid="message-content"]',
  '[data-test-id="message-content"]', '[data-slot="message-content"]',
  '[data-message-content]'
].join(',');
const UI_TO_REMOVE = [
  'script', 'style', 'noscript', 'button', 'input', 'textarea', 'select',
  'nav', 'aside', 'figure', 'svg', 'canvas', 'video', 'audio',
  'pre', '.sr-only', '[aria-hidden="true"]', '[hidden]',
  '[contenteditable="true"]', '.turn-action-controls',
  '[data-user-message-bubble]', '[data-content-search-unit-key$=":user"]',
  '[data-message-author-role="user"]', '[data-turn="user"]',
  '[data-role="user"]', '[data-conversation-role="user"]',
  '[data-testid="conversation-turn-action-bar"]',
  '[role="status"]', '[role="toolbar"]'
].join(',');
const LABEL_RE = /^(?:(?:ChatGPTの発言|ChatGPTの回答|ChatGPT said|ChatGPT:|Assistant:|アシスタントの発言|アシスタントの回答)\s*[:：]?\s*)+/i;

function cleanText(raw) {
  const value = String(raw || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ')
    .trim().replace(LABEL_RE, '').trim();
  return /^(?:ChatGPTの発言|ChatGPTの回答|ChatGPT said|ChatGPT|Assistant|アシスタントの発言)[。:.：\s]*$/i.test(value)
    ? '' : value;
}

function safeText(element) {
  if (!element || element.matches('.sr-only, [aria-hidden="true"], [hidden]')) return '';
  const copy = element.cloneNode(true);
  copy.querySelectorAll(UI_TO_REMOVE).forEach(node => node.remove());
  copy.querySelectorAll('p,li,blockquote,h1,h2,h3,h4,h5,h6,br,tr,section,div')
    .forEach(node => node.appendChild(document.createTextNode(' ')));
  return cleanText(copy.textContent);
}

function contentText(root) {
  if (!root) return '';
  const targets = [...root.querySelectorAll(CONTENT)].filter(node =>
    !node.closest('[data-user-message-bubble], [data-content-search-unit-key$=":user"], [data-message-author-role="user"]'));
  const top = targets.filter(node => !targets.some(parent => parent !== node && parent.contains(node)));
  return cleanText(top.map(safeText).filter(Boolean).join(' ')) || safeText(root);
}

function groupText(group) {
  const units = [...group.querySelectorAll(ASSISTANT_UNIT)];
  if (units.length) {
    const text = cleanText(units.map(contentText).filter(Boolean).join(' '));
    if (text) return text;
  }
  const blocks = [...group.querySelectorAll(CONTENT)].filter(node =>
    !node.closest('[data-user-message-bubble], [data-content-search-unit-key$=":user"], [data-message-author-role="user"]'));
  const top = blocks.filter(node => !blocks.some(parent => parent !== node && parent.contains(node)));
  return cleanText(top.map(safeText).filter(Boolean).join(' ')) || safeText(group);
}

function assistantEntries() {
  const roots = [...document.querySelectorAll([
    '[data-turn-key]', 'article[data-turn="assistant"]',
    '[data-message-author-role="assistant"]',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-turn="assistant"]', '[data-role="assistant"]',
    '[data-message-author="assistant"]', '.agent-turn'
  ].join(','))];
  const result = [];
  for (const node of roots) {
    if (node.closest('nav, aside, [role="dialog"], [aria-hidden="true"]')) continue;
    if (node.matches('.sr-only, [hidden], [aria-hidden="true"]')) continue;
    const group = node.matches('[data-turn-key]');
    if (node.closest('[data-turn-key]') && !group) continue;
    if (group && !node.querySelector(
      ASSISTANT_UNIT + ', [data-conversation-role="assistant"], [data-chatgpt-agent-turn-start], [data-message-author-role="assistant"]'
    )) continue;
    if (!group && node.closest('article[data-turn="assistant"]') &&
        !node.matches('article[data-turn="assistant"]')) continue;
    if (!group && node.closest('[data-message-author-role="assistant"]') &&
        !node.matches('[data-message-author-role="assistant"]')) continue;
    const text = group ? groupText(node) : contentText(node);
    if (text) result.push({
      node, text, source: group ? 'turn-key' : node.matches(ASSISTANT_UNIT) ? 'assistant-unit' : 'legacy'
    });
  }
  return result;
}
function lastEntry() { return assistantEntries().at(-1) || null; }
function isGenerating() {
  return !!document.querySelector([
    '[data-testid="stop-button"]', 'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="生成を停止する"]',
    'button[aria-label="応答を停止"]'
  ].join(','));
}

const monitor = {
  ready: false, baselineNode: null, baselineText: '',
  armed: false, armReason: '', armTime: 0,
  observed: '', pending: '', changeAt: 0,
  streamId: '', streamOpen: false, nextSeq: 0, epoch: 0,
  lastAction: '初期化中', sentCount: 0, lastError: '',
  currentUrl: location.href, latestUser: '',
  muted: false, seenSnapshots: new Set(), seenParts: new Set(),
  lastFinishedAt: 0
};

let sendChain = Promise.resolve();
function queuedMessage(type, values = {}, epoch = monitor.epoch) {
  const task = sendChain.catch(() => {}).then(async () => {
    if (epoch !== monitor.epoch) return { skipped: true };
    const response = await chrome.runtime.sendMessage({ target: 'worker', type, ...values });
    if (!response?.ok && !response?.skipped) {
      throw new Error(response?.error || '音声送信失敗');
    }
    return response;
  });
  sendChain = task.catch(error => {
    if (epoch === monitor.epoch) {
      monitor.lastError = error.message || String(error);
      monitor.lastAction = '音声送信エラー: ' + monitor.lastError;
    }
  });
  return task;
}

function userSignature() {
  const units = document.querySelectorAll([
    '[data-content-search-unit-key$=":user"]',
    '[data-message-author-role="user"]',
    '[data-user-message-bubble]'
  ].join(','));
  const last = units[units.length - 1];
  return units.length + ':' + (last?.getAttribute('data-content-search-unit-key') ||
    last?.getAttribute('data-message-id') || last?.getAttribute('data-testid') || '');
}
function initialize() {
  const entry = lastEntry();
  monitor.baselineNode = entry?.node || null;
  monitor.baselineText = entry?.text || '';
  monitor.latestUser = userSignature();
  monitor.ready = true;
  monitor.lastAction = '監視中（読み込み済みの回答は再生しません）';
}
function arm(reason, { captureBaseline = true } = {}) {
  if (!monitor.ready) initialize();
  // One user action can fire both keyboard and button events; do not reset
  // the answer already being tracked for that same action.
  if (monitor.armed && Date.now() - monitor.armTime < 650) return;
  monitor.epoch++;
  void queuedMessage('STOP', {}, monitor.epoch);
  if (captureBaseline) {
    const old = lastEntry();
    monitor.baselineNode = old?.node || null;
    monitor.baselineText = old?.text || '';
  }
  monitor.armed = true;
  monitor.muted = false;
  monitor.armReason = reason;
  monitor.armTime = Date.now();
  monitor.observed = '';
  monitor.pending = '';
  monitor.changeAt = Date.now();
  monitor.streamId = '';
  monitor.streamOpen = false;
  monitor.nextSeq = 0;
  monitor.sentCount = 0;
  monitor.seenSnapshots = new Set();
  monitor.seenParts = new Set();
  monitor.lastFinishedAt = 0;
  monitor.lastError = '';
  monitor.lastAction = '新しい回答の表示を待機中 (' + reason + ')';
}
function cancelAuto(reason = '手動停止') {
  monitor.epoch++;
  monitor.armed = false;
  monitor.muted = true;
  monitor.pending = '';
  monitor.observed = '';
  monitor.streamOpen = false;
  monitor.streamId = '';
  monitor.lastAction = reason + '（次の送信まで自動再生しません）';
  const entry = lastEntry();
  monitor.baselineNode = entry?.node || null;
  monitor.baselineText = entry?.text || '';
}

function looksLikeEditor(node) {
  return node instanceof Element && !!node.closest('textarea, [contenteditable="true"], [role="textbox"]');
}
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
      looksLikeEditor(event.target)) arm('Enter送信');
}, true);
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button');
  if (!button) return;
  const identity = [button.getAttribute('data-testid'), button.getAttribute('aria-label'), button.title]
    .filter(Boolean).join(' ');
  if (/send-button|送信|send message|regenerate|再生成|retry|再試行/i.test(identity))
    arm('送信ボタン');
}, true);

function ensureStream() {
  if (monitor.streamOpen) return;
  monitor.streamId = Date.now() + '-' + Math.random().toString(36).slice(2);
  monitor.streamOpen = true;
  monitor.nextSeq = 0;
  void queuedMessage('STREAM_START', { streamId: monitor.streamId });
}
function emitPart(part) {
  part = cleanText(part);
  if (!part || part.length < 2 || monitor.muted) return;
  const key = part.replace(/\s+/g, ' ').trim();
  if (monitor.seenParts.has(key)) return;
  monitor.seenParts.add(key);
  ensureStream();
  monitor.sentCount++;
  monitor.lastAction = '逐次読み上げ送信（' + part.length +
    '文字・累計' + monitor.sentCount + '件）';
  void queuedMessage('STREAM_APPEND', {
    streamId: monitor.streamId, seq: monitor.nextSeq++, text: part.slice(0, 450)
  });
}
function drainSentences(force = false) {
  while (monitor.pending) {
    let end = 0;
    const sentence = /[。！？!?](?:[」』）"']+)?/u.exec(monitor.pending.slice(0, 220));
    if (sentence) end = sentence.index + sentence[0].length;
    if (!end && monitor.pending.length >= 190) {
      const head = monitor.pending.slice(0, 175);
      for (const mark of ['、', '，', '；', ' ', '。']) {
        const at = head.lastIndexOf(mark);
        if (at >= 65 && at + 1 > end) end = at + 1;
      }
      if (!end) end = 160;
    }
    if (!end && force) end = Math.min(monitor.pending.length, 180);
    if (!end) break;
    emitPart(monitor.pending.slice(0, end));
    monitor.pending = monitor.pending.slice(end).trimStart();
  }
}
function appendDelta(text) {
  if (!text) return;
  monitor.pending += text;
  monitor.changeAt = Date.now();
  drainSentences(false);
}
function currentReplyText(entry) {
  if (!entry || entry.text === monitor.baselineText) return '';
  if (entry.node === monitor.baselineNode && monitor.baselineText &&
      entry.text.startsWith(monitor.baselineText)) {
    return entry.text.slice(monitor.baselineText.length).trimStart();
  }
  return entry.text;
}
function scan() {
  if (!monitor.ready) return;
  if (location.href !== monitor.currentUrl) {
    monitor.currentUrl = location.href;
    if (!monitor.armed) { initialize(); return; }
  }
  const user = userSignature();
  // ChatGPT hydrates old messages asynchronously after F5/navigation.
  // A new user DOM node, a changed answer, or a stop-generation button
  // is NOT proof of an intentional new submission.
  // Only the real send/regenerate UI handlers above can arm automatic speech.
  if (user !== monitor.latestUser) monitor.latestUser = user;
  if (!monitor.armed) return;
  const entry = lastEntry();
  if (Date.now() - monitor.armTime > 1800000) {
    drainSentences(true);
    if (monitor.streamOpen) void queuedMessage('STREAM_END', { streamId: monitor.streamId });
    monitor.armed = false;
    monitor.lastAction = '30分経過のため監視を終了しました';
    return;
  }
  const text = currentReplyText(entry);
  if (text && text !== monitor.observed && !monitor.seenSnapshots.has(text)) {
    monitor.seenSnapshots.add(text);
    if (monitor.seenSnapshots.size > 500) monitor.seenSnapshots.delete(monitor.seenSnapshots.values().next().value);
    if (text.startsWith(monitor.observed)) {
      appendDelta(text.slice(monitor.observed.length));
      monitor.observed = text;
    } else if (monitor.observed.startsWith(text)) {
      monitor.lastAction = '画面再描画中（短縮分を読み直しません）';
    } else {
      const old = monitor.observed;
      let common = 0;
      while (common < old.length && common < text.length && old[common] === text[common]) common++;
      if (common >= Math.min(old.length, text.length) * 0.65) {
        appendDelta(text.slice(common));
      } else {
        drainSentences(true);
        appendDelta(text);
      }
      monitor.observed = text;
    }
    monitor.lastFinishedAt = 0;
  }
  const stableFor = Date.now() - monitor.changeAt;
  if (monitor.pending && (stableFor > 3000 ||
      (stableFor > 1600 && monitor.pending.length >= 16))) drainSentences(true);
  if (!isGenerating() && stableFor > 9000 &&
      monitor.streamOpen && !monitor.lastFinishedAt) {
    monitor.lastFinishedAt = Date.now();
    monitor.lastAction = '入力待ち（新しい文字が現れれば続きだけ読みます）';
  }
}
// A refresh/navigation must not leave the previous page's playback running.
// The browser may terminate content scripts during pagehide, so this is best-effort.
window.addEventListener('pagehide', () => {
  if (!monitor.armed && !monitor.streamOpen) return;
  cancelAuto('ページ再読み込み');
  void chrome.runtime.sendMessage({ target: 'worker', type: 'STOP' }).catch(() => {});
});

initialize();
setInterval(scan, 450);

function diagnostics() {
  const entries = assistantEntries();
  const counts = Object.fromEntries([
    ['旧形式 assistant', '[data-message-author-role="assistant"]'],
    ['新形式 assistant', '[data-conversation-role="assistant"]'],
    ['assistant-unit', ASSISTANT_UNIT],
    ['turn-key', '[data-turn-key]'],
    ['turn article', '[data-testid^="conversation-turn-"]'],
    ['agent marker', '[data-chatgpt-agent-turn-start]']
  ].map(([name, selector]) => [name, document.querySelectorAll(selector).length]));
  return {
    counts,
    assistantCandidates: entries.length,
    lastTextChars: entries.at(-1)?.text.length || 0,
    lastSource: entries.at(-1)?.source || 'なし',
    selectionChars: (window.getSelection()?.toString() || '').trim().length,
    mainTextChars: document.querySelector('main')?.innerText?.length || 0,
    generating: isGenerating(),
    auto: {
      ready: monitor.ready, armed: monitor.armed, muted: monitor.muted,
      armReason: monitor.armReason, lastAction: monitor.lastAction,
      sentCount: monitor.sentCount, candidateChars: monitor.pending.length,
      lastError: monitor.lastError, streaming: monitor.streamOpen,
      sentPieces: monitor.sentCount, observedChars: monitor.observed.length
    },
    url: location.origin + location.pathname
  };
}
function speak(text, respond) {
  chrome.runtime.sendMessage({ target: 'worker', type: 'SPEAK', text, manual: true })
    .then(respond).catch(error => respond({ ok: false, error: error.message }));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.manualStopToken?.newValue) cancelAuto('手動停止');
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message?.type) return false;
  if (message.type === 'CANCEL_AUTO') {
    cancelAuto('手動停止'); respond({ ok: true }); return false;
  }
  if (message.type === 'DIAG') {
    respond({ ok: true, diagnostic: diagnostics() }); return false;
  }
  if (message.type === 'READ_SELECTION') {
    const text = (window.getSelection()?.toString() || '').trim();
    if (!text) { respond({ ok: false, error: '文章を選択してください。' }); return false; }
    speak(text, respond); return true;
  }
  if (message.type === 'TEST_AUTO') {
    const text = lastEntry()?.text || '';
    if (!text) { respond({ ok: false, error: '回答本文が見つかりません。' }); return false; }
    chrome.runtime.sendMessage({ target: 'worker', type: 'SPEAK', text, manual: false })
      .then(respond).catch(error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type !== 'READ_LAST') return false;
  const text = lastEntry()?.text || '';
  if (!text) {
    respond({ ok: false, error: '回答本文を検出できません。画面診断を確認してください。' });
    return false;
  }
  speak(text, respond);
  return true;
});
