'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadBuilder() {
  return import('../src/idle-vmd.mjs');
}

function readVmd(buffer) {
  const raw = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const header = String.fromCharCode(...raw.subarray(0, 30)).replace(/\0+$/, '');
  let offset = 50;
  const boneCount = view.getUint32(offset, true);
  offset += 4;
  const bones = [];
  for (let i = 0; i < boneCount; i++) {
    const row = raw.subarray(offset, offset + 111);
    const frame = view.getUint32(offset + 15, true);
    const q = [0, 1, 2, 3].map(k => view.getFloat32(offset + 31 + 4 * k, true));
    bones.push({ row, frame, q });
    offset += 111;
  }
  const morphCount = view.getUint32(offset, true);
  offset += 4;
  const morphs = [];
  for (let i = 0; i < morphCount; i++) {
    morphs.push({
      frame: view.getUint32(offset + 15, true),
      weight: view.getFloat32(offset + 19, true)
    });
    offset += 23;
  }
  const trailing = [];
  for (let i = 0; i < 4; i++) {
    trailing.push(view.getUint32(offset, true));
    offset += 4;
  }
  assert.equal(offset, buffer.byteLength);
  return { header, boneCount, bones, morphCount, morphs, trailing };
}

test('emits a valid-size VMD with a conventional header', async () => {
  const { buildIdleVmd } = await loadBuilder();
  const parsed = readVmd(buildIdleVmd({boneNames:['左腕','右腕','上半身'],morphNames:['まばたき']}));
  assert.equal(parsed.header, 'Vocaloid Motion Data 0002');
  assert.equal(parsed.boneCount, 39); // 3 bones x 13 samples
  assert.equal(parsed.morphCount, 14); // three irregular blinks, each 4 keys + start/end
  assert.deepEqual(parsed.trailing, [0, 0, 0, 0]);
  assert.ok(parsed.bones.every(row => row.q.every(Number.isFinite)));
});

test('unknown model names generate no destructive movement', async () => {
  const { buildIdleVmd } = await loadBuilder();
  const parsed = readVmd(buildIdleVmd({boneNames:['custom-root'],morphNames:['smile']}));
  assert.equal(parsed.boneCount, 0);
  assert.equal(parsed.morphCount, 0);
});

test('blink morph generates closed and open keyframes', async () => {
  const { buildIdleVmd } = await loadBuilder();
  const parsed = readVmd(buildIdleVmd({morphNames:['Blink']}));
  assert.equal(parsed.boneCount, 0);
  assert.ok(parsed.morphs.some(morph => morph.weight === 1));
  assert.equal(parsed.morphs[0].weight, 0);
  assert.equal(parsed.morphs.at(-1).weight, 0);
});

test('only recognized target bones participate in the animation', async () => {
  const { buildIdleVmd, IDLE_FRAMES } = await loadBuilder();
  const parsed = readVmd(buildIdleVmd({boneNames:['左腕','oops','RightArm']}));
  assert.equal(parsed.boneCount, 26);
  assert.equal(parsed.bones[12].frame, IDLE_FRAMES);
  assert.equal(parsed.bones[25].frame, IDLE_FRAMES);
  for (const { q } of parsed.bones) {
    const length = Math.hypot(...q);
    assert.ok(Math.abs(length - 1) < 0.00001);
  }
});
