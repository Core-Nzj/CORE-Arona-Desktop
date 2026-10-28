'use strict';

// Manage an already-installed VoiSona Talk, never bundle or modify its binaries.
// Only windows named by the verified "VoiSona Talk.exe" process are controlled.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const execFileAsync = promisify(execFile);
const EXE = 'VoiSona Talk.exe';
const SCRIPT = path.join(__dirname, 'voisona-window.ps1');

function validExecutable(file) {
  return typeof file === 'string' && path.win32.basename(file).toLowerCase() === EXE.toLowerCase();
}

async function defaultCommand(action, pid = 0, handle = '') {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT, '-Action', action, '-TargetPid', String(pid),
    '-TargetHandle', String(handle)
  ], { windowsHide: true, timeout: 9000, maxBuffer: 32768 });
  return JSON.parse(stdout.trim());
}

// A JUCE application can own many titled top-level helper windows. Never
// choose them merely because their title is non-empty or their PID matches.
// Return null when no unique editor window can be identified safely.
const HELPER_TITLE = /^(?:JUCEWindow|Windows Audio|DirectSound|JuceMidiDevice.*)$/i;
function selectMainWindow(windows) {
  if (!Array.isArray(windows)) return null;
  const candidates = windows.filter(w =>
    w && typeof w.title === 'string' && w.title.trim() &&
    typeof w.handle === 'string' && /^[1-9][0-9]{0,17}$/.test(w.handle) &&
    Number.isFinite(w.width) && w.width >= 500 &&
    Number.isFinite(w.height) && w.height >= 300 &&
    w.toolWindow !== true && !HELPER_TITLE.test(w.title.trim())
  );
  const named = candidates.filter(w => /voisona\s*talk/i.test(w.title));
  const pool = named.length ? named : candidates;
  // Multiple editor-sized windows (e.g. a modal settings dialog) are
  // ambiguous. Prefer safety over accidentally revealing JUCE internals.
  return pool.length === 1 ? pool[0] : null;
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function searchTechnoSpeech(root, depth = 2) {
  if (!root) return null;
  const direct = path.join(root, EXE);
  if (await isFile(direct)) return direct;
  if (depth <= 0) return null;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return null; }
  // Do not follow symlinks, or scan unrelated folders.
  for (const entry of entries.slice(0, 120)) {
    if (entry.isFile() && entry.name.toLowerCase() === EXE.toLowerCase()) {
      return path.join(root, entry.name);
    }
    if (!entry.isDirectory()) continue;
    const found = await searchTechnoSpeech(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

async function findExecutable(configured = '', roots = null) {
  if (configured) {
    if (!validExecutable(configured) || !path.isAbsolute(configured) || !(await isFile(configured))) {
      throw new Error('設定されたVoiSona Talk.exeが見つかりません。実行ファイルを選び直してください');
    }
    return configured;
  }
  const folders = roots || [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files'
  ];
  for (const folder of [...new Set(folders.filter(Boolean))]) {
    const found = await searchTechnoSpeech(path.join(folder, 'Techno-Speech'));
    if (found) return found;
  }
  return null;
}

class VoiSonaManager {
  constructor({
    platform = process.platform, run = defaultCommand, launch = spawn,
    find = findExecutable, sleep = delay
  } = {}) {
    this.platform = platform;
    this.run = run;
    this.launch = launch;
    this.find = find;
    this.sleep = sleep;
    this.pid = null;
    this.ownedPid = null;
    this.hiddenExternalWindow = null;
    this.handedToUser = false;
    this.visible = false;
    this.running = false;
    this.hasWindow = false;
    this.windowHandle = null;
    this.lastError = '';
    this.starting = null;
  }

  status() {
    return {
      running: this.running, visible: this.visible, hasWindow: this.hasWindow,
      managed: !!this.ownedPid && this.ownedPid === this.pid,
      pid: this.pid, error: this.lastError,
      supported: this.platform === 'win32'
    };
  }

  async refresh() {
    if (this.platform !== 'win32') {
      this.lastError = 'VoiSonaのウィンドウ統合はWindowsのみ対応しています';
      return this.status();
    }
    try {
      const response = await this.run('list');
      const processes = Array.isArray(response?.processes) ? response.processes : [];
      const match = processes.find(x => x.pid === this.ownedPid) || processes[0] || null;
      const mainWindow = selectMainWindow(match?.windows);
      this.pid = Number.isSafeInteger(match?.pid) ? match.pid : null;
      this.running = !!this.pid;
      this.visible = mainWindow?.visible === true;
      this.hasWindow = !!mainWindow;
      this.windowHandle = mainWindow?.handle || null;
      if (this.ownedPid && !processes.some(x => x.pid === this.ownedPid)) this.ownedPid = null;
      if (this.hiddenExternalWindow &&
          !processes.some(x => x.pid === this.hiddenExternalWindow.pid)) {
        this.hiddenExternalWindow = null;
      }
      this.lastError = '';
    } catch (error) {
      this.lastError = String(error?.message || error);
    }
    return this.status();
  }

  async ensureRunning(executable = '') {
    if (this.starting) return this.starting;
    this.starting = this._ensureRunning(executable).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _ensureRunning(executable) {
    await this.refresh();
    if (this.running || this.platform !== 'win32') return this.status();
    let file;
    try { file = await this.find(executable); }
    catch (error) { this.lastError = error.message; return this.status(); }
    if (!file) {
      this.lastError = 'VoiSona Talk.exeが見つかりません。音声メニューから実行ファイルを選択してください';
      return this.status();
    }
    try {
      const child = this.launch(file, [], {
        shell: false, windowsHide: false, stdio: 'ignore', detached: false
      });
      const launched = await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      void launched;
      this.ownedPid = child.pid;
      this.handedToUser = false;
      child.once('exit', () => {
        if (this.ownedPid === child.pid) this.ownedPid = null;
      });
      for (let i = 0; i < 12; i++) {
        await this.refresh();
        if (this.running && this.pid === child.pid) return this.status();
        if (child.exitCode !== null) break;
        await this.sleep(400);
      }
      // If a single-instance launcher handed control to an existing process,
      // treat that existing process as external: never close it on app exit.
      await this.refresh();
      if (this.pid !== child.pid) this.ownedPid = null;
      if (!this.running) this.lastError = 'VoiSona Talkを起動しましたが、プロセスを検出できませんでした';
    } catch (error) {
      this.ownedPid = null;
      this.lastError = 'VoiSona Talkの起動に失敗しました: ' + String(error?.message || error);
    }
    return this.status();
  }

  async hide({ manual = false } = {}) {
    await this.refresh();
    if (!this.running || !this.hasWindow || !this.pid) {
      throw new Error('VoiSona Talkのウィンドウを検出できません');
    }
    // Auto-hide may only touch a process launched by this Arona instance.
    if (!manual && this.pid !== this.ownedPid) return this.status();
    await this.run('hide', this.pid, this.windowHandle);
    if (manual && this.pid !== this.ownedPid) {
      this.hiddenExternalWindow = { pid: this.pid, handle: this.windowHandle };
    }
    return this.refresh();
  }

  async show() {
    await this.refresh();
    if (!this.running || !this.hasWindow || !this.pid) {
      throw new Error('VoiSona Talkのウィンドウを検出できません');
    }
    await this.run('show', this.pid, this.windowHandle);
    if (this.pid === this.ownedPid) this.handedToUser = true;
    if (this.hiddenExternalWindow?.pid === this.pid) this.hiddenExternalWindow = null;
    return this.refresh();
  }

  async shutdown() {
    // Explicitly revealed VoiSona becomes user-managed and stays open.
    // Pre-existing VoiSona is NEVER closed; if Arona hid it explicitly,
    // restore it so the user is not stranded with an invisible process.
    const jobs = [];
    // A visible editor may be in use (login, API setup, unsaved projects).
    // Even if Arona launched it, do not close a visible GUI behind the user's
    // back. Close only our own *hidden* window after a successful fresh check.
    if (this.ownedPid && !this.handedToUser) {
      const current = await this.refresh();
      if (current.managed && current.hasWindow && !current.visible && !current.error) {
        jobs.push(this.run('close', this.ownedPid, this.windowHandle));
      }
    }
    if (this.hiddenExternalWindow) {
      jobs.push(this.run('show', this.hiddenExternalWindow.pid, this.hiddenExternalWindow.handle));
    }
    this.ownedPid = null;
    this.hiddenExternalWindow = null;
    await Promise.allSettled(jobs);
  }
}

module.exports = {
  VoiSonaManager, findExecutable, validExecutable, searchTechnoSpeech, selectMainWindow
};
