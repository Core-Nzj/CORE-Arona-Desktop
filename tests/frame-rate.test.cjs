'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FRAME_RATE_OPTIONS, DEFAULT_FRAME_RATE, normalizeFrameRate, movementIntervalMs
} = require('../electron/frame-rate.cjs');

test('FRAME offers only the intended frame rate presets', () => {
  assert.deepEqual(FRAME_RATE_OPTIONS, [30, 60, 120]);
  assert.equal(DEFAULT_FRAME_RATE, 60);
  assert.equal(Object.isFrozen(FRAME_RATE_OPTIONS), true);
});

test('invalid or legacy saved frame-rate settings fall back to 60 FPS', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 0, 45, 59, 144, '60', {}, []]) {
    assert.equal(normalizeFrameRate(value), 60);
  }
  for (const value of FRAME_RATE_OPTIONS) assert.equal(normalizeFrameRate(value), value);
});

test('walking and drag movement timers use FPS-based periods', () => {
  assert.equal(movementIntervalMs(30), 1000 / 30);
  assert.equal(movementIntervalMs(60), 1000 / 60);
  assert.equal(movementIntervalMs(120), 1000 / 120);
  assert.equal(movementIntervalMs(45), 1000 / 60);
  assert.ok(movementIntervalMs(120) < movementIntervalMs(60));
  assert.ok(movementIntervalMs(60) < movementIntervalMs(30));
});
