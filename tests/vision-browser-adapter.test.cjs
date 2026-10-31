'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
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
  await denied.arrayBuffer(); // Drain response before closing the server.
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
  await reused.arrayBuffer();
  await assert.rejects(broker.deliver(session.requestId), /有効な画像セッション/);
});

// Node's fetch may normalize/replace Host rather than transmitting the
// caller-supplied header. Use node:http to put an invalid Host on the wire.
function requestWithHost(uri, token, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(uri, {
      method: 'POST',
      setHost: false,
      headers: { Host: host, Authorization: 'Bearer ' + token }
    }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

test('regular web origins, incorrect host and cancellation are refused', async t => {
  const { broker, delivery, pending, uri } = await setup(t);
  const origin = await fetch(uri, {
    method: 'POST', headers: {
      Authorization: 'Bearer ' + pending.token, Origin: 'https://chatgpt.com'
    }
  });
  assert.equal(origin.status, 403);
  await origin.arrayBuffer();
  const rejectedHostStatus = await requestWithHost(uri, pending.token, 'evil.test');
  assert.equal(rejectedHostStatus, 403);
  assert.equal(broker.revoke(), true);
  await assert.rejects(delivery, /取り消されました/);
  const after = await fetch(uri, {
    method: 'POST', headers: { Authorization: 'Bearer ' + pending.token }
  });
  assert.equal(after.status, 410);
  await after.arrayBuffer();
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


test('shutdown closes authenticated HTTP keep-alive sockets promptly', async t => {
  const { adapter, broker, delivery, pending, uri } = await setup(t);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());

  const denied = await new Promise((resolve, reject) => {
    const req = http.request(uri, {
      method: 'POST',
      agent,
      headers: { Authorization: 'Bearer ' + '0'.repeat(64) }
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(denied, 401);
  assert.equal(broker.getState().status, 'delivering');
  broker.revoke();
  await assert.rejects(delivery, /取り消されました/);

  // The server must not wait indefinitely for the keep-alive client's socket.
  // A deadline makes this a useful regression test instead of another hang.
  let timer;
  try {
    await Promise.race([
      adapter.disconnect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Chrome bridge shutdown timed out')), 3000);
      })
    ]);
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
  assert.equal(adapter.getPending(), null);
});
