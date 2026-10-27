// Port of CORE VoiSona Reader v0.7's ordered sentence playback.
// DOM detection and speech queue remain separate from the audio backend.
export function splitSpeechText(text, limit = 280) {
  const pieces = [];
  let remaining = String(text || '').replace(/https?:\/\/\S+/g, ' リンク ')
    .replace(/[\x60*_#>|~]/g, ' ').replace(/\s+/g, ' ').trim();
  const maxLength = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 280;

  while (remaining.length) {
    if (remaining.length <= maxLength) { pieces.push(remaining); break; }
    const windowText = remaining.slice(0, maxLength);

    // Prefer the last complete sentence in this window even when it is short.
    // This keeps brief replies intact without producing many tiny chunks.
    let cut = -1;
    for (const match of windowText.matchAll(/[。！？!?．](?:[」』）"'\u3011]*)/gu)) {
      cut = match.index + match[0].length;
    }

    // Without a sentence end, use a comma/space near the upper limit.
    if (cut < 0) {
      for (const mark of ['、', '，', '；', ' ']) {
        const at = windowText.lastIndexOf(mark);
        if (at >= Math.floor(maxLength * 0.4) && at + 1 > cut) cut = at + 1;
      }
    }
    if (cut <= 0) cut = maxLength;

    // Keep characters intact across chunks. The synth adapter trims them.
    pieces.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return pieces.filter(Boolean);
}

export class SpeechPlaybackQueue {
  constructor({ play, interrupt, status = () => {} }) {
    if (typeof play !== 'function' || typeof interrupt !== 'function') {
      throw new TypeError('play and interrupt callbacks are required');
    }
    this.play = play;
    this.interrupt = interrupt;
    this.status = status;
    this.generation = 0;
    this.stream = null;
  }

  stop() {
    this.generation++;
    this.stream = null;
    this.interrupt();
    this.status('停止しました');
  }

  start(streamId, voice = null, voiceProfiles = {}) {
    if (typeof streamId !== 'string' || !streamId || streamId.length > 100) return false;
    this.stop();
    this.stream = {
      id: streamId, voice, voiceProfiles, queue: [],
      open: true, draining: false, lastSeq: -1
    };
    this.status('新しい回答を待機中…');
    return true;
  }

  append(streamId, seq, text) {
    const stream = this.stream;
    if (!stream || stream.id !== streamId) return { missing: true };
    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= stream.lastSeq) return { ignored: true };
    stream.lastSeq = seq;
    const parts = splitSpeechText(text, 280);
    if (stream.queue.length + parts.length > 500) return { overflow: true };
    stream.queue.push(...parts);
    this.drain(stream);
    return { accepted: true };
  }

  end(streamId) {
    const stream = this.stream;
    if (!stream || stream.id !== streamId) return;
    stream.open = false;
    if (!stream.draining && !stream.queue.length) {
      this.stream = null;
      this.status('読み上げ完了');
    }
  }

  speak(text, voice = null, voiceProfiles = {}) {
    const id = 'manual-' + (++this.generation);
    this.start(id, voice, voiceProfiles);
    const parts = splitSpeechText(text, 280);
    // Manual playback uses the same ordered queue, not a long synth request.
    for (const part of parts) {
      const stream = this.stream;
      if (!stream || stream.id !== id) break;
      stream.queue.push(part);
    }
    this.end(id);
    if (this.stream) this.drain(this.stream);
  }

  async drain(stream) {
    if (stream.draining || this.stream !== stream) return;
    stream.draining = true;
    const generation = this.generation;
    try {
      while (this.stream === stream && generation === this.generation && stream.queue.length) {
        const part = stream.queue.shift();
        this.status('逐次読み上げ中（残り' + stream.queue.length + '件）');
        await this.play(part, stream.voice, stream.voiceProfiles);
      }
      if (this.stream !== stream || generation !== this.generation) return;
      if (stream.open) this.status('次の生成テキストを待機中…');
      else { this.stream = null; this.status('読み上げ完了'); }
    } catch (error) {
      if (this.stream === stream && generation === this.generation) {
        this.stream = null;
        this.status('再生失敗: ' + String(error?.message ?? error));
      }
    } finally {
      stream.draining = false;
      if (this.stream === stream && stream.queue.length && generation === this.generation) {
        void this.drain(stream);
      }
    }
  }
}
