'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanMotionLibrary, readMotionFile } = require('../electron/motion-library.cjs');

function sampleVmd() {
  const bytes = Buffer.alloc(70);
  bytes.write('Vocaloid Motion Data 0002', 0, 'ascii');
  return bytes;
}

test('recursively lists only local VMD entries in Japanese subfolders', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-motion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'Otoka', 'エモート'), { recursive: true });
  await fs.writeFile(path.join(root, 'Otoka', 'エモート', '待機_右手腰あて.vmd'), sampleVmd());
  await fs.writeFile(path.join(root, 'Otoka', 'notes.txt'), 'not an animation');
  const result = await scanMotionLibrary(root);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], {
    id: 'Otoka/エモート/待機_右手腰あて.vmd',
    name: '待機_右手腰あて.vmd',
    group: 'Otoka/エモート'
  });
  const opened = await readMotionFile(root, result.entries[0].id);
  assert.equal(opened.bytes.length, 70);
});

test('rejects traversal, malformed VMD and oversized paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-motion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'bad.vmd'), Buffer.alloc(70));
  await assert.rejects(() => readMotionFile(root, '../outside.vmd'));
  await assert.rejects(() => readMotionFile(root, '..\\outside.vmd'));
  await assert.rejects(() => readMotionFile(root, 'bad.vmd'), /VMD形式/);
});

test('does not follow symbolic links outside the motion library', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-motion-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'library');
  await fs.mkdir(root);
  await fs.writeFile(path.join(base, 'outside.vmd'), sampleVmd());
  try {
    await fs.symlink(path.join(base, 'outside.vmd'), path.join(root, 'linked.vmd'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  assert.equal((await scanMotionLibrary(root)).entries.length, 0);
  await assert.rejects(() => readMotionFile(root, 'linked.vmd'), /フォルダ外/);
});
