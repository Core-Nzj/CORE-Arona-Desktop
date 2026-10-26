'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpeechWav, WavFormatError } =
  require('../electron/wav-normalizer.cjs');

function wave({
  bits = 16, format = 1, samples = [0, 1000],
  channels = 1, sampleRate = 48000,
  extensible = false, extra = false
} = {}) {
  const bytesPerSample = bits / 8;
  const fmtSize = extensible ? 40 : 16;
  const dataSize = bytesPerSample * samples.length;
  const junkSize = extra ? 10 : 0; // 8-byte JUNK chunk + 2-byte payload
  const buf = Buffer.alloc(12 + 8 + fmtSize + junkSize + 8 + dataSize);
  let at = 0;
  buf.write('RIFF', at); at += 4;
  buf.writeUInt32LE(buf.length - 8, at); at += 4;
  buf.write('WAVE', at); at += 4;
  if (extra) {
    buf.write('JUNK', at); at += 4;
    buf.writeUInt32LE(2, at); at += 4;
    at += 2;
  }
  buf.write('fmt ', at); at += 4;
  buf.writeUInt32LE(fmtSize, at); at += 4;
  const f = at;
  buf.writeUInt16LE(extensible ? 0xfffe : format, f);
  buf.writeUInt16LE(channels, f + 2);
  buf.writeUInt32LE(sampleRate, f + 4);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, f + 8);
  buf.writeUInt16LE(channels * bytesPerSample, f + 12);
  buf.writeUInt16LE(bits, f + 14);
  if (extensible) {
    buf.writeUInt16LE(22, f + 16);   // cbSize
    buf.writeUInt16LE(bits, f + 18); // valid bits
    buf.writeUInt32LE(channels === 1 ? 4 : 3, f + 20);
    buf.writeUInt32LE(format, f + 24);
    Buffer.from('00001000800000aa00389b71', 'hex').copy(buf, f + 28);
  }
  at += fmtSize;
  buf.write('data', at); at += 4;
  buf.writeUInt32LE(dataSize, at); at += 4;
  samples.forEach((x, i) => {
    const offset = at + i * bytesPerSample;
    if (format === 3 && bits === 32) buf.writeFloatLE(x, offset);
    else if (format === 3 && bits === 64) buf.writeDoubleLE(x, offset);
    else if (bits === 8) buf.writeUInt8(x, offset);
    else if (bits === 16) buf.writeInt16LE(x, offset);
    else if (bits === 24) buf.writeIntLE(x, offset, 3);
    else if (bits === 32) buf.writeInt32LE(x, offset);
  });
  return buf;
}

function samples16(result) {
  return Array.from({length: result.buffer.readUInt32LE(40) / 2},
    (_, i) => result.buffer.readInt16LE(44 + i * 2));
}

test('PCM16 input is canonicalized with valid RIFF sizes', () => {
  const input = wave({ samples: [-32768, 0, 32767], extra: true });
  const result = normalizeSpeechWav(input);
  assert.deepEqual(samples16(result), [-32768, 0, 32767]);
  assert.equal(result.buffer.readUInt32LE(4), result.buffer.length - 8);
  assert.equal(result.buffer.readUInt32LE(40), result.buffer.length - 44);
  assert.equal(result.buffer.readUInt16LE(20), 1);
  assert.match(result.detail, /PCM 16bit.*48000Hz/);
});

test('PCM24 VoiSona output is converted into 16-bit samples', () => {
  const result = normalizeSpeechWav(wave({
    bits: 24,
    samples: [-8388608, 0, 8388607]
  }));
  assert.deepEqual(samples16(result), [-32768, 0, 32767]);
  assert.match(result.detail, /PCM 24bit.*PCM 16bit/);
});

test('PCM 8-bit and 32-bit integer variants are supported', () => {
  assert.deepEqual(samples16(normalizeSpeechWav(wave({
    bits: 8, samples: [0, 128, 255]
  }))), [-32768, 0, 32512]);
  assert.deepEqual(samples16(normalizeSpeechWav(wave({
    bits: 32, samples: [-2147483648, 0, 2147483647]
  }))), [-32768, 0, 32767]);
});

test('float32 and extensible float32 source formats become PCM16', () => {
  for (const extensible of [false, true]) {
    const normalized = normalizeSpeechWav(wave({
      format: 3, bits: 32, samples: [-1, 0, 0.5, 1],
      extensible
    }));
    assert.deepEqual(samples16(normalized), [-32768, 0, 16384, 32767]);
  }
});

test('float64 source sanitizes NaN and supports stereo', () => {
  const normalized = normalizeSpeechWav(wave({
    format: 3, bits: 64, channels: 2,
    samples: [-1, 0.5, NaN, 0]
  }));
  assert.deepEqual(samples16(normalized), [-32768, 16384, 0, 0]);
  assert.equal(normalized.buffer.readUInt16LE(22), 2);
  assert.equal(normalized.buffer.readUInt16LE(32), 4);
});

test('invalid and unsupported WAVs fail rather than reaching Web Audio', () => {
  const source = wave();
  assert.throws(() => normalizeSpeechWav(Buffer.from('junk')), WavFormatError);
  assert.throws(() => normalizeSpeechWav(wave({format: 6})), /未対応/);
  assert.throws(() => normalizeSpeechWav(source.subarray(0, source.length - 1)), /途中/);
  const broken = Buffer.from(source);
  broken.writeUInt16LE(99, 22);
  assert.throws(() => normalizeSpeechWav(broken), /不正/);
  const empty = Buffer.from(source);
  empty.writeUInt32LE(0, 40);
  assert.throws(() => normalizeSpeechWav(empty), /不正/);
});
