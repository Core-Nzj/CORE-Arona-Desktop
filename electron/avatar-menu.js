'use strict';

const feedback = document.getElementById('feedback');
const voiceList = document.getElementById('voice-list');
const emotionList = document.getElementById('emotion-list');
const motionList = document.getElementById('motion-list');
const textSizeSlider = document.getElementById('text-size');
const textSizeValue = document.getElementById('text-size-value');
const panelWarp = new window.PanelDigitalWarp(
  document.querySelector('.shell'), document.getElementById('panel-warp')
);
let menuOpenGeneration = 0;

function applyTextSize(percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 200 || percent % 5 !== 0) return;
  document.documentElement.style.setProperty('--text-scale', String(percent * 1.6 / 100));
  document.documentElement.classList.toggle('text-size-zero', percent === 0);
  textSizeSlider.value = String(percent);
  textSizeSlider.style.setProperty('--range-progress', (percent / 2) + '%');
  textSizeSlider.setAttribute('aria-valuetext', percent + '%');
  textSizeValue.textContent = percent + '%';
}
function saveTextSize() {
  window.aronaMenu.setTextSize(Number(textSizeSlider.value));
}
textSizeSlider.addEventListener('input', () => applyTextSize(Number(textSizeSlider.value)));
textSizeSlider.addEventListener('change', saveTextSize);
function resetTextSize() {
  applyTextSize(100);
  saveTextSize();
}
document.getElementById('text-size-reset').addEventListener('click', resetTextSize);
document.getElementById('text-size-recover').addEventListener('click', resetTextSize);

let busy = false;
let selectedWindowId = null;
let selectedWindowPluginId = null;
let captureBusy = false;
let lastCaptureRequest = null;
let lastPluginError = '';
let currentState = null;
let shareConsentRequestId = null;
let shareConsentChecked = false;
let browserConsentForRequestId = null;
let browserConsentChecked = false;

function message(value, error = false) {
  feedback.textContent = value;
  feedback.classList.toggle('error', error);
  const pulse = document.querySelector('footer .pulse');
  pulse.classList.toggle('error', error);
  pulse.classList.toggle('pending', !error && /処理しています|確認中/.test(String(value)));
}
// The prewarmed popup stays alive between opens. The Electron main process
// retains its navigation position in memory and resets it when FRAME exits.
const menuPages = [...document.querySelectorAll('[data-page]')];
const menuTabs = [...document.querySelectorAll('[data-tab]')];
const pageScroll = Object.fromEntries(menuPages.map(page => [page.dataset.page, 0]));
const nestedScroll = { motionList: 0, voiceList: 0 };
let activeTab = 'home';
let viewReady = false;

