'use strict';
// Local-only VMD library. Never index symlinks or expose arbitrary filesystem paths
// to untrusted renderer/menu inputs.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_MOTION_BYTES = 32 * 1024 * 1024;
const MAX_MOTIONS = 1200;
const MAX_DEPTH = 12;

async function scanMotionLibrary(directory) {
  const root = await fs.realpath(directory);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('モーションフォルダではありません');
  const found = [];
  const stack = [{ absolute: root, depth: 0 }];
  while (stack.length && found.length < MAX_MOTIONS) {
    const { absolute, depth } = stack.pop();
    let items;
    try { items = await fs.readdir(absolute, { withFileTypes: true }); }
    catch (error) { if (absolute === root) throw error; continue; }
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const absoluteFile = path.join(absolute, item.name);
      if (item.isDirectory() && depth < MAX_DEPTH) {
        stack.push({ absolute: absoluteFile, depth: depth + 1 });
      } else if (item.isFile() && path.extname(item.name).toLowerCase() === '.vmd') {
        const relative = path.relative(root, absoluteFile).split(path.sep).join('/');
        if (relative && found.length < MAX_MOTIONS) {
          found.push({ id: relative, name: item.name, group: path.posix.dirname(relative) === '.'
            ? '' : path.posix.dirname(relative) });
        }
      }
      if (found.length >= MAX_MOTIONS) break;
    }
  }
  found.sort((a, b) => a.id.localeCompare(b.id, 'ja', { numeric: true }));
  return { root, entries: found, capped: found.length >= MAX_MOTIONS };
}

async function readMotionFile(rootDirectory, id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 1024 ||
      id.includes('\\') || id.includes(String.fromCharCode(0)) || id.startsWith('/') ||
      id.split('/').some(part => !part || part === '.' || part === '..') ||
      path.posix.extname(id).toLowerCase() !== '.vmd') {
    throw new Error('不正なモーション識別子です');
  }
  const root = await fs.realpath(rootDirectory);
  const candidate = path.resolve(root, ...id.split('/'));
  if (!candidate.startsWith(root + path.sep)) throw new Error('許可されていないファイルです');
  const actual = await fs.realpath(candidate);
  if (!actual.startsWith(root + path.sep)) throw new Error('フォルダ外のファイルです');
  const stat = await fs.stat(actual);
  if (!stat.isFile() || stat.size < 54 || stat.size > MAX_MOTION_BYTES) {
    throw new Error('VMDは54バイト以上、32MiB以下にしてください');
  }
  const data = await fs.readFile(actual);
  if (!data.subarray(0, 30).toString('ascii').startsWith('Vocaloid Motion Data')) {
    throw new Error('VMD形式を確認できません');
  }
  return { name: path.basename(actual), bytes: new Uint8Array(data) };
}

module.exports = { scanMotionLibrary, readMotionFile, MAX_MOTIONS };
