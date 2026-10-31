// FRAME's first self-contained procedural locomotion study.
// The in-place stance is phase-locked to Electron's horizontal window travel:
// planted IK feet move backwards at a constant speed while the body travels
// forwards. No 3rd-party VMD, avatar, C++ binary, or physics asset is bundled.
import { encodeGeneratedVmd } from './idle-vmd.mjs';

export const WALK_FRAMES = 36; // 1.2 seconds, two footsteps at 30 fps
export const WALK_STANCE = 0.62;
export const WALK_STRIDE_HEIGHT_RATIO = 0.095;
export const WALK_SECONDS = WALK_FRAMES / 30;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const id = [0, 0, 0, 1];
const QX = a => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const QY = a => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const QZ = a => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
function quaternionMultiply(a,b) {
  return [
    a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
    a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
    a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
    a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]
  ];
}
const smooth = t => t * t * (3 - 2*t);
const fractional = x => x - Math.floor(x);

export function walkFootAt(phase, stride, lift, direction = 1) {
  const p = fractional(phase);
  if (p < WALK_STANCE) {
    return { x: direction * stride * (0.5 - p / WALK_STANCE), y: 0, planted: true };
  }
  const swing = (p - WALK_STANCE) / (1 - WALK_STANCE);
  return {
    x: direction * stride * (-0.5 + smooth(swing)),
    y: lift * Math.sin(Math.PI * swing),
    planted: false
  };
}

export function walkTravelSpeed(stride, pixelsPerUnit) {
  return stride * pixelsPerUnit / (WALK_SECONDS * WALK_STANCE);
}

const candidates = Object.freeze({
  leftIK: ['左足ＩＫ', '左足IK', 'LeftLegIK', 'LeftFootIK'],
  rightIK: ['右足ＩＫ', '右足IK', 'RightLegIK', 'RightFootIK'],
  leftArm: ['左腕', 'LeftArm'],
  rightArm: ['右腕', 'RightArm'],
  leftElbow: ['左ひじ', 'LeftElbow'],
  rightElbow: ['右ひじ', 'RightElbow'],
  hip: ['下半身', 'LowerBody'],
  upper: ['上半身', 'UpperBody'],
  neck: ['首', 'Neck'],
  groove: ['グルーブ', 'Groove']
});
export function resolveWalkBones(boneNames) {
  const names = new Set(boneNames);
  return Object.fromEntries(Object.entries(candidates).map(([role, choices]) =>
    [role, choices.find(name => names.has(name)) ?? null]));
}

export function buildWalkingVmd({ boneNames = [], modelHeight = 10, direction = 1 } = {}) {
  const bones = resolveWalkBones(boneNames);
  if (!bones.leftIK || !bones.rightIK) {
    throw new Error('歩行には左右の足IKボーンが必要です（PMXの足IKを確認してください）');
  }
  const sign = direction === -1 ? -1 : 1;
  const height = Math.max(0.3, Math.min(1000, modelHeight));
  const stride = height * WALK_STRIDE_HEIGHT_RATIO;
  const lift = height * 0.025;
  const frames = [];
  function key(role, frame, rotation = id, position = [0,0,0]) {
    if (bones[role]) frames.push({ name: bones[role], frame, rotation, position });
  }

  // Keys at frame 0 and 36 match; the native window is advanced at the exact
  // stance speed so the planted foot remains approximately fixed in space.
  for (let frame = 0; frame <= WALK_FRAMES; frame += 2) {
    const phase = frame / WALK_FRAMES;
    const left = walkFootAt(phase, stride, lift, sign);
    const right = walkFootAt(phase + 0.5, stride, lift, sign);
    key('leftIK', frame, id, [left.x, left.y, 0]);
    key('rightIK', frame, id, [right.x, right.y, 0]);

    const cycle = Math.sin(TAU * phase);
    const doubleStep = Math.cos(2 * TAU * phase);
    // Turn toward travel while keeping the torso and face partly readable.
    key('hip', frame, quaternionMultiply(QY(-sign * 55 * DEG), QZ(1.8 * DEG * cycle)));
    key('upper', frame, quaternionMultiply(QY(sign * 12 * DEG), QZ(-2.5 * DEG * cycle)));
    key('neck', frame, QY(sign * 8 * DEG));
    key('groove', frame, id, [0, height * 0.004 * (1 - doubleStep), 0]);

    // Arms swing opposite the feet. Keep the safe lowered-arm bias from the
    // existing idle motion so hands are less likely to cut through clothing.
    key('leftArm', frame, quaternionMultiply(QX(-sign * 13 * DEG * cycle), QZ(-50 * DEG)));
    key('rightArm', frame, quaternionMultiply(QX(sign * 13 * DEG * cycle), QZ(50 * DEG)));
    key('leftElbow', frame, QX(-7 * DEG - 3 * DEG * cycle));
    key('rightElbow', frame, QX(-7 * DEG + 3 * DEG * cycle));
  }
  return { buffer: encodeGeneratedVmd(frames, [], 'FRAME Walk'), stride, frames: WALK_FRAMES, rig: bones };
}
