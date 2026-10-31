'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PLUGIN_TYPE = 'frame.windows-list.v1';
const PLUGIN_ENTRY = 'list-windows.ps1';
const MAX_PLUGINS = 32;
const MAX_WINDOWS = 100;
const MAX_OUTPUT = 256 * 1024;

function normalizeManifest(raw, directoryName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id !== directoryName ||
      !/^[a-z][a-z0-9.-]{2,63}$/.test(raw.id)) return null;
  if (raw.apiVersion !== 1 || raw.type !== PLUGIN_TYPE ||
      raw.entry !== PLUGIN_ENTRY) return null;
  if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 80) return null;
  if (!Array.isArray(raw.permissions) || raw.permissions.length !== 1 ||
      raw.permissions[0] !== 'window-titles') return null;
  return { id: raw.id, name: raw.name, type: raw.type, permissions: ['window-titles'] };
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

async function runWindowsListScript(scriptPath) {
  if (process.platform !== 'win32') throw new Error('ウィンドウ一覧取得はWindows専用です');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(powershell, [
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

// Intentionally narrow first-generation plugin interface. Never load third-party
// JavaScript into Electron's privileged main process. Scripts are user-installed,
// run only after explicit opt-in, and must still be treated as trusted code.
class FramePluginHost {
  constructor({ dataDirectory, runListScript = runWindowsListScript, platform = process.platform }) {
    if (typeof dataDirectory !== 'string' || !dataDirectory) {
      throw new Error('Plugin data directory is required');
    }
    this.root = path.join(dataDirectory, 'plugins');
    this.preferencesPath = path.join(dataDirectory, 'frame-plugin-permissions.json');
    this.runListScript = runListScript;
    this.platform = platform;
    this.approved = new Set();
    this.plugins = new Map();
    this.windows = [];
    this.message = '未検索';
  }

  async initialize() {
    try {
      const prefs = JSON.parse(await fs.readFile(this.preferencesPath, 'utf8'));
      if (Array.isArray(prefs?.approved)) {
        this.approved = new Set(prefs.approved.filter(id =>
          typeof id === 'string' && /^[a-z][a-z0-9.-]{2,63}$/.test(id)));
      }
    } catch {
      this.approved = new Set();
    }
    await this.refresh();
  }

  async refresh() {
    this.windows = [];
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
      try {
        const [manifestStat, scriptStat] = await Promise.all([
          fs.lstat(manifestPath), fs.lstat(scriptPath)
        ]);
        if (!manifestStat.isFile() || manifestStat.size > 8192 || !scriptStat.isFile()) continue;
        // lstat().isFile() rejects symbolic links for both files.
        const manifest = normalizeManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), entry.name);
        if (manifest) next.set(manifest.id, { ...manifest, scriptPath });
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
      entries: [...this.plugins.values()].map(({ id, name, permissions }) => ({
        id, name, permissions, enabled: this.approved.has(id)
      })),
      windows: this.windows
    };
  }

  async setEnabled(id, enabled) {
    if (typeof id !== 'string' || typeof enabled !== 'boolean' || !this.plugins.has(id)) {
      throw new Error('不明なプラグインです');
    }
    if (enabled) this.approved.add(id);
    else this.approved.delete(id);
    this.windows = [];
    await fs.mkdir(path.dirname(this.preferencesPath), { recursive: true });
    // Store only permission choices. No windows, titles, or screenshots persist.
    await fs.writeFile(this.preferencesPath, JSON.stringify({
      approved: [...this.approved]
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async listWindows(id) {
    if (this.platform !== 'win32') throw new Error('Windows専用の機能です');
    const plugin = typeof id === 'string' ? this.plugins.get(id) : null;
    if (!plugin || plugin.type !== PLUGIN_TYPE) throw new Error('対応するプラグインがありません');
    if (!this.approved.has(id)) throw new Error('プラグインの利用を許可してください');
    // Revalidate the entry before executing; a missing/replaced symlink is denied.
    const entry = await fs.lstat(plugin.scriptPath);
    if (!entry.isFile()) throw new Error('プラグインの実行ファイルが不正です');
    try {
      const result = await this.runListScript(plugin.scriptPath);
      this.windows = normalizeWindows(result);
      return this.windows;
    } catch (error) {
      this.windows = [];
      throw new Error('ウィンドウ一覧を取得できません: ' + String(error.message).slice(0, 130));
    }
  }
}

module.exports = {
  FramePluginHost, normalizeManifest, normalizeWindows, PLUGIN_TYPE
};
