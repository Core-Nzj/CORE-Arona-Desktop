'use strict';

// CORE VoiSona Reader v0.7 controls, with desktop-only transport and pairing.
const $ = id => document.getElementById(id);
const call = (type, other = {}) =>
  chrome.runtime.sendMessage({ target: 'worker', type, ...other });
const SPECS = [
  { key: 'speed', label: '話速', min: 0.2, max: 5, step: 0.05, init: 1, unit: '倍' },
  { key: 'volume', label: '音量', min: -8, max: 8, step: 0.5, init: 0, unit: 'dB' },
  { key: 'pitch', label: 'ピッチ', min: -600, max: 600, step: 10, init: 0, unit: 'ct' },
  { key: 'intonation', label: '抑揚', min: 0, max: 2, step: 0.05, init: 1, unit: '倍' },
  { key: 'alp', label: '年齢感', min: -1, max: 1, step: 0.05, init: 0, unit: '' },
  { key: 'huskiness', label: 'ハスキー度', min: -20, max: 20, step: 0.5, init: 0, unit: '' }
];
const defaultParams = () => Object.fromEntries(SPECS.map(s => [s.key, s.init]));
const newProfile = () => ({
  params: defaultParams(), styleNames: [], styleValues: [], useStyles: false
});
const keyFor = voice => voice.voice_name + '@@' + (voice.voice_version || '');
const clamp = (v, min, max, fallback) => Number.isFinite(Number(v))
  ? Math.max(min, Math.min(max, Number(v))) : fallback;
const pretty = n => Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString();
let voices = [];
let selectedVoice = null;
let voiceProfiles = {};
let currentProfile = null;
let saveTimer = null;
let selectedTabIds = new Set();
let selectionSave = Promise.resolve();
const CHAT_TAB_PATTERNS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const CHAT_TAB_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
function isChatTab(tab) {
  try { return CHAT_TAB_HOSTS.has(new URL(tab?.url || '').hostname); }
  catch { return false; }
}
function effectiveReadingMode(settings) {
  return ['all', 'selected', 'off'].includes(settings.readingMode)
    ? settings.readingMode
    : (settings.enabled === true && settings.autoRead !== false ? 'all' : 'off');
}
function storeTabSelection() {
  const ids = [...selectedTabIds];
  selectionSave = selectionSave.catch(() => {}).then(() =>
    chrome.storage.session.set({ selectedTabIds: ids }));
  return selectionSave;
}
async function renderChatTabs() {
  await selectionSave;
  const [tabs, state] = await Promise.all([
    chrome.tabs.query({ url: CHAT_TAB_PATTERNS }),
    chrome.storage.session.get({ selectedTabIds: [] })
  ]);
  const existing = new Set(tabs.map(tab => tab.id));
  const valid = Array.isArray(state.selectedTabIds) ? state.selectedTabIds
    .filter(id => Number.isInteger(id) && existing.has(id)) : [];
  if (valid.length !== (state.selectedTabIds?.length || 0)) {
    selectedTabIds = new Set(valid);
    await storeTabSelection();
  } else selectedTabIds = new Set(valid);
  const root = $('chatTabs');
  root.replaceChildren();
  if (!tabs.length) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '開いているChatGPTタブがありません。';
    root.append(note);
    return;
  }
  tabs.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
  for (const tab of tabs) {
    const row = document.createElement('label');
    row.className = 'tab-choice';
    row.title = tab.title || tab.url || 'ChatGPT';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selectedTabIds.has(tab.id);
    input.setAttribute('aria-label', (tab.title || 'ChatGPT') + ' の読み上げ');
    input.addEventListener('change', async () => {
      if (input.checked) selectedTabIds.add(tab.id);
      else selectedTabIds.delete(tab.id);
      try { await storeTabSelection(); }
      catch (error) { status('タブ設定の保存に失敗: ' + error.message); }
    });
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'ChatGPT';
    row.append(input, title);
    if (tab.active) {
      const current = document.createElement('span');
      current.className = 'tab-current';
      current.textContent = '表示中';
      row.append(current);
    }
    root.append(row);
  }
}


