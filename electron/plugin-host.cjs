'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PLUGIN_TYPE = 'frame.windows-list.v1';
const PLUGIN_ENTRY = 'list-windows.ps1';
const CAPTURE_ENTRY = 'capture-window.ps1';
const MAX_PLUGINS = 32;
const MAX_WINDOWS = 100;
const MAX_OUTPUT = 256 * 1024;
const MAX_CAPTURE_OUTPUT = 12 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;

function normalizeManifest(raw, directoryName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id !== directoryName ||
      !/^[a-z][a-z0-9.-]{2,63}$/.test(raw.id)) return null;
  if (raw.apiVersion !== 1 || raw.type !== PLUGIN_TYPE ||
      raw.entry !== PLUGIN_ENTRY) return null;
  if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 80) return null;
  if (!Array.isArray(raw.permissions) || raw.permissions[0] !== 'window-titles') return null;
  const captureEnabled = raw.permissions.length === 2 &&
    raw.permissions[1] === 'window-capture' && raw.captureEntry === CAPTURE_ENTRY;
  const listOnly = raw.permissions.length === 1 && raw.captureEntry === undefined;
  if (!captureEnabled && !listOnly) return null;
  return {
    id: raw.id, name: raw.name, type: raw.type,
    permissions: captureEnabled ? ['window-titles', 'window-capture'] : ['window-titles'],
    captureEnabled
  };
}

function normalizeWindows(value) {
  if (!Array.isArray(value)) throw new Error('プラグインの応答は配列ではありません');
  return value.slice(0, MAX_WINDOWS).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.id !== 'string' || !/^0x[\da-f]{1,16}$/i.test(item.id) ||
        !Number.isSafeInteger(item.pid) || item.pid < 0 ||
        typeof item.title !== 'string' || item.title.length === 0) return [];
    return [{ id: item.id, pid: item.pid, title: item.title.slice(0, 200) }];
  });
}

