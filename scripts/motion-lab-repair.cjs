'use strict';

// Recovers a previous Motion Lab session whose PNGs and manifest were saved
// but HTML generation failed. Never reads model assets or other app windows.
const fs = require('node:fs/promises');
const path = require('node:path');
const { completeMotionLab, IMAGE_NAME } = require('../electron/motion-lab.cjs');

async function main() {
  const root = path.resolve(__dirname, '..', 'motion-lab');
  const runs = path.join(root, 'runs');
  const folders = (await fs.readdir(runs, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
  let seenBroken = false;
  for (const name of folders) {
    const directory = path.join(runs, name);
    try {
      await fs.access(path.join(directory, 'index.html'));
      continue; // Never overwrite a successful review.
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    seenBroken = true;
    if (!Array.isArray(meta.files) || meta.files.length !== 60 ||
        new Set(meta.files.map(file => file.filename)).size !== 60 ||
        !meta.files.every(file => IMAGE_NAME.test(file.filename))) {
      throw new Error('撮影データが不完全です。54枚＋比較画像6枚が必要です: ' + directory);
    }
    await Promise.all(meta.files.map(file =>
      fs.access(path.join(directory, file.filename))));
    await completeMotionLab({ root, directory, entries: meta.files }, meta);
    console.log('[FRAME Motion Lab] 既存画像からギャラリーを復旧しました');
    console.log('画像一覧: ' + path.join(directory, 'index.html'));
    console.log('診断情報: ' + path.join(directory, 'manifest.json'));
    console.log('レビュー手順: ' + path.join(directory, 'REVIEW_GUIDE.md'));
    return;
  }
  if (!seenBroken) throw new Error('復旧対象がありません。必要なら npm run motion:lab:request で新規撮影してください');
}

main().catch(error => {
  console.error('[FRAME Motion Lab] 復旧失敗: ' + String(error?.message ?? error));
  process.exitCode = 1;
});
