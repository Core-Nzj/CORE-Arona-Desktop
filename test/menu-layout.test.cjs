'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMenuLayout, changeMenuZoom, resizeMenuBounds } = require('../electron/menu-layout.cjs');

const area = { x: 100, y: 50, width: 1280, height: 720 };
const bounds = { x: 300, y: 160, width: 376, height: 500 };
const origin = { x: 300, y: 160 };

test('layout and zoom are clamped to safe display limits', () => {
  assert.deepEqual(normalizeMenuLayout({ width: 9999, height: -9, zoom: 99 }, area),
    { width: 1268, height: 320, zoom: 1.5 });
  assert.equal(changeMenuZoom(1, 'out'), 0.9);
  assert.equal(changeMenuZoom(1.5, 'in'), 1.5);
  assert.equal(changeMenuZoom(0.75, 'out'), 0.75);
  assert.equal(changeMenuZoom(1.4, 'reset'), 1);
});

test('left edge preserves opposite edge and enforces minimum width', () => {
  const expanded = resizeMenuBounds(bounds, origin, { x: 240, y: 160 }, 'w', area);
  assert.deepEqual(expanded, { x: 240, y: 160, width: 436, height: 500 });
  const clamped = resizeMenuBounds(bounds, origin, { x: 999, y: 160 }, 'w', area);
  assert.deepEqual(clamped, { x: 376, y: 160, width: 300, height: 500 });
});

test('top-right corner clamps to work area while preserving bottom edge', () => {
  const resized = resizeMenuBounds(bounds, origin, { x: 1500, y: 70 }, 'ne', area);
  assert.deepEqual(resized, { x: 300, y: 70, width: 1080, height: 590 });
});

test('resizing from bottom right never crosses minimum size', () => {
  const resized = resizeMenuBounds(bounds, origin, { x: -1000, y: -1000 }, 'se', area);
  assert.deepEqual(resized, { x: 300, y: 160, width: 300, height: 320 });
});
