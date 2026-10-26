'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveAssetPath } = require('./asset-path.cjs');

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
let currentModelFile = null;
let dragTimer = null;
let dragStart = null;
let idleDiagnostics = 'モーションの読み込みを待っています';
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
  await fs.writeFile(filepath, JSON.stringify({ modelPath: currentModelFile }, null, 2), 'utf8');
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

function showAvatarMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const zoom = action => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('avatar:zoom', action);
    }
  };

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
  mainWindow = new BrowserWindow({
    title: 'CORE Arona Desktop',
    width: 390,
    height: 590,
    minWidth: 390,
    minHeight: 590,
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
  mainWindow.on('closed', () => { stopAvatarDrag(); mainWindow = null; });
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

  createWindow();
}).catch(error => {
  console.error('Unable to initialize desktop avatar:', error);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
