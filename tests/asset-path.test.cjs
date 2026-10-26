'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveAssetPath } = require('../electron/asset-path.cjs');

const root = path.resolve('models', 'private');

test('resolves local texture beneath model folder', () => {
  assert.equal(resolveAssetPath(root, '/textures/hair%20color.png'),
    path.join(root, 'textures', 'hair color.png'));
});

test('accepts Windows-style separators inside a model reference', () => {
  assert.equal(resolveAssetPath(root, '/texture%5Chair.png'),
    path.join(root, 'texture', 'hair.png'));
});

test('blocks parent traversal including encoded variants', () => {
  assert.throws(() => resolveAssetPath(root, '/../secret.pmx'));
  assert.throws(() => resolveAssetPath(root, '/textures/%2e%2e/secret.pmx'));
  assert.throws(() => resolveAssetPath(root, '/%2e%2e%5Csecret.pmx'));
});

test('blocks invalid and absolute-like segments', () => {
  assert.throws(() => resolveAssetPath(root, '/'));
  assert.throws(() => resolveAssetPath(root, '/C:%5Csecrets.txt'));
  assert.throws(() => resolveAssetPath(root, '/%00a.png'));
});
