'use strict';

// Parameter ranges and per-voice presets kept compatible with v0.7.
const PARAM_SPEC = Object.freeze({
  speed: [0.2, 5, 1],
  volume: [-8, 8, 0],
  pitch: [-600, 600, 0],
  intonation: [0, 2, 1],
  alp: [-1, 1, 0],
  huskiness: [-20, 20, 0]
});

function voiceKey(voice) {
  return String(voice.voice_name) + '@@' + (voice.voice_version || '');
}

function globalParameters(profile) {
  if (!profile || typeof profile !== 'object' || !profile.params ||
      typeof profile.params !== 'object') return null;
  const params = {};
  for (const [key, [min, max, fallback]] of Object.entries(PARAM_SPEC)) {
    const input = profile.params[key];
    const number = input === '' || input == null ? NaN : Number(input);
    params[key] = Number.isFinite(number)
      ? Math.max(min, Math.min(max, number)) : fallback;
  }
  if (profile.useStyles === true &&
      Array.isArray(profile.styleNames) && Array.isArray(profile.styleValues) &&
      profile.styleNames.length > 0) {
    const weights = profile.styleNames.slice(0, 30).map((_, i) => {
      const value = Number(profile.styleValues[i]);
      return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
    });
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total > 0) params.style_weights = weights.map(value => value / total);
  }
  return params;
}

module.exports = { PARAM_SPEC, voiceKey, globalParameters };