function saveCurrentPosition() {
  const current = menuPages.find(page => page.dataset.page === activeTab);
  if (current && !current.hidden) pageScroll[activeTab] = current.scrollTop;
  if (activeTab === 'motion') nestedScroll.motionList = motionList.scrollTop;
  if (activeTab === 'voice') nestedScroll.voiceList = voiceList.scrollTop;
}
function saveViewState() {
  if (!viewReady) return;
  saveCurrentPosition();
  window.aronaMenu.saveViewState({
    tab: activeTab,
    scroll: { ...pageScroll },
    motionList: nestedScroll.motionList,
    voiceList: nestedScroll.voiceList
  });
}
function tabTo(name) {
  if (!Object.hasOwn(pageScroll, name)) return;
  if (viewReady) saveCurrentPosition();
  for (const panel of menuPages) panel.hidden = panel.dataset.page !== name;
  for (const tab of menuTabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', String(active));
  }
  activeTab = name;
  menuPages.find(page => page.dataset.page === name).scrollTop = pageScroll[name];
  if (name === 'motion') motionList.scrollTop = nestedScroll.motionList;
  if (name === 'voice') voiceList.scrollTop = nestedScroll.voiceList;
  saveViewState();
}
function restoreViewState(value, onReady = () => {}) {
  const saved = value && typeof value === 'object' ? value : {};
  const safeScroll = value => Number.isFinite(value)
    ? Math.max(0, Math.min(100000, Math.round(value))) : 0;
  for (const page of menuPages) pageScroll[page.dataset.page] = safeScroll(saved.scroll?.[page.dataset.page]);
  nestedScroll.motionList = safeScroll(saved.motionList);
  nestedScroll.voiceList = safeScroll(saved.voiceList);
  const tab = Object.hasOwn(pageScroll, saved.tab) ? saved.tab : 'home';
  viewReady = false;
  tabTo(tab);
  requestAnimationFrame(() => {
    tabTo(tab);
    viewReady = true;
    onReady();
  });
}
for (const page of menuPages) {
  page.addEventListener('scroll', () => {
    if (!viewReady || page.hidden) return;
    pageScroll[page.dataset.page] = page.scrollTop;
    saveViewState();
  }, { passive: true });
}
motionList.addEventListener('scroll', () => {
  if (!viewReady || activeTab !== 'motion') return;
  nestedScroll.motionList = motionList.scrollTop;
  saveViewState();
}, { passive: true });
voiceList.addEventListener('scroll', () => {
  if (!viewReady || activeTab !== 'voice') return;
  nestedScroll.voiceList = voiceList.scrollTop;
  saveViewState();
}, { passive: true });
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
  applyTextSize(state.textSize);
  document.getElementById('model-name').textContent = state.modelName || '未選択';
  document.getElementById('motion-status').textContent = state.motionStatus || '標準待機モーション';
  const library = state.motionLibrary || {};
  const entries = Array.isArray(library.entries) ? library.entries : [];
  const selected = entries.find(entry => entry.id === library.selectedId);
  const selectedIdle = entries.find(entry => entry.id === library.idleId);
  document.getElementById('motion-count').textContent = entries.length + '件';
  for (const choice of document.querySelectorAll('.transition-choice')) {
    const selected = choice.dataset.value === (state.motionTransitionMode || 'auto');
    choice.classList.toggle('selected', selected);
    choice.setAttribute('aria-pressed', String(selected));
  }
  document.getElementById('motion-warp-toggle').textContent =
    'デジタル転送演出 ' + (state.motionWarpEnabled !== false ? 'ON' : 'OFF');
  document.getElementById('motion-warp-toggle').setAttribute(
    'aria-pressed', String(state.motionWarpEnabled !== false));
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
  const voiceStatus = state.voiceStatus || '未接続';
  document.getElementById('voice-status').textContent = voiceStatus;
  const voiceLight = document.getElementById('voice-light');
  voiceLight.classList.toggle('online', !!state.voiceReady);
  voiceLight.classList.toggle('pending', !state.voiceReady && /確認中|接続中|処理中/.test(voiceStatus));
  voiceLight.classList.toggle('error', !state.voiceReady && /エラー|失敗|異常|拒否|401|unauthorized|timeout/i.test(voiceStatus));
  const app = state.voisona || {};
  const engineStatus = !app.supported ? 'Windowsのみ対応' :
    app.running ? (!app.hasWindow ? '起動中・メイン画面未検出（操作を保留）' :
      '起動中 (' + (app.managed ? 'アロナ管理' : '既存プロセス') +
      (app.visible ? '・表示中)' : '・非表示)')) :
      (app.error ? '未起動: ' + app.error : '停止中');
  document.getElementById('voisona-status').textContent = engineStatus;
  const engineLight = document.getElementById('voisona-light');
  engineLight.classList.toggle('online', !!app.running && !!app.hasWindow);
  engineLight.classList.toggle('pending', !app.running && /確認中|処理中/.test(engineStatus));
  engineLight.classList.toggle('error', !!app.error || (!!app.running && !app.hasWindow));
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
  const voiceScrollTop = voiceList.scrollTop;
  voiceList.replaceChildren(...voiceButtons);
  voiceList.scrollTop = voiceScrollTop;
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
  updateVisionSharePanel(preview, state.visionShare);
  updateVisionBrowserPanel(preview, state.visionShare, state.browserShare);
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
window.addEventListener('blur', () => { endResize(); saveViewState(); });