function status(text) { $('status').textContent = String(text || ''); }
function selectedKey() { return selectedVoice ? keyFor(selectedVoice) : ''; }
function toVoice(v) {
  return { voice_name: v.voice_name, voice_version: v.voice_version, language: v.languages?.[0] || 'ja_JP' };
}
function loadProfile() {
  const stored = voiceProfiles[selectedKey()] || {};
  currentProfile = {
    params: { ...defaultParams(), ...(stored.params || {}) },
    styleNames: Array.isArray(stored.styleNames) ? stored.styleNames.slice(0, 30) : [],
    styleValues: Array.isArray(stored.styleValues) ? stored.styleValues.slice(0, 30) : [],
    useStyles: !!stored.useStyles
  };
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!selectedVoice || !currentProfile) return;
  voiceProfiles[selectedKey()] = JSON.parse(JSON.stringify(currentProfile));
  await chrome.storage.local.set({ voiceProfiles });
}
function scheduleSave() {
  clearTimeout(saveTimer);
  if (selectedVoice && currentProfile) {
    voiceProfiles[selectedKey()] = JSON.parse(JSON.stringify(currentProfile));
  }
  saveTimer = setTimeout(() => { void chrome.storage.local.set({ voiceProfiles }); }, 180);
}
function numberWidget(spec, value, changed, className = 'param-row') {
  const { label, min, max, step, init, unit } = spec;
  const row = document.createElement('div');
  row.className = className;
  const title = document.createElement('label');
  title.className = className === 'style-row' ? 'style-label' : 'param-label';
  title.textContent = label;
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step;
  slider.value = String(clamp(value, min, max, init));
  title.htmlFor = slider.id = 's-' + Math.random().toString(36).slice(2);
  const box = document.createElement('div');
  box.className = 'valuebox';
  const input = document.createElement('input');
  input.type = 'number'; input.min = min; input.max = max; input.step = step;
  input.value = slider.value;
  input.setAttribute('aria-label', label + ' の数値');
  const suffix = document.createElement('span');
  suffix.className = 'unit'; suffix.textContent = unit;
  slider.addEventListener('input', () => { input.value = slider.value; changed(Number(slider.value)); });
  slider.addEventListener('change', () => { void flushSave(); });
  input.addEventListener('change', () => {
    const n = clamp(input.value, min, max, init);
    slider.value = input.value = String(n); changed(n);
  });
  box.append(input, suffix);
  row.append(title, slider, box);
  return row;
}
function renderParameters() {
  const root = $('parameterControls');
  root.replaceChildren();
  if (!currentProfile) return;
  for (const spec of SPECS) {
    root.append(numberWidget(spec, currentProfile.params[spec.key], n => {
      currentProfile.params[spec.key] = n;
      scheduleSave();
    }));
  }
}
function updateStyleStatus() {
  if (!currentProfile?.useStyles) {
    $('styleStatus').textContent = '感情ミックスはOFF。VoiSonaの既定スタイルで合成します。';
    return;
  }
  const total = currentProfile.styleValues.reduce((a, b) => a + clamp(b, 0, 100, 0), 0);
  $('styleStatus').textContent = total > 0
    ? '合成時に比率を自動正規化します（合計 ' + pretty(total) + ' → 100%）。'
    : '1つ以上のスタイルを1%以上にしてください。';
}
function renderStyles() {
  const root = $('styleControls');
  root.replaceChildren();
  if (!currentProfile) return;
  const names = currentProfile.styleNames;
  $('manualStyles').value = names.join(', ');
  $('enableStyles').checked = currentProfile.useStyles;
  $('enableStyles').disabled = names.length === 0;
  if (!names.length) {
    $('styleStatus').textContent = 'スタイル名未登録。APIから取得するか、手動入力してください。';
    return;
  }
  for (let i = 0; i < names.length; i++) {
    const spec = { label: names[i], min: 0, max: 100, step: 1, init: 0, unit: '%' };
    const row = numberWidget(spec, currentProfile.styleValues[i] || 0, n => {
      currentProfile.styleValues[i] = n;
      scheduleSave();
      updateStyleStatus();
    }, 'style-row');
    for (const input of row.querySelectorAll('input')) {
      input.disabled = !currentProfile.useStyles;
    }
    root.append(row);
  }
  updateStyleStatus();
}
function applyStyleNames(names, defaults = []) {
  const previous = Object.fromEntries(currentProfile.styleNames.map(
    (name, i) => [name, currentProfile.styleValues[i] || 0]
  ));
  currentProfile.styleNames = names;
  currentProfile.styleValues = names.map((name, i) => {
    if (Object.hasOwn(previous, name)) return previous[name];
    const n = Number(defaults[i]);
    if (Number.isFinite(n)) return clamp(n <= 1 ? n * 100 : n, 0, 100, 0);
    return i === 0 ? 100 : 0;
  });
  renderStyles();
  scheduleSave();
}
function syncVoiceUI() { renderParameters(); renderStyles(); }

