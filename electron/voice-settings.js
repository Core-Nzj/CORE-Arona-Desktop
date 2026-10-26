'use strict';

const form = document.querySelector('#credentials');
const userInput = document.querySelector('#username');
const passwordInput = document.querySelector('#password');
const status = document.querySelector('#status');
const save = document.querySelector('#save');
const connect = document.querySelector('#connect');
const clear = document.querySelector('#clear');

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
  status.textContent = lines.join('\n');
  if (info?.username) userInput.value = info.username;
  passwordInput.placeholder = info?.saved ? '変更しなければ空欄で維持' : 'API用パスワード';
  clear.disabled = !info?.saved;
  save.disabled = info?.encryptionAvailable === false;
}

async function refresh(message = '') {
  try { display(await window.voiceSettings.status(), message); }
  catch (error) { status.textContent = String(error?.message || error); }
}

function busy(pending) {
  save.disabled = pending;
  connect.disabled = pending;
  clear.disabled = pending;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  busy(true);
  status.textContent = '暗号化して保存し、接続を確認しています...';
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
  status.textContent = 'Proxyの起動・接続を確認しています...';
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

void refresh();
