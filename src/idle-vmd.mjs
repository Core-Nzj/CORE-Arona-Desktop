// Local-first generated MMD idle animation. No third-party motion asset is bundled.
// VMD file format (version 2): 50-byte header, bone records (111 bytes),
// morph records (23 bytes), followed by empty camera/light/shadow/IK sections.
// Names are encoded as Shift-JIS using a small allow-list of standard MMD bones.
// Unsupported models safely retain their original rest pose.
const SHIFT_JIS = Object.freeze({
  '左腕': '8db69872',
  '右腕': '89459872',
  '左ひじ': '8db682d082b6',
  '右ひじ': '894582d082b6',
  '上半身': '8fe394bc9067',
  '上半身2': '8fe394bc906732',
  '首': '8ef1',
  '頭': '93aa',
  'まばたき': '82dc82ce82bd82ab',
  '左足ＩＫ': '8db691ab8268826a',
  '右足ＩＫ': '894591ab8268826a',
  '左足': '8db691ab',
  '右足': '894591ab',
  '左ひざ': '8db682d082b4',
  '右ひざ': '894582d082b4',
  '下半身': '89ba94bc9067',
  'グルーブ': '834f838b815b8375'
});
export const IDLE_FRAMES = 360; // 12 seconds at the MMD standard 30 fps
export const IDLE_ARM_ANGLE_DEGREES = 50; // Conservative angle for varied A/T-pose rigs

const TAU = Math.PI * 2;
const toRadians = degrees => degrees * Math.PI / 180;
const roundFloat = n => Math.max(-1, Math.min(1, n));

function asciiBytes(s) {
  return [...s].map(c => c.charCodeAt(0));
}

function encodeName(name, size) {
  let bytes;
  if (SHIFT_JIS[name]) {
    bytes = SHIFT_JIS[name].match(/../g).map(byte => parseInt(byte, 16));
  } else if (/^[\x20-\x7e]+$/.test(name)) {
    bytes = asciiBytes(name);
  } else {
    return null;
  }
  if (bytes.length > size) return null;
  const result = new Uint8Array(size);
  result.set(bytes);
  return result;
}

