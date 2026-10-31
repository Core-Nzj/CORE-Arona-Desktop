'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_WIDTH, DEFAULT_HEIGHT, LAYOUT_VERSION,
  TEXT_SIZE_VERSION, DEFAULT_TEXT_SIZE, normalizeTextSize, restoreTextSize,
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

test('text size rebases previous 160% to new 100% and migrates saved sizes', () => {
  assert.equal(DEFAULT_TEXT_SIZE, 100);
  assert.equal(restoreTextSize({}), 100);
  assert.equal(restoreTextSize({ textSize: 160 }), 100);
  assert.equal(restoreTextSize({ textSize: 115 }), 70);
  assert.equal(restoreTextSize({ textSize: 70 }), 45);
  assert.equal(restoreTextSize({ textSize: 100, textSizeVersion: TEXT_SIZE_VERSION }), 100);
});

test('new text size limits remain within 0–200% at 5% increments', () => {
  assert.equal(normalizeTextSize(-200), 0);
  assert.equal(normalizeTextSize(999), 200);
  assert.equal(normalizeTextSize(137), 135);
  assert.equal(restoreTextSize({ textSize: 200, textSizeVersion: TEXT_SIZE_VERSION }), 200);
  assert.equal(restoreTextSize({ textSize: 0, textSizeVersion: TEXT_SIZE_VERSION }), 0);
  assert.equal(restoreTextSize({ textSize: NaN }), 100);
});
