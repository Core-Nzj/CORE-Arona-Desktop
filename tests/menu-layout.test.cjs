'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_WIDTH, DEFAULT_HEIGHT, LAYOUT_VERSION,
  normalizeMenuLayout, restoreMenuLayout
} = require('../electron/menu-layout.cjs');

const largeDesktop = { x: 0, y: 0, width: 3440, height: 1440 };

test('new FRAME settings panel defaults to a roomier size', () => {
  assert.equal(DEFAULT_WIDTH, 560);
  assert.equal(DEFAULT_HEIGHT, 760);
  assert.deepEqual(normalizeMenuLayout({}, largeDesktop), {
    width: 560, height: 760, zoom: 1
  });
});

test('small saved settings panels are enlarged once on upgrade', () => {
  const old = { width: 376, height: 566, zoom: 1.2 };
  assert.deepEqual(restoreMenuLayout(old, largeDesktop), {
    width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, zoom: 1.2
  });
  const partlyResized = { width: 600, height: 610, zoom: 0.9 };
  assert.deepEqual(restoreMenuLayout(partlyResized, largeDesktop), {
    width: 600, height: DEFAULT_HEIGHT, zoom: 0.9
  });
});

test('manual resizes after the migration remain preserved, including smaller panels', () => {
  assert.deepEqual(restoreMenuLayout({
    version: LAYOUT_VERSION, width: 420, height: 580, zoom: 1
  }, largeDesktop), { width: 420, height: 580, zoom: 1 });
});

test('new settings panel fits even on small monitors', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const result = restoreMenuLayout({ width: 376, height: 566 }, area);
  assert.equal(result.width, DEFAULT_WIDTH);
  assert.ok(result.height <= area.height - 12);
  assert.equal(result.height, area.height - 12);
});
