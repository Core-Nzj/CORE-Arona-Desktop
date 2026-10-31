import test from 'node:test';
import assert from 'node:assert/strict';
import { DigitalBodyWarp } from '../src/digital-body-warp.mjs';

function makeWarp({ noOverlay = false, throwsOnCopy = false } = {}) {
  const context = {
    clearRect() {}, drawImage() {
      if (throwsOnCopy) throw new Error('GPU copy not available');
    }, fillRect() {}, globalAlpha: 1,
    globalCompositeOperation: 'source-over', fillStyle: ''
  };
  const source = { style: {}, width: 320, height: 420 };
  const overlay = {
    width: 320, height: 420, clientWidth: 320, clientHeight: 420,
    hidden: true, getContext: () => noOverlay ? null : context
  };
  return { warp: new DigitalBodyWarp(source, overlay), source, overlay };
}

test('fades out the live body, changes pose invisibly, then fades it in', async () => {
  const { warp, source, overlay } = makeWarp();
  const disappearing = warp.conceal();
  assert.equal(warp.phase, 'out');
  assert.equal(source.style.opacity, '1');
  assert.equal(overlay.hidden, false);

  warp.render(warp.since + warp.disappearMs * 0.5);
  assert.ok(+source.style.opacity < 1 && +source.style.opacity > 0);

  warp.render(warp.since + warp.disappearMs + 1);
  await disappearing;
  assert.equal(warp.phase, 'hidden');
  assert.equal(source.style.opacity, '0');

  const appearing = warp.reveal();
  warp.render(warp.since + warp.appearMs * 0.5);
  assert.ok(+source.style.opacity < 1 && +source.style.opacity > 0);
  warp.render(warp.since + warp.appearMs + 1);
  await appearing;
  assert.equal(warp.phase, 'idle');
  assert.equal(source.style.opacity, '');
  assert.equal(overlay.hidden, true);
});

test('cancelling an in-progress transfer makes the model visible again', async () => {
  const { warp, source } = makeWarp();
  const disappearing = warp.conceal();
  warp.cancel();
  await disappearing;
  assert.equal(warp.phase, 'idle');
  assert.equal(source.style.opacity, '');
  assert.equal(warp.active, false);
});

test('explicit transfer ON remains effective with OS reduced motion enabled', async () => {
  const before = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    const { warp, source } = makeWarp();
    const disappearing = warp.conceal();
    assert.equal(warp.phase, 'out');
    warp.render(warp.since + warp.disappearMs + 1);
    await disappearing;
    assert.equal(source.style.opacity, '0');
    const appearing = warp.reveal();
    warp.render(warp.since + warp.appearMs + 1);
    await appearing;
    assert.equal(source.style.opacity, '');
  } finally {
    globalThis.window = before;
  }
});

test('missing 2D overlay still performs body disappearance and reappearance', async () => {
  const { warp, source } = makeWarp({ noOverlay: true });
  const disappearing = warp.conceal();
  warp.render(warp.since + warp.disappearMs + 1);
  await disappearing;
  assert.equal(source.style.opacity, '0');
  const appearing = warp.reveal();
  warp.render(warp.since + warp.appearMs + 1);
  await appearing;
  assert.equal(source.style.opacity, '');
});

test('GPU canvas copy failure falls back to fade without aborting transfer', async () => {
  const { warp, source, overlay } = makeWarp({ throwsOnCopy: true });
  const disappearing = warp.conceal();
  warp.render(warp.since + warp.disappearMs * 0.5);
  assert.equal(warp.fragmentsEnabled, false);
  assert.equal(overlay.hidden, true);
  assert.ok(+source.style.opacity < 1);
  warp.render(warp.since + warp.disappearMs + 1);
  await disappearing;
  assert.equal(source.style.opacity, '0');
  const appearing = warp.reveal();
  warp.render(warp.since + warp.appearMs + 1);
  await appearing;
  assert.equal(source.style.opacity, '');
});
