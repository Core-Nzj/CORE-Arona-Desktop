/**
 * Convert alpha pixels into coarse, vertically merged rectangles for Electron's
 * Windows/Linux BrowserWindow.setShape(). Pure JS for deterministic tests.
 *
 * alphaData is RGBA data from a thumbnail of the WebGL canvas.
 * The thumbnail makes the native region inexpensive to update and limits IPC.
 */
export function rectanglesFromAlpha(alphaData, columns, rows, screenWidth, screenHeight, {
  threshold = 8,
  dilation = 1,
  maxRectangles = 1800
} = {}) {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) ||
      columns < 1 || rows < 1 || columns * rows > 200000 ||
      !Number.isFinite(screenWidth) || !Number.isFinite(screenHeight) ||
      screenWidth <= 0 || screenHeight <= 0 ||
      alphaData.length < columns * rows * 4) return [];

  const occupied = new Uint8Array(columns * rows);
  for (let index = 0; index < occupied.length; index++) {
    if (alphaData[index * 4 + 3] > threshold) occupied[index] = 1;
  }

  const radius = Math.max(0, Math.min(2, Math.floor(dilation)));
  const mask = occupied.slice();
  if (radius > 0) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        if (!occupied[y * columns + x]) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && xx < columns && yy >= 0 && yy < rows) {
              mask[yy * columns + xx] = 1;
            }
          }
        }
      }
    }
  }

  const rectangles = [];
  let previousRuns = new Map();
  for (let row = 0; row < rows; row++) {
    const runs = new Map();
    const y1 = Math.round(row * screenHeight / rows);
    const y2 = Math.round((row + 1) * screenHeight / rows);
    let column = 0;

    while (column < columns) {
      if (!mask[row * columns + column]) {
        column++;
        continue;
      }
      const start = column;
      while (column < columns && mask[row * columns + column]) column++;
      const x1 = Math.round(start * screenWidth / columns);
      const x2 = Math.round(column * screenWidth / columns);
      if (x2 <= x1 || y2 <= y1) continue;

      const key = x1 + ':' + x2;
      const existing = previousRuns.get(key);
      if (existing && existing.y + existing.height === y1) {
        existing.height += y2 - y1;
        runs.set(key, existing);
      } else {
        const rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        rectangles.push(rect);
        runs.set(key, rect);
        if (rectangles.length > maxRectangles) return [];
      }
    }
    previousRuns = runs;
  }
  return rectangles;
}
