'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  motionLabRoot, beginMotionLab, writeMotionLabImage, completeMotionLab,
  galleryHtml, IMAGE_NAME, pruneMotionLabRuns, MOTION_LAB_KEEP_RUNS
} = require('../electron/motion-lab.cjs');

const tinyPng = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/4uMAAAAASUVORK5CYII=';

test('capture plan includes both directions, exact phase offsets and three views', async () => {
  const { LAB_FRAMES, LAB_DIRECTIONS, LAB_VIEWS, labCameraAlpha,
    labFileName, labSheetName } = await import('../src/motion-lab.mjs');
  assert.deepEqual(LAB_FRAMES, [0,4,8,12,16,20,24,28,32]);
  assert.deepEqual(LAB_DIRECTIONS, [-1,1]);
  assert.deepEqual(LAB_VIEWS, ['front','three-quarter','side']);
  assert.equal(labFileName(-1, 'front', 0), 'walk-left-front-f00.png');
  assert.equal(labFileName(1, 'three-quarter', 28), 'walk-right-three-quarter-f28.png');
  assert.equal(labSheetName(1, 'side'), 'sheet-right-side.png');
  assert.equal(labCameraAlpha('front',1),labCameraAlpha('front',-1));
  assert.notEqual(labCameraAlpha('side',1),labCameraAlpha('side',-1));
  assert.throws(() => labFileName(1,'side',999));
  assert.throws(() => labCameraAlpha('oblique',1));
});

test('camera framing enlarges small silhouettes without clipping the widest angle', async () => {
  const { labZoomForBounds, LAB_MAX_ZOOM, LAB_TARGET_HEIGHT_SHARE } =
    await import('../src/motion-lab.mjs');
  assert.equal(LAB_TARGET_HEIGHT_SHARE, 0.74);
  const smallModel = [
    {width: 80, height: 230},
    {width: 64, height: 220},
    {width: 75, height: 225}
  ];
  const zoom = labZoomForBounds(smallModel, 476, 720);
  assert.ok(zoom > 2 && zoom < 2.5,
    'Small avatar should fill most of the picture instead of remaining tiny');
  assert.equal(labZoomForBounds([{width:400,height:500}],476,720),1);
  assert.equal(labZoomForBounds([{width:5,height:5}],476,720),LAB_MAX_ZOOM);
  assert.equal(labZoomForBounds([],476,720),1);
  assert.equal(labZoomForBounds([{width:NaN,height:100}],476,720),1);
  assert.equal(labZoomForBounds([{width:20,height:100}],0,720),1);
  // A wide pose must limit zoom before any body part reaches the image edge.
  assert.ok(labZoomForBounds([{width:450,height:100}],476,720) <= 1);
});

test('output directory is inside the checkout in development but writable when packaged', () => {
  assert.equal(motionLabRoot('/code/frame','/user/frame',false),path.join('/code/frame','motion-lab'));
  assert.equal(motionLabRoot('/code/frame','/user/frame',true),path.join('/user/frame','motion-lab'));
});

test('local gallery escapes untrusted model names and links valid images', () => {
  const gallery = galleryHtml({modelName:'<script>alert("x")</script>'},[
    {filename:'sheet-left-front.png'},
    {filename:'walk-left-front-f00.png',frame:0}
  ]);
  assert.ok(gallery.includes('&lt;script&gt;'));
  assert.ok(!gallery.includes('<script>'));
  assert.ok(gallery.includes('sheet-left-front.png'));
  assert.ok(gallery.includes('walk-left-front-f00.png'));
  assert.ok(gallery.includes('<section>'));
  assert.ok(!gallery.includes('undefined'));
  assert.ok(gallery.includes('manifest.json'));
  assert.ok(gallery.includes('neutral gray'));
  assert.ok(gallery.includes('ground line'));
});

test('save accepts only bounded PNGs and persists local JSON/gallery/latest files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'frame-motion-lab-'));
  t.after(async () => fs.rm(root,{recursive:true,force:true}));
  const session = await beginMotionLab(root);
  assert.equal(IMAGE_NAME.test('../avatar.png'),false);
  assert.equal(IMAGE_NAME.test('walk-left-front-f00.png'),true);
  assert.equal(IMAGE_NAME.test('walk-left-front-f31.png'),false);
  assert.equal(IMAGE_NAME.test('sheet-right-side.png'),true);
  await assert.rejects(writeMotionLabImage(session,'../traversal.png',tinyPng));
  await assert.rejects(writeMotionLabImage(session,'walk-left-front-f00.png','data:text/plain;base64,SGk='));
  const written = await writeMotionLabImage(session,'walk-left-front-f00.png',tinyPng,
    {frame:0,view:'front',direction:-1,leftFoot:{x:1,y:0,planted:true}});
  assert.equal(written.files,1);
  await assert.rejects(writeMotionLabImage(session,'walk-left-front-f00.png',tinyPng));
  await writeMotionLabImage(session,'sheet-left-front.png',tinyPng,{view:'front',direction:-1});
  const dest = await completeMotionLab(session,{
    modelName:'private-sample.pmx',modelHeight:15,stride:1.2,
    captureProfile:{background:'#969AA4', cameraFov:0.7, cameraRadius:4.5,
      framingZoom:2.4, targetHeightShare:0.74, imageMaxWidth:960,
      imageMaxHeight:1440, fixedCameraBeta:Math.PI / 2,
      groundReference:'visible silhouette bottom at F00'},
    bones:{leftIK:'左足ＩＫ'}
  });
  const manifest = JSON.parse(await fs.readFile(path.join(dest,'manifest.json'),'utf8'));
  assert.equal(manifest.files.length,2);
  assert.equal(manifest.files[0].leftFoot.planted,true);
  assert.equal(manifest.modelName,'private-sample.pmx');
  assert.equal(manifest.captureProfile.background, '#969AA4');
  assert.equal(manifest.captureProfile.cameraFov, 0.7);
  assert.equal(manifest.captureProfile.cameraRadius, 4.5);
  assert.equal(manifest.captureProfile.framingZoom, 2.4);
  assert.equal(manifest.captureProfile.imageMaxHeight, 1440);
  assert.ok(manifest.captureProfile.groundReference.includes('silhouette'));
  assert.ok((await fs.readFile(path.join(dest,'REVIEW_GUIDE.md'),'utf8')).includes('VISUAL BASELINE'));
  assert.ok((await fs.readFile(path.join(dest,'index.html'),'utf8')).includes('sheet-left-front.png'));
  assert.ok((await fs.readFile(path.join(root,'latest.html'),'utf8')).includes('index.html'));
  const latest = JSON.parse(await fs.readFile(path.join(root,'latest.json'),'utf8'));
  assert.ok(latest.gallery.startsWith('runs/'));
});


