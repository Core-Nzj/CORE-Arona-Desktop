import test from 'node:test';
import assert from 'node:assert/strict';
import { fovForZoom, approachZoom } from '../src/camera-zoom.mjs';

test('FOV zoom achieves desired magnification without moving the camera', () => {
  for (const z of [1, 1.2, 2, 3, 5]) {
    const fov = fovForZoom(0.7, z);
    assert.ok(Math.abs(Math.tan(0.35) / Math.tan(fov / 2) - z) < 1e-12);
  }
});

test('camera easing never overshoots and converges', () => {
  let zoom = 1;
  for (let i = 0; i < 120; i++) {
    zoom = approachZoom(zoom, 5, 1 / 60);
    assert.ok(zoom >= 1 && zoom <= 5);
  }
  assert.equal(zoom, 5);
  assert.equal(approachZoom(5, 1, 0), 5);
  assert.throws(() => fovForZoom(0.7, 0));
});