function quatForZ(angle) {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}
function quatForX(angle) {
  return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
}
function quatForY(angle) {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

function standardBoneFrames(name) {
  const frames = [];
  // Every 30 frames is one second. The first and last keys match exactly,
  // preventing visible jumps when the clip loops.
  for (let frame = 0; frame <= IDLE_FRAMES; frame += 30) {
    const phase = TAU * frame / 120; // relaxed 4-second breathing cycle
    const slowSway = Math.sin(TAU * frame / IDLE_FRAMES);

    let rotation = [0, 0, 0, 1];
    if (name === '左腕' || name === 'LeftArm') {
      // Apply a moderate down-rotation. The former 73° rotation could place
      // hands behind the hips on a model whose rest pose already slopes down.
      rotation = quatForZ(-toRadians(IDLE_ARM_ANGLE_DEGREES) + 0.012 * Math.sin(phase));
    } else if (name === '右腕' || name === 'RightArm') {
      rotation = quatForZ(toRadians(IDLE_ARM_ANGLE_DEGREES) - 0.012 * Math.sin(phase));
    } else if (name === '左ひじ' || name === 'LeftElbow') {
      rotation = quatForY(-0.018);
    } else if (name === '右ひじ' || name === 'RightElbow') {
      rotation = quatForY(0.018);
    } else if (name === '上半身' || name === 'UpperBody') {
      rotation = quatForX(0.010 + 0.012 * Math.sin(phase));
    } else if (name === '上半身2' || name === 'UpperBody2') {
      rotation = quatForX(0.009 * Math.sin(phase + 0.3));
    } else if (name === '首' || name === 'Neck') {
      rotation = quatForZ(0.012 * slowSway);
    } else if (name === '頭' || name === 'Head') {
      rotation = quatForY(0.015 * Math.sin(TAU * frame / 180));
    }

    frames.push({ name, frame, rotation, position: [0, 0, 0] });
  }
  return frames;
}

function blinkFrames(name) {
  // Closed eyes hold for two frames (about 67ms).
  // Irregular spacing: ~3.0s, 7.2s and 10.8s.
  const frames = [{ name, frame: 0, weight: 0 }];
  for (const start of [88, 214, 322]) {
    frames.push(
      { name, frame: start, weight: 0 },
      { name, frame: start + 3, weight: 1 },
      { name, frame: start + 5, weight: 1 },
      { name, frame: start + 8, weight: 0 }
    );
  }
  frames.push({ name, frame: IDLE_FRAMES, weight: 0 });
  return frames;
}

/**
 * @param {{ boneNames?: Iterable<string>, morphNames?: Iterable<string> }} names
 * @returns {ArrayBuffer} A self-contained, original idle animation in VMD v2.
 */
export function buildIdleVmd({ boneNames = [], morphNames = [] } = {}) {
  const bones = new Set(boneNames);
  const morphs = new Set(morphNames);
  const boneFrames = [];
  const morphFrames = [];

  for (const name of ['左腕', '右腕', '左ひじ', '右ひじ', '上半身', '上半身2', '首', '頭',
    'LeftArm', 'RightArm', 'LeftElbow', 'RightElbow', 'UpperBody', 'UpperBody2', 'Neck', 'Head']) {
    if (bones.has(name) && encodeName(name, 15)) {
      boneFrames.push(...standardBoneFrames(name));
    }
  }

  const blinkName = ['まばたき', 'blink', 'Blink'].find(name => morphs.has(name));
  if (blinkName) morphFrames.push(...blinkFrames(blinkName));

  return encodeGeneratedVmd(boneFrames, morphFrames);
}

// Shared VMD writer for local, original procedural animations. It never
// reads or distributes user-supplied motion data.
export function encodeGeneratedVmd(boneFrames, morphFrames = [], label = 'CORE Idle') {
  // The last four counts are camera, lighting, self-shadow and IK/property.
  const totalBytes = 50 + 4 + boneFrames.length * 111
    + 4 + morphFrames.length * 23 + 16;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  const raw = new Uint8Array(buffer);
  let pos = 0;

  function bytes(value) {
    raw.set(value, pos);
    pos += value.length;
  }
  function u32(value) {
    view.setUint32(pos, value, true);
    pos += 4;
  }
  function f32(value) {
    view.setFloat32(pos, value, true);
    pos += 4;
  }
  function fixedAscii(value, size) {
    bytes(encodeName(value, size));
  }

  fixedAscii('Vocaloid Motion Data 0002', 30);
  fixedAscii(label, 20);
  u32(boneFrames.length);
  for (const { name, frame, rotation, position } of boneFrames) {
    bytes(encodeName(name, 15));
    u32(frame);
    position.forEach(f32);
    rotation.forEach(f32);

    // Repeated, valid, linear VMD Bezier controls.
    // Four channels x/y/z/rotation, 64 total bytes.
    const interpolation = new Uint8Array(64);
    for (let repeat = 0; repeat < 4; repeat++) {
      for (let axis = 0; axis < 4; axis++) {
        interpolation[repeat * 16 + axis] = 20;
        interpolation[repeat * 16 + axis + 4] = 20;
        interpolation[repeat * 16 + axis + 8] = 107;
        interpolation[repeat * 16 + axis + 12] = 107;
      }
    }
    bytes(interpolation);
  }
  u32(morphFrames.length);
  for (const { name, frame, weight } of morphFrames) {
    bytes(encodeName(name, 15));
    u32(frame);
    f32(roundFloat(weight));
  }
  u32(0); // camera
  u32(0); // lighting
  u32(0); // self-shadow
  u32(0); // IK/property

  if (pos !== totalBytes) throw new Error('Idle animation size mismatch');
  return buffer;
}
