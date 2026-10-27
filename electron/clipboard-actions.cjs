'use strict';

// Electron 45 clipboard methods are asynchronous (Promise-based).
// Accepting both sync and async implementations also supports test doubles.
const MAX_SPEECH_TEXT_LENGTH = 500;

async function readSpeechText(clipboard) {
  if (typeof clipboard?.readText !== 'function') {
    throw new TypeError('クリップボードの読み取り機能を利用できません');
  }
  const value = await clipboard.readText();
  if (typeof value !== 'string') {
    throw new TypeError('クリップボードから文字列を取得できませんでした');
  }
  return value.trim().slice(0, MAX_SPEECH_TEXT_LENGTH);
}

async function copySpeechToken(clipboard, token) {
  if (typeof clipboard?.writeText !== 'function') {
    throw new TypeError('クリップボードの書き込み機能を利用できません');
  }
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error('ChatGPT連携トークンが準備できていません');
  }
  // Await the write so an asynchronous OS clipboard failure is not lost.
  await clipboard.writeText(token);
}

module.exports = { readSpeechText, copySpeechToken, MAX_SPEECH_TEXT_LENGTH };
