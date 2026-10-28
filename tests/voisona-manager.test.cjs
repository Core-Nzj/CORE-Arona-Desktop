'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  VoiSonaManager, validExecutable, findExecutable, selectMainWindow
} = require('../electron/voisona-manager.cjs');

function mainWindow(pid, visible = true) {
  return {
    handle: String(pid * 10 + 1), title: 'VoiSona Talk',
    width: 1080, height: 720, toolWindow: false, visible
  };
}

function makeWindows({ initial = [], launchedPid = 3456 } = {}) {
  const processes = initial.map(p => ({
    ...p,
    windows: p.windows || (p.hasWindow === false ? [] : [mainWindow(p.pid, p.visible)])
  }));
  const operations = [];
  const launches = [];
  const run = async (action, pid = 0, handle = '') => {
    operations.push({ action, pid, handle });
    if (action === 'list') {
      return { processes: processes.map(p => ({
        pid: p.pid, windows: p.windows.map(w => ({ ...w }))
      })) };
    }
    const proc = processes.find(p => p.pid === pid);
    const target = proc?.windows.find(w => w.handle === handle);
    if (!target) throw new Error('Window missing or wrong HWND');
    if (action === 'hide') target.visible = false;
    if (action === 'show') target.visible = true;
    if (action === 'close') processes.splice(processes.indexOf(proc), 1);
    if (action !== 'close') proc.visible = target.visible;
    return { ok: true };
  };
  const launch = (exe, args, options) => {
    launches.push({ exe, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: launchedPid, exitCode: null
    });
    processes.push({
      pid: launchedPid, visible: true, hasWindow: true,
      windows: [mainWindow(launchedPid)]
    });
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  const manager = new VoiSonaManager({
    platform: 'win32', run, launch,
    find: async () => 'C:\\Program Files\\Techno-Speech\\VoiSona Talk.exe',
    sleep: async () => {}
  });
  return { manager, processes, launches, operations };
}

test('main-window selection rejects JUCE and audio helper windows', () => {
  const list = [
    { handle: '61', title: 'JUCEWindow', width: 1500, height: 900, visible: true, toolWindow: false },
    { handle: '62', title: 'Windows Audio', width: 1200, height: 700, visible: true, toolWindow: false },
    { handle: '63', title: 'DirectSound', width: 900, height: 800, visible: true, toolWindow: false },
    { handle: '64', title: 'JuceMidiDeviceDetector', width: 800, height: 600, visible: true, toolWindow: false },
    { handle: '65', title: 'VoiSona Talk', width: 1200, height: 680, visible: false, toolWindow: false }
  ];
  assert.equal(selectMainWindow(list)?.handle, '65');
  assert.equal(selectMainWindow(list.slice(0, 4)), null);
  assert.equal(selectMainWindow([
    { handle: '7', title: 'Other Tool', width: 700, height: 500, toolWindow: true }
  ]), null);
  assert.equal(selectMainWindow([
    { handle: '8', title: 'Project A', width: 900, height: 700 },
    { handle: '9', title: 'Project B', width: 1100, height: 800 }
  ]), null, 'ambiguous windows must fail closed');
});

test('show, hide and close only the main HWND, preserving visible JUCE helpers', async () => {
  const windows = [
    { handle: '1001', title: 'JUCEWindow', width: 1200, height: 750, visible: true },
    { handle: '1002', title: 'Windows Audio', width: 1200, height: 800, visible: true },
    { handle: '1003', title: 'DirectSound', width: 800, height: 700, visible: true },
    { handle: '1004', title: 'JuceMidiDeviceDetector', width: 1500, height: 750, visible: true },
    { handle: '1005', title: 'VoiSona Talk', width: 1000, height: 650, visible: true }
  ];
  const { manager, processes, operations } = makeWindows({
    initial: [{ pid: 221, windows, visible: true }]
  });
  await manager.hide({ manual: true });
  assert.equal(processes[0].windows.at(-1).visible, false);
  assert.ok(processes[0].windows.slice(0, 4).every(w => w.visible));
  await manager.show();
  assert.equal(processes[0].windows.at(-1).visible, true);
  assert.ok(operations.filter(o => ['hide', 'show'].includes(o.action))
    .every(o => o.handle === '1005'));
});

test('ambiguous or helper-only windows cannot be shown, hidden or closed', async () => {
  const { manager, operations } = makeWindows({
    initial: [{ pid: 221, windows: [
      { handle: '1001', title: 'JUCEWindow', width: 1000, height: 750, visible: true },
      { handle: '1002', title: 'Windows Audio', width: 1000, height: 750, visible: true }
    ] }]
  });
  const state = await manager.refresh();
  assert.equal(state.running, true);
  assert.equal(state.hasWindow, false);
  await assert.rejects(manager.hide({ manual: true }), /検出できません/);
  await assert.rejects(manager.show(), /検出できません/);
  await manager.shutdown();
  assert.equal(operations.some(o => ['hide', 'show', 'close'].includes(o.action)), false);
});

test('finds installed VoiSona Talk.exe in the official Techno-Speech directory', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'arona-voisona-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const folder = path.join(temp, 'Techno-Speech', 'VoiSona Talk');
  await fs.mkdir(folder, { recursive: true });
  const exe = path.join(folder, 'VoiSona Talk.exe');
  await fs.writeFile(exe, '');
  assert.equal(await findExecutable('', [temp]), exe);
  assert.equal(await findExecutable(exe), exe);
  assert.equal(validExecutable('C:\\Program Files\\Techno-Speech\\VoiSona Talk.exe'), true);
  assert.equal(validExecutable('C:\\Program Files\\Techno-Speech\\VoiSona.exe'), false);
  await assert.rejects(findExecutable(path.join(temp, 'Other.exe')), /見つかりません/);
});

