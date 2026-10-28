'use strict';

// Adapted from CORE VoiSona Reader v0.7's stream state machine.
// Only the player transport changed: Chrome offscreen -> desktop loopback.
const BASE = 'http://127.0.0.1:32779/command';
const activeStreamByTab = new Map();
const canceledStreamIds = new Set();
let outputOwnerTabId = null;
const CHAT_HOSTS = ['chatgpt.com', 'chat.openai.com'];

function tabId(sender) { return sender.tab?.id ?? -1; }
function allowedChatTab(sender) {
  const url = sender.url || sender.tab?.url;
  if (!url) return false;
  try { return CHAT_HOSTS.includes(new URL(url).hostname); }
  catch { return false; }
}
function blockStream(id) {
  if (!id) return;
  canceledStreamIds.add(id);
  if (canceledStreamIds.size > 250) canceledStreamIds.delete(canceledStreamIds.values().next().value);
}
async function setStatus(message) {
  await chrome.storage.local.set({ status: String(message), statusAt: Date.now() });
}
// Modes persist across browser restarts. Tab IDs live in session storage to
// avoid accidentally enabling unrelated tabs when Chrome recycles an ID.
async function enabledFor(sender) {
  const prefs = await chrome.storage.local.get({
    readingMode: null, enabled: false, autoRead: true
  });
  const mode = ['all', 'selected', 'off'].includes(prefs.readingMode)
    ? prefs.readingMode
    : (prefs.enabled === true && prefs.autoRead !== false ? 'all' : 'off');
  if (mode === 'all') return true;
  if (mode !== 'selected') return false;
  const id = tabId(sender);
  if (!Number.isInteger(id) || id < 0) return false;
  const { selectedTabIds = [] } = await chrome.storage.session.get({ selectedTabIds: [] });
  return Array.isArray(selectedTabIds) && selectedTabIds.includes(id);
}
// F5/navigation must not stop another tab's audio. This check runs inside
// the same serialized transport used for all playback commands.
async function stopIfOwner(id) {
  const task = playbackTransport.catch(() => {}).then(async () => {
    if (outputOwnerTabId !== id) return { ok: true, skipped: true };
    const result = await sendDesktopRequest({ type: 'STOP' });
    outputOwnerTabId = null;
    return result;
  });
  playbackTransport = task.catch(() => {});
  return task;
}
function abandonTab(id) {
  const stream = activeStreamByTab.get(id);
  if (stream) blockStream(stream);
  activeStreamByTab.delete(id);
}
chrome.tabs.onRemoved.addListener(id => {
  abandonTab(id);
  void chrome.storage.session.get({ selectedTabIds: [] }).then(({ selectedTabIds }) => {
    if (!Array.isArray(selectedTabIds) || !selectedTabIds.includes(id)) return;
    return chrome.storage.session.set({ selectedTabIds: selectedTabIds.filter(item => item !== id) });
  }).catch(() => {});
});
let playbackTransport = Promise.resolve();
async function desktopCommand(payload, ownerTabId = null) {
  if (['SPEAK', 'STREAM_START', 'STREAM_APPEND', 'STREAM_END', 'STOP'].includes(payload.type)) {
    // Preserve order across tabs; update ownership after the request arrives.
    const request = playbackTransport.catch(() => {}).then(async () => {
      const result = await sendDesktopRequest(payload);
      if (payload.type === 'STREAM_START' || payload.type === 'SPEAK') {
        outputOwnerTabId = ownerTabId;
      } else if (payload.type === 'STOP') outputOwnerTabId = null;
      return result;
    });
    playbackTransport = request.catch(() => {});
    return request;
  }
  return sendDesktopRequest(payload);
}
async function sendDesktopRequest(payload) {
  const { token } = await chrome.storage.local.get('token');
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    throw new Error('アロナ本体との接続トークンを設定してください');
  }
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  let result;
  try { result = await res.json(); }
  catch { throw new Error('アロナ本体から正しい応答がありません (HTTP ' + res.status + ')'); }
  if (!res.ok || !result.ok) throw new Error(result?.error || 'アロナ本体 HTTP ' + res.status);
  return result;
}
async function handle(request, sender) {
  const type = request?.type;
  if (!type) throw new Error('コマンドを指定してください');
  if ((type.startsWith('STREAM_') || type === 'SPEAK' && sender.tab) && !allowedChatTab(sender)) {
    throw new Error('ChatGPT以外のタブからは読み上げできません');
  }
  switch (type) {
    case 'PING_PROXY':
      return desktopCommand({ type });
    case 'GET_VOICES':
      return desktopCommand({ type });
    case 'GET_STYLE_META': {
      return desktopCommand({
        type, username: request.username, password: request.password,
        voice_name: request.voice_name, voice_version: request.voice_version
      });
    }
    case 'SPEAK': {
      if (!request.manual && !(await enabledFor(sender))) return { ok: true, skipped: true };
      if (typeof request.text !== 'string' || !request.text.trim()) {
        throw new Error('読み上げる文章がありません');
      }
      const { voice = null, voiceProfiles = {} } = await chrome.storage.local.get({
        voice: null, voiceProfiles: {}
      });
      return desktopCommand({
        type, text: request.text.slice(0, 9000), voice, voiceProfiles
      }, sender.tab ? tabId(sender) : null);
    }
    case 'STREAM_START': {
      if (!(await enabledFor(sender))) return { ok: true, skipped: true };
      const { streamId } = request;
      if (typeof streamId !== 'string' || !streamId || streamId.length > 100) {
        throw new Error('不正なstreamIdです');
      }
      if (canceledStreamIds.has(streamId)) return { ok: true, skipped: true };
      const { voice = null, voiceProfiles = {} } = await chrome.storage.local.get({
        voice: null, voiceProfiles: {}
      });
      activeStreamByTab.set(tabId(sender), streamId);
      return desktopCommand({ type, streamId, voice, voiceProfiles }, tabId(sender));
    }
    case 'STREAM_APPEND': {
      if (!(await enabledFor(sender))) {
        abandonTab(tabId(sender));
        return { ok: true, skipped: true };
      }
      const { streamId, seq, text } = request;
      if (typeof streamId !== 'string' || typeof text !== 'string' ||
          !Number.isSafeInteger(seq) || seq < 0) throw new Error('ストリーム情報が不正です');
      if (canceledStreamIds.has(streamId) || activeStreamByTab.get(tabId(sender)) !== streamId) {
        return { ok: true, skipped: true };
      }
      return desktopCommand({ type, streamId, seq, text: text.slice(0, 480) });
    }
    case 'STREAM_END': {
      if (!(await enabledFor(sender))) {
        abandonTab(tabId(sender));
        return { ok: true, skipped: true };
      }
      if (activeStreamByTab.get(tabId(sender)) !== request.streamId) {
        return { ok: true, skipped: true };
      }
      const result = await desktopCommand({ type, streamId: request.streamId });
      blockStream(request.streamId);
      activeStreamByTab.delete(tabId(sender));
      return result;
    }
    case 'STOP': {
      if (sender.tab && !request.manual) {
        // A pagehide/F5 STOP is scoped to the initiating tab.
        const id = tabId(sender);
        abandonTab(id);
        return stopIfOwner(id);
      }
      for (const id of activeStreamByTab.values()) blockStream(id);
      activeStreamByTab.clear();
      if (request.manual) {
        await chrome.storage.local.set({ manualStopToken: Date.now() + '-' + Math.random() });
      }
      const response = await desktopCommand({ type });
      await setStatus('停止しました');
      return response;
    }
    default:
      throw new Error('未対応の操作です');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'worker') return false;
  handle(message, sender).then(
    value => sendResponse(value),
    error => {
      const description = String(error?.message ?? error);
      void setStatus('エラー: ' + description);
      sendResponse({ ok: false, error: description });
    }
  );
  return true;
});
