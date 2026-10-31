'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VisionSessionBroker } = require('../electron/vision-session-broker.cjs');
const { VisionBrowserAdapter, DESTINATION_ID } = require('../electron/vision-browser-adapter.cjs');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8aUUAAAAASUVORK5CYII=', 'base64'
);
const target = { pluginId: 'frame.vision.windows', windowId: '0x1a', pid: 42 };
const request = { source: 'frame.menu', target, destinationId: DESTINATION_ID };

async function setup(t) {
  const adapter = new VisionBrowserAdapter({ port: 0 }); // OS-assigned test port.
  const broker = new VisionSessionBroker({ adapter, ttlMs: 1500 });
  t.after(async () => { broker.revoke(); await adapter.disconnect(); });
  await adapter.start();
  const session = broker.begin(request);
  broker.capture(session.requestId, PNG);
  broker.approve({ requestId: session.requestId, destinationId: DESTINATION_ID, userConfirmed: true });
  const delivery = broker.deliver(session.requestId);
  await new Promise(resolve => setImmediate(resolve));
  const pending = adapter.getPending();
  assert.ok(pending);
  const uri = 'http://127.0.0.1:' + pending.port + '/take';
  return { adapter, broker, session, delivery, pending, uri };
}

test('only a valid one-time code fetches PNG and second claim fails', async t => {
  const { broker, session, delivery, pending, uri } = await setup(t);
  const denied = await fetch(uri, {
    method: 'POST', headers: { Authorization: 'Bearer ' + '0'.repeat(64) }
  });
  assert.equal(denied.status, 401);
  assert.equal(broker.getState().status, 'delivering');
  const response = await fetch(uri, {
    method: 'POST', headers: { Authorization: 'Bearer ' + pending.token }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  await delivery;
  assert.equal(broker.getState().status, 'delivered');
  const reused = await fetch(uri, {
    method: 'POST', headers: { Authorization: 'Bearer ' + pending.token }
  });
  assert.equal(reused.status, 410);
  await assert.rejects(broker.deliver(session.requestId), /有効な画像セッション/);
});

test('regular web origins, incorrect host and cancellation are refused', async t => {
  const { broker, delivery, pending, uri } = await setup(t);
  const origin = await fetch(uri, {
    method: 'POST', headers: {
      Authorization: 'Bearer ' + pending.token, Origin: 'https://chatgpt.com'
    }
  });
  assert.equal(origin.status, 403);
  const host = await fetch(uri, {
    method: 'POST', headers: { Authorization: 'Bearer ' + pending.token, Host: 'evil.test' }
  });
  assert.equal(host.status, 403);
  assert.equal(broker.revoke(), true);
  await assert.rejects(delivery, /取り消されました/);
  const after = await fetch(uri, {
    method: 'POST', headers: { Authorization: 'Bearer ' + pending.token }
  });
  assert.equal(after.status, 410);
});

test('expiry removes receipt code and prevents late reads', async t => {
  const adapter = new VisionBrowserAdapter({ port: 0 });
  const broker = new VisionSessionBroker({ adapter, ttlMs: 35 });
  t.after(async () => { broker.revoke(); await adapter.disconnect(); });
  await adapter.start();
  const { requestId } = broker.begin(request);
  broker.capture(requestId, PNG);
  broker.approve({ requestId, destinationId: DESTINATION_ID, userConfirmed: true });
  const delivery = broker.deliver(requestId);
  // Prevent unhandled rejection while waiting for the expiry timer.
  const completed = delivery.then(() => 'ok', error => String(error.message));
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(broker.getState().status, 'expired');
  assert.equal(adapter.getPending(), null);
  assert.match(await completed, /取り消されました/);
});
