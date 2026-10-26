'use strict';

// Validate RIFF/WAVE chunks and normalize supported PCM/IEEE float formats
// into a canonical little-endian 16-bit PCM WAV for Chromium.
// Unsupported compressed formats fail with an actionable diagnostic.
const MAX_WAV_BYTES = 16 * 1024 * 1024;
const MAX_PCM_BYTES = 32 * 1024 * 1024;
const RIFF_FMT_PCM = 0x0001;
const RIFF_FMT_FLOAT = 0x0003;
const RIFF_FMT_EXTENSIBLE = 0xfffe;

class WavFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavFormatError';
  }
}

function normalizeSpeechWav(input) {
  if (!Buffer.isBuffer(input) || input.length < 44 || input.length > MAX_WAV_BYTES) {
    throw new WavFormatError('WAVのサイズが不正です');
  }
  if (input.toString('ascii', 0, 4) !== 'RIFF' ||
      input.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError('RIFF/WAVE形式ではありません');
  }

  let fmt = null;
  let sampleData = null;
  let cursor = 12;
  while (cursor + 8 <= input.length) {
    const chunkId = input.toString('ascii', cursor, cursor + 4);
    const length = input.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    if (length > input.length - start) {
      throw new WavFormatError('WAVチャンクが途中で切れています (' + chunkId + ')');
    }
    if (chunkId === 'fmt ' && !fmt) {
      if (length < 16) throw new WavFormatError('WAVのfmtチャンクが短すぎます');
      let format = input.readUInt16LE(start);
      const channels = input.readUInt16LE(start + 2);
      const sampleRate = input.readUInt32LE(start + 4);
      const blockAlign = input.readUInt16LE(start + 12);
      const bitDepth = input.readUInt16LE(start + 14);
      if (format === RIFF_FMT_EXTENSIBLE) {
        if (length < 40 || input.readUInt16LE(start + 16) < 22) {
          throw new WavFormatError('拡張WAVのfmtヘッダーが不完全です');
        }
        // WAVEFORMATEXTENSIBLE GUID:
        // {00000001/03-0000-0010-8000-00AA00389B71}
        const expectedTail = Buffer.from('00001000800000aa00389b71', 'hex');
        if (!input.subarray(start + 28, start + 40).equals(expectedTail)) {
          throw new WavFormatError('拡張WAVのサブタイプに対応していません');
        }
        format = input.readUInt16LE(start + 24);
      }
      if (![RIFF_FMT_PCM, RIFF_FMT_FLOAT].includes(format) ||
          (format === RIFF_FMT_PCM && ![8, 16, 24, 32].includes(bitDepth)) ||
          (format === RIFF_FMT_FLOAT && ![32, 64].includes(bitDepth))) {
        throw new WavFormatError(
          '未対応のWAV形式です（形式番号=' + format + ', ' + bitDepth + 'bit）'
        );
      }
      const bytesPerSample = bitDepth / 8;
      if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 ||
          blockAlign !== channels * bytesPerSample) {
        throw new WavFormatError('WAVのチャンネル数・サンプルレート・ブロック長が不正です');
      }
      fmt = { format, channels, sampleRate, blockAlign, bitDepth };
    } else if (chunkId === 'data' && !sampleData) {
      sampleData = { start, length };
    }
    cursor = start + length + (length & 1);
  }

  if (!fmt || !sampleData || sampleData.length === 0 ||
      sampleData.length % fmt.blockAlign !== 0) {
    throw new WavFormatError('WAVのfmt/dataチャンクまたは音声長が不正です');
  }

  const totalSamples = sampleData.length / (fmt.bitDepth / 8);
  const outBytes = totalSamples * 2;
  if (outBytes > MAX_PCM_BYTES) throw new WavFormatError('変換後のWAVが大きすぎます');

  const result = Buffer.allocUnsafe(44 + outBytes);
  result.write('RIFF', 0, 'ascii');
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVE', 8, 'ascii');
  result.write('fmt ', 12, 'ascii');
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(fmt.channels, 22);
  result.writeUInt32LE(fmt.sampleRate, 24);
  result.writeUInt32LE(fmt.sampleRate * fmt.channels * 2, 28);
  result.writeUInt16LE(fmt.channels * 2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36, 'ascii');
  result.writeUInt32LE(outBytes, 40);

  let source = sampleData.start;
  let dest = 44;
  const sourceEnd = source + sampleData.length;
  while (source < sourceEnd) {
    let sample;
    if (fmt.format === RIFF_FMT_FLOAT) {
      sample = fmt.bitDepth === 32 ? input.readFloatLE(source) : input.readDoubleLE(source);
    } else if (fmt.bitDepth === 8) {
      sample = (input[source] - 128) / 128;
    } else if (fmt.bitDepth === 16) {
      sample = input.readInt16LE(source) / 32768;
    } else if (fmt.bitDepth === 24) {
      sample = input.readIntLE(source, 3) / 8388608;
    } else {
      sample = input.readInt32LE(source) / 2147483648;
    }
    if (!Number.isFinite(sample)) sample = 0;
    // Avoid signed 16-bit overflow when source reaches +1.0.
    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
    result.writeInt16LE(int16, dest);
    source += fmt.bitDepth / 8;
    dest += 2;
  }

  return {
    buffer: result,
    detail: (fmt.format === RIFF_FMT_FLOAT ? 'IEEE float ' : 'PCM ') +
      fmt.bitDepth + 'bit / ' + fmt.sampleRate + 'Hz / ' +
      fmt.channels + 'ch → PCM 16bit'
  };
}

module.exports = { normalizeSpeechWav, WavFormatError };
