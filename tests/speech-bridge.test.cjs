'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { SpeechBridge, HOST } = require('../electron/speech-bridge.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value, 'utf8'),
  decryptString: data => data.toString('utf8')
};

test('accepts token-authenticated speech on loopback and refuses other requests', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'core-speech-'));
  const accepted = [];
  const bridge = new SpeechBridge({
    userDataPath, safeStorage, port: 0,
    onText: text => { accepted.push(text); return true; }
  });
  try {
    await bridge.start();
    assert.match(bridge.token, /^[a-f0-9]{64}$/);
    const base = 'http://' + HOST + ':' + bridge.server.address().port + '/speak';
    const send = (payload, token = bridge.token, headers = {}) => fetch(base, {
      method: 'POST', body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers }
    });
    assert.equal((await send({ text: '声を出します' }, 'x'.repeat(64))).status, 401);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.request(base, {
        method: 'POST',
        headers: {
          Host: 'example.org',
          Authorization: 'Bearer ' + bridge.token,
          'Content-Type': 'application/json'
        }
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      req.once('error', reject);
      req.end(JSON.stringify({ text: '声を出します' }));
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await send({ text: 'あ'.repeat(501) })).status, 400);
    assert.equal((await send({ text: 'テスト発話' })).status, 202);
    assert.deepEqual(accepted, ['テスト発話']);
  } finally {
    bridge.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test('bridge token persists encrypted and is reused across restart', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'core-speech-'));
  try {
    const first = new SpeechBridge({ userDataPath, safeStorage, port: 0, onText: () => true });
    const token = await first.loadToken();
    const second = new SpeechBridge({ userDataPath, safeStorage, port: 0, onText: () => true });
    assert.equal(await second.loadToken(), token);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
