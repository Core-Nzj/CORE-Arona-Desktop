'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, screen, safeStorage, shell } = require('electron');
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
const { BrowserCredentialPortal } = require('./browser-credentials.cjs');
const { SpeechBridge } = require('./speech-bridge.cjs');
const { readSpeechText, copySpeechToken } = require('./clipboard-actions.cjs');

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
const proxyManager = new ProxyManager();
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
    error: credentialsError
  };
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
  await fs.writeFile(filepath, JSON.stringify({ modelPath: currentModelFile, voiceName: selectedVoiceName }, null, 2), 'utf8');
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

function zoomAvatarWindow(action, anchorToCursor = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!['in', 'out', 'reset'].includes(action)) return;
  const currentBounds = mainWindow.getBounds();
  const pointer = anchorToCursor ? screen.getCursorScreenPoint() : null;
  const display = pointer
    ? screen.getDisplayNearestPoint(pointer)
    : screen.getDisplayMatching(currentBounds);
  const requestedScale = action === 'reset' ? INITIAL_SCALE
    : avatarScale * (action === 'in' ? 1 / 0.85 : 0.85);
  const { bounds, scale } = boundsForScale(
    currentBounds, display.workArea, requestedScale, pointer
  );
  avatarScale = scale;
  if (bounds.x === currentBounds.x && bounds.y === currentBounds.y &&
      bounds.width === currentBounds.width && bounds.height === currentBounds.height) return;
  stopAvatarDrag();
  mainWindow.setBounds(bounds, false);
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

function showAvatarMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const zoom = action => zoomAvatarWindow(action);

  const voiceSubmenu = [
    {
      label: '接続設定・認証情報...',
      click: () => openVoiceSettings()
    },
    { type: 'separator' },
    {
      label: voiceError ? '未接続（更新してください）' : '接続中',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Proxyを起動・音声一覧を更新',
      click: async () => {
        await startProxyAndRefresh();
        if (mainWindow && !mainWindow.isDestroyed()) {
          await dialog.showMessageBox(mainWindow, {
            type: voiceError ? 'warning' : 'info',
            title: 'VoiSona Talk Proxy',
            message: voiceError || '音声ライブラリを検出しました',
            detail: voiceDiagnostics(),
            buttons: ['閉じる']
          });
        }
      }
    },
    {
      label: '使用する音声',
      enabled: voiceEntries.length > 0,
      submenu: voiceEntries.length
        ? voiceEntries.map(voice => ({
          label: voice.voice_name,
          type: 'radio',
          checked: selectedVoiceName === voice.voice_name,
          click: () => {
            selectedVoiceName = voice.voice_name;
            void saveModelSelection();
          }
        }))
        : [{ label: '音声ライブラリなし', enabled: false }]
    },
    { type: 'separator' },
    {
      label: 'テスト発話',
      enabled: voiceEntries.length > 0,
      click: () => mainWindow?.webContents.send('avatar:voice-test')
    },
    {
      label: 'クリップボードの文章を発話（最大500文字）',
      click: async () => {
        try {
          const text = await readSpeechText(clipboard);
          if (!text) return;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('avatar:voice-text', text);
          }
        } catch (error) {
          await reportClipboardError(error);
        }
      }
    },
    {
      label: 'ChatGPT連携トークンをコピー',
      enabled: Boolean(speechBridge?.server),
      click: async () => {
        try {
          await copySpeechToken(clipboard, speechBridge?.token);
        } catch (error) {
          await reportClipboardError(error);
        }
      }
    },
    {
      label: '再生停止',
      click: () => {
        if (voiceSynthesis) voiceSynthesis.abort();
        mainWindow?.webContents.send('avatar:voice-stop');
      }
    },
    { type: 'separator' },
    {
      label: '音声診断',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        void dialog.showMessageBox(mainWindow, {
          type: voiceError ? 'warning' : 'info',
          title: 'VoiSona Talk Proxy',
          message: '音声接続の状態',
          detail: voiceDiagnostics(),
          buttons: ['閉じる']
        });
      }
    }
  ];

  const menu = Menu.buildFromTemplate([
    {
      label: 'モデルを変更...',
      click: async () => {
        try {
          const selected = await chooseModel();
          if (selected && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('avatar:model-changed', selected);
          }
        } catch (error) {
          console.error('Unable to choose model from context menu:', error);
        }
      }
    },
    {
      label: '音声（VoiSona Talk）',
      submenu: voiceSubmenu
    },
    {
      label: '表情',
      submenu: EMOTION_OPTIONS.map(({ id, label }) => ({
        label,
        type: 'radio',
        checked: emotionState.selected === id,
        enabled: emotionState.available[id] === true,
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (emotionState.available[id] !== true) return;
          mainWindow.webContents.send('avatar:emotion-change', id);
        }
      }))
    },
    { type: 'separator' },
    { label: '拡大', click: () => zoom('in') },
    { label: '縮小', click: () => zoom('out') },
    { label: '大きさをリセット', click: () => zoom('reset') },
    { type: 'separator' },
    {
      label: '表情診断',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        void dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'CORE Arona Desktop / Phase 2-2',
          message: 'モデルの表情対応',
          detail: emotionState.details,
          buttons: ['閉じる']
        });
      }
    },
    {
      label: 'モーション診断',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        void dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'CORE Arona Desktop / Phase 2-1',
          message: '待機モーションの診断',
          detail: idleDiagnostics,
          buttons: ['閉じる']
        });
      }
    },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() }
  ]);
  stopAvatarDrag();
  menu.popup({ window: mainWindow });
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
  mainWindow.on('closed', () => { stopAvatarDrag(); voiceSynthesis?.abort(); mainWindow = null; });
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
  ipcMain.on('avatar:zoom', (event, action) => {
    if (isOurWindow(event) && currentModelFile) zoomAvatarWindow(action, true);
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

  ipcMain.handle('avatar:voice-synthesize', async (event, text) => {
    if (!isOurWindow(event)) throw new Error('Unauthorized voice request');
    const voice = currentVoice();
    if (!voice) throw new Error('音声ライブラリが未選択です。右クリックから接続を更新してください');
    if (voiceSynthesis) voiceSynthesis.abort();
    const controller = new AbortController();
    voiceSynthesis = controller;
    try {
      const bytes = await voiceClient.synthesize(text, voice, controller.signal);
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
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
      mainWindow.webContents.send('avatar:voice-text', text);
      return true;
    }
  });
  void speechBridge.start().catch(error => {
    speechBridgeError = String(error?.message ?? error);
    speechBridge = null;
    console.warn('[CORE speech bridge] unable to listen:', speechBridgeError);
  });
  // Check/launch localhost Python proxy without delaying model rendering.
  void startProxyAndRefresh();
}).catch(error => {
  console.error('Unable to initialize desktop avatar:', error);
  app.quit();
});

app.on('before-quit', () => { browserCredentialPortal?.close(); speechBridge?.close(); proxyManager.stop(); });
app.on('window-all-closed', () => app.quit());
