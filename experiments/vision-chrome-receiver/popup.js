'use strict';

const input = document.getElementById('token');
const receiveButton = document.getElementById('receive');
const status = document.getElementById('status');
const preview = document.getElementById('preview');
const attachmentPanel = document.getElementById('attachment-panel');
const targetLabel = document.getElementById('target');
const attachConsent = document.getElementById('attach-consent');
const attachButton = document.getElementById('attach');
const attachStatus = document.getElementById('attach-status');
const discardButton = document.getElementById('discard');

let imageBlob = null;
let previewUrl = null;
let attachmentBusy = false;

function isChatGPTTab(tab) {
  if (!Number.isSafeInteger(tab?.id) || typeof tab.url !== 'string') return false;
  try {
    const address = new URL(tab.url);
    return address.protocol === 'https:' && address.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

async function activeChatGPTTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  return isChatGPTTab(tab) ? tab : null;
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  imageBlob = null;
  preview.hidden = true;
  preview.removeAttribute('src');
  attachmentPanel.hidden = true;
  attachConsent.checked = false;
  attachConsent.disabled = true;
  attachButton.disabled = true;
  attachStatus.textContent = '';
  targetLabel.textContent = '';
}
window.addEventListener('pagehide', clearPreview);

async function updateTarget() {
  if (!imageBlob) return;
  let tab;
  try { tab = await activeChatGPTTab(); } catch { tab = null; }
  targetLabel.textContent = tab
    ? '現在のChatGPTタブ: ' + (tab.title || 'ChatGPT')
    : 'ChatGPTの会話タブを開いてから、拡張アイコンを押してください。';
  attachConsent.disabled = !tab || attachmentBusy;
  attachButton.disabled = !tab || !attachConsent.checked || attachmentBusy;
}

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('画像をメモリ上で読み取れませんでした'));
    reader.readAsDataURL(blob);
  });
}

attachConsent.addEventListener('change', () => { void updateTarget(); });

discardButton.addEventListener('click', () => {
  if (attachmentBusy) return;
  clearPreview();
  status.textContent = 'Chrome拡張内の撮影画像を破棄しました。';
});

receiveButton.addEventListener('click', async () => {
  const token = input.value.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    status.textContent = 'FRAMEの認証コード（64文字）を貼り付けてください。';
    return;
  }
  receiveButton.disabled = true;
  status.textContent = 'FRAMEから受信しています…';
  clearPreview();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch('http://127.0.0.1:32780/take', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error('HTTP ' + response.status +
        '（コード違い・期限切れ・FRAME停止を確認してください）');
    }
    if (response.headers.get('content-type') !== 'image/png') {
      throw new Error('PNG以外のデータを受信しました');
    }
    const blob = await response.blob();
    if (blob.size < 33 || blob.size > 8 * 1024 * 1024) {
      throw new Error('受信画像のサイズが不正です');
    }
    const sig = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if ([137, 80, 78, 71, 13, 10, 26, 10].some((b, i) => sig[i] !== b)) {
      throw new Error('画像データがPNGではありません');
    }
    imageBlob = blob;
    previewUrl = URL.createObjectURL(blob);
    preview.src = previewUrl;
    preview.hidden = false;
    attachmentPanel.hidden = false;
    status.textContent = 'Chrome受信成功（' + Math.round(blob.size / 1024) +
      ' KiB）。ChatGPTへはまだ添付していません。';
    input.value = '';
    await updateTarget();
  } catch (error) {
    status.textContent = '受信失敗: ' + String(error?.message || error);
  } finally {
    receiveButton.disabled = false;
  }
});

attachButton.addEventListener('click', async () => {
  if (!imageBlob || !attachConsent.checked || attachmentBusy) return;
  attachmentBusy = true;
  attachButton.disabled = true;
  attachConsent.disabled = true;
  discardButton.disabled = true;
  attachStatus.textContent = 'ChatGPTの入力欄へ画像を渡しています…';
  try {
    // Validate again at the moment of handoff; never inject into another site.
    const tab = await activeChatGPTTab();
    if (!tab) throw new Error('現在のタブがChatGPTではありません');
    const dataUrl = await readDataUrl(imageBlob);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('PNGを読み込めませんでした');
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: frameAttachPngToChatGPT,
      args: [dataUrl],
      world: 'ISOLATED'
    });
    const outcome = results?.[0]?.result;
    if (!outcome?.ok) {
      const reasons = {
        'wrong-origin': '対象がChatGPTではありません',
        'invalid-png-data': '画像データが不正です',
        'invalid-png-base64': '画像を復元できません',
        'invalid-png-file': 'PNGの検証に失敗しました',
        'composer-not-found': 'ChatGPTの入力欄が見つかりません',
        'file-input-rejected': 'ChatGPT側がファイル入力を拒否しました',
        'no-compatible-upload-control': '対応する添付操作が見つかりません'
      };
      throw new Error(reasons[outcome?.reason] || 'ChatGPTへの添付操作を実行できませんでした');
    }
    const mode = outcome.mode === 'file-input' ? 'ファイル入力' : 'ドラッグ＆ドロップ';
    attachStatus.textContent = mode + 'で添付操作を実行しました。ChatGPTの入力欄に画像のプレビューが追加されたか確認してください。メッセージの送信は行っていません。';
    // A fresh confirmation is needed for a retry, to avoid accidental duplicates.
    attachConsent.checked = false;
  } catch (error) {
    attachStatus.textContent = '添付失敗: ' + String(error?.message || error);
  } finally {
    attachmentBusy = false;
    discardButton.disabled = false;
    await updateTarget();
  }
});
