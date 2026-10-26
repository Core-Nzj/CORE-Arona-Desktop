'use strict';

// Windows safeStorage encrypts secrets with DPAPI. Credentials are NEVER written
// to settings.json, passed via CLI args/environment, or returned to the renderer.
const fs = require('node:fs/promises');
const path = require('node:path');

const FILE_NAME = 'voisona-credentials.dat';

class VoiceCredentialStore {
  constructor({ safeStorage, userDataPath }) {
    this.safeStorage = safeStorage;
    this.userDataPath = userDataPath;
  }
  filePath() { return path.join(this.userDataPath, FILE_NAME); }
  available() { return this.safeStorage.isEncryptionAvailable(); }

  async read() {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8');
      if (!this.available()) throw new Error('Windowsの暗号化機能を利用できません');
      const doc = JSON.parse(raw);
      if (doc.version !== 1 || typeof doc.encrypted !== 'string' ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(doc.encrypted)) {
        throw new Error('認証ファイルの形式が不正です');
      }
      const content = this.safeStorage.decryptString(Buffer.from(doc.encrypted, 'base64'));
      const credentials = JSON.parse(content);
      return validateCredentials(credentials);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(username, password) {
    const credentials = validateCredentials({ username, password });
    if (!this.available()) throw new Error('暗号化が利用できないため、認証情報は保存しません');
    const encrypted = this.safeStorage.encryptString(JSON.stringify(credentials));
    const file = this.filePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Rename is atomic. The temporary file contains only encrypted bytes.
    const temporary = file + '.tmp';
    try {
      await fs.writeFile(temporary,
        JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') }), {
          encoding: 'utf8', mode: 0o600
        });
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return credentials;
  }

  async clear() {
    await fs.rm(this.filePath(), { force: true });
  }
}

function validateCredentials({ username, password } = {}) {
  if (typeof username !== 'string' || username.length > 254 ||
      !username.trim() || username.includes(':') || /[\x00-\x1f\x7f]/.test(username)) {
    throw new Error('正しいVoiSona APIユーザー名（メールアドレス）を入力してください');
  }
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024 ||
      /[\r\n\x00]/.test(password)) {
    throw new Error('VoiSonaのAPIパスワードを入力してください');
  }
  return { username: username.trim(), password };
}

module.exports = { VoiceCredentialStore, validateCredentials };
