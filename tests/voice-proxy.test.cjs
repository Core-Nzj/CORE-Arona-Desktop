'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceProxyClient, VoiceProxyError, normalizeVoice, PROXY_ORIGIN } =
  require('../electron/voice-proxy.cjs');

const sampleVoice = {
  voice_name: 'ui_ja_JP',
  voice_version: '2.0.0',
  languages: ['ja_JP']
};
function makeWav() {
  // Minimal RIFF/WAVE header for an empty mono 16-bit PCM stream.
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(38, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(2, 40);
  wav.writeInt16LE(1200, 44);
  return wav;
}

test('reads voice libraries from the fixed loopback endpoint', async () => {
  let calledUrl;
  const client = new VoiceProxyClient(async url => {
    calledUrl = url;
    return new Response(JSON.stringify({ items: [sampleVoice, { malformed: true }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  assert.equal(PROXY_ORIGIN, 'http://127.0.0.1:32777');
  assert.deepEqual(await client.listVoices(), [sampleVoice]);
  assert.equal(calledUrl, PROXY_ORIGIN + '/voices');
});

test('synthesizes to validated WAV and sends correct voice request', async () => {
  let sent;
  const client = new VoiceProxyClient(async (url, options) => {
    sent = { url, method: options.method, payload: JSON.parse(options.body) };
    return new Response(makeWav(), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' }
    });
  });
  const data = await client.synthesize('こんにちは', sampleVoice);
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.readUInt16LE(34), 16);
  assert.equal(data.readUInt32LE(40), 2);
  assert.equal(sent.url, PROXY_ORIGIN + '/speech-syntheses');
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.payload, {
    text: 'こんにちは',
    language: 'ja_JP',
    voice_name: 'ui_ja_JP',
    voice_version: '2.0.0'
  });
});

test('rejects invalid text and voice before contacting the server', async () => {
  const client = new VoiceProxyClient(() => { throw new Error('Should not call network'); });
  await assert.rejects(client.synthesize('   ', sampleVoice), VoiceProxyError);
  await assert.rejects(client.synthesize('あ'.repeat(501), sampleVoice), VoiceProxyError);
  await assert.rejects(client.synthesize('こんにちは', {}), VoiceProxyError);
  assert.equal(normalizeVoice({ voice_name: 'bad', languages: [] }), null);
});

test('rejects proxy authorization errors and non-WAV responses', async () => {
  const unauthorized = new VoiceProxyClient(async () => new Response('unauthorized', { status: 401 }));
  await assert.rejects(unauthorized.listVoices(), /401/);
  const invalidWave = new VoiceProxyClient(async () => new Response(Buffer.alloc(48), { status: 200 }));
  await assert.rejects(invalidWave.synthesize('test', sampleVoice), /正しいWAV/);
});

test('rejects server-declared oversized WAV before reading body', async () => {
  const client = new VoiceProxyClient(async () => new Response(makeWav(), {
    status: 200,
    headers: { 'Content-Length': String(20 * 1024 * 1024) }
  }));
  await assert.rejects(client.synthesize('test', sampleVoice), /大きすぎ/);
});

test('does not persist or send credentials and rejects invalid voices', async () => {
  const payloads = [];
  const client = new VoiceProxyClient(async (_url, options) => {
    payloads.push(options);
    return new Response(makeWav(), { status: 200 });
  });
  await client.synthesize('speech test', sampleVoice);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].headers.Authorization, undefined);
  assert.equal(payloads[0].body.includes('password'), false);
  assert.equal(normalizeVoice({ voice_name: '', languages: ['ja_JP'] }), null);
});
