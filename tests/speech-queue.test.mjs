import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlaybackQueue, splitSpeechText } from '../src/speech-queue.mjs';

test('sentence splitting preserves order and 280-character synth limit', () => {
  const text = 'こんにちは。' + 'あ'.repeat(550);
  const parts = splitSpeechText(text);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'こんにちは。');
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(piece => piece.length <= 280));
});


test('splits at natural punctuation without losing or repeating characters', () => {
  const cases = [
    'はい。'.repeat(130),
    'これは確認事項です！「その通りです。」' + '続き'.repeat(300),
    '単語 '.repeat(250) + '終わり。',
    '句読点、あり。' + 'あ'.repeat(1000)
  ];
  for (const text of cases) {
    const parts = splitSpeechText(text);
    assert.equal(parts.join(''), text.trim(), 'split must preserve every character');
    assert.ok(parts.every(part => part.length > 0 && part.length <= 280));
  }
  // Several short sentences should share a chunk, rather than starting
  // hundreds of wasteful individual synth requests.
  assert.ok(splitSpeechText('はい。'.repeat(130)).length <= 3);
});


test('same-stream pieces play in order without interrupting the previous piece', async () => {
  const played = [], resolvers = [];
  let stops = 0;
  const queue = new SpeechPlaybackQueue({
    play: text => { played.push(text); return new Promise(resolve => resolvers.push(resolve)); },
    interrupt: () => { stops++; }
  });
  queue.start('reply-1');
  queue.append('reply-1', 0, '最初。');
  queue.append('reply-1', 1, '二番目。');
  assert.deepEqual(played, ['最初。']);
  resolvers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(played, ['最初。', '二番目。']);
  assert.equal(stops, 1); // only the new stream's initial interrupt
  queue.end('reply-1');
  resolvers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.stream, null);
});

test('duplicate and stale chunks are never played; next stream cancels previous one', async () => {
  const played = [], resolves = [];
  const queue = new SpeechPlaybackQueue({
    play: text => { played.push(text); return new Promise(resolve => resolves.push(resolve)); },
    interrupt: () => {}
  });
  queue.start('old');
  queue.append('old', 0, '古い回答。');
  assert.equal(queue.append('old', 0, '古い回答。').ignored, true);
  queue.start('new');
  assert.equal(queue.append('old', 1, 'もう一度。').missing, true);
  queue.append('new', 0, '新しい回答。');
  resolves.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(played, ['古い回答。', '新しい回答。']);
  queue.stop();
  resolves.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.stream, null);
});

test('manual playback splits oversized input and reuses queue', async () => {
  const played = [];
  const queue = new SpeechPlaybackQueue({
    play: async text => { played.push(text); },
    interrupt: () => {}
  });
  queue.speak('あ'.repeat(650));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(played.join(''), 'あ'.repeat(650));
  assert.ok(played.every(text => text.length <= 280));
});
