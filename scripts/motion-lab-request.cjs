'use strict';

// Request a capture from a running development FRAME. No clicks, browser
// automation, network server, model uploads, or elevated Windows permissions.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { requestDirectory, requestName, resultName } =
  require('../electron/motion-lab-control.cjs');

async function main() {
  const root = path.resolve(__dirname, '..', 'motion-lab');
  const folder = requestDirectory(root);
  const id = randomUUID();
  await fs.mkdir(folder, { recursive: true });
  const request = path.join(folder, requestName(id));
  const result = path.join(folder, resultName(id));
  await fs.writeFile(request, JSON.stringify({
    id, type: 'capture-walk', createdAt: new Date().toISOString()
  }), { flag: 'wx' });
  console.log('[FRAME Motion Lab] 撮影を依頼しました。起動中の開発版FRAMEで処理します。');
  console.log('[FRAME Motion Lab] 実行されない場合は、FRAMEを起動してMMDモデルを読み込んでください。');

  const until = Date.now() + 150000;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 750));
    let data;
    try {
      data = JSON.parse(await fs.readFile(result, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (data.id !== id) throw new Error('Motion Lab result ID mismatch');
    if (!data.ok) throw new Error(data.message || '歩行撮影が失敗しました');
    console.log('[FRAME Motion Lab] 撮影完了！');
    console.log('ギャラリー: ' + path.join(data.directory, 'index.html'));
    console.log('診断情報: ' + path.join(data.directory, 'manifest.json'));
    console.log('AIレビュー手順: ' + path.join(data.directory, 'REVIEW_GUIDE.md'));
    console.log('最新ギャラリー: ' + path.join(root, 'latest.html'));
    return;
  }
  throw new Error('FRAMEから撮影完了の応答がありません（150秒）。診断画面かログを確認してください');
}

main().catch(error => {
  console.error('[FRAME Motion Lab] ' + error.message);
  process.exitCode = 1;
});
