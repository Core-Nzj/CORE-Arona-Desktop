'use strict';

// Adapted from CORE VoiSona Reader v0.7's stream state machine.
// Only the player transport changed: Chrome offscreen -> desktop loopback.
const BASE = 'http://127.0.0.1:32779/command';
const activeStreamByTab = new Map();
const canceledStreamIds = new Set();

function tabId(sender) { return sender.tab?.id ?? -1; }
function allowedChatTab(sender) {
  const url = sender.url || sender.tab?.url;
  if (!url) return false;
  try { return ['chatgpt.com', 'chat.openai.com'].includes(new URL(url).hostname); }
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
async function enabled() {
  const prefs = await chrome.storage.local.get({ enabled: false, autoRead: true });
  return prefs.enabled === true && prefs.autoRead !== false;
}
let playbackTransport = Promise.resolve();
async function desktopCommand(payload) {
  if (['SPEAK', 'STREAM_START', 'STREAM_APPEND', 'STREAM_END', 'STOP'].includes(payload.type)) {
    // Manual STOP must not be overtaken by an earlier, delayed HTTP request.
    const request = playbackTransport.catch(() => {}).then(() => sendDesktopRequest(payload));
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
      if (!request.manual && !(await enabled())) return { ok: true, skipped: true };
      if (typeof request.text !== 'string' || !request.text.trim()) {
        throw new Error('読み上げる文章がありません');
      }
      const { voice = null, voiceProfiles = {} } = await chrome.storage.local.get({
        voice: null, voiceProfiles: {}
      });
      return desktopCommand({
        type, text: request.text.slice(0, 9000), voice, voiceProfiles
      });
    }
    case 'STREAM_START': {
      if (!(await enabled())) return { ok: true, skipped: true };
      const { streamId } = request;
      if (typeof streamId !== 'string' || !streamId || streamId.length > 100) {
        throw new Error('不正なstreamIdです');
      }
      if (canceledStreamIds.has(streamId)) return { ok: true, skipped: true };
      const { voice = null, voiceProfiles = {} } = await chrome.storage.local.get({
        voice: null, voiceProfiles: {}
      });
      activeStreamByTab.set(tabId(sender), streamId);
      return desktopCommand({ type, streamId, voice, voiceProfiles });
    }
    case 'STREAM_APPEND': {
      if (!(await enabled())) return { ok: true, skipped: true };
      const { streamId, seq, text } = request;
      if (typeof streamId !== 'string' || typeof text !== 'string' ||
          !Number.isSafeInteger(seq) || seq < 0) throw new Error('ストリーム情報が不正です');
      if (canceledStreamIds.has(streamId) || activeStreamByTab.get(tabId(sender)) !== streamId) {
        return { ok: true, skipped: true };
      }
      return desktopCommand({ type, streamId, seq, text: text.slice(0, 480) });
    }
    case 'STREAM_END': {
      if (activeStreamByTab.get(tabId(sender)) !== request.streamId) {
        return { ok: true, skipped: true };
      }
      const result = await desktopCommand({ type, streamId: request.streamId });
      blockStream(request.streamId);
      activeStreamByTab.delete(tabId(sender));
      return result;
    }
    case 'STOP': {
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
