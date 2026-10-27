'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { voiceKey, globalParameters } = require('../electron/speech-settings.cjs');

test('v0.7 per-voice identifiers preserve versions', () => {
  assert.equal(voiceKey({ voice_name: '雨衣', voice_version: '1.2' }), '雨衣@@1.2');
  assert.equal(voiceKey({ voice_name: '雨衣' }), '雨衣@@');
});

test('v0.7 global parameters retain all six ranges', () => {
  const parameters = globalParameters({
    params: { speed: 7, volume: -99, pitch: 730, intonation: 0.5, alp: -0.4, huskiness: 2 }
  });
  assert.deepEqual(parameters, {
    speed: 5, volume: -8, pitch: 600, intonation: 0.5, alp: -0.4, huskiness: 2
  });
});

test('v0.7 style percentages are normalized rather than dropped', () => {
  const parameters = globalParameters({
    params: { speed: 1 },
    useStyles: true, styleNames: ['Normal','Happy','Sad'], styleValues: [20, 30, 50]
  });
  assert.deepEqual(parameters.style_weights, [0.2, 0.3, 0.5]);
});

test('malformed parameters fall back safely and missing profiles use defaults', () => {
  assert.equal(globalParameters(null), null);
  const parameters = globalParameters({
    params: { speed: 'wat', pitch: null, huskiness: Infinity },
    useStyles: true, styleNames: ['Normal'], styleValues: [0]
  });
  assert.equal(parameters.speed, 1);
  assert.equal(parameters.pitch, 0);
  assert.equal(parameters.huskiness, 0);
  assert.equal('style_weights' in parameters, false);
});
