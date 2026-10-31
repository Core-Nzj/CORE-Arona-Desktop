'use strict';

const feedback = document.getElementById('feedback');
const voiceList = document.getElementById('voice-list');
const emotionList = document.getElementById('emotion-list');
const motionList = document.getElementById('motion-list');
let busy = false;
let selectedWindowId = null;
let selectedWindowPluginId = null;
let captureBusy = false;
let lastCaptureRequest = null;
let lastPluginError = '';
let currentState = null;

function message(value, error = false) {
  feedback.textContent = value;
  feedback.classList.toggle('error', error);
}
function tabTo(name) {
  for (const panel of document.querySelectorAll('[data-page]')) {
    panel.hidden = panel.dataset.page !== name;
  }
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', String(active));
  }
}
function makeOption(label, id, selected, enabled, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'option' + (selected ? ' selected' : '');
  element.disabled = !enabled;
  element.dataset.action = action;
  element.dataset.value = id;
  element.setAttribute('aria-pressed', String(selected));
  const text = document.createElement('span');
  text.textContent = label; // Never interpret voice/model names as HTML.
  element.appendChild(text);
  return element;
}
function renderState(state) {
  if (!state || typeof state !== 'object') return;
  currentState = state;
  document.getElementById('model-name').textContent = state.modelName || '未選択';
  document.getElementById('motion-status').textContent = state.motionStatus || '標準待機モーション';
  const library = state.motionLibrary || {};
  const entries = Array.isArray(library.entries) ? library.entries : [];
  const selected = entries.find(entry => entry.id === library.selectedId);
  const selectedIdle = entries.find(entry => entry.id === library.idleId);
  document.getElementById('motion-count').textContent = entries.length + '件';
  document.getElementById('motion-folder').textContent = library.directory || 'フォルダ未設定';
  document.getElementById('motion-library-status').textContent = library.message || '';
  document.getElementById('motion-selected').textContent = '選択中: ' + (selected?.name || 'なし');
  document.getElementById('motion-idle').textContent = '待機: ' +
    (selectedIdle?.name || (library.idleId ? '保存されたファイルが見つかりません' : '標準'));
  document.getElementById('motion-set-idle').disabled = !selected;
  for (const action of ['motion.next', 'motion.previous']) {
    document.querySelector('[data-action="' + action + '"]').disabled = !entries.length;
  }
  const priorScroll = motionList.scrollTop;
  const buttons = entries.map(entry => {
    const active = entry.id === library.selectedId;
    const item = makeOption(entry.name, entry.id, active, true, 'motion.preview');
    item.classList.add('motion-option');
    item.title = entry.group ? entry.group + '/' + entry.name : entry.name;
    if (entry.group) {
      const group = document.createElement('small');
      group.textContent = entry.group;
      item.appendChild(group);
    }
    if (entry.id === library.idleId) {
      const pin = document.createElement('span');
      pin.className = 'motion-pin';
      pin.textContent = '待機';
      item.appendChild(pin);
    }
    return item;
  });
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'VMDがありません。フォルダを指定してください。';
    buttons.push(empty);
  }
  motionList.replaceChildren(...buttons);
  motionList.scrollTop = priorScroll;
  const activeButton = motionList.querySelector('.motion-option.selected');
  if (activeButton) activeButton.scrollIntoView({ block: 'nearest' });
  document.getElementById('voice-status').textContent = state.voiceStatus || '未接続';
  document.getElementById('voice-light').classList.toggle('online', !!state.voiceReady);
  const app = state.voisona || {};
  const engineStatus = !app.supported ? 'Windowsのみ対応' :
    app.running ? (!app.hasWindow ? '起動中・メイン画面未検出（操作を保留）' :
      '起動中 (' + (app.managed ? 'アロナ管理' : '既存プロセス') +
      (app.visible ? '・表示中)' : '・非表示)')) :
      (app.error ? '未起動: ' + app.error : '停止中');
  document.getElementById('voisona-status').textContent = engineStatus;
  document.getElementById('voisona-light').classList.toggle('online', !!app.running);
  document.getElementById('voisona-autostart').textContent = '自動起動 ' + (app.autoStart ? 'ON' : 'OFF');
  document.getElementById('voisona-autohide').textContent = '自動非表示 ' + (app.autoHide ? 'ON' : 'OFF');
  document.getElementById('voisona-autostart').setAttribute('aria-pressed', String(!!app.autoStart));
  document.getElementById('voisona-autohide').setAttribute('aria-pressed', String(!!app.autoHide));
  // Launch is only available while VoiSona Talk is stopped.
  // A missing main window does not mean the process has stopped.
  document.querySelector('[data-action="voice.appStart"]').disabled =
    !!app.running || app.supported === false;
  document.getElementById('voisona-show').disabled = !app.running || !app.hasWindow;
  document.getElementById('voisona-hide').disabled = !app.running || !app.hasWindow || !app.visible;
  const voices = Array.isArray(state.voices) ? state.voices : [];
  const voiceButtons = voices.map(voice =>
    makeOption(voice.name, voice.name, !!voice.selected, true, 'voice.select'));
  if (!voices.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '音声ライブラリがありません';
    voiceButtons.push(empty);
  }
  voiceList.replaceChildren(...voiceButtons);
  document.querySelector('[data-action="voice.test"]').disabled = !voices.length;
  document.querySelector('[data-action="voice.token"]').disabled = !state.tokenReady;
  const options = [['neutral','通常'],['happy','笑顔'],['angry','怒り'],['sad','悲しみ'],['surprised','驚き']];
  emotionList.replaceChildren(...options.map(([id,label]) =>
    makeOption(label,id,state.emotion?.selected === id,
      state.emotion?.available?.[id] === true,'emotion.select')));
  const plugins = state.plugins || {};
  const entriesForPlugins = Array.isArray(plugins.entries) ? plugins.entries : [];
  const pluginCards = entriesForPlugins.map(plugin => {
    const card = document.createElement('div');
    card.className = 'plugin-card';
    const header = document.createElement('div');
    header.className = 'plugin-card-heading';
    const name = document.createElement('strong');
    name.textContent = plugin.name;
    const status = document.createElement('span');
    status.textContent = plugin.enabled ? '許可済み' : '無効';
    status.className = plugin.enabled ? 'plugin-status-on' : '';
    header.append(name, status);
    const rights = document.createElement('p');
    rights.className = 'hint';
    rights.textContent = '権限: ウィンドウ名・PID' +
      (plugin.captureEnabled ? '・選択ウィンドウの撮影' : 'の取得');
    const controls = document.createElement('div');
    controls.className = 'motion-toolbar';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'row';
    toggle.dataset.action = 'plugin.toggle';
    toggle.dataset.value = plugin.id;
    toggle.textContent = plugin.enabled ? '無効化する' : '利用を許可する';
    const list = document.createElement('button');
    list.type = 'button';
    list.className = 'row' + (plugin.enabled ? ' primary' : '');
    list.dataset.action = 'plugin.listWindows';
    list.dataset.value = plugin.id;
    list.dataset.captureEnabled = String(plugin.captureEnabled);
    list.textContent = '窓一覧を取得';
    list.disabled = !plugin.enabled || plugins.supported === false;
    controls.append(toggle, list);
    card.append(header, rights, controls);
    return card;
  });
  if (!entriesForPlugins.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'プラグインがありません。フォルダへ配置して再読み込みしてください。';
    pluginCards.push(empty);
  }
  document.getElementById('plugin-count').textContent = entriesForPlugins.length + '件';
  document.getElementById('plugin-status').textContent = plugins.message || '';
  const pluginList = document.getElementById('plugin-list');
  const oldPluginScroll = pluginList.scrollTop;
  pluginList.replaceChildren(...pluginCards);
  pluginList.scrollTop = oldPluginScroll;
  const windows = Array.isArray(plugins.windows) ? plugins.windows : [];
  const currentPluginId = plugins.activePluginId;
  if (!windows.some(item => item.id === selectedWindowId) ||
      selectedWindowPluginId !== currentPluginId) {
    selectedWindowId = null;
    selectedWindowPluginId = null;
  }
  const windowItems = windows.map(item => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'plugin-window-item' +
      (item.id === selectedWindowId ? ' selected' : '');
    row.dataset.windowId = item.id;
    row.dataset.pluginId = currentPluginId || '';
    row.setAttribute('aria-pressed', String(item.id === selectedWindowId));
    const title = document.createElement('span');
    title.textContent = item.title;
    const pid = document.createElement('small');
    pid.textContent = 'PID ' + item.pid;
    row.append(title, pid);
    return row;
  });
  if (!windows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'まだ取得していません（または表示中のウィンドウがありません）。';
    windowItems.push(empty);
  }
  const windowList = document.getElementById('plugin-windows');
  const oldWindowScroll = windowList.scrollTop;
  windowList.replaceChildren(...windowItems);
  windowList.scrollTop = oldWindowScroll;

  const activePlugin = entriesForPlugins.find(item =>
    item.id === currentPluginId && item.enabled && item.captureEnabled);
  const captureButton = document.getElementById('plugin-capture');
  captureButton.disabled = captureBusy || !selectedWindowId || !activePlugin;
  captureButton.textContent = captureBusy ? '撮影中…' : '選択した窓を撮影';
  if (!captureButton.disabled) {
    captureButton.dataset.value = JSON.stringify({
      pluginId: currentPluginId, windowId: selectedWindowId
    });
  } else {
    delete captureButton.dataset.value;
  }

  // A re-capture is only valid while the originally listed window/PID remains.
  if (lastCaptureRequest && (!activePlugin ||
      lastCaptureRequest.pluginId !== currentPluginId ||
      !windows.some(item =>
        item.id === lastCaptureRequest.windowId && item.pid === lastCaptureRequest.pid))) {
    lastCaptureRequest = null;
  }
  const recaptureButton = document.getElementById('plugin-recapture');
  recaptureButton.disabled = captureBusy || !lastCaptureRequest;
  if (lastCaptureRequest) {
    recaptureButton.dataset.value = JSON.stringify({
      pluginId: lastCaptureRequest.pluginId,
      windowId: lastCaptureRequest.windowId
    });
  } else {
    delete recaptureButton.dataset.value;
  }

  const errorBox = document.getElementById('plugin-error');
  errorBox.hidden = !lastPluginError;
  errorBox.textContent = lastPluginError;

  const preview = plugins.capture || null;
  const previewElement = document.getElementById('plugin-preview');
  previewElement.hidden = !preview;
  document.getElementById('plugin-clear').disabled = captureBusy || !preview;
  document.getElementById('plugin-preview-open').disabled = !preview;
  const previewImage = document.getElementById('plugin-preview-image');
  if (preview && typeof preview.dataUrl === 'string' &&
      preview.dataUrl.startsWith('data:image/png;base64,')) {
    previewImage.src = preview.dataUrl;
    document.getElementById('plugin-preview-title').textContent = preview.title || '';
    document.getElementById('plugin-preview-size').textContent =
      preview.width + ' × ' + preview.height;
  } else {
    previewImage.removeAttribute('src');
    document.getElementById('plugin-preview-title').textContent = '';
    document.getElementById('plugin-preview-size').textContent = '';
    if (!document.getElementById('plugin-lightbox').hidden) {
      closePreviewLightbox(false);
    }
  }
}
// The window is transparent and frameless: manually capture edge drags.
let resizing = null;
let resizeFrame = null;

