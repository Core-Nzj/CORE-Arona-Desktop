'use strict';

// Geometry for FRAME's transparent, frameless menu. Pure functions are kept
// independent of Electron so edge constraints can be tested with node --test.
const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 760;
const LAYOUT_VERSION = 2; // v1 used 376 x 566, before the extra motion/voice controls.
const MIN_WIDTH = 300;
const MIN_HEIGHT = 320;
const WINDOW_MARGIN = 12;
const ZOOM_LEVELS = Object.freeze([0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
const EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function nearestZoom(value) {
  const candidate = Number.isFinite(value) ? value : 1;
  return ZOOM_LEVELS.reduce((closest, item) =>
    Math.abs(item - candidate) < Math.abs(closest - candidate) ? item : closest, 1);
}

function normalizeMenuLayout(value, workArea) {
  const raw = value && typeof value === 'object' ? value : {};
  const maxWidth = Math.max(MIN_WIDTH, Math.floor(workArea.width - WINDOW_MARGIN));
  const maxHeight = Math.max(MIN_HEIGHT, Math.floor(workArea.height - WINDOW_MARGIN));
  return {
    width: Math.round(clamp(Number.isFinite(raw.width) ? raw.width : DEFAULT_WIDTH, MIN_WIDTH, maxWidth)),
    height: Math.round(clamp(Number.isFinite(raw.height) ? raw.height : DEFAULT_HEIGHT, MIN_HEIGHT, maxHeight)),
    zoom: nearestZoom(raw.zoom)
  };
}

// Upgrade previously saved small panels once, but preserve intentional
// window resizes after version 2 has been written to disk.
function restoreMenuLayout(value, workArea) {
  if (value && typeof value === 'object' && value.version === LAYOUT_VERSION) {
    return normalizeMenuLayout(value, workArea);
  }
  const old = value && typeof value === 'object' ? value : {};
  return normalizeMenuLayout({
    ...old,
    width: Math.max(DEFAULT_WIDTH, Number.isFinite(old.width) ? old.width : 0),
    height: Math.max(DEFAULT_HEIGHT, Number.isFinite(old.height) ? old.height : 0)
  }, workArea);
}

function changeMenuZoom(current, direction) {
  if (direction === 'reset') return 1;
  if (direction !== 'in' && direction !== 'out') return nearestZoom(current);
  const index = ZOOM_LEVELS.indexOf(nearestZoom(current));
  return ZOOM_LEVELS[clamp(index + (direction === 'in' ? 1 : -1), 0, ZOOM_LEVELS.length - 1)];
}

function resizeMenuBounds(bounds, origin, pointer, edge, workArea) {
  if (!EDGES.has(edge)) return { ...bounds };
  const dx = Math.round(pointer.x - origin.x);
  const dy = Math.round(pointer.y - origin.y);
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  const areaRight = workArea.x + workArea.width;
  const areaBottom = workArea.y + workArea.height;
  if (edge.includes('w')) left = clamp(bounds.x + dx, workArea.x, right - MIN_WIDTH);
  if (edge.includes('e')) right = clamp(right + dx, left + MIN_WIDTH, areaRight);
  if (edge.includes('n')) top = clamp(bounds.y + dy, workArea.y, bottom - MIN_HEIGHT);
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + MIN_HEIGHT, areaBottom);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

module.exports = {
  DEFAULT_WIDTH, DEFAULT_HEIGHT, MIN_WIDTH, MIN_HEIGHT, LAYOUT_VERSION,
  EDGES, normalizeMenuLayout, restoreMenuLayout, changeMenuZoom, resizeMenuBounds
};
