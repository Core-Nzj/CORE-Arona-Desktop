// Audio processing is limited to canonical 16-bit PCM WAV returned
// by the trusted Electron main process. Use Web Audio rather than relying
// on HTMLMediaElement's WAV container/codec support.
export function decodePcm16Wav(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 46) {
    throw new Error('PCM WAVデータが短すぎます');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' ||
      tag(12) !== 'fmt ' || tag(36) !== 'data') {
    throw new Error('標準PCM WAVヘッダーが見つかりません');
  }
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const blockAlign = view.getUint16(32, true);
  const bitDepth = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  if (format !== 1 || ![1, 2].includes(channels) || bitDepth !== 16 ||
      sampleRate < 8000 || sampleRate > 192000 || blockAlign !== channels * 2 ||
      dataBytes === 0 || dataBytes > bytes.byteLength - 44 ||
      dataBytes % blockAlign !== 0) {
    throw new Error('PCM WAVヘッダーに未対応の値があります');
  }
  const frames = dataBytes / blockAlign;
  const signals = Array.from({ length: channels }, () => new Float32Array(frames));
  let cursor = 44;
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < channels; channel++) {
      signals[channel][i] = view.getInt16(cursor, true) / 32768;
      cursor += 2;
    }
  }
  return { sampleRate, signals, frames };
}

export function makeWebAudioBuffer(context, pcmBytes) {
  const { sampleRate, signals, frames } = decodePcm16Wav(pcmBytes);
  const audioBuffer = context.createBuffer(signals.length, frames, sampleRate);
  signals.forEach((signal, channel) => {
    audioBuffer.getChannelData(channel).set(signal);
  });
  return audioBuffer;
}
