'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ProxyManager } = require('../electron/proxy-manager.cjs');

test('reuses an already-running localhost proxy and never spawns Python', async () => {
  let spawnCount = 0;
  const manager = new ProxyManager({
    fetchImpl: async url => {
      assert.equal(url, 'http://127.0.0.1:32777/health');
      return { ok: true };
    },
    spawnImpl: () => { spawnCount++; throw new Error('must not spawn'); }
  });
  const ready = await manager.ensureRunning();
  assert.deepEqual(ready, { running: true, managed: false });
  assert.equal(spawnCount, 0);
  assert.equal(manager.status().managed, false);
  manager.stop();
});

test('automatically starts the Python package on loopback without CLI credentials', async () => {
  const commands = [];
  const child = Object.assign(new EventEmitter(), { pid: 999999, exitCode: null, killed: false });
  let healthChecks = 0;
  const manager = new ProxyManager({
    commands: [['py', ['-m', 'voisona_talk_proxy']]],
    fetchImpl: async () => ({ ok: ++healthChecks > 1 }),
    spawnImpl: (exe, args, options) => {
      commands.push({ exe, args, options });
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });
  const state = await manager.ensureRunning();
  assert.equal(state.running, true);
  assert.equal(state.managed, true);
  assert.equal(commands[0].exe, 'py');
  assert.deepEqual(commands[0].args, [
    '-m', 'voisona_talk_proxy', '--host', '127.0.0.1', '--port', '32777'
  ]);
  assert.equal(commands[0].options.shell, false);
  assert.equal(JSON.stringify(commands[0].args).includes('password'), false);
  // Avoid killing a fake PID; simulate exit after startup.
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal(manager.status().managed, false);
});

test('fails gracefully when Python launcher cannot start', async () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, killed: false });
  const manager = new ProxyManager({
    commands: [['py', ['-m', 'voisona_talk_proxy']]],
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    spawnImpl: () => {
      process.nextTick(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return child;
    }
  });
  const state = await manager.ensureRunning();
  assert.equal(state.running, false);
  assert.match(state.error, /ENOENT/);
  assert.equal(manager.status().managed, false);
});
