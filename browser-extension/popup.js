'use strict';
const tokenInput = document.getElementById('token');
const enabledInput = document.getElementById('enabled');
const status = document.getElementById('status');
chrome.storage.local.get(['token', 'enabled']).then(({ token, enabled }) => {
  tokenInput.value = token || '';
  enabledInput.checked = enabled === true;
});
document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    status.textContent = '64文字のトークンを入力してください。';
    return;
  }
  await chrome.storage.local.set({ token, enabled: enabledInput.checked });
  status.textContent = '保存しました。ChatGPTのページを更新してください。';
});
