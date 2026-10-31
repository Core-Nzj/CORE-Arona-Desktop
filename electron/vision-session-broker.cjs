'use strict';

const { randomUUID } = require('node:crypto');

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const DEFAULT_TTL_MS = 60_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validatePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > MAX_PNG_BYTES ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG画像が不正、または8MiBの上限を超えています');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new Error('PNG画像の寸法が不正です');
  }
}

function validateRequest({ source, target, destinationId }) {
  if (typeof source !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/i.test(source) ||
      !target || typeof target !== 'object' ||
      typeof target.pluginId !== 'string' ||
      !/^[a-z][a-z0-9.-]{2,63}$/.test(target.pluginId) ||
      typeof target.windowId !== 'string' ||
      !/^0x[\da-f]{1,16}$/i.test(target.windowId) ||
      !Number.isSafeInteger(target.pid) || target.pid <= 0 ||
      typeof destinationId !== 'string' || !/^[a-z][a-z0-9._-]{2,79}$/i.test(destinationId)) {
    throw new Error('撮影セッションの要求が不正です');
  }
}

// Main-process-only session coordinator. No IPC handlers or network endpoints are
// registered here. Future UI code must authenticate its caller before invoking approve().
class VisionSessionBroker {
  #adapter;
  #session = null;
  #last = null;
  #ttlMs;
  #now;
  #timer = null;
  #closed = false;

  constructor({ adapter, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    if (!adapter || typeof adapter.getCapabilities !== 'function' ||
        typeof adapter.deliver !== 'function' ||
        typeof adapter.cancel !== 'function' ||
        typeof adapter.disconnect !== 'function') {
      throw new TypeError('Connection adapter interface is incomplete');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 600_000 ||
        typeof now !== 'function') {
      throw new TypeError('Invalid vision session configuration');
    }
    this.#adapter = adapter;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  getCapabilities() {
    return { ...this.#adapter.getCapabilities() };
  }

  #summary(session) {
    return {
      requestId: session.requestId,
      source: session.source,
      target: { ...session.target },
      destinationId: session.destinationId,
      capturedAt: session.capturedAt,
      expiresAt: session.expiresAt,
      status: session.status
    };
  }

  getState() {
    this.#expireIfNeeded();
    if (this.#session) return this.#summary(this.#session);
    return this.#last ? {
      ...this.#last, target: { ...this.#last.target }
    } : null;
  }

  #stopTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #armTimer() {
    this.#stopTimer();
    if (!this.#session) return;
    const requestId = this.#session.requestId;
    const delay = Math.max(1, this.#session.expiresAt - this.#now());
    this.#timer = setTimeout(() => {
      if (this.#session?.requestId === requestId) {
        this.#expireIfNeeded();
      }
    }, delay);
    this.#timer.unref?.();
  }

  #finish(session, status) {
    if (this.#session !== session) return;
    this.#stopTimer();
    session.status = status;
    if (status !== 'delivered') session.controller?.abort();
    // Also clear the broker's byte copy. V8/OS may retain memory pages until reuse.
    if (session.imageBytes) session.imageBytes.fill(0);
    session.imageBytes = null;
    this.#last = this.#summary(session);
    this.#session = null;
    if (status === 'revoked' || status === 'expired') {
      try {
        Promise.resolve(this.#adapter.cancel(session.requestId)).catch(() => {});
      } catch { /* Cancelling must not restore permission or bytes. */ }
    }
  }

  #expireIfNeeded() {
    if (this.#session && this.#now() >= this.#session.expiresAt) {
      this.#finish(this.#session, 'expired');
    }
  }

  #current(requestId, status) {
    this.#expireIfNeeded();
    const session = this.#session;
    if (!session || session.requestId !== requestId ||
        (status && session.status !== status)) {
      throw new Error('有効な画像セッションではないか、操作順序が正しくありません');
    }
    return session;
  }

  begin({ source, target, destinationId } = {}) {
    if (this.#closed) throw new Error('接続アダプターは終了済みです');
    validateRequest({ source, target, destinationId });
    const capabilities = this.getCapabilities();
    if (capabilities.destinationId !== destinationId ||
        capabilities.acceptsPng !== true || capabilities.requiresApproval !== true) {
      throw new Error('指定された送信先は利用できません');
    }
    this.#expireIfNeeded();
    if (this.#session?.status === 'delivering') {
      throw new Error('画像の受け渡し中は別の撮影を開始できません');
    }
    if (this.#session) this.#finish(this.#session, 'revoked');
    this.#last = null;
    const timestamp = this.#now();
    this.#session = {
      requestId: randomUUID(),
      source,
      target: { pluginId: target.pluginId, windowId: target.windowId, pid: target.pid },
      destinationId,
      status: 'pending',
      capturedAt: null,
      expiresAt: timestamp + this.#ttlMs,
      imageBytes: null,
      controller: null
    };
    this.#armTimer();
    return this.getState();
  }

  capture(requestId, imageBytes) {
    const session = this.#current(requestId, 'pending');
    validatePng(imageBytes);
    // Copy: callers cannot mutate or retain the broker's internal image buffer.
    session.imageBytes = Buffer.from(imageBytes);
    session.capturedAt = this.#now();
    session.expiresAt = session.capturedAt + this.#ttlMs;
    session.status = 'captured';
    this.#armTimer();
    return this.getState();
  }

  approve({ requestId, destinationId, userConfirmed } = {}) {
    const session = this.#current(requestId, 'captured');
    if (userConfirmed !== true || destinationId !== session.destinationId) {
      throw new Error('画像の送信には、送信先を確認した明示的な許可が必要です');
    }
    session.status = 'approved';
    return this.getState();
  }

  async deliver(requestId) {
    const session = this.#current(requestId, 'approved');
    const controller = new AbortController();
    session.controller = controller;
    session.status = 'delivering'; // Prevent concurrent or duplicate delivery.
    const imageBytes = Buffer.from(session.imageBytes);
    let status = 'failed';
    try {
      const response = await this.#adapter.deliver({
        requestId, destinationId: session.destinationId,
        mimeType: 'image/png', imageBytes, signal: controller.signal
      });
      if (controller.signal.aborted || this.#session !== session) {
        throw new Error('画像の受け渡しは取り消されました');
      }
      if (response?.delivered !== true) {
        throw new Error('受信先から受領確認が得られませんでした');
      }
      status = 'delivered';
      return { requestId, destinationId: session.destinationId, delivered: true };
    } finally {
      imageBytes.fill(0);
      this.#finish(session, status);
    }
  }

  revoke(requestId = null) {
    if (requestId !== null && this.#session?.requestId !== requestId) return false;
    if (!this.#session) return false;
    this.#finish(this.#session, 'revoked');
    return true;
  }

  async disconnect() {
    this.revoke();
    this.#closed = true;
    await this.#adapter.disconnect();
  }
}

module.exports = { VisionSessionBroker, validatePng, MAX_PNG_BYTES, DEFAULT_TTL_MS };
