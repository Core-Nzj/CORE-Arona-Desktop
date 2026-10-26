'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const LOOPBACK = 'http://127.0.0.1:32777/health';

class ProxyManager {
  constructor({
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    commands = process.platform === 'win32'
      ? [['py', ['-m', 'voisona_talk_proxy']]]
      : [['python3', ['-m', 'voisona_talk_proxy']]]
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.commands = commands;
    this.child = null;
    this.startedByApp = false;
    this.lastError = '';
    this.pending = null;
  }

  async isAvailable() {
    try {
      const response = await this.fetchImpl(LOOPBACK, {
        method: 'GET',
        signal: AbortSignal.timeout(1200)
      });
      // The API may demand authorization for some operations. An HTTP reply
      // still means a server is listening, but don't confuse 404 with health.
      return response.ok;
    } catch { return false; }
  }

  async ensureRunning() {
    if (this.pending) return this.pending;
    this.pending = this._ensureRunning().finally(() => { this.pending = null; });
    return this.pending;
  }

  async _ensureRunning() {
    if (await this.isAvailable()) {
      this.lastError = '';
      return { running: true, managed: this.startedByApp };
    }
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.waitUntilReady();
    }

    for (const [command, prefix] of this.commands) {
      try {
        const child = this.spawnImpl(command,
          [...prefix, '--host', '127.0.0.1', '--port', '32777'],
          { shell: false, windowsHide: true, stdio: 'ignore', env: process.env });
        this.child = child;
        this.startedByApp = true;
        // An error event must always have a handler to avoid crashing Electron.
        const startup = new Promise(resolve => {
          child.once('error', err => resolve({ error: err }));
          child.once('spawn', () => resolve({ spawned: true }));
        });
        const event = await startup;
        if (event.error) {
          this.lastError = String(event.error.message);
          this.child = null;
          this.startedByApp = false;
          continue;
        }
        child.once('exit', (code, signal) => {
          if (this.child === child) {
            this.child = null;
            this.startedByApp = false;
            this.lastError = 'Proxyが終了しました (code=' + code + ', signal=' + signal + ')';
          }
        });
        return this.waitUntilReady();
      } catch (error) {
        this.lastError = String(error.message);
      }
    }
    return { running: false, managed: false, error: this.lastError ||
      'Pythonを起動できませんでした。Pythonとvoisona-talk-proxyを確認してください' };
  }

  async waitUntilReady() {
    for (let attempt = 0; attempt < 28; attempt++) {
      if (await this.isAvailable()) {
        this.lastError = '';
        return { running: true, managed: this.startedByApp };
      }
      if (!this.child || this.child.exitCode !== null) break;
      await delay(250);
    }
    this.lastError = this.lastError || 'Proxyが起動できません。Python 3.11+ とvoisona-talk-proxyのインストールを確認してください';
    return { running: false, managed: this.startedByApp, error: this.lastError };
  }

  status() {
    return {
      managed: this.startedByApp,
      error: this.lastError,
      needsPython: true // Current dev build uses the installed Python package.
    };
  }

  stop() {
    const child = this.child;
    this.child = null;
    const managed = this.startedByApp;
    this.startedByApp = false;
    if (!child || !managed || !child.pid) return;
    if (process.platform === 'win32') {
      // py.exe launches Python as its descendant. Kill only the owned tree,
      // never an externally started Proxy (e.g. from yesterday's extension).
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 2000
      });
    } else {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
  }
}

module.exports = { ProxyManager };