function openPreviewLightbox() {
  const preview = currentState?.plugins?.capture;
  if (!preview?.dataUrl?.startsWith('data:image/png;base64,')) return;
  const layer = document.getElementById('plugin-lightbox');
  document.getElementById('plugin-lightbox-title').textContent = preview.title || 'LOCAL PREVIEW';
  document.getElementById('plugin-lightbox-image').src = preview.dataUrl;
  layer.hidden = false;
  document.getElementById('plugin-lightbox-close').focus();
}

function closePreviewLightbox(restoreFocus = true) {
  const layer = document.getElementById('plugin-lightbox');
  layer.hidden = true;
  document.getElementById('plugin-lightbox-image').removeAttribute('src');
  if (restoreFocus && !document.getElementById('plugin-preview-open').disabled) {
    document.getElementById('plugin-preview-open').focus();
  }
}


function updateVisionSharePanel(preview, share) {
  const card = document.getElementById('vision-share');
  card.hidden = !preview;
  const session = share?.session || null;
  if (shareConsentRequestId !== (session?.requestId ?? null)) {
    shareConsentRequestId = session?.requestId ?? null;
    shareConsentChecked = false; // A new capture never inherits approval.
  }
  const expiresIn = Number(session?.expiresAt) - Date.now();
  const canSend = !!preview && session?.status === 'captured' && expiresIn > 0;
  const checkbox = document.getElementById('vision-share-consent');
  if (!canSend) shareConsentChecked = false;
  checkbox.disabled = !canSend || busy;
  checkbox.checked = canSend && shareConsentChecked;

  const status = document.getElementById('vision-share-status');
  const labels = {
    captured: '確認待ち', approved: '許可済み', delivering: '受領確認中',
    delivered: 'ローカル受領済み', revoked: '取り消し済み',
    expired: '期限切れ', failed: '受け渡し失敗'
  };
  status.textContent = session?.status === 'captured' && expiresIn <= 0
    ? '期限切れ' : (labels[session?.status] || '未準備');
  document.getElementById('vision-share-target').textContent =
    preview ? (preview.title || '選択されたウィンドウ') +
      ' / ' + preview.width + ' × ' + preview.height : '';
  document.getElementById('vision-share-destination').textContent =
    share?.destination?.label || '受信先なし';
  const ttl = document.getElementById('vision-share-expiry');
  ttl.textContent = canSend
    ? '有効期限まで残り ' + Math.ceil(expiresIn / 1000) + ' 秒（再撮影すると更新）'
    : (session?.status === 'delivered'
      ? '1回の受け渡しが完了しました。次回は再撮影が必要です。'
      : 'この画像の受け渡しには再撮影が必要です。');
  const send = document.getElementById('vision-share-send');
  send.disabled = !canSend || !shareConsentChecked || busy;
  if (!send.disabled) {
    send.dataset.value = JSON.stringify({
      requestId: session.requestId,
      destinationId: share.destination.destinationId,
      userConfirmed: true
    });
  } else {
    delete send.dataset.value;
  }
  document.getElementById('vision-share-revoke').disabled =
    busy || !session || !['captured', 'approved', 'delivering'].includes(session.status) ||
    expiresIn <= 0;
}
document.getElementById('vision-share-consent').addEventListener('change', event => {
  if (event.target.disabled) return;
  shareConsentChecked = event.target.checked;
  updateVisionSharePanel(currentState?.plugins?.capture, currentState?.visionShare);
});
// Update the countdown without re-rendering window lists or captured PNGs.
setInterval(() => {
  if (!currentState || panelWarp.phase === 'closed' || panelWarp.phase === 'closing') return;
  updateVisionSharePanel(currentState.plugins?.capture, currentState.visionShare);
  updateVisionBrowserPanel(currentState.plugins?.capture, currentState.visionShare,
    currentState.browserShare);
}, 1000);

