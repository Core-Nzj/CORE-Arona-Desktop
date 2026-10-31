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

function clampAvatarPosition(target, area) {
  return {
    x: Math.round(Math.max(area.x, Math.min(target.x, area.x + Math.max(0, area.width - target.width)))),
    y: Math.round(Math.max(area.y, Math.min(target.y, area.y + Math.max(0, area.height - target.height)))),
    width: target.width,
    height: target.height
  };
}

module.exports = { stageInDisplay, cursorHitsStageRects, sanitizeHitRectangles, clampAvatarPosition };
