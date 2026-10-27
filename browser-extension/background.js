'use strict';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'speak') return false;
  // A content script has sender.url even when the extension lacks tabs access.
  const sourceUrl = sender.url || sender.tab?.url;
  if (!sourceUrl) return false;
  let hostname;
  try { hostname = new URL(sourceUrl).hostname; } catch { return false; }
  if (!['chatgpt.com', 'chat.openai.com'].includes(hostname)) return false;
  if (typeof message.text !== 'string' || message.text.length < 1 || message.text.length > 500) return false;
  (async () => {
    const { token, enabled } = await chrome.storage.local.get(['token', 'enabled']);
    if (!enabled || !/^[a-f0-9]{64}$/.test(token || '')) return { ok: false, error: '連携設定が未完了です' };
    const response = await fetch('http://127.0.0.1:32779/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ text: message.text }),
      signal: AbortSignal.timeout(8000)
    });
    return { ok: response.ok, error: response.ok ? '' : 'HTTP ' + response.status };
  })().then(respond, error => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
