'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { VisionSessionBroker } = require('../electron/vision-session-broker.cjs');
const { VisionLocalAdapter, LOCAL_DESTINATION_ID } = require('../electron/vision-local-adapter.cjs');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8aUUAAAAASUVORK5CYII=', 'base64'
);
const target = { pluginId: 'frame.vision.windows', windowId: '0x1a', pid: 321 };
const request = {
  source: 'frame.menu', target, destinationId: LOCAL_DESTINATION_ID
};

function createBroker(options = {}) {
  return new VisionSessionBroker({ adapter: new VisionLocalAdapter(), ...options });
}

test('capture cannot be delivered without separate explicit destination approval', async t => {
  const broker = createBroker();
  t.after(() => broker.disconnect());
  const { requestId } = broker.begin(request);
  await assert.rejects(broker.deliver(requestId), /操作順序/);
  const input = Buffer.from(PNG);
  broker.capture(requestId, input);
  input.fill(0); // The broker owns an independent in-RAM copy.
  const state = broker.getState();
  assert.equal(state.status, 'captured');
  assert.equal(state.capturedAt !== null, true);
  assert.equal(JSON.stringify(state).includes(PNG.toString('base64')), false);
  await assert.rejects(broker.deliver(requestId), /操作順序/);
  assert.throws(() => broker.approve({ requestId, destinationId: LOCAL_DESTINATION_ID }), /明示的/);
  assert.throws(() => broker.approve({
    requestId, destinationId: 'another.destination', userConfirmed: true
  }), /明示的/);
  broker.approve({ requestId, destinationId: LOCAL_DESTINATION_ID, userConfirmed: true });
  assert.deepEqual(await broker.deliver(requestId),
    { requestId, destinationId: LOCAL_DESTINATION_ID, delivered: true });
  assert.equal(broker.getState().status, 'delivered');
  await assert.rejects(broker.deliver(requestId), /有効な画像セッション/);
});

test('only one delivery runs even if requests race', async t => {
  let resolveReceipt;
  let deliveryCalls = 0;
  const adapter = {
    getCapabilities: () => new VisionLocalAdapter().getCapabilities(),
    deliver: () => {
      deliveryCalls++;
      return new Promise(resolve => { resolveReceipt = resolve; });
    },
    cancel: async () => {},
    disconnect: async () => {}
  };
  const broker = createBroker({ adapter });
  t.after(() => broker.disconnect());
  const { requestId } = broker.begin(request);
  broker.capture(requestId, PNG);
  broker.approve({ requestId, destinationId: LOCAL_DESTINATION_ID, userConfirmed: true });
  const inFlight = broker.deliver(requestId);
  assert.equal(broker.getState().status, 'delivering');
  await assert.rejects(broker.deliver(requestId), /操作順序/);
  assert.throws(() => broker.begin(request), /受け渡し中/);
  resolveReceipt({ delivered: true });
  await inFlight;
  assert.equal(deliveryCalls, 1);
});

test('revoking a delivery aborts the request and does not revive approval', async t => {
  let resolveReceipt;
  let wasAborted = false;
  let cancelCalls = 0;
  const adapter = {
    getCapabilities: () => new VisionLocalAdapter().getCapabilities(),
    deliver: ({ signal }) => new Promise(resolve => {
      resolveReceipt = resolve;
      signal.addEventListener('abort', () => { wasAborted = true; }, { once: true });
    }),
    cancel: async () => { cancelCalls++; },
    disconnect: async () => {}
  };
  const broker = createBroker({ adapter });
  t.after(() => broker.disconnect());
  const { requestId } = broker.begin(request);
  broker.capture(requestId, PNG);
  broker.approve({ requestId, destinationId: LOCAL_DESTINATION_ID, userConfirmed: true });
  const inFlight = broker.deliver(requestId);
  assert.equal(broker.revoke(requestId), true);
  assert.equal(wasAborted, true);
  assert.equal(broker.getState().status, 'revoked');
  resolveReceipt({ delivered: true }); // A late receipt is not a successful session.
  await assert.rejects(inFlight, /取り消されました/);
  assert.equal(broker.getState().status, 'revoked');
  assert.equal(cancelCalls, 1);
});

test('captured images automatically expire and are never transferable afterward', async t => {
  const broker = createBroker({ ttlMs: 20 });
  t.after(() => broker.disconnect());
  const { requestId } = broker.begin(request);
  broker.capture(requestId, PNG);
  broker.approve({ requestId, destinationId: LOCAL_DESTINATION_ID, userConfirmed: true });
  await wait(50);
  assert.equal(broker.getState().status, 'expired');
  await assert.rejects(broker.deliver(requestId), /有効な画像セッション/);
});

test('invalid PNG, wrong destination, missing receipt and disconnect fail closed', async t => {
  const broker = createBroker();
  t.after(() => broker.disconnect());
  assert.throws(() => broker.begin({ ...request, destinationId: 'fake.remote' }), /送信先/);
  const first = broker.begin(request);
  assert.throws(() => broker.capture(first.requestId, Buffer.from('not PNG')), /PNG/);
  assert.equal(broker.getState().status, 'pending');
  broker.capture(first.requestId, PNG);
  broker.begin(request);
  assert.throws(() => broker.approve({
    requestId: first.requestId, destinationId: LOCAL_DESTINATION_ID, userConfirmed: true
  }), /有効な画像セッション/);
  const second = broker.getState();
  broker.capture(second.requestId, PNG);
  broker.approve({ requestId: second.requestId,
    destinationId: LOCAL_DESTINATION_ID, userConfirmed: true });
  assert.equal(broker.revoke(second.requestId), true);
  assert.equal(broker.getState().status, 'revoked');
  await broker.disconnect();
  assert.throws(() => broker.begin(request), /終了済み/);

  const rejectAdapter = {
    getCapabilities: () => new VisionLocalAdapter().getCapabilities(),
    deliver: async () => ({ delivered: false }),
    cancel: async () => {},
    disconnect: async () => {}
  };
  const rejecting = createBroker({ adapter: rejectAdapter });
  t.after(() => rejecting.disconnect());
  const next = rejecting.begin(request);
  rejecting.capture(next.requestId, PNG);
  rejecting.approve({ requestId: next.requestId,
    destinationId: LOCAL_DESTINATION_ID, userConfirmed: true });
  await assert.rejects(rejecting.deliver(next.requestId), /受領確認/);
  assert.equal(rejecting.getState().status, 'failed');
});
