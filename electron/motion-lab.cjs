'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_SESSION_BYTES = 120 * 1024 * 1024;
const MAX_IMAGES = 64;
const IMAGE_NAME = /^(walk-(left|right)-(front|three-quarter|side)-f(00|04|08|12|16|20|24|28|32)|sheet-(left|right)-(front|three-quarter|side))\.png$/;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const cleanText = value => String(value ?? '').slice(0, 240);
const escapeHtml = value => cleanText(value).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function motionLabRoot(appPath, userDataPath, isPackaged) {
  // In development, put captures next to the checked-out source for VSCode
  // agents. A packaged app must never write into an asar/install directory.
  return path.join(isPackaged ? userDataPath : appPath, 'motion-lab');
}

async function beginMotionLab(root) {
  const stamp = new Date().toISOString().replace(/[.:]/g, '-');
  const id = randomUUID();
  const directory = path.join(root, 'runs', stamp + '-' + id.slice(0, 8));
  await fs.mkdir(directory, { recursive: true });
  return { id, root, directory, names: new Set(), bytes: 0, entries: [] };
}

async function writeMotionLabImage(session, filename, dataUrl, info = {}) {
  if (!session || !IMAGE_NAME.test(filename) || session.names.has(filename) ||
      session.names.size >= MAX_IMAGES) throw new Error('Invalid or duplicate motion lab image');
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) ||
      dataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) {
    throw new Error('Motion lab capture is not a bounded PNG');
  }
  const base64 = dataUrl.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Invalid PNG encoding');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      session.bytes + bytes.length > MAX_SESSION_BYTES) throw new Error('Invalid or oversized PNG');
  await fs.writeFile(path.join(session.directory, filename), bytes, { flag: 'wx' });
  session.bytes += bytes.length;
  session.names.add(filename);
  const cleanInfo = {
    filename,
    ...(Number.isInteger(info.frame) ? { frame: info.frame } : {}),
    ...(typeof info.view === 'string' ? { view: info.view.slice(0, 32) } : {}),
    ...(info.direction === -1 || info.direction === 1 ? { direction: info.direction } : {}),
    ...(info.leftFoot && typeof info.leftFoot === 'object'
      ? { leftFoot: cleanFoot(info.leftFoot) } : {}),
    ...(info.rightFoot && typeof info.rightFoot === 'object'
      ? { rightFoot: cleanFoot(info.rightFoot) } : {})
  };
  session.entries.push(cleanInfo);
  return { files: session.names.size, bytes: session.bytes };
}

function cleanFoot(foot) {
  const number = n => Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
  return { x: number(foot.x), y: number(foot.y), planted: foot.planted === true };
}

function galleryHtml(meta, entries) {
  const sheets = entries.filter(x => x.filename.startsWith('sheet-'));
  const individual = entries.filter(x => x.filename.startsWith('walk-'));
  const group = sheets.map(sheet => {
    const key = sheet.filename.replace(/^sheet-/, '').replace(/\.png$/, '');
    const matching = individual.filter(entry => entry.filename.startsWith('walk-' + key + '-'));
    return '<section><h2>' + escapeHtml(key.replaceAll('-', ' ')) + '</h2>' +
      '<a href="' + sheet.filename + '"><img class="sheet" src="' + sheet.filename +
      '" alt="Gait contact sheet"></a><div class="frames">' +
      matching.map(entry => '<a href="' + entry.filename + '" title="Frame ' + entry.frame +
        '"><img loading="lazy" src="' + entry.filename + '" alt="Frame ' + entry.frame +
        '"><span>F' + String(entry.frame).padStart(2,'0') + '</span></a>').join('') +
      '</div></section>';
  }).join('\n');
  const label = escapeHtml(meta.modelName || 'Local MMD model');
  return '<!doctype html><html lang="ja"><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>FRAME / Motion Lab</title><style>' +
    '*{box-sizing:border-box}body{margin:0;background:#14161d;color:#f5f5f7;font-family:Segoe UI,Arial,sans-serif}' +
    'main{max-width:1250px;margin:auto;padding:24px}h1{font-size:22px;margin:0 0 8px}' +
    'h2{font-size:16px;text-transform:uppercase;letter-spacing:.06em;color:#a9d9ff}' +
    'p{color:#a2a8b4;line-height:1.6}a{color:#8ac7ff}section{padding:18px;margin:20px 0;' +
    'background:#20232d;border:1px solid #353a46;border-radius:14px}.sheet{width:min(100%,900px);' +
    'border:1px solid #393e48;border-radius:8px}.frames{display:grid;grid-template-columns:' +
    'repeat(auto-fill,minmax(105px,1fr));gap:8px;margin-top:16px}.frames a{display:flex;flex-direction:column;' +
    'font-size:12px;text-decoration:none;background:#303541;border-radius:8px;overflow:hidden}' +
    '.frames img{width:100%;aspect-ratio:2/3;object-fit:contain}.frames span{padding:5px;text-align:center}' +
    '</style><main><h1>FRAME / MOTION LAB</h1><p>Model: ' + label + '<br>' +
    'Deterministic 30fps VMD checkpoints F00–F32 at fixed 4-frame intervals. ' +
    'Front, three-quarter and side cameras. No screen or other app was captured.<br>' +
    'For numeric IK foot positions, supported bones and rendering details, see ' +
    '<a href="manifest.json">manifest.json</a> and <a href="REVIEW_GUIDE.md">REVIEW_GUIDE.md</a>. ' +
    'Local private assets; do not commit these images.</p>' +
    group + '</main></html>';
}

