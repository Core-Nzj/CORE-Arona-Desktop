'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/emotions.mjs');

function makeMorph(names) {
  const indices = new Map(names.map((name, index) => [name, [index]]));
  const values = new Map(names.map(name => [name, 0]));
  const writes = [];
  return {
    writes,
    values,
    getMorphIndices(name) { return indices.get(name); },
    setMorphWeight(name, weight) {
      if (!indices.has(name)) throw new Error('Unknown morph: ' + name);
      writes.push([name, weight]);
      values.set(name, weight);
    }
  };
}

test('neutral is always available, missing emotions cannot be selected', async () => {
  const { EmotionController } = await load();
  const morph = makeMorph(['まばたき', 'あ']);
  const emotions = new EmotionController(morph);
  assert.deepEqual(emotions.available(), {
    neutral: true, happy: false, angry: false, sad: false, surprised: false
  });
  assert.equal(emotions.select('happy'), false);
  assert.equal(emotions.select('not-a-preset'), false);
  assert.equal(emotions.selected, 'neutral');
  emotions.tick(0.5);
  assert.deepEqual(morph.writes, []);
});

test('selects available Japanese morphs and interpolates without touching blink', async () => {
  const { EmotionController } = await load();
  const morph = makeMorph(['にこり', '怒り', '困る', 'びっくり', 'まばたき', 'あ']);
  const emotions = new EmotionController(morph, { transitionSeconds: 0.3 });
  assert.ok(Object.values(emotions.available()).every(Boolean));
  assert.equal(emotions.select('happy'), true);
  emotions.tick(0.05);
  assert.ok(morph.values.get('にこり') > 0 && morph.values.get('にこり') < 1);
  emotions.tick(1);
  assert.ok(morph.values.get('にこり') > 0.9);

  assert.equal(emotions.select('sad'), true);
  emotions.tick(0.3);
  assert.ok(morph.values.get('にこり') < 0.9);
  assert.ok(morph.values.get('困る') > 0.6);
  assert.ok(morph.writes.every(([name]) => name !== 'まばたき' && name !== 'あ'));
});

test('neutral fades out expression and disposal resets only controlled morphs', async () => {
  const { EmotionController } = await load();
  const morph = makeMorph(['Smile', 'Blink', 'a']);
  const emotions = new EmotionController(morph);
  assert.equal(emotions.select('happy'), true);
  emotions.tick(0.3);
  const active = morph.values.get('Smile');
  assert.ok(active > 0);
  emotions.select('neutral');
  emotions.tick(0.3);
  assert.ok(morph.values.get('Smile') < active);
  emotions.dispose();
  assert.equal(morph.values.get('Smile'), 0);
  assert.equal(emotions.select('happy'), false);
  emotions.tick(0.1);
  assert.ok(morph.writes.every(([name]) => name === 'Smile'));
});

test('prefers one known morph over competing aliases, no doubled smile', async () => {
  const { EmotionController } = await load();
  const morph = makeMorph(['にこり', '笑い', 'smile', 'まばたき']);
  const emotions = new EmotionController(morph);
  assert.match(emotions.diagnostics(), /笑顔：にこり/);
  emotions.select('happy');
  emotions.tick(1);
  assert.ok(morph.writes.some(([name]) => name === 'にこり'));
  assert.ok(morph.writes.every(([name]) => name === 'にこり'));
});

test('two independently loaded models have no shared emotion state', async () => {
  const { EmotionController } = await load();
  const first = new EmotionController(makeMorph(['にこり']));
  first.select('happy');
  first.tick(1);
  first.dispose();

  const second = new EmotionController(makeMorph(['怒り']));
  assert.equal(second.selected, 'neutral');
  assert.equal(second.select('happy'), false);
  assert.equal(second.select('angry'), true);
});

test('invalid input and malformed weights fail closed', async () => {
  const { EmotionController } = await load();
  assert.throws(() => new EmotionController(null), /morph controller/);
  const controller = new EmotionController(makeMorph(['困る']));
  assert.equal(controller.select('__proto__'), false);
  controller.tick(NaN);
  controller.tick(-3);
  controller.tick(Number.POSITIVE_INFINITY);
  assert.equal(controller.selected, 'neutral');
});
