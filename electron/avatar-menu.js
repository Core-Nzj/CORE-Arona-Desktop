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

const keepOpen = new Set([
  'voice.refresh', 'voice.select', 'emotion.select',
  'voice.autoStart', 'voice.autoHide', 'voice.appHide',
  'motion.folder', 'motion.refresh', 'motion.preview', 'motion.next',
  'motion.previous', 'motion.setIdle', 'motion.stop', 'motion.resetIdle', 'motion.warpToggle',
  'motion.transition'
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
      if (!keepOpen.has(action)) { saveViewState(); window.aronaMenu.close(); }
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
  const target = event.target.closest('[data-action]');
  if (target && !target.disabled) void runAction(target.dataset.action, target.dataset.value);
});
document.getElementById('close').addEventListener('click', () => { saveViewState(); window.aronaMenu.close(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
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
  panelWarp.close(() => window.aronaMenu.closeComplete(generation));
});