test('reuses pre-existing VoiSona Talk, never auto-hides or closes it', async () => {
  const { manager, launches, operations, processes } = makeWindows({
    initial: [{ pid: 111, visible: true, hasWindow: true }]
  });
  const status = await manager.ensureRunning();
  assert.equal(status.running, true);
  assert.equal(status.managed, false);
  assert.equal(launches.length, 0);
  await manager.hide();
  assert.equal(processes[0].visible, true, 'auto-hide must not touch pre-existing GUI');
  await manager.shutdown();
  assert.equal(operations.some(x => x.action === 'close'), false);
});

test('starts installed VoiSona and hides only the owned editor window', async () => {
  const { manager, launches, operations, processes } = makeWindows();
  const started = await manager.ensureRunning();
  assert.equal(started.running, true);
  assert.equal(started.managed, true);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, []);
  assert.equal(launches[0].options.shell, false);
  await manager.hide();
  assert.equal(processes[0].visible, false);
  await manager.shutdown();
  assert.ok(operations.some(x => x.action === 'close' && x.pid === 3456));
});

test('does not close a newly launched editor left visible for API setup', async () => {
  const { manager, processes, operations } = makeWindows();
  await manager.ensureRunning();
  assert.equal(processes[0].visible, true);
  await manager.shutdown();
  assert.equal(operations.some(x => x.action === 'close'), false);
});

test('manual show hands ownership of an app-launched editor to the user', async () => {
  const { manager, processes, operations } = makeWindows();
  await manager.ensureRunning();
  await manager.hide();
  await manager.show();
  assert.equal(processes[0].visible, true);
  await manager.shutdown();
  assert.equal(operations.some(x => x.action === 'close'), false);
});

test('manually hidden external VoiSona is restored when Arona exits', async () => {
  const { manager, processes, operations } = makeWindows({
    initial: [{ pid: 221, visible: true, hasWindow: true }]
  });
  await manager.hide({ manual: true });
  assert.equal(processes[0].visible, false);
  await manager.shutdown();
  assert.equal(processes[0].visible, true);
  assert.equal(operations.some(x => x.action === 'close'), false);
});

test('cannot operate on unready window and does not launch on unsupported OS', async () => {
  const windows = makeWindows({ initial: [{ pid: 221, visible: false, hasWindow: false }] });
  await assert.rejects(windows.manager.hide({ manual: true }), /検出できません/);
  const unsupported = new VoiSonaManager({ platform: 'linux', run: async () => {
    throw new Error('should never be invoked');
  } });
  const state = await unsupported.ensureRunning();
  assert.equal(state.supported, false);
  assert.equal(state.running, false);
});
