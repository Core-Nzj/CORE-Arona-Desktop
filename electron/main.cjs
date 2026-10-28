'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, screen, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveAssetPath } = require('./asset-path.cjs');
const {
  BASE_WIDTH, BASE_HEIGHT, INITIAL_SCALE, MIN_SCALE,
  clampScale, windowSizeForScale, boundsForScale
} = require('./avatar-window-size.cjs');
const { VoiceProxyClient, PROXY_ORIGIN } = require('./voice-proxy.cjs');
const { VoiceCredentialStore } = require('./voice-credentials.cjs');
const { ProxyManager } = require('./proxy-manager.cjs');
const { VoiSonaManager } = require('./voisona-manager.cjs');
const { BrowserCredentialPortal } = require('./browser-credentials.cjs');
const { SpeechBridge } = require('./speech-bridge.cjs');
const { readSpeechText, copySpeechToken } = require('./clipboard-actions.cjs');
const { voiceKey, globalParameters } = require('./speech-settings.cjs');

// Desktop speech may start from a native context-menu action.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const SCHEME = 'arona-avatar';
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
let avatarScale = INITIAL_SCALE;
let settingsWindow = null;
let menuWindow = null;
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
let idleDiagnostics = 'モーションの読み込みを待っています';
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
    backgroundColor: '#f6f8fb',
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
    url: SCHEME + '://model/' + encodeURIComponent(path.basename(currentModelFile))
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
    voisonaExecutable: voisonaPrefs.executable
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

function isOurWindow(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

function setAvatarRegion(rects) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (rects === null) {
    mainWindow.setShape([]);
    return;
  }
  if (!Array.isArray(rects) || rects.length < 1 || rects.length > 2000) return;

  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  const checked = [];
  for (const rect of rects) {
    const values = [rect?.x, rect?.y, rect?.width, rect?.height];
    if (!values.every(Number.isFinite)) return;
    const x = Math.max(0, Math.min(windowWidth, Math.floor(rect.x)));
    const y = Math.max(0, Math.min(windowHeight, Math.floor(rect.y)));
    const width = Math.max(0, Math.min(windowWidth - x, Math.ceil(rect.width)));
    const height = Math.max(0, Math.min(windowHeight - y, Math.ceil(rect.height)));
    if (width && height) checked.push({ x, y, width, height });
  }
  if (checked.length) mainWindow.setShape(checked);
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
  stopAvatarDrag();
  dragStart = {
    pointer: screen.getCursorScreenPoint(),
    position: mainWindow.getPosition(),
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
    const [oldX, oldY] = mainWindow.getPosition();
    if (x !== oldX || y !== oldY) mainWindow.setPosition(x, y);
  }, 16);
}

function zoomAvatarWindow(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const steps = action === 'in' ? 1 : action === 'out' ? -1
    : typeof action === 'number' && Number.isFinite(action) && Math.abs(action) <= 2
      ? action : null;
  if (action !== 'reset' && (steps === null || steps === 0)) return;
  const currentBounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(currentBounds).workArea;
  const requestedScale = action === 'reset'
    ? clampScale(INITIAL_SCALE, workArea)
    : avatarScale * Math.pow(1 / 0.85, steps);
  // Center-based anchoring avoids the cursor/window oscillation on resize.
  const { bounds, scale, cameraZoom } =
    boundsForScale(currentBounds, workArea, requestedScale);
  avatarScale = scale;
  if (bounds.x !== currentBounds.x || bounds.y !== currentBounds.y ||
      bounds.width !== currentBounds.width || bounds.height !== currentBounds.height) {
    stopAvatarDrag();
    mainWindow.setBounds(bounds, false);
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

// A separate popup keeps the avatar's native click-through silhouette intact.
function menuState() {
  return {
    modelName: currentModelFile ? path.basename(currentModelFile) : '未選択',
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

function closeAvatarMenu() {
  const popup = menuWindow;
  menuWindow = null;
  if (popup && !popup.isDestroyed()) popup.close();
}

function showAvatarMenu() {
  if (!mainWindow || mainWindow.isDestroyed() || !currentModelFile) return;
  closeAvatarMenu();
  stopAvatarDrag();
  const pointer = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pointer).workArea;
  const width = Math.min(376, Math.max(280, area.width - 12));
  const height = Math.min(566, Math.max(320, area.height - 12));
  const x = Math.max(area.x, Math.min(pointer.x + 12, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(pointer.y + 10, area.y + area.height - height));
  const popup = new BrowserWindow({
    parent: mainWindow,
    title: 'CORE Arona / Control Panel',
    x, y, width, height,
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
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  menuWindow = popup;
  popup.setMenuBarVisibility(false);
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', event => event.preventDefault());
  popup.once('ready-to-show', () => {
    if (menuWindow !== popup || popup.isDestroyed()) return;
    popup.show();
    popup.focus();
  });
  popup.on('blur', () => {
    if (menuWindow === popup) closeAvatarMenu();
  });
  popup.on('closed', () => {
    if (menuWindow === popup) menuWindow = null;
  });
  popup.loadFile(path.join(__dirname, 'avatar-menu.html')).catch(error => {
    console.error('[CORE menu] load failed:', error);
    if (menuWindow === popup) closeAvatarMenu();
  });
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
  // Start near the previously requested 2x avatar size, without clipping
  // outside the current monitor's working area.
  avatarScale = clampScale(INITIAL_SCALE, screen.getPrimaryDisplay().workArea);
  const { width, height } = windowSizeForScale(avatarScale);
  mainWindow = new BrowserWindow({
    title: 'CORE Arona Desktop',
    width,
    height,
    minWidth: Math.min(BASE_WIDTH, width),
    minHeight: Math.min(BASE_HEIGHT, height),
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

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const { cameraZoom } = boundsForScale(mainWindow.getBounds(), area, avatarScale);
    mainWindow.webContents.send('avatar:camera-zoom', cameraZoom);
  });
  mainWindow.on('closed', () => {
    closeAvatarMenu();
    stopAvatarDrag();
    voiceSynthesis?.abort();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await restoreModelSelection();
  protocol.handle(SCHEME, handleModelAsset);

  ipcMain.handle('avatar:current', () => infoForCurrentModel());
  ipcMain.handle('avatar:choose', async event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Unauthorized window');
    return chooseModel();
  });
  ipcMain.on('avatar:menu', event => {
    if (isOurWindow(event) && currentModelFile) showAvatarMenu();
  });
  ipcMain.handle('avatar-menu:state', async event => {
    if (!isMenuWindow(event)) throw new Error('Unauthorized menu request');
    await voisonaManager.refresh();
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
  ipcMain.on('avatar-menu:close', event => {
    if (isMenuWindow(event)) closeAvatarMenu();
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
  closeAvatarMenu();
  browserCredentialPortal?.close();
  speechBridge?.close();
  proxyManager.stop();
});
app.on('window-all-closed', () => app.quit());
