'use strict';

const path = require('node:path');

// Resolve URL paths relative to a user-selected model folder, never outside it.
// The caller must also realpath() the result before reading to reject symlinks.
function resolveAssetPath(root, rawPath) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('An absolute model root is required');
  }
  if (typeof rawPath !== 'string') throw new Error('Invalid asset path');
  const decoded = decodeURIComponent(rawPath).replace(/\\/g, '/');
  if (decoded.includes('\0')) throw new Error('NUL byte not allowed');
  const parts = decoded.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('Path traversal or invalid path');
  }
  const rootPath = path.resolve(root);
  const result = path.resolve(rootPath, ...parts);
  if (!result.startsWith(rootPath + path.sep)) {
    throw new Error('Asset path is outside selected model folder');
  }
  return result;
}

module.exports = { resolveAssetPath };
