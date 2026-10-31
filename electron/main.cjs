'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, screen, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveAssetPath } = require('./asset-path.cjs');
const {
  stageInDisplay, cursorHitsStageRects, sanitizeHitRectangles, clampAvatarPosition
} = require('./avatar-overlay.cjs');
const { scanMotionLibrary, readMotionFile } = require('./motion-library.cjs');
const {
  BASE_WIDTH, BASE_HEIGHT, INITIAL_SCALE, MIN_SCALE, ZOOM_IN_FACTOR,
  clampScale, resolveZoomScale, startupScaleForArea, windowSizeForScale, boundsForScale
} = require('./avatar-window-size.cjs');
const { VoiceProxyClient, PROXY_ORIGIN } = require('./voice-proxy.cjs');
const { VoiceCredentialStore } = require('./voice-credentials.cjs');
const { ProxyManager } = require('./proxy-manager.cjs');
const { VoiSonaManager } = require('./voisona-manager.cjs');
const { BrowserCredentialPortal } = require('./browser-credentials.cjs');
const { SpeechBridge } = require('./speech-bridge.cjs');
const { readSpeechText, copySpeechToken } = require('./clipboard-actions.cjs');
const { voiceKey, globalParameters } = require('./speech-settings.cjs');
const {
  DEFAULT_WIDTH, DEFAULT_HEIGHT, LAYOUT_VERSION, EDGES,
  normalizeMenuLayout, restoreMenuLayout: normalizeSavedMenuLayout,
  changeMenuZoom, resizeMenuBounds,
  TEXT_SIZE_VERSION, DEFAULT_TEXT_SIZE, normalizeTextSize, restoreTextSize
} = require('./menu-layout.cjs');

// Desktop speech may start from a native context-menu action.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const SCHEME = 'arona-avatar';
const MAX_VMD_BYTES = 32 * 1024 * 1024; // Locally selected, one-shot animation files.
const ALLOWED_EXTENSIONS = new Set([
  '.pmx', '.pmd', '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.dds',
  '.webp', '.gif', '.spa', '.sph'
]);
const MIME = {
  '.pmx': 'application/octet-stream',
  '.pmd': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.tga': 'image/x-tga',
  '.dds': 'image/vnd-ms.dds',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.spa': 'application/octet-stream',
  '.sph': 'application/octet-stream'
};

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

let mainWindow;
let exitWarpPending = false;
let exitWarpComplete = false;
let exitWarpTimeout = null;
function completeExitWarp() {
  if (exitWarpComplete) return;
  exitWarpComplete = true;
  exitWarpPending = false;
  if (exitWarpTimeout) clearTimeout(exitWarpTimeout);
  exitWarpTimeout = null;
  app.quit(); // Continue with the existing VoiSona cleanup and window teardown.
}
let avatarScale = INITIAL_SCALE;
let avatarBounds = null; // Physical avatar extent, independent of the full-display overlay.
let avatarHitRects = [];
let avatarHitTimer = null;
let avatarMouseIgnored = true;
let avatarDisplayId = null;
let settingsWindow = null;
let menuWindow = null;
let motionFolderDialogOpen = false;
let menuLayout = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, zoom: 1 };
let menuTextSize = DEFAULT_TEXT_SIZE;
// Session-only navigation state. Closing FRAME clears this automatically.
const MENU_TABS = ['home', 'motion', 'voice', 'emotion', 'status'];
const MENU_TAB_SET = new Set(MENU_TABS);
let menuViewState = {
  tab: 'home',
  scroll: Object.fromEntries(MENU_TABS.map(tab => [tab, 0])),
  motionList: 0,
  voiceList: 0
};
let menuResize = null;
let menuLayoutSave = Promise.resolve();
const proxyManager = new ProxyManager();
const voisonaManager = new VoiSonaManager();
const voisonaPrefs = { autoStart: true, autoHide: true, executable: '' };
let credentialStore = null;
let browserCredentialPortal = null;
let credentials = null;
let credentialsError = '';
let proxyStartup = null;
let currentModelFile = null;
let dragTimer = null;
let dragStart = null;
let walkTimer = null;
let walkState = null;
let idleDiagnostics = 'モーションの読み込みを待っています';
let motionDirectory = null;
let motionEntries = [];
let motionSelectedId = null;
let motionIdleId = null;
let motionLibraryMessage = '未検索';
let motionWarpEnabled = true;
let motionTransitionMode = 'auto';
const voiceClient = new VoiceProxyClient();
let voiceEntries = [];
let voiceError = '接続を確認していません';
let selectedVoiceName = null;
let voiceSynthesis = null;
let voicePlaybackStatus = 'テスト再生はまだ実行されていません';
let speechBridge = null;
let speechBridgeError = '';

function isSettingsWindow(event) {
  return settingsWindow && !settingsWindow.isDestroyed() &&
    event.sender === settingsWindow.webContents;
}

async function startProxyAndRefresh() {
  if (proxyStartup) return proxyStartup;
  proxyStartup = (async () => {
    const state = await proxyManager.ensureRunning();
    if (state.running) await refreshVoices();
    else {
      voiceEntries = [];
      voiceError = state.error || 'Proxyが起動していません';
    }
    return state;
  })().finally(() => { proxyStartup = null; });
  return proxyStartup;
}

async function voiceSettingsStatus() {
  return {
    saved: credentials !== null,
    username: credentials?.username || '',
    encryptionAvailable: credentialStore?.available() ?? false,
    voice: { count: voiceEntries.length, error: voiceError },
    proxy: {
      ...proxyManager.status(),
      running: await proxyManager.isAvailable()
    },
    voisona: voisonaManager.status(),
    error: credentialsError
  };
}

async function startIntegratedVoice() {
  try {
    if (voisonaPrefs.autoStart) await voisonaManager.ensureRunning(voisonaPrefs.executable);
    else await voisonaManager.refresh();
  } catch (error) {
    console.warn('[CORE Voice] VoiSona auto-launch failed:', error?.message);
  }
  await startProxyAndRefresh();
  if (!voisonaPrefs.autoHide || !voisonaManager.status().managed || !credentials) return;
  // The editor and REST API may become ready at different times.
  // Wait for BOTH before hiding; never fall back to a JUCE helper window.
  // Leave the GUI visible when first-run login or API setup is necessary.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (voiceEntries.length && !voiceError) {
      const state = await voisonaManager.refresh();
      if (!state.managed || !state.running) return;
      if (state.hasWindow) {
        try { await voisonaManager.hide(); }
        catch (error) { console.warn('[CORE Voice] auto-hide failed:', error?.message); }
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!voiceEntries.length || voiceError) await refreshVoices();
  }
}

function openVoiceSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    title: 'VoiSona Talk 接続設定',
    parent: mainWindow,
    modal: true,
    width: 545,
    height: 565,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#1d1d1f',
    webPreferences: {
      preload: path.join(__dirname, 'voice-settings-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.loadFile(path.join(__dirname, 'voice-settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

async function refreshVoices() {
  try {
    voiceEntries = await voiceClient.listVoices();
    voiceError = voiceEntries.length ? '' : 'VoiSona Talkに音声ライブラリがありません';
    if (voiceEntries.length && !voiceEntries.some(v => v.voice_name === selectedVoiceName)) {
      selectedVoiceName = voiceEntries[0].voice_name;
      await saveModelSelection();
    }
    return voiceEntries;
  } catch (error) {
    voiceEntries = [];
    voiceError = String(error?.message ?? error);
    return [];
  }
}

function resolveSelectedVoice(preference) {
  if (preference?.voice_name && typeof preference.voice_name === 'string') {
    const matching = voiceEntries.find(entry =>
      entry.voice_name === preference.voice_name &&
      (!preference.voice_version || entry.voice_version === preference.voice_version));
    if (matching) return matching;
  }
  return currentVoice();
}

function isVoiceCommandWindowReady() {
  return mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading();
}

async function handleSpeechCommand(command) {
  if (!command || typeof command.type !== 'string') throw new Error('不正な音声連携コマンドです');
  if (command.type === 'PING_PROXY') {
    return { ok: true, data: { running: await proxyManager.isAvailable(), bridge: true } };
  }
  if (command.type === 'GET_VOICES') {
    await startProxyAndRefresh();
    if (voiceError) throw new Error(voiceError);
    return { ok: true, data: { items: voiceEntries } };
  }
  if (command.type === 'GET_STYLE_META') {
    const voiceName = command.voice_name;
    const voiceVersion = command.voice_version;
    if (typeof voiceName !== 'string' || !voiceName || voiceName.length > 160 ||
        typeof voiceVersion !== 'string' || !voiceVersion || voiceVersion.length > 160) {
      throw new Error('ボイス名とバージョンが必要です');
    }
    const username = command.username || credentials?.username;
    const password = command.password || credentials?.password;
    if (typeof username !== 'string' || typeof password !== 'string' ||
        !username || !password || username.length > 254 || password.length > 1024) {
      throw new Error('VoiSona API認証情報をデスクトップ側で設定してください');
    }
    const url = 'http://127.0.0.1:32766/api/talk/v1/voices/' +
      encodeURIComponent(voiceName) + '/' + encodeURIComponent(voiceVersion);
    const response = await fetch(url, {
      headers: { Authorization: 'Basic ' +
        Buffer.from(username + ':' + password, 'utf8').toString('base64') },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('VoiSona API HTTP ' + response.status);
    const info = await response.json();
    const data = info?.data || info;
    if (!Array.isArray(data.style_names)) throw new Error('VoiSona APIからスタイル一覧を取得できません');
    return { ok: true, data: {
      style_names: data.style_names.filter(name => typeof name === 'string').slice(0, 30),
      default_style_weights: Array.isArray(data.default_style_weights)
        ? data.default_style_weights.slice(0, 30) : []
    } };
  }
  if (!['SPEAK', 'STREAM_START', 'STREAM_APPEND', 'STREAM_END', 'STOP'].includes(command.type)) {
    throw new Error('未対応の音声連携コマンドです');
  }
  if (!isVoiceCommandWindowReady()) throw new Error('アロナの描画ウィンドウが準備できていません');
  if (command.type.startsWith('STREAM_') &&
      (typeof command.streamId !== 'string' || !command.streamId ||
       command.streamId.length > 100)) throw new Error('ストリーム識別子が不正です');
  if (command.type === 'STREAM_APPEND' &&
      (!Number.isSafeInteger(command.seq) || command.seq < 0)) {
    throw new Error('ストリーム連番が不正です');
  }
  if (['SPEAK', 'STREAM_APPEND'].includes(command.type) &&
      (typeof command.text !== 'string' || !command.text.trim() ||
       command.text.length > (command.type === 'SPEAK' ? 9000 : 480))) {
    throw new Error('音声テキストの長さが不正です');
  }
  const options = (command.type === 'SPEAK' || command.type === 'STREAM_START')
    ? { voice: command.voice ?? null, voiceProfiles: command.voiceProfiles ?? {} } : {};
  mainWindow.webContents.send('avatar:voice-command', {
    type: command.type,
    streamId: command.streamId,
    seq: command.seq,
    text: command.text,
    ...options
  });
  return { ok: true };
}

function currentVoice() {
  return voiceEntries.find(v => v.voice_name === selectedVoiceName) || null;
}

function voiceDiagnostics() {
  return [
    '接続先: ' + PROXY_ORIGIN,
    '状態: ' + (voiceError || '接続成功'),
    '検出されたライブラリ数: ' + voiceEntries.length,
    '使用音声: ' + (selectedVoiceName ?? '未設定'),
    '再生状態: ' + voicePlaybackStatus,
    'ChatGPT連携: ' + (speechBridge?.server ? '待受中 (127.0.0.1:32779)' : (speechBridgeError || '準備中')),
    '音声形式: ' + voiceClient.lastWavInfo,
    '',
    'Proxy管理: ' + (proxyManager.status().managed
      ? 'このアプリが起動・管理' : '外部起動または停止中'),
    '自動起動エラー: ' + (proxyManager.status().error || 'なし'),
    'VoiSona本体: ' + (voisonaManager.status().running
      ? (voisonaManager.status().managed ? 'アロナから起動' : '既存プロセスを再利用')
      : '停止中'),
    'VoiSona管理エラー: ' + (voisonaManager.status().error || 'なし'),
    '認証情報: ' + (credentials ? 'Windowsで暗号化保存済み' : '未設定'),
    '前提: VoiSona Talk本体を起動しREST APIを有効にする',
    '接続設定は右クリック → 音声 → 接続設定・認証情報から変更できます。'
  ].join('\n');
}
const EMOTION_OPTIONS = Object.freeze([
  { id: 'neutral', label: '通常' },
  { id: 'happy', label: '笑顔' },
  { id: 'angry', label: '怒り' },
  { id: 'sad', label: '悲しみ' },
  { id: 'surprised', label: '驚き' }
]);
let emotionState = { available: { neutral: true }, selected: 'neutral', details: 'モデルの読み込み待ち' };

function resetEmotionState() {
  emotionState = { available: { neutral: true }, selected: 'neutral', details: '表情を確認中' };
}

function infoForCurrentModel() {
  if (!currentModelFile) return null;
  return {
    name: path.basename(currentModelFile),
    url: SCHEME + '://model/' + encodeURIComponent(path.basename(currentModelFile)),
    motionWarpEnabled,
    motionTransitionMode
  };
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function restoreModelSelection() {
  try {
    const settings = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    if (typeof settings.voiceName === 'string') selectedVoiceName = settings.voiceName;
    if (typeof settings.voisonaAutoStart === 'boolean') voisonaPrefs.autoStart = settings.voisonaAutoStart;
    if (typeof settings.voisonaAutoHide === 'boolean') voisonaPrefs.autoHide = settings.voisonaAutoHide;
    if (typeof settings.voisonaExecutable === 'string') voisonaPrefs.executable = settings.voisonaExecutable;
    if (typeof settings.motionDirectory === 'string' && settings.motionDirectory.length < 2048) {
      motionDirectory = settings.motionDirectory;
    }
    if (typeof settings.motionIdleId === 'string') motionIdleId = settings.motionIdleId;
    if (typeof settings.motionSelectedId === 'string') motionSelectedId = settings.motionSelectedId;
    if (typeof settings.motionWarpEnabled === 'boolean') motionWarpEnabled = settings.motionWarpEnabled;
    if (['auto', 'blend', 'warp'].includes(settings.motionTransitionMode)) motionTransitionMode = settings.motionTransitionMode;
    if (typeof settings.modelPath !== 'string') return;
    if (!['.pmx', '.pmd'].includes(path.extname(settings.modelPath).toLowerCase())) return;
    const stats = await fs.stat(settings.modelPath);
    if (stats.isFile()) currentModelFile = settings.modelPath;
  } catch {
    // First launch, moved model, or invalid settings: show model picker instead.
  }
}

async function saveModelSelection() {
  const filepath = settingsFile();
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, JSON.stringify({
    modelPath: currentModelFile,
    voiceName: selectedVoiceName,
    voisonaAutoStart: voisonaPrefs.autoStart,
    voisonaAutoHide: voisonaPrefs.autoHide,
    voisonaExecutable: voisonaPrefs.executable,
    motionDirectory,
    motionIdleId,
    motionSelectedId,
    motionWarpEnabled,
    motionTransitionMode
  }, null, 2), 'utf8');
}

async function handleModelAsset(request) {
  if (request.method !== 'GET' || !currentModelFile) return new Response('Not found', { status: 404 });
  try {
    const url = new URL(request.url);
    if (url.hostname !== 'model' || url.search || url.hash) {
      return new Response('Bad request', { status: 400 });
    }
    const modelFolder = await fs.realpath(path.dirname(currentModelFile));
    const candidate = resolveAssetPath(modelFolder, url.pathname);
    if (!ALLOWED_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
      return new Response('Unsupported file type', { status: 403 });
    }
    const actual = await fs.realpath(candidate);
    if (!actual.startsWith(modelFolder + path.sep)) {
      return new Response('Outside model folder', { status: 403 });
    }
    const stat = await fs.stat(actual);
    if (!stat.isFile()) return new Response('Not a file', { status: 404 });
    const data = await fs.readFile(actual);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(actual).toLowerCase()] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch {
    return new Response('Asset not found', { status: 404 });
  }
}

async function chooseModel() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'MMDモデルを選択',
    buttonLabel: '読み込む',
    properties: ['openFile'],
    filters: [
      { name: 'MMD models', extensions: ['pmx', 'pmd'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  currentModelFile = result.filePaths[0];
  resetEmotionState();
  await saveModelSelection();
  return infoForCurrentModel();
}

// The development layout keeps Motions/ beside CORE-Arona-Desktop/.
async function refreshMotionLibrary() {
  const suggestions = motionDirectory ? [motionDirectory] : [
    path.resolve(app.getAppPath(), '..', 'Motions'),
    path.resolve(process.cwd(), '..', 'Motions'),
    path.resolve(path.dirname(app.getPath('exe')), 'Motions')
  ];
  let lastError = null;
  for (const candidate of new Set(suggestions)) {
    try {
      const result = await scanMotionLibrary(candidate);
      motionDirectory = result.root;
      motionEntries = result.entries;
      if (!motionEntries.some(entry => entry.id === motionSelectedId)) motionSelectedId = null;
      motionLibraryMessage = motionEntries.length + '件を検出' +
        (result.capped ? '（上限に達しました）' : '');
      return;
    } catch (error) { lastError = error; }
  }
  motionEntries = [];
  motionLibraryMessage = motionDirectory
    ? '指定フォルダを開けません: ' + String(lastError?.message || lastError)
    : 'Motionsフォルダがありません。フォルダを指定してください';
}

function libraryEntry(id) {
  const entry = motionEntries.find(item => item.id === id);
  if (!entry || !motionDirectory) throw new Error('一覧にないモーションです。再検索してください');
  return entry;
}

async function readLibraryMotion(id) {
  libraryEntry(id);
  return readMotionFile(motionDirectory, id);
}

async function previewLibraryMotion(id) {
  const motion = await readLibraryMotion(id);
  motionSelectedId = id;
  mainWindow.webContents.send('avatar:motion-command', { type: 'play', ...motion });
  return 'プレビュー: ' + motion.name;
}

async function chooseMotionFile() {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: '再生するVMDモーションを選択',
    buttonLabel: '1回再生',
    properties: ['openFile'],
    filters: [{ name: 'MMDモーション', extensions: ['vmd'] }]
  });
  if (selected.canceled || !selected.filePaths.length) return null;
  const filename = selected.filePaths[0];
  if (path.extname(filename).toLowerCase() !== '.vmd') {
    throw new Error('VMDファイルを選択してください');
  }
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size < 54 || stat.size > MAX_VMD_BYTES) {
    throw new Error('VMDが空か大きすぎます（最大32MiB）');
  }
  const data = await fs.readFile(filename);
  if (!data.subarray(0, 30).toString('ascii').startsWith('Vocaloid Motion Data')) {
    throw new Error('VMD形式を確認できません');
  }
  // Do not transmit the local path or copy third-party assets into the repo.
  return { name: path.basename(filename), bytes: new Uint8Array(data) };
}

function isOurWindow(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

// Native hit-testing no longer clips pixels. Only the mouse input is shaped;
// WebGL transparency and antialiasing stay fully intact.
function updateAvatarMousePassThrough(cursor = screen.getCursorScreenPoint()) {
  if (!mainWindow || mainWindow.isDestroyed() || !avatarBounds) return;
  const shouldIgnore = !dragStart && !cursorHitsStageRects(cursor, avatarBounds, avatarHitRects);
  if (shouldIgnore === avatarMouseIgnored) return;
  avatarMouseIgnored = shouldIgnore;
  mainWindow.setIgnoreMouseEvents(shouldIgnore, shouldIgnore ? { forward: true } : undefined);
}
function setAvatarRegion(rects) {
  if (!avatarBounds) return;
  avatarHitRects = sanitizeHitRectangles(rects, avatarBounds);
  updateAvatarMousePassThrough();
}

function syncAvatarViewport() {
  if (!mainWindow || mainWindow.isDestroyed() || !avatarBounds) return;
  const display = screen.getDisplayMatching(avatarBounds);
  if (avatarDisplayId !== display.id) {
    avatarDisplayId = display.id;
    mainWindow.setBounds(display.bounds, false); // Covers the entire monitor including edges.
  }
  mainWindow.webContents.send('avatar:stage-viewport',
    stageInDisplay(avatarBounds, display.bounds));
  updateAvatarMousePassThrough();
}

function startAvatarHitPolling() {
  if (avatarHitTimer) clearInterval(avatarHitTimer);
  avatarHitTimer = setInterval(updateAvatarMousePassThrough, 16);
}

// Native window motion is driven here rather than by DOM mouse deltas, which
// are unreliable while a transparent, shaped Electron window is moving.
function stopAvatarWalk(notify = false) {
  if (walkTimer !== null) clearInterval(walkTimer);
  walkTimer = null;
  walkState = null;
  if (notify && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('avatar:walk-stopped');
  }
}

function beginAvatarWalk(direction, speed) {
  stopAvatarWalk();
  if (!mainWindow || mainWindow.isDestroyed() ||
      ![-1, 1].includes(direction) || !Number.isFinite(speed)) return;
  stopAvatarDrag();
  const actualSpeed = Math.max(20, Math.min(360, speed));
  const bounds = avatarBounds;
  if (!bounds) return;
  walkState = { direction, speed: actualSpeed, x: bounds.x, last: performance.now() };
  walkTimer = setInterval(() => {
    const state = walkState;
    if (!state || !mainWindow || mainWindow.isDestroyed()) {
      stopAvatarWalk();
      return;
    }
    const bounds = avatarBounds;
    const area = screen.getDisplayMatching(bounds).workArea;
    const minimum = area.x;
    const maximum = Math.max(minimum, area.x + area.width - bounds.width);
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - state.last) / 1000));
    state.last = now;
    state.x = Math.min(maximum, Math.max(minimum, state.x + state.direction * state.speed * dt));
    const next = Math.round(state.x);
    if (next !== bounds.x) {
      avatarBounds = { ...bounds, x: next };
      syncAvatarViewport();
    }
    if ((state.direction > 0 && state.x >= maximum) ||
        (state.direction < 0 && state.x <= minimum)) {
      stopAvatarWalk(true); // Stop before the model would slide beyond the screen.
    }
  }, 16);
}

function stopAvatarDrag() {
  if (dragTimer !== null) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  dragStart = null;
}

function startAvatarDrag() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopAvatarWalk(true);
  stopAvatarDrag();
  dragStart = {
    pointer: screen.getCursorScreenPoint(),
    position: [avatarBounds.x, avatarBounds.y],
    startedAt: Date.now()
  };

  // The cursor position is absolute (DIP). Unlike DOM mousemove deltas,
  // it stays stable while the frameless window itself is moving.
  dragTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !dragStart) {
      stopAvatarDrag();
      return;
    }
    // Safety timeout if the mouseup event was lost.
    if (Date.now() - dragStart.startedAt > 30_000) {
      stopAvatarDrag();
      return;
    }
    const pointer = screen.getCursorScreenPoint();
    const x = Math.round(dragStart.position[0] + pointer.x - dragStart.pointer.x);
    const y = Math.round(dragStart.position[1] + pointer.y - dragStart.pointer.y);
    const nearest = screen.getDisplayNearestPoint(pointer);
    const next = clampAvatarPosition({ ...avatarBounds, x, y }, nearest.workArea);
    if (next.x !== avatarBounds.x || next.y !== avatarBounds.y) {
      avatarBounds = next;
      syncAvatarViewport();
    }
  }, 16);
}

