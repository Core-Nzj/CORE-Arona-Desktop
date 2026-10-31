'use strict';

const { validatePng } = require('./vision-session-broker.cjs');

const LOCAL_DESTINATION_ID = 'frame.local.sink';

// Deliberately inert: accepts an explicitly approved PNG in-process,
// validates it and immediately forgets it. No network, files or logs.
class VisionLocalAdapter {
  #connected = true;

  getCapabilities() {
    return {
      destinationId: LOCAL_DESTINATION_ID,
      acceptsPng: true,
      requiresApproval: true,
      remote: false,
      label: 'FRAMEローカル検証（外部送信なし）'
    };
  }

  async deliver({ destinationId, mimeType, imageBytes, signal } = {}) {
    if (!this.#connected || signal?.aborted) {
      throw new Error('ローカル受信先は利用できません');
    }
    if (destinationId !== LOCAL_DESTINATION_ID || mimeType !== 'image/png') {
      throw new Error('ローカル受信先または画像形式が不正です');
    }
    validatePng(imageBytes);
    if (signal?.aborted) throw new Error('画像の受け渡しが取り消されました');
    // Acknowledges receipt inside this process only; ChatGPT has not received it.
    return { delivered: true };
  }

  async cancel() {
    // No queued messages or retained images.
  }

  async disconnect() {
    this.#connected = false;
  }
}

module.exports = { VisionLocalAdapter, LOCAL_DESTINATION_ID };