async function checkConnection(preferredVoice = null) {
  try {
    const ping = await call('PING_PROXY');
    if (!ping?.ok) throw Error(ping?.error || 'アロナ本体に接続できません');
    const result = await call('GET_VOICES');
    if (!result?.ok) throw Error(result?.error || '音声ライブラリの取得に失敗');
    voices = result.data.items || [];
    const select = $('voice');
    select.replaceChildren();
    if (!voices.length) throw Error('VoiSona Talkにボイスがありません');
    for (const [i, voice] of voices.entries()) {
      const name = voice.display_names?.find(n => n.language === 'ja_JP')?.name || voice.voice_name;
      select.add(new Option(name + ' (' + (voice.voice_version || '不明') + ')', String(i)));
    }
    const index = Math.max(0, voices.findIndex(voice =>
      voice.voice_name === preferredVoice?.voice_name &&
      voice.voice_version === preferredVoice?.voice_version
    ));
    selectedVoice = voices[index];
    select.value = String(index);
    loadProfile();
    syncVoiceUI();
    await chrome.storage.local.set({ voice: toVoice(selectedVoice) });
    $('connection').textContent = 'アロナ接続OK';
    status('アロナ本体と接続しました');
  } catch (error) {
    $('connection').textContent = 'アロナ接続NG';
    $('voice').replaceChildren(new Option('接続できません', ''));
    status('接続エラー: ' + (error.message || error));
  }
}
async function init() {
  const settings = await chrome.storage.local.get({
    token: '', enabled: false, autoRead: true, readingMode: null,
    voice: null, voiceProfiles: {}, status: ''
  });
  voiceProfiles = settings.voiceProfiles || {};
  const mode = effectiveReadingMode(settings);
  $('readingMode').value = mode;
  $('tabChooser').hidden = mode !== 'selected';
  if (mode === 'selected') {
    try { await renderChatTabs(); }
    catch (error) { status('タブ一覧の取得に失敗: ' + error.message); }
  }
  $('token').value = settings.token || '';
  status(settings.status || '');
  if (settings.token) await checkConnection(settings.voice);
  else {
    $('connection').textContent = '接続未設定';
    $('voice').replaceChildren(new Option('トークンを登録してください', ''));
  }
}

$('saveToken').addEventListener('click', async () => {
  const token = $('token').value.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return status('64文字の連携トークンを入力してください');
  await chrome.storage.local.set({ token });
  const previous = await chrome.storage.local.get('voice');
  await checkConnection(previous.voice);
});
$('readingMode').addEventListener('change', async event => {
  const mode = event.target.value;
  if (!['all', 'selected', 'off'].includes(mode)) return;
  $('tabChooser').hidden = mode !== 'selected';
  try {
    if (mode === 'selected') {
      await renderChatTabs();
      // When entering selected mode for the first time, the active
      // ChatGPT tab is a sensible default; subsequent choices are preserved.
      if (!selectedTabIds.size) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (isChatTab(activeTab)) {
          selectedTabIds.add(activeTab.id);
          await storeTabSelection();
          await renderChatTabs();
        }
      }
    }
    await chrome.storage.local.set({
      readingMode: mode, enabled: mode !== 'off', autoRead: mode !== 'off'
    });
    status(mode === 'all' ? 'すべてのChatGPTタブで読み上げます'
      : mode === 'off' ? '自動読み上げをすべて無効にしました'
      : 'チェックしたタブだけ読み上げます');
  } catch (error) {
    status('読み上げ対象の切り替えに失敗: ' + error.message);
  }
});
$('refreshTabs').addEventListener('click', () => {
  void renderChatTabs().catch(error => status('タブ一覧の更新に失敗: ' + error.message));
});
$('voice').addEventListener('change', async event => {
  await flushSave();
  const selected = voices[Number(event.target.value)];
  if (!selected) return;
  selectedVoice = selected;
  loadProfile();
  syncVoiceUI();
  await chrome.storage.local.set({ voice: toVoice(selectedVoice) });
  status('ボイスを切り替えました。設定はボイスごとに保存されます。');
});
$('reset').addEventListener('click', () => {
  if (!currentProfile) return;
  const names = currentProfile.styleNames;
  currentProfile = {
    ...newProfile(), styleNames: names,
    styleValues: names.map((_, i) => i ? 0 : 100)
  };
  syncVoiceUI();
  scheduleSave();
  status('このボイスのパラメータを初期化しました');
});
$('enableStyles').addEventListener('change', event => {
  if (!currentProfile) return;
  currentProfile.useStyles = event.target.checked;
  renderStyles(); scheduleSave(); void flushSave();
});
$('applyStyles').addEventListener('click', () => {
  if (!currentProfile) return;
  const names = $('manualStyles').value.split(/[,、\n]+/)
    .map(value => value.trim()).filter(Boolean).slice(0, 30);
  if (names.length !== new Set(names).size) return status('同じスタイル名が重複しています');
  applyStyleNames(names);
  status('スタイル名を登録しました。順序がVoiSonaと一致しているか確認してください。');
});
$('loadStyles').addEventListener('click', async () => {
  if (!selectedVoice) return status('ボイスを選択してください');
  const user = $('apiUser').value.trim();
  const password = $('apiPassword').value;
  const key = selectedKey();
  status('スタイル情報を取得中…');
  try {
    const result = await call('GET_STYLE_META', {
      username: user, password,
      voice_name: selectedVoice.voice_name,
      voice_version: selectedVoice.voice_version
    });
    if (!result?.ok) throw Error(result?.error || 'スタイル取得失敗');
    if (selectedKey() !== key) return status('ボイスが切り替わりました。もう一度取得してください。');
    const names = result.data.style_names;
    if (!names.length) throw Error('このボイスにはスタイルがありません');
    applyStyleNames(names, result.data.default_style_weights);
    status(names.length + '種類のスタイルを取得しました');
  } catch (error) { status('スタイル取得失敗: ' + error.message); }
  finally { $('apiPassword').value = ''; }
});

