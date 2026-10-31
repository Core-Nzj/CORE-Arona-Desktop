'use strict';

const path = require('node:path');
const REQUEST_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.request\.json$/i;
const MAX_REQUEST_AGE_MS = 10 * 60 * 1000;

function requestDirectory(root) {
  return path.join(root, 'requests');
}
function requestName(id) {
  if (!REQUEST_NAME.test(id + '.request.json')) throw new Error('Invalid motion lab request ID');
  return id + '.request.json';
}
function resultName(id) {
  requestName(id);
  return id + '.result.json';
}
function validateRequest(filename, value, now = Date.now()) {
  const match = REQUEST_NAME.exec(filename);
  if (!match || !value || value.type !== 'capture-walk' ||
      value.id !== match[1] || typeof value.createdAt !== 'string') return false;
  const created = Date.parse(value.createdAt);
  return Number.isFinite(created) && created <= now + 10000 &&
    now - created <= MAX_REQUEST_AGE_MS;
}

module.exports = { requestDirectory, requestName, resultName, validateRequest, REQUEST_NAME };