async function fakeCompletedRun(root, runName, { extraFile = false, complete = true } = {}) {
  const dir = path.join(root, 'runs', runName);
  await fs.mkdir(dir, { recursive: true });
  const images = [];
  for (const dirName of ['left', 'right']) {
    for (const angle of ['front', 'three-quarter', 'side']) {
      images.push('sheet-' + dirName + '-' + angle + '.png');
      for (const frame of [0, 4, 8, 12, 16, 20, 24, 28, 32]) {
        images.push('walk-' + dirName + '-' + angle + '-f' +
          String(frame).padStart(2, '0') + '.png');
      }
    }
  }
  const files = images.map(filename => ({ filename }));
  for (const filename of images) await fs.writeFile(path.join(dir, filename), 'test');
  await fs.writeFile(path.join(dir, 'manifest.json'),
    JSON.stringify({ version: 1, motion: 'generated-walk', files }));
  await fs.writeFile(path.join(dir, 'REVIEW_GUIDE.md'), 'review');
  if (complete) await fs.writeFile(path.join(dir, 'index.html'), 'gallery');
  if (extraFile) await fs.writeFile(path.join(dir, 'personal-notes.txt'), 'KEEP');
  return dir;
}

test('retention keeps three newest complete reviews and does not remove unfinished or custom folders', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-motion-lab-retention-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  assert.equal(MOTION_LAB_KEEP_RUNS, 3);
  const names = [
    '2026-10-31T06-00-00-000Z-aaaaaaaa',
    '2026-10-31T06-01-00-000Z-bbbbbbbb',
    '2026-10-31T06-02-00-000Z-cccccccc',
    '2026-10-31T06-03-00-000Z-dddddddd',
    '2026-10-31T06-04-00-000Z-eeeeeeee'
  ];
  for (const name of names) await fakeCompletedRun(root, name);
  const unfinished = await fakeCompletedRun(root,
    '2026-10-31T05-59-00-000Z-ffffffff', { complete: false });
  const withNotes = await fakeCompletedRun(root,
    '2026-10-31T05-58-00-000Z-99999999', { extraFile: true });
  const unrelated = await fakeCompletedRun(root, 'my-saved-reference');
  await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({
    folder: 'runs/' + names[4]
  }));
  const gone = await pruneMotionLabRuns(root);
  assert.deepEqual(gone, [names[1], names[0]]);
  for (const name of names.slice(2)) await fs.access(path.join(root, 'runs', name));
  for (const name of names.slice(0, 2)) {
    await assert.rejects(fs.access(path.join(root, 'runs', name)), { code: 'ENOENT' });
  }
  await fs.access(unfinished);
  await fs.access(path.join(withNotes, 'personal-notes.txt'));
  await fs.access(unrelated);
  assert.deepEqual(await pruneMotionLabRuns(root), []);
});

test('retention never removes latest or explicitly protected captures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-motion-lab-guard-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const names = Array.from({ length: 4 }, (_, i) =>
    '2026-10-31T06-0' + i + '-00-000Z-' + String(i).repeat(8));
  for (const name of names) await fakeCompletedRun(root, name);
  await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({
    folder: 'runs/' + names[0]
  }));
  const gone = await pruneMotionLabRuns(root, {
    protectedRun: path.join(root, 'runs', names[0])
  });
  assert.deepEqual(gone, []);
  for (const name of names) await fs.access(path.join(root, 'runs', name));
  await assert.rejects(pruneMotionLabRuns(root, { keep: 0 }));
});

test('retention skips symlinked folders rather than following them', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-motion-lab-links-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-motion-lab-outside-'));
  t.after(async () => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'runs'));
  const link = path.join(root, 'runs', '2026-10-31T01-00-00-000Z-abcdef12');
  try { await fs.symlink(outside, link, 'dir'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return;
    throw error;
  }
  assert.deepEqual(await pruneMotionLabRuns(root), []);
  await fs.access(outside);
  assert.ok((await fs.lstat(link)).isSymbolicLink());
});
