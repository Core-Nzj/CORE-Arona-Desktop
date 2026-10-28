'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { VoiSonaManager, validExecutable, findExecutable } = require('../electron/voisona-manager.cjs');

function makeWindows({ initial = [], launchedPid = 3456 } = {}) {
  const processes = initial.map(p => ({ ...p }));
  const operations = [];
  const launches = [];
  const run = async (action, pid = 0) => {
    operations.push({ action, pid });
    if (action === 'list') {
      return { processes: processes.map(p => ({ ...p })) };
    }
    const proc = processes.find(p => p.pid === pid);
    if (!proc || !proc.hasWindow) throw new Error('Window missing');
    if (action === 'hide') proc.visible = false;
    if (action === 'show') proc.visible = true;
    if (action === 'close') processes.splice(processes.indexOf(proc), 1);
    return { ok: true };
  };
  const launch = (exe, args, options) => {
    launches.push({ exe, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: launchedPid, exitCode: null
    });
    processes.push({ pid: launchedPid, visible: true, hasWindow: true });
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