function zoomAvatarWindow(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopAvatarWalk(true);
  const steps = action === 'in' ? 1 : action === 'out' ? -1
    : typeof action === 'number' && Number.isFinite(action) && Math.abs(action) <= 2
      ? action : null;
  if (action !== 'reset' && (steps === null || steps === 0)) return;
  const currentBounds = avatarBounds;
  if (!currentBounds) return;
  const workArea = screen.getDisplayMatching(currentBounds).workArea;
  const requestedScale = action === 'reset'
    ? startupScaleForArea(workArea)
    : avatarScale * Math.pow(ZOOM_IN_FACTOR, steps);
  // Center-based anchoring avoids the cursor/window oscillation on resize.
  const { bounds, scale, cameraZoom } =
    boundsForScale(currentBounds, workArea, requestedScale);
  avatarScale = scale;
  if (bounds.x !== currentBounds.x || bounds.y !== currentBounds.y ||
      bounds.width !== currentBounds.width || bounds.height !== currentBounds.height) {
    stopAvatarDrag();
    avatarBounds = bounds;
    avatarHitRects = []; // Recompute silhouette at the new rendered resolution.
    syncAvatarViewport();
  }
  mainWindow.webContents.send('avatar:camera-zoom', cameraZoom);
}

async function reportClipboardError(error) {
  console.error('[CORE clipboard] operation failed:', error);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'クリップボード操作エラー',
      message: 'クリップボードを操作できませんでした',
      detail: String(error?.message ?? error).slice(0, 500),
      buttons: ['閉じる']
    });
  } catch (dialogError) {
    console.warn('[CORE clipboard] unable to display error:', dialogError);
  }
}