function endResize() {
  if (!resizing) return;
  const { zone, pointerId } = resizing;
  resizing = null;
  if (resizeFrame !== null) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = null;
  }
  // Deliver the final cursor position before persisting the window dimensions.
  window.aronaMenu.resizeEnd();
  if (zone.hasPointerCapture(pointerId)) zone.releasePointerCapture(pointerId);
}

for (const zone of document.querySelectorAll('[data-resize-edge]')) {
  zone.addEventListener('pointerdown', event => {
    if (event.button !== 0 || resizing) return;
    event.preventDefault();
    resizing = { zone, pointerId: event.pointerId };
    zone.setPointerCapture(event.pointerId);
    window.aronaMenu.resizeStart(zone.dataset.resizeEdge);
  });
  zone.addEventListener('pointermove', event => {
    if (!resizing || resizing.zone !== zone || resizing.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) { endResize(); return; }
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (resizing?.zone === zone) window.aronaMenu.resizeMove();
    });
  });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    zone.addEventListener(eventName, event => {
      if (resizing?.zone === zone && resizing.pointerId === event.pointerId) endResize();
    });
  }
}
window.addEventListener('blur', endResize);

const keepOpen = new Set([
  'voice.refresh', 'voice.select', 'emotion.select',
  'voice.autoStart', 'voice.autoHide', 'voice.appHide',
  'motion.folder', 'motion.refresh', 'motion.preview', 'motion.next',
  'motion.previous', 'motion.setIdle', 'motion.stop', 'motion.resetIdle',
  'plugin.folder', 'plugin.refresh', 'plugin.toggle', 'plugin.listWindows',
  'plugin.captureWindow', 'plugin.clearCapture'
]);
async function runAction(action, value) {
  if (busy) return;
  busy = true;
  message('処理しています…');
  try {
    const result = await window.aronaMenu.action(action, value);
    if (!result?.ok) {
      message(result?.message || '操作に失敗しました', true);
    } else {
      if (result.state) renderState(result.state);
      message(result.message || '完了しました');
      if (!keepOpen.has(action)) window.aronaMenu.close();
    }
  } catch (error) {
    message('操作できませんでした: ' + String(error?.message ?? error), true);
  } finally {
    busy = false;
  }
}