function updateVisionBrowserPanel(preview, localShare, browserShare) {
  const root = document.getElementById('vision-browser');
  root.hidden = !preview;
  const local = localShare?.session;
  const browser = browserShare?.session;
  const receipt = browserShare?.receipt;
  if (browserConsentForRequestId !== (local?.requestId || null)) {
    browserConsentForRequestId = local?.requestId || null;
    browserConsentChecked = false;
  }
  const awaiting = browser?.status === 'delivering' && !!receipt;
  const ready = !!preview && local?.status === 'captured' &&
    local.expiresAt > Date.now() && !awaiting;
  const checkbox = document.getElementById('vision-browser-consent');
  if (!ready) browserConsentChecked = false;
  checkbox.disabled = !ready || busy;
  checkbox.checked = ready && browserConsentChecked;
  const start = document.getElementById('vision-browser-start');
  start.disabled = !ready || !browserConsentChecked || busy;
  start.dataset.value = 'confirm-browser-handoff';
  const cancel = document.getElementById('vision-browser-cancel');
  cancel.disabled = !awaiting || busy;
  const codeArea = document.getElementById('vision-browser-code-area');
  codeArea.hidden = !awaiting;
  document.getElementById('vision-browser-code').value = awaiting ? receipt.token : '';
  document.getElementById('vision-browser-copy').disabled = !awaiting || busy;
  let label = '未準備';
  if (awaiting) label = 'Chrome受信待機中';
  else if (browser?.status === 'delivered') label = 'Chrome受領済み';
  else if (browser?.status === 'expired') label = '期限切れ';
  else if (browser?.status === 'revoked') label = '取消済み';
  else if (browser?.status === 'failed') label = '受信失敗';
  else if (ready) label = '撮影済み・確認待ち';
  document.getElementById('vision-browser-status').textContent = label;
}
document.getElementById('vision-browser-consent').addEventListener('change', event => {
  if (event.target.disabled) return;
  browserConsentChecked = event.target.checked;
  updateVisionBrowserPanel(currentState?.plugins?.capture,
    currentState?.visionShare, currentState?.browserShare);
});

function discardCapture() {
  lastCaptureRequest = null;
  lastPluginError = '';
  shareConsentRequestId = null;
  shareConsentChecked = false;
  browserConsentForRequestId = null;
  browserConsentChecked = false;
  closePreviewLightbox(false);
  if (currentState) {
    currentState = { ...currentState, plugins: { ...currentState.plugins, capture: null } };
    renderState(currentState);
  }
}

const keepOpen = new Set([
  'voice.refresh', 'voice.select', 'emotion.select',
  'voice.autoStart', 'voice.autoHide', 'voice.appHide',
  'motion.folder', 'motion.refresh', 'motion.preview', 'motion.next',
  'motion.previous', 'motion.setIdle', 'motion.stop', 'motion.resetIdle', 'motion.warpToggle',
  'motion.transition',
  'plugin.folder', 'plugin.refresh', 'plugin.toggle', 'plugin.listWindows',
  'plugin.captureWindow', 'plugin.clearCapture', 'vision.deliverLocal', 'vision.revoke',
  'vision.beginBrowser', 'vision.copyBrowserToken', 'vision.cancelBrowser'
]);

