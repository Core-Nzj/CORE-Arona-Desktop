'use strict';

// A frame-rate choice controls visual updates only. Input hit polling and
// alpha silhouette sampling deliberately remain on independent schedules.
const FRAME_RATE_OPTIONS = Object.freeze([30, 60, 120]);
const DEFAULT_FRAME_RATE = 60;

function normalizeFrameRate(value) {
  return FRAME_RATE_OPTIONS.includes(value) ? value : DEFAULT_FRAME_RATE;
}

function movementIntervalMs(frameRate) {
  return 1000 / normalizeFrameRate(frameRate);
}

module.exports = { FRAME_RATE_OPTIONS, DEFAULT_FRAME_RATE, normalizeFrameRate, movementIntervalMs };
