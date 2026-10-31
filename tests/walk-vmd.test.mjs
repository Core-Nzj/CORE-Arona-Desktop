import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALK_FRAMES, WALK_STANCE, WALK_SECONDS, WALK_STRIDE_HEIGHT_RATIO,
  walkFootAt, walkTravelSpeed, resolveWalkBones, buildWalkingVmd
} from '../src/walk-vmd.mjs';

const bones = [
  '左足ＩＫ', '右足ＩＫ', '左腕', '右腕', '左ひじ', '右ひじ',
  '上半身', '下半身', '首', 'グルーブ'
];

function extractVmd(buffer) {
  const view = new DataView(buffer);
  let cursor = 50;
  const count = view.getUint32(cursor, true); cursor += 4;
  const decoder = new TextDecoder('shift_jis');
  const samples = [];
  for (let i=0;i<count;i++) {
    const name = decoder.decode(new Uint8Array(buffer, cursor, 15)).replace(/\0+$/, '');
    const frame = view.getUint32(cursor+15, true);
    const pos = [0,1,2].map(k=>view.getFloat32(cursor+19+4*k, true));
    const quat = [0,1,2,3].map(k=>view.getFloat32(cursor+31+4*k, true));
    samples.push({name,frame,pos,quat});
    cursor+=111;
  }
  const morphs=view.getUint32(cursor,true);cursor+=4;
  assert.equal(morphs,0);
  assert.equal(cursor+16,buffer.byteLength);
  return samples;
}

test('both standard Japanese and English foot IK rigs are recognized', () => {
  const actual = resolveWalkBones(bones);
  assert.equal(actual.leftIK, '左足ＩＫ');
  assert.equal(actual.rightIK, '右足ＩＫ');
  assert.equal(resolveWalkBones(['LeftLegIK','RightLegIK']).leftIK, 'LeftLegIK');
  assert.equal(resolveWalkBones(['左足IK','右足IK']).rightIK, '右足IK');
});

test('procedural walk rejects PMX models without both legs IK', () => {
  assert.throws(() => buildWalkingVmd({boneNames:['左腕'],direction:1}), /左右の足IK/);
  assert.throws(() => buildWalkingVmd({boneNames:['左足ＩＫ'],direction:1}), /左右の足IK/);
});

test('walk VMD contains only matching bones and is a seamless loop', () => {
  const {buffer, stride, frames} = buildWalkingVmd({boneNames:bones,modelHeight:15,direction:1});
  assert.equal(frames, WALK_FRAMES);
  assert.ok(Math.abs(stride-15*WALK_STRIDE_HEIGHT_RATIO)<1e-8);
  const samples = extractVmd(buffer);
  assert.equal(samples.length, bones.length * (WALK_FRAMES/2 + 1));
  for (const bone of bones) {
    const frames = samples.filter(s=>s.name===bone);
    assert.equal(frames.length, WALK_FRAMES/2+1);
    assert.equal(frames[0].frame,0);
    assert.equal(frames.at(-1).frame,WALK_FRAMES);
    for (let k=0;k<3;k++) assert.ok(Math.abs(frames[0].pos[k] - frames.at(-1).pos[k]) < 1e-5);
    for (let k=0;k<4;k++) assert.ok(Math.abs(frames[0].quat[k] - frames.at(-1).quat[k]) < 1e-5);
    assert.ok(frames.every(s=>s.quat.every(Number.isFinite)));
  }
});

test('walking chest and hips face the direction of travel while head stays slightly open', () => {
  const yawDegrees = q => 2 * Math.atan2(q[1], q[3]) * 180 / Math.PI;
  for (const direction of [-1, 1]) {
    const { buffer } = buildWalkingVmd({ boneNames: bones, modelHeight: 15, direction });
    const samples = extractVmd(buffer);
    const atStart = name => samples.find(sample => sample.name === name && sample.frame === 0);
    const chestYaw = yawDegrees(atStart('上半身').quat);
    const hipYaw = yawDegrees(atStart('下半身').quat);
    const neckYaw = yawDegrees(atStart('首').quat);
    assert.ok(Math.abs(chestYaw + direction * 78) < 0.2, 'chest should nearly face sideways');
    assert.ok(Math.abs(hipYaw + direction * 55) < 0.2, 'hips preserve existing gait orientation');
    assert.ok(Math.abs(neckYaw - direction * 8) < 0.2, 'head remains slightly turned toward camera');
    assert.ok(chestYaw * hipYaw > 0, 'torso and hips must face the same travel direction');
  }
});

test('planted foot opposes window travel at constant rate', () => {
  const stride=2.4;
  const delta=0.07;
  const a=walkFootAt(.2,stride,0.6,1);
  const b=walkFootAt(.2+delta,stride,0.6,1);
  assert.equal(a.planted,true);
  assert.equal(b.planted,true);
  assert.ok(Math.abs((b.x-a.x) + stride*delta/WALK_STANCE) < 1e-10);
  assert.equal(a.y,0);
  assert.equal(b.y,0);
  assert.ok(Math.abs(walkTravelSpeed(stride,100)*WALK_SECONDS*WALK_STANCE-stride*100) < 1e-9);
});

test('swing foot lifts and returns to its first position without discontinuity', () => {
  const stride=2, lift=.35;
  const middle=walkFootAt((WALK_STANCE+1)/2,stride,lift,-1);
  assert.equal(middle.planted,false);
  assert.ok(Math.abs(middle.y-lift)<1e-10);
  const first=walkFootAt(0,stride,lift,-1), last=walkFootAt(1,stride,lift,-1);
  assert.deepEqual(first,last);
  assert.ok(walkFootAt(.75,stride,lift,1).y>0);
});
