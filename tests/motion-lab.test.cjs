'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  motionLabRoot, beginMotionLab, writeMotionLabImage, completeMotionLab,
  galleryHtml, IMAGE_NAME
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
    captureProfile:{background:'#969AA4', cameraFov:0.7, fixedCameraBeta:Math.PI / 2,
      groundReference:'projected initial model bounds minimum Y'},
    bones:{leftIK:'左足ＩＫ'}
  });
  const manifest = JSON.parse(await fs.readFile(path.join(dest,'manifest.json'),'utf8'));
  assert.equal(manifest.files.length,2);
  assert.equal(manifest.files[0].leftFoot.planted,true);
  assert.equal(manifest.modelName,'private-sample.pmx');
  assert.equal(manifest.captureProfile.background, '#969AA4');
  assert.equal(manifest.captureProfile.cameraFov, 0.7);
  assert.ok(manifest.captureProfile.groundReference.includes('initial'));
  assert.ok((await fs.readFile(path.join(dest,'REVIEW_GUIDE.md'),'utf8')).includes('GROUND REF'));
  assert.ok((await fs.readFile(path.join(dest,'index.html'),'utf8')).includes('sheet-left-front.png'));
  assert.ok((await fs.readFile(path.join(root,'latest.html'),'utf8')).includes('index.html'));
  const latest = JSON.parse(await fs.readFile(path.join(root,'latest.json'),'utf8'));
  assert.ok(latest.gallery.startsWith('runs/'));
});
