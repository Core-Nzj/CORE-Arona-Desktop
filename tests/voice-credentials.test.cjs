'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VoiceCredentialStore, validateCredentials } = require('../electron/voice-credentials.cjs');

function fakeEncryption() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.from('test-encrypted|' + Buffer.from(s).toString('base64')),
    decryptString: b => Buffer.from(b.toString().slice('test-encrypted|'.length), 'base64').toString()
  };
}

test('only the encrypted payload is persisted to userData', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arona-voice-credentials-'));
  try {
    const store = new VoiceCredentialStore({ safeStorage: fakeEncryption(), userDataPath: dir });
    const account = { username: 'speaker@example.org', password: 'api-secret-string' };
    assert.deepEqual(await store.read(), null);
    await store.write(account.username, account.password);
    const raw = await fs.readFile(store.filePath(), 'utf8');
    assert.ok(!raw.includes(account.username) && !raw.includes(account.password));
    assert.deepEqual(await store.read(), account);
    await store.clear();
    assert.equal(await store.read(), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('never writes plaintext when Windows encryption is unavailable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arona-voice-unavailable-'));
  try {
    const store = new VoiceCredentialStore({
      safeStorage: { isEncryptionAvailable: () => false },
      userDataPath: dir
    });
    await assert.rejects(store.write('speaker@example.org', 'api-pass'), /暗号化/);
    await assert.rejects(fs.access(store.filePath()), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rejects invalid username, missing password and newline injection', () => {
  assert.throws(() => validateCredentials({ username: 'bad:user', password: 'x' }), /ユーザー名/);
  assert.throws(() => validateCredentials({ username: 'x@x.jp', password: '' }), /APIパスワード/);
  assert.throws(() => validateCredentials({ username: 'x@x.jp', password: 'abc\nbad' }), /APIパスワード/);
  assert.deepEqual(validateCredentials({ username: '  test@example.jp ', password: 'a b' }),
    { username: 'test@example.jp', password: 'a b' });
});
