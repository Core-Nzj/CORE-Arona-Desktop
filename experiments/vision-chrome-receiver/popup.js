'use strict';

const input = document.getElementById('token');
const button = document.getElementById('receive');
const status = document.getElementById('status');
const preview = document.getElementById('preview');
let url = null;

function clearPreview() {
  if (url) URL.revokeObjectURL(url);
  url = null;
  preview.hidden = true;
  preview.removeAttribute('src');
}
window.addEventListener('pagehide', clearPreview);

button.addEventListener('click', async () => {
  const token = input.value.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    status.textContent = 'FRAMEの認証コード（64文字）を貼り付けてください。';
    return;
  }
  button.disabled = true;
  status.textContent = 'FRAMEのRAMから受信しています…';
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
    if (!response.ok) throw new Error('HTTP ' + response.status +
      '（コード違い・期限切れ・FRAME停止を確認してください）');
    if (response.headers.get('content-type') !== 'image/png') {
      throw new Error('PNG以外のデータを受信しました');
    }
    const blob = await response.blob();
    if (blob.size < 33 || blob.size > 8 * 1024 * 1024) {
      throw new Error('受信画像のサイズが不正です');
    }
    const sig = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if ([137,80,78,71,13,10,26,10].some((b, i) => sig[i] !== b)) {
      throw new Error('画像データがPNGではありません');
    }
    url = URL.createObjectURL(blob);
    preview.src = url;
    preview.hidden = false;
    status.textContent = '受信成功（' + Math.round(blob.size / 1024) +
      ' KiB）。Chrome拡張内でのみ表示。ChatGPTへは未送信です。';
    input.value = '';
  } catch (error) {
    status.textContent = '受信失敗: ' + String(error?.message || error);
  } finally {
    button.disabled = false;
  }
});