async function completeMotionLab(session, meta = {}) {
  const metadata = {
    version: 1,
    createdAt: new Date().toISOString(),
    modelName: cleanText(meta.modelName),
    motion: 'generated-walk',
    directions: [-1, 1],
    frames: [0, 4, 8, 12, 16, 20, 24, 28, 32],
    views: ['front', 'three-quarter', 'side'],
    baseMotionFps: 30,
    applicationFps: Number.isFinite(meta.applicationFps) ? meta.applicationFps : null,
    modelHeight: Number.isFinite(meta.modelHeight) ? meta.modelHeight : null,
    stride: Number.isFinite(meta.stride) ? meta.stride : null,
    bones: meta.bones && typeof meta.bones === 'object'
      ? Object.fromEntries(Object.entries(meta.bones).map(([k,v]) => [cleanText(k),cleanText(v)]))
      : {},
    files: session.entries,
    notes: 'Foot x/y are MMD-model local units, not screen pixels. All captures are posed in place.'
  };
  await fs.writeFile(path.join(session.directory, 'manifest.json'), JSON.stringify(metadata, null, 2));
  await fs.writeFile(path.join(session.directory, 'index.html'), galleryHtml(metadata,session.entries));
  await fs.writeFile(path.join(session.directory, 'REVIEW_GUIDE.md'), [
    '# FRAME Motion Lab / AI歩行レビュー',
    '',
    'この撮影はローカルでのみ行われています。モデルの画像やファイルをGitHub等へ公開しないでください。',
    '',
    '## 確認順序',
    '1. index.html の左・右それぞれの正面／斜め／側面コンタクトシートを確認。',
    '2. 同じフレーム番号 F00〜F32 を比較し、足の接地・膝の屈伸・重心・腰肩の回旋・腕振りを評価。',
    '3. manifest.json の各コマ leftFoot/rightFoot の x / y / planted を照合。値はモデル空間であり、実際のスクリーン上の足滑り量ではありません。',
    '4. ソース src/walk-vmd.mjs の WALK_STANCE / WALK_STRIDE_HEIGHT_RATIO / 回転クォータニオン / groove / 腕の振りを小さな単位で修正。',
    '5. 同じモデル・撮影条件で再撮影し、新旧の同方向・同視点・同フレームを比較。姿勢改善と足滑りの悪化を切り分ける。',
    '',
    '## 注意',
    '- 静止フレームの観察は実際の歩行速度・床との接触物理・動的な脚滑りの直接測定ではありません。',
    '- 生成モーションはモデルのボーン構造に依存します。IKの位置だけでなく視覚結果を優先してください。',
    '- ウィンドウ位置を動かす処理は electron/main.cjs、モーション評価・表示は src/renderer.js です。',
    '- 撮影は状態を復元する設計ですが、実機動作の最終確認は必要です。',
    ''
  ].join('\n'), 'utf8');
  const rel = path.relative(session.root, session.directory).replaceAll('\\','/');
  await fs.writeFile(path.join(session.root, 'latest.json'),
    JSON.stringify({ folder: rel, gallery: rel + '/index.html', manifest: rel + '/manifest.json' },null,2));
  await fs.writeFile(path.join(session.root, 'latest.html'),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' +
    rel + '/index.html"><a href="' + rel + '/index.html">Open latest motion review</a>');
  return session.directory;
}

module.exports = {
  motionLabRoot, beginMotionLab, writeMotionLabImage, completeMotionLab, galleryHtml,
  MAX_IMAGE_BYTES, MAX_SESSION_BYTES, IMAGE_NAME
};
