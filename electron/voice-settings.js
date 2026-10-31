'use strict';

const form = document.querySelector('#credentials');
const userInput = document.querySelector('#username');
const passwordInput = document.querySelector('#password');
const status = document.querySelector('#status');
const save = document.querySelector('#save');
const connect = document.querySelector('#connect');
const clear = document.querySelector('#clear');
const browserFill = document.querySelector('#browser-fill');

function setStatus(text, state = 'neutral') {
  status.textContent = text;
  status.dataset.state = state;
}

function display(info, message = '') {
  const proxy = info?.proxy || {};
  const lines = [];
  if (message) lines.push(message);
  lines.push('認証情報: ' + (info?.saved ? '暗号化して保存済み' : '未設定'));
  lines.push('Windows暗号化: ' + (info?.encryptionAvailable ? '利用可能' : '利用不可'));
  lines.push('Proxy: ' + (proxy.running
    ? (proxy.managed ? 'このアプリで起動中' : '既存プロセスに接続中')
    : '未接続'));
  if (proxy.error) lines.push('接続詳細: ' + proxy.error);
  lines.push('音声ライブラリ: ' + (info?.voice?.count ?? 0) + '件');
  if (info?.voice?.error) lines.push('VoiSona Talk: ' + info.voice.error);
  if (info?.error) lines.push('認証情報: ' + info.error);
  const failed = !!(proxy.error || info?.voice?.error || info?.error) || /失敗|できませんでした|接続できません/.test(message);
  setStatus(lines.join('\n'), failed ? 'error' : proxy.running ? 'online' : 'neutral');
  if (info?.username) userInput.value = info.username;
  passwordInput.placeholder = info?.saved ? '変更しなければ空欄で維持' : 'API用パスワード';
  clear.disabled = !info?.saved;
  save.disabled = info?.encryptionAvailable === false;
}

async function refresh(message = '') {
  try { display(await window.voiceSettings.status(), message); }
  catch (error) { setStatus(String(error?.message || error), 'error'); }
}

function busy(pending) {
  save.disabled = pending;
  connect.disabled = pending;
  clear.disabled = pending;
  browserFill.disabled = pending;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  busy(true);
  setStatus('暗号化して保存し、接続を確認しています...', 'pending');
  try {
    await window.voiceSettings.save(userInput.value, passwordInput.value);
    passwordInput.value = '';
    await refresh('保存しました。');
  } catch (error) {
    passwordInput.value = '';
    await refresh('保存または接続に失敗しました: ' + (error?.message || error));
  } finally { busy(false); }
});

connect.addEventListener('click', async () => {
  busy(true);
  setStatus('Proxyの起動・接続を確認しています...', 'pending');
  try {
    const state = await window.voiceSettings.connect();
    await refresh(state?.running ? '接続できました。' : 'Proxyに接続できませんでした。');
  } catch (error) {
    await refresh('接続確認に失敗しました: ' + (error?.message || error));
  } finally { busy(false); }
});

clear.addEventListener('click', async () => {
  busy(true);
  try {
    await window.voiceSettings.clear();
    passwordInput.value = '';
    userInput.value = '';
    await refresh('保存された認証情報を削除しました。');
  } catch (error) {
    await refresh('削除できませんでした: ' + (error?.message || error));
  } finally { busy(false); }
});

browserFill.addEventListener('click', async () => {
  busy(true);
  setStatus('ブラウザーに安全な一時入力フォームを開いています...', 'pending');
  try {
    await window.voiceSettings.openBrowserAutofill();
    await refresh('ブラウザーでAPIパスワードを入力してください（フォームは3分間有効です）。');
  } catch (error) {
    await refresh('ブラウザーを開けませんでした: ' + String(error?.message || error));
  } finally { busy(false); }
});

window.voiceSettings.onCredentialsImported(() => {
  passwordInput.value = '';
  void refresh('ブラウザーから認証情報を安全に保存しました。');
});

void refresh();
