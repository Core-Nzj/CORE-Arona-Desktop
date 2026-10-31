import test from 'node:test';
import assert from 'node:assert/strict';
import { DigitalBodyWarp } from '../src/digital-body-warp.mjs';

function makeWarp() {
  const context = {
    clearRect() {}, drawImage() {}, fillRect() {}, globalAlpha: 1,
    globalCompositeOperation: 'source-over', fillStyle: ''
  };
  const source = { style: {}, width: 320, height: 420 };
  const overlay = {
    width: 320, height: 420, clientWidth: 320, clientHeight: 420,
    hidden: true, getContext: () => context
  };
  return { warp: new DigitalBodyWarp(source, overlay), source, overlay };
}

test('digital body vanishes, switches invisibly, then restores normal canvas', async () => {
  const before = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  try {
    const { warp, source, overlay } = makeWarp();
    const disappearing = warp.conceal();
    assert.equal(warp.phase, 'out');
    assert.equal(source.style.opacity, '0');
    assert.equal(overlay.hidden, false);

    warp.render(warp.since + warp.disappearMs + 1);
    await disappearing;
    assert.equal(warp.phase, 'hidden');
    assert.equal(source.style.opacity, '0');

    const appearing = warp.reveal();
    warp.render(warp.since + warp.appearMs + 1);
    await appearing;
    assert.equal(warp.phase, 'idle');
    assert.equal(source.style.opacity, '');
    assert.equal(overlay.hidden, true);
  } finally {
    globalThis.window = before;
  }
});

test('cancelling an in-progress transfer makes the model visible again', async () => {
  const before = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  try {
    const { warp, source } = makeWarp();
    const disappearing = warp.conceal();
    warp.cancel();
    await disappearing;
    assert.equal(warp.phase, 'idle');
    assert.equal(source.style.opacity, '');
    assert.equal(warp.active, false);
  } finally {
    globalThis.window = before;
  }
});

test('reduced motion skips visual effect', async () => {
  const before = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    const { warp, source } = makeWarp();
    await warp.conceal();
    assert.equal(warp.phase, 'idle');
    assert.equal(source.style.opacity, undefined);
  } finally {
    globalThis.window = before;
  }
});
