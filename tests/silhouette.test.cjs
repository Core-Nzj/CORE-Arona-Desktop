'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function moduleUnderTest() {
  return import('../src/silhouette.mjs');
}

function alphaGrid(rows) {
  const width = rows[0].length;
  const pixels = new Uint8ClampedArray(width * rows.length * 4);
  rows.forEach((row, y) => {
    assert.equal(row.length, width);
    [...row].forEach((item, x) => {
      pixels[(y * width + x) * 4 + 3] = item === '#' ? 255 : 0;
    });
  });
  return pixels;
}

test('only occupied silhouette receives mouse input', async () => {
  const { rectanglesFromAlpha } = await moduleUnderTest();
  const alpha = alphaGrid([
    '..##....##..',
    '..##....##..',
    '..########..',
    '..########..',
    '............'
  ]);
  const rects = rectanglesFromAlpha(alpha, 12, 5, 120, 50, { dilation: 0 });
  function hit(x, y) {
    return rects.some(r => x >= r.x && x < r.x + r.width &&
      y >= r.y && y < r.y + r.height);
  }
  assert.equal(hit(25, 5), true);
  assert.equal(hit(95, 5), true);
  assert.equal(hit(60, 5), false);
  assert.equal(hit(60, 25), true);
  assert.equal(hit(0, 45), false);
});

test('rows with identical spans merge into tall rectangles', async () => {
  const { rectanglesFromAlpha } = await moduleUnderTest();
  const rects = rectanglesFromAlpha(
    alphaGrid(['.##.', '.##.', '.##.']), 4, 3, 40, 30, { dilation: 0 }
  );
  assert.deepEqual(rects, [{ x: 10, y: 0, width: 20, height: 30 }]);
});

test('small dilation makes thin edges easier to click', async () => {
  const { rectanglesFromAlpha } = await moduleUnderTest();
  const rects = rectanglesFromAlpha(alphaGrid(['...', '.#.', '...']), 3, 3, 30, 30);
  assert.deepEqual(rects, [{ x: 0, y: 0, width: 30, height: 30 }]);
});

test('transparent canvas and invalid alpha fail safely', async () => {
  const { rectanglesFromAlpha } = await moduleUnderTest();
  assert.deepEqual(rectanglesFromAlpha(alphaGrid(['...', '...']), 3, 2, 30, 20), []);
  assert.deepEqual(rectanglesFromAlpha(new Uint8Array(3), 3, 2, 30, 20), []);
  assert.deepEqual(rectanglesFromAlpha(new Uint8Array(4), 0, 1, 30, 20), []);
});

test('large or excessive native region is rejected', async () => {
  const { rectanglesFromAlpha } = await moduleUnderTest();
  assert.deepEqual(rectanglesFromAlpha(alphaGrid(['#.#']), 3, 1, 30, 10, {
    dilation: 0, maxRectangles: 1
  }), []);
});