async function runAction(action, value) {
  if (busy || panelWarp.phase === 'closed' || panelWarp.phase === 'closing') return;
  const generation = menuOpenGeneration;
  const isCurrent = () => generation === menuOpenGeneration &&
    panelWarp.phase !== 'closed' && panelWarp.phase !== 'closing';
  if (action === 'plugin.previewOpen') { openPreviewLightbox(); return; }
  if (action === 'plugin.previewClose') { closePreviewLightbox(); return; }

  if (action === 'plugin.recapture') {
    if (!lastCaptureRequest) return;
    action = 'plugin.captureWindow';
    value = JSON.stringify({
      pluginId: lastCaptureRequest.pluginId,
      windowId: lastCaptureRequest.windowId
    });
  }
  const isPlugin = action.startsWith('plugin.') || action.startsWith('vision.');
  busy = true;
  if (isPlugin) lastPluginError = '';
  if (action === 'plugin.captureWindow') {
    let request;
    try { request = JSON.parse(value); } catch { request = null; }
    const target = currentState?.plugins?.windows?.find(item =>
      item.id === request?.windowId);
    if (!target || request?.pluginId !== currentState?.plugins?.activePluginId) {
      busy = false;
      lastPluginError = '撮影対象が見つかりません。一覧を取り直してください。';
      if (currentState) renderState(currentState);
      message(lastPluginError, true);
      return;
    }
    lastCaptureRequest = {
      pluginId: request.pluginId, windowId: target.id, pid: target.pid
    };
    captureBusy = true;
    message('撮影中…');
  } else {
    message('処理しています…');
  }
  if (isPlugin && currentState) renderState(currentState);
  try {
    const result = await window.aronaMenu.action(action, value);
    if (!isCurrent()) return;
    if (!result?.ok) {
      if (isPlugin) {
        lastPluginError = String(result?.message || '操作に失敗しました');
        // A capture error clears the image in the host; fetch fresh state.
        try {
          const state = await window.aronaMenu.state();
          if (!isCurrent()) return;
          renderState(state);
        }
        catch (stateError) {
          if (!isCurrent()) return;
          lastPluginError += '\n状態更新に失敗: ' + String(stateError?.message ?? stateError);
        }
        message('操作に失敗しました。拡張タブに詳細を表示しています。', true);
      } else {
        message(result?.message || '操作に失敗しました', true);
      }
    } else {
      if (action === 'plugin.clearCapture') {
        lastCaptureRequest = null;
        closePreviewLightbox(false);
      }
      if (result.state) renderState(result.state);
      message(result.message || '完了しました');
      if (!keepOpen.has(action)) { saveViewState(); window.aronaMenu.close(); }
    }
  } catch (error) {
    if (!isCurrent()) return;
    if (isPlugin) lastPluginError = String(error?.message ?? error);
    message('操作できませんでした: ' + String(error?.message ?? error).slice(0, 200), true);
    if (isPlugin) {
      try {
        const state = await window.aronaMenu.state();
        if (isCurrent()) renderState(state);
      } catch { /* Keep original error. */ }
    }
  } finally {
    busy = false;
    captureBusy = false;
    // Re-enable controls even if the panel reopened while this action ran.
    // Only redraw the latest snapshot; the old result was discarded above.
    if (currentState && panelWarp.phase !== 'closed' && panelWarp.phase !== 'closing') {
      renderState(currentState);
    }
  }
}

document.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { tabTo(tab.dataset.tab); return; }
  const windowRow = event.target.closest('[data-window-id]');
  if (windowRow) {
    if (busy || !currentState) return;
    selectedWindowId = windowRow.dataset.windowId;
    selectedWindowPluginId = windowRow.dataset.pluginId;
    renderState(currentState);
    return;
  }
  const target = event.target.closest('[data-action]');
  if (target && !target.disabled) void runAction(target.dataset.action, target.dataset.value);
});
document.getElementById('close').addEventListener('click', () => { saveViewState(); window.aronaMenu.close(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!document.getElementById('plugin-lightbox').hidden) {
      event.preventDefault();
      closePreviewLightbox();
      return;
    }
    if (resizing) endResize();
    saveViewState();
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
// The open event carries a synchronous snapshot: no voice-engine/network wait
// and no flash of the previous tab before its scroll position is restored.
window.aronaMenu.onOpen((generation, state) => {
  menuOpenGeneration = generation;
  panelWarp.open();
  renderState(state);
  restoreViewState(state?.viewState, () => {
    if (menuOpenGeneration !== generation) return;
    panelWarp.ready();
    message('FRAME / READY');
  });
});
window.aronaMenu.onStateUpdate(state => {
  // A background voice refresh may finish after the menu has been reopened.
  if (panelWarp.phase === 'closed' || panelWarp.phase === 'closing') return;
  renderState(state);
});
window.aronaMenu.onCloseAnimation(generation => {
  if (menuOpenGeneration !== generation) return;
  saveViewState();
  discardCapture();
  panelWarp.close(() => window.aronaMenu.closeComplete(generation));
});