// Store menu preferences separately from model and VoiSona settings to avoid
// overwriting them when the popup is resized or its text zoom is changed.
function menuLayoutFile() {
  return path.join(app.getPath('userData'), 'frame-panel-layout.json');
}

async function restoreMenuLayout() {
  try {
    const value = JSON.parse(await fs.readFile(menuLayoutFile(), 'utf8'));
    menuLayout = normalizeSavedMenuLayout(value, screen.getPrimaryDisplay().workArea);
    menuTextSize = restoreTextSize(value);
    if (value.version !== LAYOUT_VERSION || value.textSizeVersion !== TEXT_SIZE_VERSION) {
      saveMenuLayout();
    }
  } catch {
    // Missing or invalid local preferences: use defaults.
  }
}

function saveMenuLayout() {
  const snapshot = JSON.stringify({
    ...menuLayout, textSize: menuTextSize,
    textSizeVersion: TEXT_SIZE_VERSION, version: LAYOUT_VERSION
  }, null, 2);
  menuLayoutSave = menuLayoutSave.catch(() => {}).then(async () => {
    const destination = menuLayoutFile();
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, snapshot, 'utf8');
  });
  void menuLayoutSave.catch(error => console.warn('[FRAME UI] layout not saved:', error?.message));
}

function finishMenuResize() {
  if (!menuResize) return;
  const popup = menuResize.window;
  menuResize = null;
  if (!popup.isDestroyed()) {
    const { width, height } = popup.getBounds();
    menuLayout.width = width;
    menuLayout.height = height;
    saveMenuLayout();
  }
}

function beginMenuResize(edge) {
  if (!menuWindow || menuWindow.isDestroyed() || !EDGES.has(edge)) return;
  finishMenuResize();
  const pointer = screen.getCursorScreenPoint();
  menuResize = {
    window: menuWindow,
    edge,
    pointer,
    bounds: menuWindow.getBounds(),
    area: screen.getDisplayNearestPoint(pointer).workArea
  };
}

function moveMenuResize() {
  const state = menuResize;
  if (!state || state.window !== menuWindow || state.window.isDestroyed()) return;
  const target = resizeMenuBounds(
    state.bounds, state.pointer, screen.getCursorScreenPoint(), state.edge, state.area
  );
  const current = state.window.getBounds();
  if (current.x !== target.x || current.y !== target.y ||
      current.width !== target.width || current.height !== target.height) {
    // Programmatic resize keeps the transparent window's rounded corners.
    // Native OS edge resizing is unsupported for transparent Electron windows.
    state.window.setBounds(target, false);
  }
}

