'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stageInDisplay, cursorHitsStageRects, sanitizeHitRectangles, clampAvatarPosition
} = require('../electron/avatar-overlay.cjs');

const stage = { x: 2120, y: 160, width: 580, height: 780 };

test('full-display stage uses absolute DIP offset, not full-screen WebGL dimensions', () => {
  assert.deepEqual(stageInDisplay(stage, { x: 1920, y: 0, width: 2560, height: 1440 }), {
    x: 200, y: 160, width: 580, height: 780
  });
  assert.deepEqual(stageInDisplay({x:-1600,y:-40,width:300,height:700},
    {x:-1920,y:-120,width:1920,height:1080}),{x:320,y:80,width:300,height:700});
});

test('native hit testing accepts only alpha silhouette rectangles', () => {
  const hit = [{x:20,y:40,width:110,height:290},{x:185,y:70,width:80,height:50}];
  assert.equal(cursorHitsStageRects({x:2140,y:200}, stage, hit), true);
  assert.equal(cursorHitsStageRects({x:2305,y:240}, stage, hit), true);
  assert.equal(cursorHitsStageRects({x:2140,y:199}, stage, hit), false);
  assert.equal(cursorHitsStageRects({x:2250,y:240}, stage, hit), false);
  assert.equal(cursorHitsStageRects({x:2100,y:190}, stage, hit), false);
  assert.equal(cursorHitsStageRects({x:2140,y:200}, stage, []), false);
});

test('untrusted renderer masks are clamped and malformed masks cannot intercept screen', () => {
  assert.deepEqual(sanitizeHitRectangles([{x:-10,y:6,width:30,height:19}],stage),
    [{x:0,y:6,width:20,height:19}]);
  assert.deepEqual(sanitizeHitRectangles([{x:0,y:0,width:Infinity,height:100}],stage), []);
  assert.deepEqual(sanitizeHitRectangles([{x:0,y:0,width:40,height:40},
    {x:0,y:0,width:NaN,height:40}],stage), []);
  assert.deepEqual(sanitizeHitRectangles([{x:10,y:10,width:50,height:70},
    {x:-50,y:-50,width:10,height:10}],stage),[{x:10,y:10,width:50,height:70}]);
  assert.deepEqual(sanitizeHitRectangles(new Array(2001).fill({x:1,y:1,width:1,height:1}),stage), []);
});

test('avatar travels inside work area and can jump between differently placed displays', () => {
  assert.deepEqual(clampAvatarPosition({x:3100,y:-999,width:580,height:780},
    {x:1920,y:0,width:1920,height:1040}),
  {x:3100,y:0,width:580,height:780});
  assert.deepEqual(clampAvatarPosition({x:4000,y:600,width:580,height:780},
    {x:1920,y:0,width:1920,height:1040}),
  {x:3260,y:260,width:580,height:780});
  assert.deepEqual(clampAvatarPosition({x:-2300,y:200,width:580,height:780},
    {x:-1920,y:-200,width:1600,height:880}),
  {x:-1920,y:-100,width:580,height:780});
});
