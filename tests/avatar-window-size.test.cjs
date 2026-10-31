'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  INITIAL_SCALE, STARTUP_ZOOM_CLICKS, ZOOM_IN_FACTOR,
  maxScaleForArea, clampScale, resolveZoomScale, startupScaleForArea,
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

test('camera zoom reaches 5x startup size on a 1080p work area', () => {
  const { resolveZoomScale } = require('../electron/avatar-window-size.cjs');
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const initialScale = clampScale(INITIAL_SCALE, workArea);
  const max = resolveZoomScale(Infinity, workArea);
  assert.equal(max.scale, initialScale);
  const limit = resolveZoomScale(100, workArea);
  assert.ok(Math.abs(limit.scale / initialScale - 5) < 1e-10);
  assert.ok(Math.abs(limit.cameraZoom - 5) < 1e-10);
  assert.equal(limit.nativeScale, maxScaleForArea(workArea));
  assert.equal(resolveZoomScale(initialScale, workArea).cameraZoom, 1);
});

test('native resizing stops at monitor size while optical zoom continues', () => {
  const { resolveZoomScale } = require('../electron/avatar-window-size.cjs');
  const area = { x: 0, y: 0, width: 2560, height: 1440 };
  assert.equal(resolveZoomScale(1.5, area).cameraZoom, 1);
  const limit = maxScaleForArea(area);
  const beyond = resolveZoomScale(limit * 1.5, area);
  assert.equal(beyond.nativeScale, limit);
  assert.ok(Math.abs(beyond.cameraZoom - 1.5) < 1e-10);
  const old = { x: 150, y: 50, width: 950, height: 1424 };
  const first = boundsForScale(old, area, limit * 1.5);
  const second = boundsForScale(first.bounds, area, limit * 2);
  assert.deepEqual(first.bounds, second.bounds);
  assert.ok(second.cameraZoom > first.cameraZoom);
});

test('new startup equals five consecutive old zoom-in button presses', () => {
  const workAreas = [
    { x: 0, y: 0, width: 3440, height: 1440 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: -2560, y: 0, width: 2560, height: 1440 }
  ];
  assert.equal(STARTUP_ZOOM_CLICKS, 5);
  for (const area of workAreas) {
    const previousStart = clampScale(INITIAL_SCALE, area);
    let manualScale = previousStart;
    for (let i = 0; i < STARTUP_ZOOM_CLICKS; i++) {
      manualScale = resolveZoomScale(manualScale * ZOOM_IN_FACTOR, area).scale;
    }
    const startupScale = startupScaleForArea(area);
    assert.ok(Math.abs(startupScale - manualScale) < 1e-9);
    const { nativeScale, cameraZoom } = resolveZoomScale(startupScale, area);
    assert.ok(Math.abs(nativeScale * cameraZoom - startupScale) < 1e-9);
    const dimensions = windowSizeForScale(nativeScale);
    assert.ok(dimensions.width <= area.width);
    assert.ok(dimensions.height <= area.height);
    assert.ok(cameraZoom >= 1);
  }
});

test('reset can restore the enlarged startup while zooming out remains possible', () => {
  const area = { x: 0, y: 0, width: 3440, height: 1440 };
  const startup = startupScaleForArea(area);
  assert.ok(startup > clampScale(INITIAL_SCALE, area));
  const reset = resolveZoomScale(startup, area);
  assert.ok(Math.abs(reset.scale - startup) < 1e-9);
  assert.ok(resolveZoomScale(startup / ZOOM_IN_FACTOR, area).scale < startup);
});
