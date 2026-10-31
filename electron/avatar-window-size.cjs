'use strict';

// Native dimensions and screen coordinates use Electron's DIP units.
const BASE_WIDTH = 390;
const BASE_HEIGHT = 590;
const INITIAL_SCALE = 2;
const STARTUP_ZOOM_CLICKS = 5;
const ZOOM_IN_FACTOR = 1 / 0.85; // Keep in sync with menu zoom buttons.
const MIN_SCALE = 1;
const MAX_SCALE = 20 / 3; // Old maximum relative to an automatically fitted model.
const SCREEN_MARGIN = 8;
const MAX_ZOOM_MULTIPLIER = 5; // Five times the displayed startup size.

function maxScaleForArea(workArea) {
  if (!workArea || !Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)) {
    throw new TypeError('Valid work area is required');
  }
  return Math.max(0.1, Math.min(
    MAX_SCALE,
    Math.max(1, workArea.width - 2 * SCREEN_MARGIN) / BASE_WIDTH,
    Math.max(1, workArea.height - 2 * SCREEN_MARGIN) / BASE_HEIGHT
  ));
}

function clampScale(requestedScale, workArea) {
  const limit = maxScaleForArea(workArea);
  const minimum = Math.min(MIN_SCALE, limit);
  if (!Number.isFinite(requestedScale)) return minimum;
  return Math.max(minimum, Math.min(limit, requestedScale));
}

// Native resizing stops at the monitor bounds; optical zoom keeps going.
function resolveZoomScale(requestedScale, workArea) {
  const nativeLimit = maxScaleForArea(workArea);
  const startScale = clampScale(INITIAL_SCALE, workArea);
  const lower = Math.min(MIN_SCALE, nativeLimit);
  const upper = startScale * MAX_ZOOM_MULTIPLIER;
  const scale = Number.isFinite(requestedScale)
    ? Math.max(lower, Math.min(upper, requestedScale)) : startScale;
  const nativeScale = Math.min(scale, nativeLimit);
  const cameraZoom = Math.min(MAX_ZOOM_MULTIPLIER, scale / nativeScale);
  return { scale, nativeScale, cameraZoom };
}

// Start exactly where five clicks on the original (screen-fitted) avatar
// would land. The native viewport still fits the display; excess scale
// becomes optical camera zoom instead of an off-screen window.
function startupScaleForArea(workArea) {
  const originalStart = clampScale(INITIAL_SCALE, workArea);
  return resolveZoomScale(originalStart * Math.pow(ZOOM_IN_FACTOR, STARTUP_ZOOM_CLICKS), workArea).scale;
}

function windowSizeForScale(scale) {
  return {
    width: Math.max(1, Math.floor(BASE_WIDTH * scale)),
    height: Math.max(1, Math.floor(BASE_HEIGHT * scale))
  };
}

function boundsForScale(oldBounds, workArea, requestedScale, screenAnchor = null) {
  const { scale, nativeScale, cameraZoom } = resolveZoomScale(requestedScale, workArea);
  const { width, height } = windowSizeForScale(nativeScale);

  // Keep either the cursor's point on the model or its visual center stationary.
  const anchorX = Number.isFinite(screenAnchor?.x)
    ? screenAnchor.x : oldBounds.x + oldBounds.width / 2;
  const anchorY = Number.isFinite(screenAnchor?.y)
    ? screenAnchor.y : oldBounds.y + oldBounds.height / 2;
  const fractionX = (anchorX - oldBounds.x) / oldBounds.width;
  const fractionY = (anchorY - oldBounds.y) / oldBounds.height;
  const desiredX = Math.round(anchorX - fractionX * width);
  const desiredY = Math.round(anchorY - fractionY * height);

  // The on-screen avatar must not be lost beyond the monitor's work area.
  const clampCoordinate = (n, min, span, windowSize) =>
    Math.max(min, Math.min(n, min + Math.max(0, span - windowSize)));
  return {
    scale,
    nativeScale,
    cameraZoom,
    bounds: {
      x: clampCoordinate(desiredX, workArea.x, workArea.width, width),
      y: clampCoordinate(desiredY, workArea.y, workArea.height, height),
      width,
      height
    }
  };
}

module.exports = {
  BASE_WIDTH, BASE_HEIGHT, INITIAL_SCALE, MIN_SCALE, STARTUP_ZOOM_CLICKS, ZOOM_IN_FACTOR,
  maxScaleForArea, clampScale, resolveZoomScale, startupScaleForArea,
  windowSizeForScale, boundsForScale
};
