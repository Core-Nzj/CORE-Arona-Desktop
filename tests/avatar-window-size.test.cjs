'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  INITIAL_SCALE, maxScaleForArea, clampScale,
  windowSizeForScale, boundsForScale
} = require('../electron/avatar-window-size.cjs');

test('starting at 2x doubles both viewport dimensions without camera zoom', () => {
  const area = { x: 0, y: 0, width: 2560, height: 1600 };
  const scale = clampScale(INITIAL_SCALE, area);
  assert.equal(scale, 2);
  assert.deepEqual(windowSizeForScale(scale), { width: 780, height: 1180 });
});

test('small screens cap both dimensions while preserving their aspect ratio', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const scale = clampScale(INITIAL_SCALE, area);
  assert.ok(scale < 2);
  assert.ok(scale > 1);
  const { width, height } = windowSizeForScale(scale);
  assert.ok(width <= area.width - 16);
  assert.ok(height <= area.height - 16);
  assert.ok(Math.abs(width / height - 390 / 590) < 0.002);
  assert.equal(clampScale(999, area), maxScaleForArea(area));
});

test('wheel resizing keeps the pixel under the cursor stationary', () => {
  const area = { x: 0, y: 0, width: 3840, height: 2160 };
  const old = { x: 700, y: 500, width: 390, height: 590 };
  const pointer = { x: 800, y: 700 };
  const { bounds } = boundsForScale(old, area, 1.5, pointer);
  assert.deepEqual(bounds, { x: 650, y: 400, width: 585, height: 885 });
  assert.equal((pointer.x - old.x) / old.width, (pointer.x - bounds.x) / bounds.width);
});

test('window remains in the matching monitor work area on zoom', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  const old = { x: -1650, y: 400, width: 390, height: 590 };
  const { bounds } = boundsForScale(old, area, 100);
  assert.ok(bounds.x >= area.x);
  assert.ok(bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
});

test('reset restores initial scale subject to the current screen limit', () => {
  const area = { x: 0, y: 0, width: 2560, height: 1440 };
  const old = { x: 500, y: 400, width: 390, height: 590 };
  assert.equal(boundsForScale(old, area, INITIAL_SCALE).scale, 2);
  assert.equal(boundsForScale(old, area, -1).scale, 1);
});
