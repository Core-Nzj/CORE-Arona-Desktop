'use strict';

// Experimental Chrome handoff. Memory-only; never writes a file or contacts ChatGPT.
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { validatePng } = require('./vision-session-broker.cjs');

const HOST = '127.0.0.1';
const PORT = 32780;
const DESTINATION_ID = 'frame.chrome.receive';

function safeToken(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

class VisionBrowserAdapter {
  #server = null;
  #pending = null;
  #starting = null;
  #port;

  constructor({ port = PORT } = {}) {
    this.#port = port;
  }

  getCapabilities() {
    return {
      destinationId: DESTINATION_ID,
      acceptsPng: true,
      requiresApproval: true,
      remote: false,
      label: 'Chrome受信テスト（ChatGPTへは未送信）'
    };
  }

  getPending() {
    return this.#pending ? {
      requestId: this.#pending.requestId,
      token: this.#pending.token,
      port: this.#server?.address()?.port ?? this.#port
    } : null;
  }

  async start() {
    if (this.#server) return;
    if (this.#starting) return this.#starting;
    const server = http.createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        }
        res.end('Internal error');
      });
    });
    this.#starting = new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#port, HOST, () => {
        server.off('error', reject);
        this.#server = server;
        resolve();
      });
    });
    try { await this.#starting; }
    catch (error) {
      server.close();
      throw new Error('Chrome接続ポートを開始できません: ' + (error?.code || 'unknown'));
    } finally { this.#starting = null; }
  }

  async #handle(req, res) {
    const reply = (status, message) => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(message);
    };
    if (req.headers.host !== HOST + ':' + this.#server?.address()?.port) {
      return reply(403, 'Invalid host');
    }
    // Do not grant CORS to regular web pages. Chrome extensions with explicit
    // loopback host permission can fetch from their own privileged context.
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      return reply(403, 'Invalid origin');
    }
    if (req.url !== '/take' || req.method !== 'POST') return reply(404, 'Not found');
    const pending = this.#pending;
    if (!pending || pending.signal?.aborted) return reply(410, 'No image available');
    const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!match || !safeToken(match[1]) ||
        !timingSafeEqual(Buffer.from(match[1], 'hex'), Buffer.from(pending.token, 'hex'))) {
      return reply(401, 'Invalid receipt code');
    }
    // Forbid body uploads; the image moves from FRAME to Chrome, not reverse.
    if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
      return reply(413, 'No request body allowed');
    }
    if (pending.claimed) return reply(409, 'Already claimed');
    pending.claimed = true;
    const bytes = pending.imageBytes;
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    // A result is acknowledged only once the HTTP response is flushed.
    res.once('finish', () => {
      if (this.#pending === pending) {
        this.#pending = null;
        pending.resolve({ delivered: true });
      }
    });
    res.once('close', () => {
      if (this.#pending === pending) {
        this.#pending = null;
        pending.reject(new Error('ブラウザへの転送が中断されました'));
      }
    });
    res.end(bytes);
  }

  async deliver({ requestId, destinationId, mimeType, imageBytes, signal } = {}) {
    if (destinationId !== DESTINATION_ID || mimeType !== 'image/png' || signal?.aborted) {
      throw new Error('Chrome受信先が利用できません');
    }
    validatePng(imageBytes);
    await this.start();
    if (this.#pending) throw new Error('前のChrome受信処理が完了していません');
    if (signal?.aborted) throw new Error('受け渡しは取り消されました');
    const token = randomBytes(32).toString('hex');
    return new Promise((resolve, reject) => {
      const pending = { requestId, token, imageBytes, signal, claimed: false,
        resolve, reject };
      this.#pending = pending;
      const onAbort = () => {
        if (this.#pending === pending) {
          this.#pending = null;
          reject(new Error('受け渡しは取り消されました'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async cancel(requestId) {
    if (this.#pending && (!requestId || this.#pending.requestId === requestId)) {
      const pending = this.#pending;
      this.#pending = null;
      pending.reject(new Error('受け渡しは取り消されました'));
    }
  }

  async disconnect() {
    await this.cancel();
    if (this.#starting) {
      try { await this.#starting; } catch { /* Startup already failed. */ }
    }
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { VisionBrowserAdapter, DESTINATION_ID, HOST, PORT };