// A separate popup keeps the avatar's native click-through silhouette intact.
function menuState() {
  return {
    modelName: currentModelFile ? path.basename(currentModelFile) : '未選択',
    textSize: menuTextSize,
    viewState: menuViewState,
    motionStatus: idleDiagnostics.split('\n')[0],
    motionWarpEnabled,
    motionTransitionMode,
    motionLibrary: {
      directory: motionDirectory || '',
      entries: motionEntries,
      selectedId: motionSelectedId,
      idleId: motionIdleId,
      message: motionLibraryMessage
    },
    voices: voiceEntries.map(v => ({
      name: v.voice_name,
      selected: v.voice_name === selectedVoiceName
    })),
    voiceStatus: voiceError || '接続済み',
    voiceReady: !voiceError && voiceEntries.length > 0,
    tokenReady: Boolean(speechBridge?.server),
    voisona: {
      ...voisonaManager.status(),
      autoStart: voisonaPrefs.autoStart,
      autoHide: voisonaPrefs.autoHide,
      executableSet: !!voisonaPrefs.executable
    },
    emotion: { selected: emotionState.selected, available: emotionState.available }
  };
}

// Keep the settings renderer warm, so a right-click starts the effect
// immediately instead of paying for a new BrowserWindow on every open.
let menuPrepared = false;
let menuPendingOpen = false;
let menuClosing = false;
let menuTransition = 0;
let menuHideTimer = null;

function finishMenuHide(generation) {
  if (generation !== menuTransition || !menuClosing ||
      !menuWindow || menuWindow.isDestroyed()) return;
  menuClosing = false;
  if (menuHideTimer) clearTimeout(menuHideTimer);
  menuHideTimer = null;
  menuWindow.hide();
}

function closeAvatarMenu(force = false) {
  finishMenuResize();
  if (!menuWindow || menuWindow.isDestroyed()) return;
  if (force) {
    menuPendingOpen = false;
    menuClosing = false;
    ++menuTransition;
    if (menuHideTimer) clearTimeout(menuHideTimer);
    menuHideTimer = null;
    const popup = menuWindow;
    menuWindow = null;
    menuPrepared = false;
    popup.destroy();
    return;
  }
  if (!menuWindow.isVisible() || menuClosing) {
    menuPendingOpen = false;
    return;
  }
  menuClosing = true;
  const generation = menuTransition;
  menuWindow.webContents.send('avatar-menu:close-animation', generation);
  // Fallback if renderer animation is throttled or interrupted by focus loss.
  menuHideTimer = setTimeout(() => finishMenuHide(generation), 400);
}

