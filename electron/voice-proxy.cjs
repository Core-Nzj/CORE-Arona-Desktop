'use strict';

// Local VoiSona Talk Proxy adapter. No VoiSona binaries, keys or WAVs are bundled.
// This adapter never accepts URLs from the renderer; it talks only to localhost.
const PROXY_ORIGIN = 'http://127.0.0.1:32777';
const { normalizeSpeechWav } = require('./wav-normalizer.cjs');
const MAX_WAV_BYTES = 16 * 1024 * 1024;

class VoiceProxyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VoiceProxyError';
  }
}

function requireSuccess(response, route) {
  if (!response.ok) throw new VoiceProxyError(
    route + ' HTTP ' + response.status +
    (response.status === 401 ? ' (Proxyの認証設定を確認してください)' : '')
  );
}

function normalizeVoice(item) {
  if (!item || typeof item.voice_name !== 'string' || item.voice_name.length > 160 ||
      !Array.isArray(item.languages)) return null;
  const languages = item.languages.filter(lang =>
    typeof lang === 'string' && /^[a-z]{2}_[A-Z]{2}$/.test(lang));
  if (!item.voice_name.trim() || !languages.length) return null;
  return {
    voice_name: item.voice_name,
    voice_version: typeof item.voice_version === 'string' ? item.voice_version : null,
    languages
  };
}

class VoiceProxyClient {
  constructor(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    this.fetchImpl = fetchImpl;
    this.lastWavInfo = 'WAVはまだ生成されていません';
  }

  async listVoices() {
    const response = await this.fetchImpl(PROXY_ORIGIN + '/voices', {
      method: 'GET',
      signal: AbortSignal.timeout(7000)
    });
    requireSuccess(response, '/voices');
    const data = await response.json();
    if (!data || !Array.isArray(data.items)) {
      throw new VoiceProxyError('/voicesの応答形式が不正です');
    }
    return data.items.map(normalizeVoice).filter(Boolean).slice(0, 50);
  }

  async synthesize(text, voice, signal = undefined) {
    if (typeof text !== 'string' || !text.trim() || text.length > 500) {
      throw new VoiceProxyError('発話テキストは1～500文字で指定してください');
    }
    const safeVoice = normalizeVoice(voice);
    if (!safeVoice) throw new VoiceProxyError('使用する音声ライブラリを選んでください');

    const payload = {
      text: text.trim(),
      language: safeVoice.languages.includes('ja_JP') ? 'ja_JP' : safeVoice.languages[0],
      voice_name: safeVoice.voice_name
    };
    if (safeVoice.voice_version) payload.voice_version = safeVoice.voice_version;

    const timeout = AbortSignal.timeout(60000);
    const response = await this.fetchImpl(PROXY_ORIGIN + '/speech-syntheses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    requireSuccess(response, '/speech-syntheses');

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_WAV_BYTES) throw new VoiceProxyError('WAVデータが大きすぎます');

    // Reading as a stream allows a hard size cap even with no Content-Length.
    if (!response.body) throw new VoiceProxyError('WAVデータが返されませんでした');
    const reader = response.body.getReader();
    const chunks = [];
    let count = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        count += value.byteLength;
        if (count > MAX_WAV_BYTES) throw new VoiceProxyError('WAVデータが大きすぎます');
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }
    const data = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), count);
    if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' ||
        data.toString('ascii', 8, 12) !== 'WAVE') {
      throw new VoiceProxyError('Proxyから正しいWAV音声が返されませんでした');
    }
    const normalized = normalizeSpeechWav(data);
    this.lastWavInfo = normalized.detail;
    return normalized.buffer;
  }
}

module.exports = { VoiceProxyClient, VoiceProxyError, normalizeVoice, PROXY_ORIGIN };
