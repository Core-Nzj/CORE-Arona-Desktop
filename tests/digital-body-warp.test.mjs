import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DigitalBodyWarp, shouldAnimateMotionWarp, warpColorForSeed,
  WARP_PALETTE, WARP_HIDDEN_MS, remainingWarpHoldMs
} from '../src/digital-body-warp.mjs';

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

test('only displayed MMD avatars use warp; hidden placeholder must not invert guard', () => {
  const ready = { animate: true, enabled: true, available: true };
  assert.equal(shouldAnimateMotionWarp({ ...ready, placeholderHidden: true }), true);
  assert.equal(shouldAnimateMotionWarp({ ...ready, placeholderHidden: false }), false);
  assert.equal(shouldAnimateMotionWarp({ ...ready, placeholderHidden: true, enabled: false }), false);
  assert.equal(shouldAnimateMotionWarp({ ...ready, placeholderHidden: true, animate: false }), false);
  assert.equal(shouldAnimateMotionWarp({ ...ready, placeholderHidden: true, available: false }), false);
});

test('digital fragments use 60:30:10 cyan, deep blue and turquoise', () => {
  assert.deepEqual(WARP_PALETTE, ['65, 197, 255', '48, 142, 224', '64, 221, 207']);
  const counts = [0, 0, 0];
  for (let i = 0; i < 1000; i++) {
    const picked = warpColorForSeed((i + 0.5) / 1000);
    counts[WARP_PALETTE.indexOf(picked)]++;
  }
  assert.deepEqual(counts, [600, 300, 100]);
});

test('body stays entirely hidden for at least 1000ms after disappearing', () => {
  assert.equal(WARP_HIDDEN_MS, 1000);
  assert.equal(remainingWarpHoldMs(500, 500), 1000);
  assert.equal(remainingWarpHoldMs(500, 750), 750);
  assert.equal(remainingWarpHoldMs(500, 1499), 1);
  assert.equal(remainingWarpHoldMs(500, 1500), 0);
  assert.equal(remainingWarpHoldMs(500, 1900), 0);
});

test('startup appearance holds the model hidden and reveals it over two seconds', async () => {
  const { warp, source, overlay } = makeWarp();
  warp.holdHidden();
  assert.equal(warp.phase, 'hidden');
  assert.equal(source.style.opacity, '0');
  assert.equal(overlay.hidden, true);

  const appearing = warp.reveal(2000);
  assert.equal(warp.phase, 'in');
  assert.equal(overlay.hidden, false);
  warp.render(warp.since + 1000);
  assert.ok(Number(source.style.opacity) > 0);
  assert.ok(Number(source.style.opacity) < 1);
  warp.render(warp.since + 1999);
  assert.equal(warp.phase, 'in');
  warp.render(warp.since + 2000);
  await appearing;
  assert.equal(warp.phase, 'idle');
  assert.equal(source.style.opacity, '');
  assert.equal(overlay.hidden, true);
});

test('subsequent transfer reveals still use the original 300ms duration', async () => {
  const { warp } = makeWarp();
  warp.holdHidden();
  const first = warp.reveal(2000);
  warp.render(warp.since + 2000);
  await first;
  warp.holdHidden();
  const next = warp.reveal();
  warp.render(warp.since + 299);
  assert.equal(warp.phase, 'in');
  warp.render(warp.since + 300);
  await next;
  assert.equal(warp.phase, 'idle');
});