function createAvatarMenuWindow() {
  if (!mainWindow || mainWindow.isDestroyed() ||
      (menuWindow && !menuWindow.isDestroyed())) return;
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = normalizeMenuLayout(menuLayout, area);
  const popup = new BrowserWindow({
    parent: mainWindow,
    title: 'FRAME / Settings',
    x: area.x, y: area.y, width, height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'avatar-menu-preload.cjs'),
      partition: 'frame-panel-ui',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  menuWindow = popup;
  menuPrepared = false;
  popup.setMenuBarVisibility(false);
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', event => event.preventDefault());
  popup.webContents.on('did-finish-load', () => {
    if (menuWindow !== popup || popup.isDestroyed()) return;
    popup.webContents.setZoomFactor(menuLayout.zoom);
    // A fully transparent prewarmed page may never emit ready-to-show on
    // some GPU drivers. Script-load completion is enough for an instant open.
    menuPrepared = true;
    if (menuPendingOpen) showAvatarMenu();
  });
  popup.on('blur', () => {
    if (menuWindow === popup && popup.isVisible() && !menuResize &&
        !motionFolderDialogOpen && !menuClosing) closeAvatarMenu();
  });
  popup.on('closed', () => {
    if (menuResize?.window === popup) menuResize = null;
    if (menuWindow === popup) {
      menuWindow = null;
      menuPrepared = false;
      menuClosing = false;
    }
  });
  popup.loadFile(path.join(__dirname, 'avatar-menu.html')).catch(error => {
    console.error('[CORE menu] load failed:', error);
    if (menuWindow === popup) closeAvatarMenu(true);
  });
}

function showAvatarMenu() {
  if (!mainWindow || mainWindow.isDestroyed() || !currentModelFile) return;
  stopAvatarDrag();
  if (!menuWindow || menuWindow.isDestroyed()) createAvatarMenuWindow();
  if (!menuWindow || menuWindow.isDestroyed()) return;
  if (!menuPrepared) { menuPendingOpen = true; return; }
  const popup = menuWindow;
  const generation = ++menuTransition;
  menuPendingOpen = false;
  menuClosing = false;
  if (menuHideTimer) clearTimeout(menuHideTimer);
  menuHideTimer = null;
  const pointer = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pointer).workArea;
  const layout = normalizeMenuLayout(menuLayout, area);
  const { width, height } = layout;
  const x = Math.max(area.x, Math.min(pointer.x + 12, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(pointer.y + 10, area.y + area.height - height));
  popup.setBounds({ x, y, width, height }, false);
  // Fire the blue transfer immediately. The view snapshot is local and
  // already available; optional VoiSona status refresh happens afterward.
  popup.webContents.send('avatar-menu:open', generation, menuState());
  popup.show();
  popup.focus();
  void voisonaManager.refresh().then(() => {
    if (menuWindow === popup && !popup.isDestroyed() && popup.isVisible() &&
        generation === menuTransition && !menuClosing) {
      popup.webContents.send('avatar-menu:state-update', menuState());
    }
  }).catch(error => console.warn('[FRAME UI] voice status refresh failed:', error?.message));
}

function isMenuWindow(event) {
  return Boolean(menuWindow && !menuWindow.isDestroyed() &&
    event.sender === menuWindow.webContents);
}

async function executeMenuAction(action, value) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('モデル画面がありません');
  switch (action) {
    case 'model.change': {
      const model = await chooseModel();
      if (model && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('avatar:model-changed', model);
      }
      return model ? 'モデルを変更しました' : '変更をキャンセルしました';
    }
    case 'motion.play': {
      const motion = await chooseMotionFile();
      if (!motion) return '選択をキャンセルしました';
      mainWindow.webContents.send('avatar:motion-command', { type: 'play', ...motion });
      return 'VMDを送信しました: ' + motion.name;
    }
    case 'motion.walkLeft': case 'motion.walkRight':
      mainWindow.webContents.send('avatar:motion-command', {
        type: 'walk', direction: action === 'motion.walkLeft' ? -1 : 1
      });
      return action === 'motion.walkLeft' ? '左へ歩きます' : '右へ歩きます';
    case 'motion.walkStop':
      stopAvatarWalk();
      mainWindow.webContents.send('avatar:motion-command', { type: 'walk-stop' });
      return '歩行を停止します';
    case 'motion.stop':
      stopAvatarWalk();
      mainWindow.webContents.send('avatar:motion-command', { type: 'stop' });
      return '待機モーションへ戻します';
    case 'motion.folder': {
      motionFolderDialogOpen = true;
      let selection;
      try {
        selection = await dialog.showOpenDialog(menuWindow || mainWindow, {
          title: 'Motionsの保存先を選択',
          buttonLabel: 'ライブラリとして使用',
          properties: ['openDirectory']
        });
      } finally {
        motionFolderDialogOpen = false;
        if (menuWindow && !menuWindow.isDestroyed()) menuWindow.focus();
      }
      if (selection.canceled || !selection.filePaths.length) return '選択をキャンセルしました';
      const previous = motionDirectory;
      motionDirectory = selection.filePaths[0];
      await refreshMotionLibrary();
      if (motionEntries.length === 0 && motionLibraryMessage.startsWith('指定フォルダを開けません')) {
        motionDirectory = previous;
        await refreshMotionLibrary();
        throw new Error('フォルダを読み込めませんでした');
      }
      if (previous !== motionDirectory) {
        motionSelectedId = null;
        motionIdleId = null;
        mainWindow.webContents.send('avatar:motion-command', { type: 'reset-idle' });
      }
      await saveModelSelection();
      return motionLibraryMessage;
    }
    case 'motion.refresh':
      await refreshMotionLibrary();
      return motionLibraryMessage;
    case 'motion.preview':
      return previewLibraryMotion(value);
    case 'motion.next': case 'motion.previous': {
      if (!motionEntries.length) throw new Error('再生できるVMDがありません');
      const offset = action === 'motion.next' ? 1 : -1;
      const index = motionEntries.findIndex(entry => entry.id === motionSelectedId);
      const target = motionEntries[(index < 0
        ? (offset === 1 ? 0 : motionEntries.length - 1)
        : (index + offset + motionEntries.length) % motionEntries.length)];
      return previewLibraryMotion(target.id);
    }
    case 'motion.setIdle': {
      if (!motionSelectedId) throw new Error('先にモーションを選択してください');
      const motion = await readLibraryMotion(motionSelectedId);
      motionIdleId = motionSelectedId;
      await saveModelSelection();
      mainWindow.webContents.send('avatar:motion-command', { type: 'idle', ...motion });
      return '待機モーションに設定しました: ' + motion.name;
    }
    case 'motion.transition':
      if (!['auto', 'blend', 'warp'].includes(value)) throw new Error('不正な遷移方式です');
      motionTransitionMode = value;
      await saveModelSelection();
      mainWindow.webContents.send('avatar:motion-transition-mode', value);
      return '切り替え方式: ' + ({ auto: '自動', blend: 'ブレンド優先', warp: 'デジタル転送' }[value]);
    case 'motion.warpToggle':
      motionWarpEnabled = !motionWarpEnabled;
      await saveModelSelection();
      mainWindow.webContents.send('avatar:motion-warp-enabled', motionWarpEnabled);
      return 'デジタル転送演出: ' + (motionWarpEnabled ? 'ON' : 'OFF');
    case 'motion.resetIdle':
      motionIdleId = null;
      await saveModelSelection();
      mainWindow.webContents.send('avatar:motion-command', { type: 'reset-idle' });
      return '標準待機モーションへ戻しました';
    case 'voice.settings':
      openVoiceSettings();
      return '接続設定を開きました';
    case 'voice.refresh':
      await startProxyAndRefresh();
      await voisonaManager.refresh();
      return voiceError || '音声を更新しました';
    case 'voice.appStart': {
      const state = await voisonaManager.ensureRunning(voisonaPrefs.executable);
      if (!state.running) throw new Error(state.error || 'VoiSona Talkを起動できませんでした');
      await startProxyAndRefresh();
      return 'VoiSona Talkを起動・検出しました';
    }
    case 'voice.appShow':
      await voisonaManager.show();
      return 'VoiSona Talkの画面を表示しました';
    case 'voice.appHide':
      await voisonaManager.hide({ manual: true });
      return 'VoiSona Talkを非表示にしました';
    case 'voice.autoStart':
      voisonaPrefs.autoStart = !voisonaPrefs.autoStart;
      await saveModelSelection();
      return '自動起動: ' + (voisonaPrefs.autoStart ? 'ON' : 'OFF');
    case 'voice.autoHide':
      voisonaPrefs.autoHide = !voisonaPrefs.autoHide;
      await saveModelSelection();
      return '起動後の自動非表示: ' + (voisonaPrefs.autoHide ? 'ON' : 'OFF');
    case 'voice.appPath': {
      const chosen = await dialog.showOpenDialog(mainWindow, {
        title: 'VoiSona Talk.exeを選択',
        buttonLabel: '登録',
        properties: ['openFile'],
        filters: [{ name: 'VoiSona Talk', extensions: ['exe'] }]
      });
      if (chosen.canceled || !chosen.filePaths.length) return '選択をキャンセルしました';
      const selected = chosen.filePaths[0];
      if (path.win32.basename(selected).toLowerCase() !== 'voisona talk.exe') {
        throw new Error('VoiSona Talk.exeを選択してください');
      }
      voisonaPrefs.executable = selected;
      await saveModelSelection();
      return 'VoiSona Talkの実行ファイルを登録しました';
    }
    case 'voice.select':
      if (typeof value !== 'string' || value.length > 160 ||
          !voiceEntries.some(v => v.voice_name === value)) {
        throw new Error('使用できない音声です');
      }
      selectedVoiceName = value;
      await saveModelSelection();
      return '音声を選択しました';
    case 'voice.test':
      if (!voiceEntries.length) throw new Error('音声ライブラリがありません');
      mainWindow.webContents.send('avatar:voice-test');
      return 'テスト発話を開始しました';
    case 'voice.clipboard': {
      const text = await readSpeechText(clipboard);
      if (!text) throw new Error('クリップボードに文章がありません');
      mainWindow.webContents.send('avatar:voice-text', text);
      return '読み上げを開始しました';
    }
    case 'voice.token':
      if (!speechBridge?.server || !speechBridge.token) {
        throw new Error('連携トークンはまだ準備できていません');
      }
      await copySpeechToken(clipboard, speechBridge.token);
      return '連携トークンをコピーしました';
    case 'voice.stop':
      if (voiceSynthesis) voiceSynthesis.abort();
      mainWindow.webContents.send('avatar:voice-stop');
      return '再生を停止しました';
    case 'emotion.select':
      if (typeof value !== 'string' ||
          !EMOTION_OPTIONS.some(v => v.id === value) ||
          emotionState.available[value] !== true) {
        throw new Error('このモデルでは利用できない表情です');
      }
      mainWindow.webContents.send('avatar:emotion-change', value);
      return '表情を変更しました';
    case 'zoom.in': case 'zoom.out': case 'zoom.reset':
      zoomAvatarWindow(action.slice(5));
      return '表示倍率を変更しました';
    case 'diagnostic.emotion':
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'CORE Arona / 表情診断',
        message: 'モデルの表情対応',
        detail: emotionState.details,
        buttons: ['閉じる']
      });
      return '表情診断を閉じました';
    case 'diagnostic.motion':
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'CORE Arona / モーション診断',
        message: '待機モーションの診断',
        detail: idleDiagnostics,
        buttons: ['閉じる']
      });
      return 'モーション診断を閉じました';
    case 'diagnostic.voice':
      await dialog.showMessageBox(mainWindow, {
        type: voiceError ? 'warning' : 'info',
        title: 'CORE Arona / 音声診断',
        message: '音声接続の状態',
        detail: voiceDiagnostics(),
        buttons: ['閉じる']
      });
      return '音声診断を閉じました';
    case 'app.quit':
      app.quit();
      return '終了します';
    default:
      throw new Error('未対応のメニュー操作です');
  }
}