document.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { tabTo(tab.dataset.tab); return; }
  const windowRow = event.target.closest('[data-window-id]');
  if (windowRow) {
    selectedWindowId = windowRow.dataset.windowId;
    selectedWindowPluginId = windowRow.dataset.pluginId;
    for (const item of document.querySelectorAll('[data-window-id]')) {
      const selected = item === windowRow;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    }
    const target = document.getElementById('plugin-capture');
    const plugin = windowRow.dataset.pluginId;
    const available = [...document.querySelectorAll('[data-action="plugin.listWindows"]')]
      .some(item => item.dataset.value === plugin &&
        item.dataset.captureEnabled === 'true' && !item.disabled);
    target.disabled = !available;
    if (available) target.dataset.value = JSON.stringify({
      pluginId: plugin, windowId: selectedWindowId
    });
    return;
  }
  const target = event.target.closest('[data-action]');
  if (target && !target.disabled) void runAction(target.dataset.action, target.dataset.value);
});
document.getElementById('close').addEventListener('click', () => window.aronaMenu.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (resizing) endResize();
    window.aronaMenu.close();
    return;
  }
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  const plus = ['+', '='].includes(event.key) || ['Equal', 'NumpadAdd'].includes(event.code);
  const minus = ['-', '_'].includes(event.key) || ['Minus', 'NumpadSubtract'].includes(event.code);
  const reset = event.key === '0' || event.code === 'Numpad0';
  if (!plus && !minus && !reset) return;
  event.preventDefault();
  window.aronaMenu.zoom(reset ? 'reset' : plus ? 'in' : 'out');
});
window.aronaMenu.state().then(state => {
  renderState(state);
  message('FRAME / READY');
}).catch(error => message('メニューを初期化できません: ' + String(error?.message ?? error), true));
