'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stageInDisplay, cursorHitsStageRects, sanitizeHitRectangles, clampAvatarPosition,
  avatarMovementLimits, unboundedOverlayZoom, scaleAvatarHitRectangles
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

test('dragging can put the real model beyond all four screen edges', () => {
  const display = {x:0,y:0,width:1920,height:1080};
  const model = {x:50,y:100,width:250,height:650};
  const hit = [{x:80,y:140,width:160,height:480}];
  const limits = avatarMovementLimits(model,display,hit);
  assert.deepEqual(limits,{minX:-192,maxX:1792,minY:-572,maxY:892});
  assert.deepEqual(clampAvatarPosition({...model,x:-100,y:-250},display,hit),
    {...model,x:-100,y:-250});
  assert.deepEqual(clampAvatarPosition({...model,x:2300,y:1400},display,hit),
    {...model,x:1792,y:892});
  assert.deepEqual(clampAvatarPosition({...model,x:-1000,y:-2000},display,hit),
    {...model,x:-192,y:-572});
  // Even when the stage center sits outside the display, 48px of actual body
  // still remains available for dragging it back.
  assert.equal(limits.minX+240,48);
  assert.equal(limits.maxX+80,1872);
});

test('the safety limit includes the taskbar region and keeps cursor anchoring', () => {
  const display = {x:1920,y:-120,width:1600,height:900};
  const model = {x:2400,y:0,width:500,height:900};
  const hit = [{x:120,y:200,width:300,height:440}];
  assert.deepEqual(clampAvatarPosition({...model,x:2000,y:650},display,hit),
    {...model,x:2000,y:532});
  // A negative-Y second monitor and a stage wider than it remain recoverable.
  const large = {x:-500,y:0,width:1900,height:1100};
  const area = {x:0,y:0,width:1600,height:900};
  const result = clampAvatarPosition({...large,x:-2000},area,[{x:600,y:300,width:500,height:500}]);
  assert.equal(result.x,-1052);
});

test('zoom retains its center even when the stage extends outside the screen', () => {
  const old = {x:-100,y:-40,width:500,height:700};
  const bounds = unboundedOverlayZoom(old,{
    bounds:{x:0,y:0,width:700,height:980},scale:4,cameraZoom:1.5
  });
  assert.deepEqual(bounds,{bounds:{x:-200,y:-180,width:700,height:980},
    scale:4,cameraZoom:1.5});
  assert.deepEqual(scaleAvatarHitRectangles(
    [{x:70,y:80,width:200,height:450}],old,bounds.bounds),
    [{x:98,y:112,width:280,height:630}]);
});

test('partial stage overflow is possible on displays to the left and right', () => {
  const bounds = {x:3100,y:-999,width:580,height:780};
  assert.deepEqual(clampAvatarPosition(bounds,
    {x:1920,y:0,width:1920,height:1040}),{...bounds,y:-615});
  assert.deepEqual(clampAvatarPosition({x:4000,y:600,width:580,height:780},
    {x:1920,y:0,width:1920,height:1040}),
  {x:3676,y:600,width:580,height:780});
  assert.deepEqual(clampAvatarPosition({x:-2300,y:200,width:580,height:780},
    {x:-1920,y:-200,width:1600,height:880}),
  {x:-2300,y:200,width:580,height:780});
});