function createWindow() {
  // One transparent overlay per active display. Its small inner WebGL stage
  // retains the old camera framing and zoom, without cutting the visible pixels.
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const startupZoom = resolveZoomScale(startupScaleForArea(workArea), workArea);
  avatarScale = startupZoom.scale;
  const { width, height } = windowSizeForScale(startupZoom.nativeScale);
  avatarBounds = clampAvatarPosition({
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width, height
  }, workArea);
  avatarDisplayId = display.id;
  mainWindow = new BrowserWindow({
    title: 'CORE Arona Desktop',
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  // The overlay is transparent to every other app by default. Only hovering
  // a verified alpha hit rectangle re-enables native pointer input.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  startAvatarHitPolling();
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const area = screen.getDisplayMatching(avatarBounds).workArea;
    const { cameraZoom } = boundsForScale(avatarBounds, area, avatarScale);
    syncAvatarViewport();
    mainWindow.webContents.send('avatar:camera-zoom', cameraZoom);
  });
  mainWindow.on('close', event => {
    // Closing the frame directly (taskbar/OS) must use the same animation as
    // the in-app Exit button. An app.quit() call can be cancelled before close.
    if (!exitWarpComplete) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on('closed', () => {
    if (avatarHitTimer) clearInterval(avatarHitTimer);
    avatarHitTimer = null;
    avatarBounds = null;
    avatarHitRects = [];
    avatarDisplayId = null;
    stopAvatarWalk();
    closeAvatarMenu(true);
    stopAvatarDrag();
    voiceSynthesis?.abort();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await restoreModelSelection();
  await refreshMotionLibrary();
  await restoreMenuLayout();
  protocol.handle(SCHEME, handleModelAsset);

  ipcMain.handle('avatar:viewport', event => {
    if (!isOurWindow(event) || !avatarBounds) return null;
    return stageInDisplay(avatarBounds, screen.getDisplayMatching(avatarBounds).bounds);
  });
  ipcMain.handle('avatar:current', () => infoForCurrentModel());
  ipcMain.handle('avatar:motion-restore', async event => {
    if (!isOurWindow(event) || !motionIdleId || !motionDirectory) return null;
    try { return await readLibraryMotion(motionIdleId); }
    catch (error) {
      console.warn('[CORE motion] saved idle unavailable:', error);
      return null;
    }
  });
  ipcMain.handle('avatar:choose', async event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Unauthorized window');
    return chooseModel();
  });
  ipcMain.on('avatar:menu', event => {
    if (isOurWindow(event) && currentModelFile) showAvatarMenu();
  });
  ipcMain.handle('avatar-menu:state', event => {
    if (!isMenuWindow(event)) throw new Error('Unauthorized menu request');
    return menuState();
  });
  ipcMain.handle('avatar-menu:action', async (event, action, value) => {
    if (!isMenuWindow(event)) throw new Error('Unauthorized menu action');
    try {
      const message = await executeMenuAction(action, value);
      return { ok: true, message, state: menuState() };
    } catch (error) {
      console.error('[CORE menu] action failed:', action, error);
      return { ok: false, message: String(error?.message ?? error).slice(0, 240) };
    }
  });
  ipcMain.on('avatar-menu:resize-start', (event, edge) => {
    if (isMenuWindow(event)) beginMenuResize(edge);
  });
  ipcMain.on('avatar-menu:resize-move', event => {
    if (isMenuWindow(event)) moveMenuResize();
  });
  ipcMain.on('avatar-menu:resize-end', event => {
    if (isMenuWindow(event)) {
      moveMenuResize();
      finishMenuResize();
    }
  });
  ipcMain.on('avatar-menu:zoom', (event, direction) => {
    if (!isMenuWindow(event) || !['in', 'out', 'reset'].includes(direction)) return;
    menuLayout.zoom = changeMenuZoom(menuLayout.zoom, direction);
    menuWindow.webContents.setZoomFactor(menuLayout.zoom);
    saveMenuLayout();
  });
  ipcMain.on('avatar-menu:text-size', (event, percent) => {
    if (!isMenuWindow(event) || !Number.isInteger(percent) ||
        percent !== normalizeTextSize(percent)) return;
    if (menuTextSize === percent) return;
    menuTextSize = percent;
    saveMenuLayout();
  });
  ipcMain.on('avatar-menu:view-state', (event, state) => {
    if (!isMenuWindow(event) || !state || typeof state !== 'object' ||
        !MENU_TAB_SET.has(state.tab)) return;
    const safeScroll = value => Number.isFinite(value)
      ? Math.round(Math.max(0, Math.min(value, 100000))) : 0;
    menuViewState = {
      tab: state.tab,
      scroll: Object.fromEntries(MENU_TABS.map(tab => [tab, safeScroll(state.scroll?.[tab])])),
      motionList: safeScroll(state.motionList),
      voiceList: safeScroll(state.voiceList)
    };
  });
  ipcMain.on('avatar-menu:close', event => {
    if (isMenuWindow(event)) closeAvatarMenu();
  });
  ipcMain.on('avatar-menu:close-complete', (event, generation) => {
    if (isMenuWindow(event) && Number.isInteger(generation)) finishMenuHide(generation);
  });
  ipcMain.on('avatar:walk-velocity', (event, direction, speed) => {
    if (!isOurWindow(event)) return;
    if (direction === 0) {
      stopAvatarWalk();
    } else if ([-1, 1].includes(direction) && Number.isFinite(speed) &&
               speed >= 0 && speed <= 1000 && currentModelFile && !exitWarpPending) {
      beginAvatarWalk(direction, speed);
    }
  });
  ipcMain.on('avatar:zoom', (event, action) => {
    if (isOurWindow(event) && currentModelFile) zoomAvatarWindow(action);
  });
  ipcMain.on('avatar:set-region', (event, rect) => {
    if (isOurWindow(event)) setAvatarRegion(rect);
  });
  ipcMain.on('avatar:emotions-state', (event, state) => {
    if (!isOurWindow(event) || !state || typeof state !== 'object') return;
    const available = { neutral: true };
    for (const { id } of EMOTION_OPTIONS) {
      if (id !== 'neutral') available[id] = state.available?.[id] === true;
    }
    const requested = typeof state.selected === 'string' ? state.selected : 'neutral';
    const selected = available[requested] === true ? requested : 'neutral';
    emotionState = {
      available,
      selected,
      details: typeof state.details === 'string'
        ? state.details.slice(0, 3000)
        : '表情モーフの診断結果がありません'
    };
  });
  ipcMain.handle('voice-settings:status', async event => {
    if (!isSettingsWindow(event)) throw new Error('Unauthorized settings window');
    return voiceSettingsStatus();
  });
  ipcMain.handle('voice-settings:save', async (event, data) => {
    if (!isSettingsWindow(event)) throw new Error('Unauthorized settings window');
    const username = typeof data?.username === 'string' ? data.username.trim() : '';
    let password = typeof data?.password === 'string' ? data.password : '';
    if (!password && credentials?.username === username) password = credentials.password;
    const saved = await credentialStore.write(username, password);
    credentials = saved;
    credentialsError = '';
    voiceClient.setCredentials(saved);
    await startProxyAndRefresh();
    return voiceSettingsStatus();
  });
  ipcMain.handle('voice-settings:browser-autofill', async event => {
    if (!isSettingsWindow(event)) throw new Error('Unauthorized settings window');
    return browserCredentialPortal.open();
  });
  ipcMain.handle('voice-settings:clear', async event => {
    if (!isSettingsWindow(event)) throw new Error('Unauthorized settings window');
    await credentialStore.clear();
    credentials = null;
    credentialsError = '';
    voiceClient.setCredentials(null);
    // Existing externally-started Proxy may still have credentials set.
    await refreshVoices();
    return voiceSettingsStatus();
  });
  ipcMain.handle('voice-settings:connect', async event => {
    if (!isSettingsWindow(event)) throw new Error('Unauthorized settings window');
    return startProxyAndRefresh();
  });

  ipcMain.handle('avatar:voice-synthesize', async (event, request) => {
    if (!isOurWindow(event)) throw new Error('Unauthorized voice request');
    const text = typeof request === 'string' ? request : request?.text;
    const voice = resolveSelectedVoice(typeof request === 'string' ? null : request?.voice);
    const voiceProfiles = typeof request === 'string' ? null : request?.voiceProfiles;
    const profile = voiceProfiles && typeof voiceProfiles === 'object' &&
      !Array.isArray(voiceProfiles) && voice
      ? Object.hasOwn(voiceProfiles, voiceKey(voice)) ? voiceProfiles[voiceKey(voice)] : null
      : null;
    const globals = globalParameters(profile);
    if (!voice) throw new Error('音声ライブラリが未選択です。右クリックから接続を更新してください');
    if (voiceSynthesis) voiceSynthesis.abort();
    const controller = new AbortController();
    voiceSynthesis = controller;
    try {
      const bytes = await voiceClient.synthesize(text, voice, controller.signal, globals);
      console.info('[CORE speech] normalized:', voiceClient.lastWavInfo);
      if (controller.signal.aborted) throw new Error('古い音声リクエストを中断しました');
      return { wavBase64: bytes.toString('base64'), voiceName: voice.voice_name };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('古い音声リクエストを中断しました');
      throw new Error('音声生成に失敗しました: ' + String(error?.message ?? error));
    } finally {
      if (voiceSynthesis === controller) voiceSynthesis = null;
    }
  });
  ipcMain.on('avatar:voice-playback-status', (event, status) => {
    if (!isOurWindow(event) || typeof status !== 'string') return;
    voicePlaybackStatus = status.slice(0, 800);
  });
  ipcMain.on('avatar:voice-cancel', event => {
    if (isOurWindow(event) && voiceSynthesis) voiceSynthesis.abort();
  });
  ipcMain.on('avatar:idle-status', (event, diagnostic) => {
    if (!isOurWindow(event) || typeof diagnostic !== 'string') return;
    idleDiagnostics = diagnostic.slice(0, 3500);
  });
  ipcMain.on('avatar:drag-start', event => {
    if (isOurWindow(event)) startAvatarDrag();
  });
  ipcMain.on('avatar:drag-stop', event => {
    if (isOurWindow(event)) stopAvatarDrag();
  });
  ipcMain.on('avatar:quit', event => {
    if (mainWindow && event.sender === mainWindow.webContents) app.quit();
  });
  ipcMain.on('avatar:quit-ready', event => {
    if (isOurWindow(event) && exitWarpPending) completeExitWarp();
  });

  credentialStore = new VoiceCredentialStore({
    safeStorage, userDataPath: app.getPath('userData')
  });
  browserCredentialPortal = new BrowserCredentialPortal({
    openExternal: url => shell.openExternal(url),
    onCredentials: async (username, password) => {
      const saved = await credentialStore.write(username, password);
      credentials = saved;
      credentialsError = '';
      voiceClient.setCredentials(saved);
      // Inform settings modal without ever returning the password to HTML.
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('voice-settings:credentials-imported');
      }
      void refreshVoices();
    }
  });
  try {
    credentials = await credentialStore.read();
    voiceClient.setCredentials(credentials);
  } catch (error) {
    credentialsError = '暗号化済み認証情報を復号できません。設定画面で再登録してください';
    console.warn('[CORE Voice] encrypted settings cannot be restored:', error?.message);
  }
  createWindow();
  createAvatarMenuWindow(); // Prewarm once during startup, not on right-click.
  speechBridge = new SpeechBridge({
    userDataPath: app.getPath('userData'),
    safeStorage,
    onText: text => {
      if (!isVoiceCommandWindowReady()) return false;
      mainWindow.webContents.send('avatar:voice-text', text);
      return true;
    },
    onCommand: handleSpeechCommand
  });
  void speechBridge.start().catch(error => {
    speechBridgeError = String(error?.message ?? error);
    speechBridge = null;
    console.warn('[CORE speech bridge] unable to listen:', speechBridgeError);
  });
  // Start installed VoiSona Talk and its existing Python proxy without
  // delaying MMD rendering. A configured API must be reachable before
  // automatically hiding a newly launched editor window.
  void startIntegratedVoice();
}).catch(error => {
  console.error('Unable to initialize desktop avatar:', error);
  app.quit();
});

let voiceShutdownPending = false;
let voiceShutdownComplete = false;
app.on('before-quit', event => {
  if (!exitWarpComplete) {
    if (mainWindow && !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isLoadingMainFrame()) {
      event.preventDefault();
      if (exitWarpPending) return;
      exitWarpPending = true;
      stopAvatarWalk();
      closeAvatarMenu(true); // The popup must not cover the disappearing avatar.
      mainWindow.webContents.send('avatar:prepare-quit');
      // The 260ms exit transfer cannot block quitting if rendering stalls.
      exitWarpTimeout = setTimeout(() => {
        console.warn('[FRAME warp] exit animation timed out; closing safely');
        completeExitWarp();
      }, 2500);
      return;
    }
    // Early boot failure or no remaining avatar window: quit immediately.
    exitWarpComplete = true;
  }
  if (!voiceShutdownComplete) {
    event.preventDefault();
    if (voiceShutdownPending) return;
    voiceShutdownPending = true;
    void voisonaManager.shutdown().catch(error => {
      console.warn('[CORE Voice] VoiSona shutdown failed:', error?.message);
    }).finally(() => {
      voiceShutdownComplete = true;
      app.quit();
    });
    return;
  }
  closeAvatarMenu(true);
  browserCredentialPortal?.close();
  speechBridge?.close();
  proxyManager.stop();
});
app.on('window-all-closed', () => app.quit());
