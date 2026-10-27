import test from 'node:test';
import assert from 'node:assert/strict';
import { LipSyncController, mouthLevelFromSamples } from '../src/lip-sync.mjs';

test('silence and noise do not open the mouth; louder speech does', () => {
  assert.equal(mouthLevelFromSamples(new Float32Array(1024)), 0);
  assert.equal(mouthLevelFromSamples(Float32Array.of(0.005, -0.005)), 0);
  assert.ok(mouthLevelFromSamples(Float32Array.of(0.2, -0.2)) > 0.9);
});

test('lip sync uses only a supported mouth morph and resets on disposal', () => {
  const weights = new Map();
  const morph = {
    getMorphIndices: name => name === 'あ' ? [2] : [],
    setMorphWeight: (name, weight) => weights.set(name, weight)
  };
  const controller = new LipSyncController(morph);
  controller.setLevel(0.9);
  for (let i = 0; i < 10; i++) controller.tick(0.016);
  assert.ok(weights.get('あ') > 0.5);
  assert.deepEqual([...weights.keys()], ['あ']);
  controller.dispose();
  assert.equal(weights.get('あ'), 0);
});

test('models without mouth morphs remain unaffected', () => {
  let writes = 0;
  const controller = new LipSyncController({
    getMorphIndices: () => [],
    setMorphWeight: () => { writes++; }
  });
  controller.setLevel(1);
  controller.tick(0.1);
  controller.dispose();
  assert.equal(writes, 0);
});
