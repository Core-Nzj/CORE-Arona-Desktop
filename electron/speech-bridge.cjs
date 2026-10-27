'use strict';

// Authenticated, loopback-only receiver for speech sent by a browser companion.
// The token is stored encrypted using the same Windows safeStorage as VoiSona.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = 32779;
const TOKEN_FILE = 'speech-bridge-token.dat';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 500;

class SpeechBridge {
  constructor({ userDataPath, safeStorage, onText, port = PORT }) {
    this.userDataPath = userDataPath;
    this.port = port;
    this.safeStorage = safeStorage;
    this.onText = onText;
    this.server = null;
    this.token = null;
  }

  async loadToken() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('音声連携トークンのWindows暗号化が使用できません');
    }
    const location = path.join(this.userDataPath, TOKEN_FILE);
    try {
      const encrypted = await fs.readFile(location);
      const token = this.safeStorage.decryptString(encrypted);
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid bridge token');
      return token;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const token = randomBytes(32).toString('hex');
    const encrypted = this.safeStorage.encryptString(token);
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(location, encrypted, { mode: 0o600, flag: 'wx' });
    return token;
  }

  async start() {
    this.token = await this.loadToken();
    const server = http.createServer((request, response) => {
      void this.receive(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        }
        response.end('Internal error');
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, HOST, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      this.server = server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async receive(request, response) {
    const reply = (status, message) => {
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(message);
    };
    if (request.url !== '/speak' || request.method !== 'POST') return reply(404, 'Not found');
    if (request.headers.host !== HOST + ':' + (this.server?.address()?.port ?? this.port)) {
      return reply(403, 'Invalid host');
    }
    const supplied = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!supplied || !this.token || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) {
      return reply(401, 'Invalid token');
    }
    if (!(request.headers['content-type'] || '').startsWith('application/json')) {
      return reply(415, 'JSON required');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return reply(413, 'Payload too large');
      chunks.push(chunk);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return reply(400, 'Invalid JSON'); }
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      return reply(400, 'Text must contain 1-500 characters');
    }
    if (!this.onText(text)) return reply(503, 'Avatar window is unavailable');
    return reply(202, 'Accepted');
  }

  close() {
    if (this.server) this.server.close();
    this.server = null;
  }
}

module.exports = { SpeechBridge, HOST, PORT };
