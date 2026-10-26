'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function makePcm16(sampleRate, channels, interleavedSamples) {
  const buffer = new Uint8Array(44 + 2 * interleavedSamples.length);
  const view = new DataView(buffer.buffer);
  for (const [offset, str] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
    [...str].forEach((c, i) => { buffer[offset + i] = c.charCodeAt(0); });
  }
  view.setUint32(4, buffer.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, interleavedSamples.length * 2, true);
  interleavedSamples.forEach((value, i) => view.setInt16(44 + i * 2, value, true));
  return buffer;
}

test('PCM16 WAV is decoded to correct channel-separated Float32 arrays', async () => {
  const { decodePcm16Wav } = await import('../src/pcm-playback.mjs');
  const pcm = makePcm16(48000, 2, [-32768, 32767, 0, 16384]);
  const decoded = decodePcm16Wav(pcm);
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.frames, 2);
  assert.deepEqual(Array.from(decoded.signals[0]), [-1, 0]);
  assert.deepEqual(Array.from(decoded.signals[1]), [32767 / 32768, 0.5]);
});

test('Web Audio channel data receives decoded samples', async () => {
  const { makeWebAudioBuffer } = await import('../src/pcm-playback.mjs');
  const actual = [new Float32Array(2), new Float32Array(2)];
  const context = {
    createBuffer(channels, frames, rate) {
      assert.equal(channels, 2);
      assert.equal(frames, 2);
      assert.equal(rate, 16000);
      return { getChannelData(channel) { return actual[channel]; } };
    }
  };
  makeWebAudioBuffer(context, makePcm16(16000, 2, [32767, -32768, 1000, -1000]));
  assert.ok(actual[0][0] > 0.99);
  assert.equal(actual[1][0], -1);
  assert.ok(actual[0][1] > 0);
  assert.ok(actual[1][1] < 0);
});

test('rejects unsafe / missing audio data', async () => {
  const { decodePcm16Wav } = await import('../src/pcm-playback.mjs');
  assert.throws(() => decodePcm16Wav(new Uint8Array(10)), /短すぎ/);
  const broken = makePcm16(48000, 1, [0, 100]);
  new DataView(broken.buffer).setUint16(34, 24, true);
  assert.throws(() => decodePcm16Wav(broken), /未対応/);
  const truncated = makePcm16(48000, 1, [1]);
  new DataView(truncated.buffer).setUint32(40, 10000, true);
  assert.throws(() => decodePcm16Wav(truncated), /未対応/);
});