function powershellExecutable() {
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function runWindowsListScript(scriptPath) {
  if (process.platform !== 'win32') throw new Error('ウィンドウ一覧取得はWindows専用です');
  const { stdout } = await execFileAsync(powershellExecutable(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath
  ], {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: MAX_OUTPUT,
    encoding: 'utf8'
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

async function runCaptureScript(scriptPath, window) {
  if (process.platform !== 'win32') throw new Error('撮影はWindows専用です');
  const { stdout } = await execFileAsync(powershellExecutable(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, '-WindowId', window.id, '-ProcessId', String(window.pid)
  ], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: MAX_CAPTURE_OUTPUT,
    encoding: 'utf8'
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

function normalizeCapture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.image !== 'string' || value.image.length > 11200000 ||
      !/^[a-zA-Z0-9+/]+={0,2}$/.test(value.image) ||
      value.image.length % 4 !== 0) {
    throw new Error('PNG画像の応答形式が不正です');
  }
  const bytes = Buffer.from(value.image, 'base64');
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || bytes.length > MAX_PNG_BYTES ||
      !bytes.subarray(0, 8).equals(pngSignature) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG画像が不正、またはサイズ上限を超えています');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 4096 ||
      value.width !== width || value.height !== height ||
      value.mode !== 'PrintWindow') {
    throw new Error('撮影画像のサイズまたは取得方式が不正です');
  }
  return {
    dataUrl: 'data:image/png;base64,' + value.image,
    width, height, mode: value.mode
  };
}

// Intentionally narrow first-generation plugin interface. Never load third-party
// JavaScript into Electron's privileged main process. Scripts are user-installed,
// run only after explicit opt-in, and must still be treated as trusted code.
class FramePluginHost {
  constructor({ dataDirectory, runListScript = runWindowsListScript,
    runCapture = runCaptureScript, platform = process.platform }) {
    if (typeof dataDirectory !== 'string' || !dataDirectory) {
      throw new Error('Plugin data directory is required');
    }
    this.root = path.join(dataDirectory, 'plugins');
    this.preferencesPath = path.join(dataDirectory, 'frame-plugin-permissions.json');
    this.runListScript = runListScript;
    this.platform = platform;
    this.approved = new Map();
    this.plugins = new Map();
    this.windows = [];
    this.activePluginId = null;
    this.capture = null;
    this.runCaptureScript = runCapture;
    this.message = '未検索';
  }

  async initialize() {
    try {
      const prefs = JSON.parse(await fs.readFile(this.preferencesPath, 'utf8'));
      if (prefs?.approved && typeof prefs.approved === 'object' && !Array.isArray(prefs.approved)) {
        this.approved = new Map(Object.entries(prefs.approved).filter(([id, hash]) =>
          /^[a-z][a-z0-9.-]{2,63}$/.test(id) && /^[a-f0-9]{64}$/.test(hash)));
      }
    } catch {
      this.approved = new Map();
    }
    await this.refresh();
  }

  async refresh() {
    this.windows = [];
    this.activePluginId = null;
    this.capture = null;
    const next = new Map();
    let entries = [];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.plugins = next;
        this.message = 'プラグインフォルダを開けません: ' + String(error.message).slice(0, 100);
        return;
      }
    }
    for (const entry of entries.slice(0, MAX_PLUGINS)) {
      if (!entry.isDirectory() || !/^[a-z][a-z0-9.-]{2,63}$/.test(entry.name)) continue;
      const folder = path.join(this.root, entry.name);
      const manifestPath = path.join(folder, 'plugin.json');
      const scriptPath = path.join(folder, PLUGIN_ENTRY);
      const capturePath = path.join(folder, CAPTURE_ENTRY);
      try {
        const [manifestStat, scriptStat] = await Promise.all([
          fs.lstat(manifestPath), fs.lstat(scriptPath)
        ]);
        if (!manifestStat.isFile() || manifestStat.size > 8192 || !scriptStat.isFile() ||
            scriptStat.size > 128 * 1024) continue;
        // lstat().isFile() rejects symbolic links for both files.
        const manifest = normalizeManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), entry.name);
        if (manifest) {
          let fingerprint;
          if (manifest.captureEnabled) {
            const captureStat = await fs.lstat(capturePath);
            if (!captureStat.isFile() || captureStat.size > 128 * 1024) continue;
            fingerprint = createHash('sha256')
              .update(await fs.readFile(manifestPath)).update('\0')
              .update(await fs.readFile(scriptPath)).update('\0')
              .update(await fs.readFile(capturePath)).digest('hex');
          } else {
            // Keep approvals for the original list-only v0.1 plugin valid.
            fingerprint = createHash('sha256')
              .update(await fs.readFile(scriptPath)).digest('hex');
          }
          next.set(manifest.id, { ...manifest, scriptPath, capturePath, fingerprint });
        }
      } catch {
        // Invalid plugins are never loaded or executed.
      }
    }
    this.plugins = next;
    this.message = next.size ? next.size + '件のプラグインを検出' : 'プラグインが見つかりません';
  }

  state() {
    return {
      directory: this.root,
      supported: this.platform === 'win32',
      message: this.message,
      entries: [...this.plugins.values()].map(({ id, name, permissions, captureEnabled }) => ({
        id, name, permissions, captureEnabled,
        enabled: this.approved.get(id) === this.plugins.get(id).fingerprint
      })),
      activePluginId: this.activePluginId,
      windows: this.windows,
      capture: this.capture
    };
  }

  async setEnabled(id, enabled) {
    if (typeof id !== 'string' || typeof enabled !== 'boolean' || !this.plugins.has(id)) {
      throw new Error('不明なプラグインです');
    }
    if (enabled) this.approved.set(id, this.plugins.get(id).fingerprint);
    else this.approved.delete(id);
    this.windows = [];
    this.activePluginId = null;
    this.capture = null;
    await fs.mkdir(path.dirname(this.preferencesPath), { recursive: true });
    // Store only permission choices. No windows, titles, or screenshots persist.
    await fs.writeFile(this.preferencesPath, JSON.stringify({
      approved: Object.fromEntries(this.approved)
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async listWindows(id) {
    if (this.platform !== 'win32') throw new Error('Windows専用の機能です');
    const plugin = typeof id === 'string' ? this.plugins.get(id) : null;
    if (!plugin || plugin.type !== PLUGIN_TYPE) throw new Error('対応するプラグインがありません');
    if (this.approved.get(id) !== plugin.fingerprint) {
      throw new Error('プラグインの利用を許可してください（更新後は再許可が必要です）');
    }
    // Revalidate the entry before executing; a missing/replaced symlink is denied.
    const entry = await fs.lstat(plugin.scriptPath);
    if (!entry.isFile() || entry.size > 128 * 1024) {
      throw new Error('プラグインの実行ファイルが不正です');
    }
    const hasCapture = Boolean(plugin.captureEnabled);
    const currentHash = createHash('sha256');
    if (hasCapture) {
      const manifestPath = path.join(path.dirname(plugin.scriptPath), 'plugin.json');
      const [manifest, capture] = await Promise.all([
        fs.lstat(manifestPath), fs.lstat(plugin.capturePath)
      ]);
      if (!manifest.isFile() || !capture.isFile() ||
          manifest.size > 8192 || capture.size > 128 * 1024) {
        throw new Error('プラグインファイルが不正です');
      }
      currentHash.update(await fs.readFile(manifestPath)).update('\0');
    }
    currentHash.update(await fs.readFile(plugin.scriptPath));
    if (hasCapture) {
      currentHash.update('\0').update(await fs.readFile(plugin.capturePath));
    }
    const currentFingerprint = currentHash.digest('hex');
    if (currentFingerprint !== plugin.fingerprint) {
      throw new Error('プラグインが変更されています。再読み込みして権限を再確認してください');
    }
    try {
      const result = await this.runListScript(plugin.scriptPath);
      this.windows = normalizeWindows(result);
      this.activePluginId = id;
      this.capture = null;
      return this.windows;
    } catch (error) {
      this.windows = [];
      this.activePluginId = null;
      this.capture = null;
      throw new Error('ウィンドウ一覧を取得できません: ' + String(error.message).slice(0, 130));
    }
  }

  clearCapture() {
    this.capture = null;
  }

  async captureWindow(pluginId, windowId) {
    this.capture = null;
    if (this.platform !== 'win32') throw new Error('撮影はWindows専用です');
    const plugin = typeof pluginId === 'string' ? this.plugins.get(pluginId) : null;
    if (!plugin || !plugin.captureEnabled) throw new Error('撮影対応プラグインがありません');
    if (this.approved.get(pluginId) !== plugin.fingerprint) {
      throw new Error('撮影権限がありません。プラグインを再許可してください');
    }
    if (this.activePluginId !== pluginId) throw new Error('先にウィンドウ一覧を取得してください');
    const target = this.windows.find(item => item.id === windowId);
    if (!target) throw new Error('指定したウィンドウが一覧に存在しません');
    const [manifestStat, scriptStat, captureStat] = await Promise.all([
      fs.lstat(path.join(path.dirname(plugin.scriptPath), 'plugin.json')),
      fs.lstat(plugin.scriptPath),
      fs.lstat(plugin.capturePath)
    ]);
    if (![manifestStat, scriptStat, captureStat].every(stat =>
      stat.isFile() && stat.size <= 128 * 1024)) {
      throw new Error('プラグインの実行ファイルが不正です');
    }
    const fingerprint = createHash('sha256')
      .update(await fs.readFile(path.join(path.dirname(plugin.scriptPath), 'plugin.json')))
      .update('\0')
      .update(await fs.readFile(plugin.scriptPath)).update('\0')
      .update(await fs.readFile(plugin.capturePath)).digest('hex');
    if (fingerprint !== plugin.fingerprint) {
      throw new Error('プラグインが更新されています。再読み込みと再許可が必要です');
    }
    try {
      const image = normalizeCapture(await this.runCaptureScript(plugin.capturePath, target));
      this.capture = { ...image, title: target.title, pid: target.pid };
      return this.capture;
    } catch (error) {
      this.capture = null;
      throw new Error('撮影に失敗しました: ' + String(error.message).slice(0, 130));
    }
  }
}

module.exports = {
  FramePluginHost, normalizeManifest, normalizeWindows, normalizeCapture, PLUGIN_TYPE
};