async function activeChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id) || !isChatTab(tab)) {
    throw Error('ChatGPTの会話タブで実行してください');
  }
  return tab.id;
}
async function tabCommand(type, initial) {
  status(initial);
  try {
    await flushSave();
    const res = await chrome.tabs.sendMessage(await activeChatTab(), { type });
    if (!res?.ok || res.skipped) throw Error(res?.error || '読み上げに失敗しました');
    status('読み上げを開始しました');
  } catch (error) {
    status('エラー: ' + error.message + '\nChatGPTページを再読み込みしてください');
  }
}
$('read').addEventListener('click', () => tabCommand('READ_LAST', '最後の回答を取得しています…'));
$('selection').addEventListener('click', () => tabCommand('READ_SELECTION', '選択範囲を取得しています…'));
$('testAuto').addEventListener('click', () => tabCommand('TEST_AUTO', '自動読み上げをテストしています…'));
$('preview').addEventListener('click', async () => {
  status('現在の設定で試聴しています…');
  try {
    await flushSave();
    const res = await call('SPEAK', {
      manual: true, text: '先生、おかえりなさい。音声パラメータの試聴テストです。'
    });
    if (!res?.ok) throw Error(res?.error || '試聴失敗');
    status('試聴を送信しました');
  } catch (error) { status('試聴失敗: ' + error.message); }
});
$('stop').addEventListener('click', async () => {
  try {
    const res = await call('STOP', { manual: true });
    status(res?.ok
      ? '停止しました（次の質問まで自動読み上げを停止）'
      : '停止失敗: ' + res?.error);
  } catch (error) { status('停止エラー: ' + error.message); }
});
$('diagnose').addEventListener('click', async () => {
  try {
    const response = await chrome.tabs.sendMessage(await activeChatTab(), { type: 'DIAG' });
    if (!response?.ok) throw Error(response?.error || '診断失敗');
    const d = response.diagnostic;
    $('diagnostic').hidden = false;
    $('diagnostic').textContent = [
      ...Object.entries(d.counts).map(([name, n]) => name + ': ' + n),
      '検出回答数: ' + d.assistantCandidates,
      '最終回答の文字数: ' + d.lastTextChars,
      '抽出元: ' + (d.lastSource || '不明'),
      '選択中の文字数: ' + d.selectionChars,
      'main内の文字数: ' + d.mainTextChars,
      '生成中: ' + d.generating,
      '自動監視: ' + (d.auto?.ready ? '稼働' : '初期化中'),
      '回答待ち: ' + (d.auto?.armed ? 'はい' : 'いいえ'),
      '手動停止状態: ' + (d.auto?.muted ? 'はい' : 'いいえ'),
      '監視状況: ' + (d.auto?.lastAction || '不明'),
      '自動送信回数: ' + (d.auto?.sentCount ?? 0),
      '逐次読み上げ: ' + (d.auto?.streaming ? '送信中' : '待機中'),
      '監視した新規文字数: ' + (d.auto?.observedChars ?? 0),
      '未送信の文字数: ' + (d.auto?.candidateChars ?? 0),
      '音声送信片数: ' + (d.auto?.sentPieces ?? 0),
      '直近エラー: ' + (d.auto?.lastError || 'なし'),
      'ページ: ' + d.url
    ].join('\n');
    status('画面診断が完了しました');
  } catch (error) { status('診断エラー: ' + error.message); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status) status(changes.status.newValue || '');
});
void init();
