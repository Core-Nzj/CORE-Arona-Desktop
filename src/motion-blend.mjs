// Conservative transition routing for local MMD clips. "auto" chooses
// blending only when the key poses are demonstrably close. Ambiguous pairs
// keep FRAME's proven digital teleport rather than guessing an arm trajectory.
export const MOTION_TRANSITION_MODES = Object.freeze(['auto', 'blend', 'warp']);
export const BLEND_FRAMES = 12; // 0.4 sec at MMD 30fps

const IMPORTANT_BONES = new Set([
  '上半身', '上半身2', '下半身', '首', '頭',
  '左腕', '右腕', '左ひじ', '右ひじ',
  'UpperBody', 'UpperBody2', 'LowerBody', 'Neck', 'Head',
  'LeftArm', 'RightArm', 'LeftElbow', 'RightElbow'
]);

function tracksByBone(animation) {
  const tracks = new Map();
  if (!animation) return tracks;
  for (const track of [...(animation.boneTracks || []), ...(animation.movableBoneTracks || [])]) {
    if (IMPORTANT_BONES.has(track.name) && track.frameNumbers?.length && track.rotations?.length) {
      tracks.set(track.name, track);
    }
  }
  return tracks;
}

function rotationAt(track, frame) {
  const keys = track.frameNumbers;
  if (!keys?.length || keys[0] > frame) return null;
  let low = 0, high = keys.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (keys[mid] <= frame) low = mid + 1;
    else high = mid;
  }
  const p = (low - 1) * 4;
  return track.rotations.subarray(p, p + 4);
}

function angleBetween(a, b) {
  const dot = Math.abs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]);
  return 2 * Math.acos(Math.min(1, Math.max(0, dot)));
}

export function poseSimilarity(fromAnimation, toAnimation, fromFrame, toFrame = 0) {
  const from = tracksByBone(fromAnimation);
  const to = tracksByBone(toAnimation);
  let sum = 0, max = 0, count = 0;
  for (const [name, track] of from) {
    const other = to.get(name);
    if (!other) continue;
    const a = rotationAt(track, fromFrame), b = rotationAt(other, toFrame);
    if (!a || !b) continue;
    const angle = angleBetween(a, b);
    if (!Number.isFinite(angle)) continue;
    sum += angle;
    max = Math.max(max, angle);
    count++;
  }
  return { count, mean: count ? sum / count : Infinity, max };
}

export function chooseMotionTransition({
  mode = 'auto', fromAnimation, toAnimation, fromFrame, fromEndFrame,
  toEndFrame, blendFrames = BLEND_FRAMES, isAutomaticReturn = false
}) {
  if (mode === 'warp') return { method: 'warp', reason: 'manual' };
  // MMD's runtime clamps each track to its first/last key. A one-frame pose
  // therefore remains valid across a 12-frame crossfade without extrapolating
  // an uncontrolled bone trajectory.
  if (!fromAnimation || !toAnimation ||
      !Number.isFinite(fromFrame) || fromFrame < 0 ||
      !Number.isFinite(fromEndFrame) || fromEndFrame < 0 ||
      !Number.isFinite(toEndFrame) || toEndFrame < 0 ||
      !Number.isFinite(blendFrames) || blendFrames < 1) {
    return { method: 'warp', reason: 'missing-animation' };
  }
  // Let a finished preview visibly return to idle instead of trying to
  // blend from the very last frame while the runtime is already looping.
  if (isAutomaticReturn) return { method: 'warp', reason: 'clip-finished' };
  if (mode === 'blend') return { method: 'blend', reason: 'manual' };
  const similarity = poseSimilarity(fromAnimation, toAnimation, fromFrame, 0);
  return similarity.count >= 3 && similarity.mean < 0.27 && similarity.max < 0.52
    ? { method: 'blend', reason: 'similar-pose', similarity }
    : { method: 'warp', reason: 'distant-or-unknown-pose', similarity };
}

// Composite spans play from current source time and new target time zero.
// When the blend ends, the new clip has advanced blendFrames (not 0).
export function blendSpanParameters(fromFrame, blendFrames = BLEND_FRAMES) {
  return {
    outgoing: { start: fromFrame, end: fromFrame + blendFrames, offset: -fromFrame },
    incoming: { start: 0, end: blendFrames, offset: 0 },
    endFrame: blendFrames
  };
}
