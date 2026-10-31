import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOTION_TRANSITION_MODES, BLEND_FRAMES, poseSimilarity,
  chooseMotionTransition, blendSpanParameters
} from '../src/motion-blend.mjs';

function clip(rotations, endFrame = 120) {
  return {
    endFrame,
    boneTracks: Object.entries(rotations).map(([name, rotation]) => ({
      name,
      frameNumbers: new Uint32Array([0, endFrame]),
      rotations: new Float32Array([...rotation, ...rotation])
    })),
    movableBoneTracks: []
  };
}

const same = {
  '頭': [0, 0, 0, 1],
  '上半身': [0, 0, 0, 1],
  '左腕': [0, 0, 0, 1],
  '右腕': [0, 0, 0, 1]
};
const wideArms = {
  ...same,
  '左腕': [0, 0, Math.sin(0.8), Math.cos(0.8)],
  '右腕': [0, 0, -Math.sin(0.8), Math.cos(0.8)]
};
function decide(from, to, extra={}) {
  return chooseMotionTransition({
    fromAnimation: from, toAnimation: to,
    fromFrame: 20, fromEndFrame: from?.endFrame,
    toEndFrame: to?.endFrame, ...extra
  });
}

test('available manual strategies are stable and distinguish three modes', () => {
  assert.deepEqual(MOTION_TRANSITION_MODES, ['auto', 'blend', 'warp']);
  assert.equal(BLEND_FRAMES, 12);
});

test('auto blends matching upper-body poses without a teleport', () => {
  const result = decide(clip(same), clip(same));
  assert.equal(result.method, 'blend');
  assert.equal(result.reason, 'similar-pose');
  assert.equal(result.similarity.count, 4);
});

test('auto uses digital transfer for dramatic arm change or unknown rigs', () => {
  assert.equal(decide(clip(same), clip(wideArms)).method, 'warp');
  assert.equal(decide(clip(same), clip({ '足': [0,0,0,1] })).method, 'warp');
  assert.equal(poseSimilarity(clip(same), clip(wideArms), 20).count, 4);
});

test('manual blend can override the pose heuristic while warp always wins if selected', () => {
  assert.equal(decide(clip(same), clip(wideArms), { mode: 'blend' }).method, 'blend');
  assert.equal(decide(clip(same), clip(same), { mode: 'warp' }).method, 'warp');
});

test('short source tail, insufficient target and finished preview use teleport', () => {
  assert.equal(decide(clip(same), clip(same), { mode: 'blend', fromFrame: 115 }).method, 'warp');
  assert.equal(decide(clip(same), clip(same, 9), { mode: 'blend' }).method, 'warp');
  assert.equal(decide(clip(same), clip(same), { mode: 'auto', isAutomaticReturn: true }).method, 'warp');
  assert.equal(decide(null, clip(same), { mode: 'blend' }).method, 'warp');
});

test('composite spans start at current outgoing pose, incoming frame 0 and converge at 12', () => {
  assert.deepEqual(blendSpanParameters(38), {
    outgoing: { start: 38, end: 50, offset: -38 },
    incoming: { start: 0, end: 12, offset: 0 },
    endFrame: 12
  });
});
