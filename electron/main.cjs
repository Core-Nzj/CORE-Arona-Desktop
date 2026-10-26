'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, protocol } = require('electron');
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
let clickThrough = false;

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
  await saveModelSelection();
  return infoForCurrentModel();
}

function isOurWindow(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

function setClickThrough(enabled) {
  if (!mainWindow || mainWindow.isDestroyed() || enabled === clickThrough) return;
  mainWindow.setIgnoreMouseEvents(enabled, enabled ? { forward: true } : {});
  clickThrough = enabled;
}

function showAvatarMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // The menu itself must be able to receive pointer events.
  setClickThrough(false);

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
    { type: 'separator' },
    { label: '拡大', click: () => zoom('in') },
    { label: '縮小', click: () => zoom('out') },
    { label: '大きさをリセット', click: () => zoom('reset') },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() }
  ]);
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

  clickThrough = false;
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
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
  ipcMain.on('avatar:click-through', (event, enabled) => {
    if (isOurWindow(event) && typeof enabled === 'boolean') {
      setClickThrough(enabled);
    }
  });
  ipcMain.on('avatar:move-by', (event, dx, dy) => {
    if (!isOurWindow(event) || clickThrough || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // A renderer may request only incremental movement, not arbitrary coordinates.
    if (Math.abs(dx) > 100 || Math.abs(dy) > 100) return;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
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
