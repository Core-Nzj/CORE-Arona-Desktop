import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
function run(messages) {
  const child = spawnSync(process.execPath, [entry], {
    input: messages.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n',
    encoding: 'utf8', timeout: 5000
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  return child.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('legacy handshake, discovery and actual ping tool over stdio', () => {
  const replies = run([
    request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    request(2, 'tools/list'), request(3, 'tools/call', { name: 'ping', arguments: {} })
  ]);
  assert.equal(replies.length, 3);
  assert.equal(replies[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), ['ping']);
  assert.match(replies[2].result.content[0].text, /^FRAME_PONG \(local Node.js, /);
  assert.equal(replies[2].result.isError, false);
});

test('modern discovery and ping tool without a handshake', () => {
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  const replies = run([request(1, 'server/discover'), request(2, 'tools/call', { _meta, name: 'ping' })]);
  assert.deepEqual(replies[0].result.supportedVersions, ['2026-07-28']);
  assert.equal(replies[1].result.resultType, 'complete');
  assert.match(replies[1].result.content[0].text, /^FRAME_PONG/);
});

test('reject malformed requests and unknown tools; recover after bad input', () => {
  const replies = run([
    '{', null, request({}, 'tools/list'), request(1, 'tools/list'),
    request(2, 'initialize', { protocolVersion: '0000-00-00' }),
    request(3, 'tools/call', { name: 'missing' }),
    request(4, 'tools/call', { name: 'ping', arguments: { command: 'anything' } }),
    request(5, 'tools/call', null), request(6, 'tools/call', { name: 'ping' })
  ]);
  assert.deepEqual(replies.slice(0, 4).map(r => r.error.code), [-32700, -32600, -32600, -32000]);
  assert.equal(replies[4].result.protocolVersion, '2025-11-25');
  assert.deepEqual(replies.slice(5, 8).map(r => r.error.code), [-32602, -32602, -32602]);
  assert.match(replies[8].result.content[0].text, /^FRAME_PONG/);
});
