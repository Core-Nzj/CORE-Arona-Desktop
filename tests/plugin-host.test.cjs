'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FramePluginHost, normalizeManifest, normalizeWindows, normalizeCapture } =
  require('../electron/plugin-host.cjs');

const ID = 'frame.vision.windows';
const manifest = Object.freeze({
  id: ID,
  name: '視覚 / ウィンドウ一覧',
  apiVersion: 1,
  type: 'frame.windows-list.v1',
  entry: 'list-windows.ps1',
  permissions: ['window-titles']
});

async function fixture(t) {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-plugin-'));
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const dir = path.join(dataDirectory, 'plugins', ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, 'list-windows.ps1'), '# test entry');
  return { dataDirectory, dir };
}

test('disabled until explicitly approved; only trusted menu action can run', async t => {
  const { dataDirectory } = await fixture(t);
  let calls = 0;
  const host = new FramePluginHost({
    dataDirectory, platform: 'win32',
    runListScript: async () => {
      calls++;
      return [{ id: '0x1a2b', pid: 99, title: 'テスト用ウィンドウ' }];
    }
  });
  await host.initialize();
  assert.equal(host.state().entries.length, 1);
  assert.equal(host.state().entries[0].enabled, false);
  await assert.rejects(host.listWindows(ID), /許可/);
  assert.equal(calls, 0);
  await host.setEnabled(ID, true);
  assert.equal(host.state().entries[0].enabled, true);
  assert.deepEqual(await host.listWindows(ID), [{ id: '0x1a2b', pid: 99, title: 'テスト用ウィンドウ' }]);
  assert.equal(calls, 1);
  await host.setEnabled(ID, false);
  assert.deepEqual(host.state().windows, []);
  await assert.rejects(host.listWindows(ID), /許可/);
  assert.equal(calls, 1);
});

test('opt-in permission persists, but window titles never persist', async t => {
  const { dataDirectory } = await fixture(t);
  const host = new FramePluginHost({
    dataDirectory, platform: 'win32',
    runListScript: async () => [{ id: '0x12', pid: 8, title: 'private title' }]
  });
  await host.initialize();
  await host.setEnabled(ID, true);
  await host.listWindows(ID);
  const prefs = await fs.readFile(host.preferencesPath, 'utf8');
  assert.equal(prefs.includes('private title'), false);
  const restarted = new FramePluginHost({ dataDirectory, platform: 'win32' });
  await restarted.initialize();
  assert.equal(restarted.state().entries[0].enabled, true);
  assert.deepEqual(restarted.state().windows, []);
});

test('a changed local script cannot reuse a prior approval', async t => {
  const { dataDirectory, dir } = await fixture(t);
  let calls = 0;
  const host = new FramePluginHost({
    dataDirectory, platform: 'win32',
    runListScript: async () => { calls++; return []; }
  });
  await host.initialize();
  await host.setEnabled(ID, true);
  await fs.writeFile(path.join(dir, 'list-windows.ps1'), '# replaced entry');
  await assert.rejects(host.listWindows(ID), /変更されています/);
  assert.equal(calls, 0);
  await host.refresh();
  assert.equal(host.state().entries[0].enabled, false);
  await host.setEnabled(ID, true);
  assert.deepEqual(await host.listWindows(ID), []);
  assert.equal(calls, 1);
});

test('invalid manifests and malformed tool responses are rejected', () => {
  assert.equal(normalizeManifest({ ...manifest, entry: '../hack.ps1' }, ID), null);
  assert.equal(normalizeManifest({ ...manifest, permissions: ['window-titles', 'camera'] }, ID), null);
  assert.equal(normalizeManifest(manifest, 'another-id'), null);
  assert.deepEqual(normalizeWindows([
    { id: '0xff', pid: 3, title: 'ok' },
    { id: 'evil', pid: 0, title: 'not ok' },
    { id: '0xaa', pid: 4, title: '' }
  ]), [{ id: '0xff', pid: 3, title: 'ok' }]);
  assert.throws(() => normalizeWindows({ unexpected: true }), /配列/);
});

test('plugin is discovered only if its entry exists and is a regular file', async t => {
  const { dataDirectory, dir } = await fixture(t);
  await fs.rm(path.join(dir, 'list-windows.ps1'));
  const host = new FramePluginHost({ dataDirectory });
  await host.initialize();
  assert.equal(host.state().entries.length, 0);
});

const PNG_ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8aUUAAAAASUVORK5CYII=';

test('capture-enabled plugin requires new approval and never persists screenshots', async t => {
  const { dataDirectory, dir } = await fixture(t);
  const upgraded = {
    ...manifest, name: '視覚 / ウィンドウ一覧と撮影',
    captureEntry: 'capture-window.ps1',
    permissions: ['window-titles', 'window-capture']
  };
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(upgraded));
  const capturePath = path.join(dir, 'capture-window.ps1');
  await fs.writeFile(capturePath, '# capture test');
  let captureCalls = 0;
  const host = new FramePluginHost({
    dataDirectory, platform: 'win32',
    runListScript: async () => [{ id: '0x1', pid: 42, title: 'private window' }],
    runCapture: async () => {
      captureCalls++;
      return { image: PNG_ONE_PIXEL, width: 1, height: 1, mode: 'PrintWindow' };
    }
  });
  await host.initialize();
  assert.equal(host.state().entries[0].captureEnabled, true);
  await assert.rejects(host.captureWindow(ID, '0x1'), /権限/);
  await host.setEnabled(ID, true);
  await host.listWindows(ID);
  assert.deepEqual(host.state().windows[0].pid, 42);
  await assert.rejects(host.captureWindow(ID, '0x99'), /存在しません/);
  const image = await host.captureWindow(ID, '0x1');
  assert.equal(image.dataUrl, 'data:image/png;base64,' + PNG_ONE_PIXEL);
  assert.equal(image.title, 'private window');
  assert.equal(captureCalls, 1);
  const saved = await fs.readFile(host.preferencesPath, 'utf8');
  assert.equal(saved.includes('private window'), false);
  assert.equal(saved.includes(PNG_ONE_PIXEL), false);
  host.clearCapture();
  assert.equal(host.state().capture, null);
  await fs.writeFile(capturePath, '# modified; needs approval');
  await assert.rejects(host.captureWindow(ID, '0x1'), /更新されています/);
  await host.refresh();
  assert.equal(host.state().entries[0].enabled, false);
});

test('legacy list-only plugin never authorizes capture', async t => {
  const { dataDirectory } = await fixture(t);
  const host = new FramePluginHost({
    dataDirectory, platform: 'win32',
    runListScript: async () => [{ id: '0xff', pid: 123, title: 'x' }]
  });
  await host.initialize();
  await host.setEnabled(ID, true);
  await host.listWindows(ID);
  assert.equal(host.state().entries[0].captureEnabled, false);
  await assert.rejects(host.captureWindow(ID, '0xff'), /撮影対応プラグイン/);
});

test('capture result rejects non-PNG, malformed dimensions and untrusted modes', () => {
  assert.throws(() => normalizeCapture({ image: 'not base64!' }), /不正/);
  assert.throws(() => normalizeCapture({
    image: PNG_ONE_PIXEL, width: 2, height: 1, mode: 'PrintWindow'
  }), /不正/);
  assert.throws(() => normalizeCapture({
    image: PNG_ONE_PIXEL, width: 1, height: 1, mode: 'Other'
  }), /不正/);
});
