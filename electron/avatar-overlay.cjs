'use strict';

// Coordinates are Electron DIPs. The transparent overlay covers a display,
// while the WebGL stage remains small and travels independently of the window.
function stageInDisplay(stage, display) {
  return {
    x: Math.round(stage.x - display.x),
    y: Math.round(stage.y - display.y),
    width: Math.round(stage.width),
    height: Math.round(stage.height)
  };
}

function cursorHitsStageRects(cursor, stage, rectangles) {
  if (!cursor || !stage || !Array.isArray(rectangles) || !rectangles.length) return false;
  const x = cursor.x - stage.x;
  const y = cursor.y - stage.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x >= stage.width || y >= stage.height) return false;
  return rectangles.some(rect =>
    x >= rect.x && y >= rect.y &&
    x < rect.x + rect.width && y < rect.y + rect.height
  );
}

function sanitizeHitRectangles(rectangles, stage, maxRectangles = 2000) {
  if (!Array.isArray(rectangles) || rectangles.length > maxRectangles) return [];
  const result = [];
  for (const rect of rectangles) {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return [];
    const x1 = Math.max(0, Math.min(stage.width, Math.floor(rect.x)));
    const y1 = Math.max(0, Math.min(stage.height, Math.floor(rect.y)));
    const x2 = Math.max(0, Math.min(stage.width, Math.ceil(rect.x + rect.width)));
    const y2 = Math.max(0, Math.min(stage.height, Math.ceil(rect.y + rect.height)));
    if (x2 > x1 && y2 > y1) result.push({x:x1,y:y1,width:x2-x1,height:y2-y1});
  }
  return result;
}

// Clamp the *visible model*, not the full WebGL viewport. The old bound check
// trapped FRAME well before the physical screen edge because most of the stage
// was transparent. Leave a small on-screen piece so it can always be grabbed.
const MIN_VISIBLE_AVATAR_PIXELS = 48;

function avatarExtents(stage, rectangles) {
  const valid = Array.isArray(rectangles) ? rectangles.filter(rect =>
    rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 && rect.height > 0) : [];
  if (!valid.length) {
    // During a model load/warp, retain a recoverable center section.
    return { left: stage.width * 0.2, top: stage.height * 0.15,
      right: stage.width * 0.8, bottom: stage.height * 0.85 };
  }
  return {
    left: Math.min(...valid.map(rect => rect.x)),
    top: Math.min(...valid.map(rect => rect.y)),
    right: Math.max(...valid.map(rect => rect.x + rect.width)),
    bottom: Math.max(...valid.map(rect => rect.y + rect.height))
  };
}

function avatarMovementLimits(stage, area, rectangles, visiblePixels = MIN_VISIBLE_AVATAR_PIXELS) {
  const extents = avatarExtents(stage, rectangles);
  const visibleX = Math.min(visiblePixels, area.width / 2, (extents.right - extents.left) / 2);
  const visibleY = Math.min(visiblePixels, area.height / 2, (extents.bottom - extents.top) / 2);
  return {
    minX: area.x + visibleX - extents.right,
    maxX: area.x + area.width - visibleX - extents.left,
    minY: area.y + visibleY - extents.bottom,
    maxY: area.y + area.height - visibleY - extents.top
  };
}

function clampAvatarPosition(target, area, rectangles = []) {
  const limits = avatarMovementLimits(target, area, rectangles);
  return {
    ...target,
    x: Math.round(Math.max(limits.minX, Math.min(target.x, limits.maxX))),
    y: Math.round(Math.max(limits.minY, Math.min(target.y, limits.maxY)))
  };
}

// Existing boundsForScale() remains safe for legacy native-sized windows.
// The overlay's stage, however, must not be pinned to its display edges.
function unboundedOverlayZoom(oldBounds, zoomResult) {
  const { width, height } = zoomResult.bounds;
  return {
    ...zoomResult,
    bounds: {
      x: Math.round(oldBounds.x + (oldBounds.width - width) / 2),
      y: Math.round(oldBounds.y + (oldBounds.height - height) / 2),
      width, height
    }
  };
}

function scaleAvatarHitRectangles(rectangles, oldStage, newStage) {
  if (!Array.isArray(rectangles) || !oldStage.width || !oldStage.height) return [];
  const sx = newStage.width / oldStage.width;
  const sy = newStage.height / oldStage.height;
  return rectangles.map(rect => ({
    x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy
  }));
}

module.exports = {
  stageInDisplay, cursorHitsStageRects, sanitizeHitRectangles,
  avatarMovementLimits, clampAvatarPosition, unboundedOverlayZoom,
  scaleAvatarHitRectangles, MIN_VISIBLE_AVATAR_PIXELS
};
