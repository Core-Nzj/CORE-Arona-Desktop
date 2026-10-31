'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const {
  requestDirectory, requestName, resultName, validateRequest, REQUEST_NAME
} = require('../electron/motion-lab-control.cjs');

test('motion lab terminal requests use only a local fixed filename and UUID', () => {
  const id = randomUUID();
  assert.equal(requestName(id), id + '.request.json');
  assert.equal(resultName(id), id + '.result.json');
  assert.equal(REQUEST_NAME.test(requestName(id)), true);
  assert.equal(requestDirectory('/repo/motion-lab'), path.join('/repo/motion-lab','requests'));
  assert.throws(() => requestName('../avatar'));
  assert.throws(() => resultName('evil.json'));
});

test('only fresh capture-walk requests with matching IDs are accepted', () => {
  const id = randomUUID();
  const now = Date.now();
  const filename = requestName(id);
  const good = { id, type:'capture-walk', createdAt: new Date(now-1000).toISOString() };
  assert.equal(validateRequest(filename,good,now),true);
  assert.equal(validateRequest(filename,{...good,id:randomUUID()},now),false);
  assert.equal(validateRequest(filename,{...good,type:'eval'},now),false);
  assert.equal(validateRequest(filename,{...good,createdAt:new Date(now-11*60000).toISOString()},now),false);
  assert.equal(validateRequest(filename,{...good,createdAt:new Date(now+30000).toISOString()},now),false);
  assert.equal(validateRequest('../'+filename,good,now),false);
});
