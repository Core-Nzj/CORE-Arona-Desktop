'use strict';

// One-time local password-entry portal, opened in the user's regular browser
// so Chrome's Google Password Manager or Apple's iCloud Passwords extension
// can assist with password input. Electron itself does not inherit them.
//
// Security:
// - listens ONLY on IPv4 loopback; never reachable from other machines
// - unpredictable one-time URL token, expires after 3 minutes
// - GET/POST must match the exact Host and token, POST requires same Origin
// - no external scripts, subresources, redirects, third-party requests or logs
// - sends username/password solely to the in-process credential store
// - the password never appears in the URL, renderer IPC, or the response
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { validateCredentials } = require('./voice-credentials.cjs');

const PREFERRED_PORT = 32778;
const MAX_FORM_BYTES = 8192;
const SESSION_LIFETIME_MS = 180000;

const securityHeaders = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'Pragma': 'no-cache',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function page({ action = '', error = '', success = false } = {}) {
  const heading = success ? '認証情報を保存しました' : 'VoiSona Talk API 認証情報';
  const detail = success
    ? '<p>CORE Arona Desktopに暗号化保存されました。ブラウザーを閉じてアプリに戻ってください。</p>'
    : '<p>このページはお使いのPC内で一時的に開いています。ChromeのGoogleパスワードマネージャー、または有効化済みのiCloudパスワード拡張機能から入力できます。</p>';
  const form = success ? '' : '<form method="POST" autocomplete="on" action="' + escapeHtml(action) + '">' +
    '<label for="username">VoiSona APIユーザー名（メールアドレス）</label>' +
    '<input id="username" name="username" type="email" autocomplete="username" required maxlength="254" autofocus>' +
    '<label for="password">API用パスワード</label>' +
    '<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">' +
    '<button type="submit">暗号化してアプリに保存</button></form>' +
    '<p class="note">パスワード候補が出ない場合、保存先のサイトが異なる可能性があります。パスワード管理ツールからコピーして貼り付けることもできます。ここではVoiSonaのログインパスワードではなくAPI用パスワードを入力してください。</p>';
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CORE Arona Desktop: VoiSona Talk</title>' +
    '<style>body{font:14px "Yu Gothic UI",Meiryo,sans-serif;max-width:480px;margin:45px auto;padding:24px;color:#21313a;background:#f6f9fb}h1{font-size:21px}p{line-height:1.7}label{display:block;margin:19px 0 6px;font-weight:600}input{box-sizing:border-box;width:100%;font-size:16px;padding:10px;border:1px solid #9aacb8;border-radius:6px}button{margin-top:22px;border:0;border-radius:7px;background:#00919f;color:white;font-weight:600;padding:13px 19px;cursor:pointer}.note{font-size:12px;color:#526875;margin-top:21px}.error{color:#a11717}</style></head><body>' +
    '<h1>' + heading + '</h1>' + detail +
    (error ? '<p class="error">' + escapeHtml(error) + '</p>' : '') +
    form + '</body></html>';
}

class BrowserCredentialPortal {
  constructor({
    onCredentials,
    openExternal,
    preferredPort = PREFERRED_PORT,
    ttlMs = SESSION_LIFETIME_MS,
    createServer = http.createServer
  } = {}) {
    if (typeof onCredentials !== 'function' || typeof openExternal !== 'function') {
      throw new TypeError('onCredentials and openExternal are required');
    }
    this.onCredentials = onCredentials;
    this.openExternal = openExternal;
    this.preferredPort = preferredPort;
    this.ttlMs = ttlMs;
    this.createServer = createServer;
    this.server = null;
    this.expiryTimer = null;
    this.used = false;
  }

  async open() {
    this.close();
    const token = randomBytes(32).toString('hex');
    const route = '/credentials/' + token;
    const server = this.createServer((req, res) => {
      void this.handle(req, res, server, route);
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    this.server = server;

    try {
      // Stable origin improves password-manager site matching across launches.
      // Use an ephemeral port only when the preferred one is already occupied.
      await this.listen(server, this.preferredPort).catch(error => {
        if (error.code !== 'EADDRINUSE') throw error;
        return this.listen(server, 0);
      });
      const port = server.address().port;
      this.origin = 'http://127.0.0.1:' + port;
      this.route = route;
      this.used = false;
      this.expiryTimer = setTimeout(() => this.close(), this.ttlMs);
      this.expiryTimer.unref?.();
      await this.openExternal(this.origin + route);
      return { opened: true, expiresInSeconds: Math.round(this.ttlMs / 1000) };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  listen(server, port) {
    return new Promise((resolve, reject) => {
      const fail = error => { server.off('listening', okay); reject(error); };
      const okay = () => { server.off('error', fail); resolve(); };
      server.once('error', fail);
      server.once('listening', okay);
      server.listen(port, '127.0.0.1');
    });
  }

  close() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const server = this.server;
    this.server = null;
    this.route = null;
    this.origin = null;
    if (server) server.closeAllConnections?.();
    if (server?.listening) server.close();
  }

  reply(res, code, html) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(code, securityHeaders);
    res.end(html);
  }

  async handle(req, res, server, route) {
    if (!this.server || this.server !== server || this.used ||
        !this.origin || !this.route || route !== this.route ||
        req.headers.host !== new URL(this.origin).host ||
        req.url !== route) {
      this.reply(res, 404, page({ success: true, error: '期限切れのフォームです' }));
      return;
    }
    if (req.method === 'GET') {
      this.reply(res, 200, page({ action: route }));
      return;
    }
    if (req.method !== 'POST' ||
        req.headers.origin !== this.origin ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) {
      this.reply(res, 403, page({ error: 'この送信方法は許可されていません' }));
      return;
    }
    const claimedLength = Number(req.headers['content-length'] ?? 0);
    if (!Number.isFinite(claimedLength) || claimedLength > MAX_FORM_BYTES) {
      this.reply(res, 413, page({ error: '入力サイズが上限を超えています' }));
      return;
    }
    const chunks = [];
    let count = 0;
    try {
      for await (const chunk of req) {
        count += chunk.length;
        if (count > MAX_FORM_BYTES) {
          this.reply(res, 413, page({ error: '入力サイズが上限を超えています' }));
          return;
        }
        chunks.push(chunk);
      }
      const fields = new URLSearchParams(Buffer.concat(chunks, count).toString('utf8'));
      const { username, password } = validateCredentials({
        username: fields.get('username'),
        password: fields.get('password')
      });
      // Reject concurrent duplicate submissions.
      this.used = true;
      await this.onCredentials(username, password);
      this.reply(res, 200, page({ success: true }));
      // Let the browser receive its confirmation before closing its socket.
      const closeTimer = setTimeout(() => this.close(), 450);
      closeTimer.unref?.();
    } catch (error) {
      this.used = false;
      // Errors shown to the user must never contain submitted secrets.
      this.reply(res, 400, page({
        action: route,
        error: '保存に失敗しました。入力内容を確認するか、アプリの設定画面から登録してください。'
      }));
    }
  }
}

module.exports = { BrowserCredentialPortal };
