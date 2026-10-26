'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserCredentialPortal } = require('../electron/browser-credentials.cjs');

test('opens a one-time loopback browser form with password manager hints', async t => {
  let openedUrl = null;
  const imported = [];
  const portal = new BrowserCredentialPortal({
    preferredPort: 0,
    onCredentials: async (username, password) => { imported.push({ username, password }); },
    openExternal: async url => { openedUrl = url; }
  });
  t.after(() => portal.close());
  const result = await portal.open();
  assert.equal(result.opened, true);
  const url = new URL(openedUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/credentials\/[0-9a-f]{64}$/);

  const page = await fetch(openedUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /name="password"/);
  const csrfToken = html.match(/name="csrf_token" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(csrfToken, 'must have an unpredictable hidden form token');
  assert.equal(page.headers.get('cache-control'), 'no-store, max-age=0');
  assert.ok(!html.includes('secret-api-password'));

  const rejected = await fetch(openedUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://evil.example' },
    // The random CSRF token is NOT available to a cross-site page.
    body: new URLSearchParams({ username: 'test@example.com', password: 'bad' })
  });
  assert.equal(rejected.status, 403);
  assert.equal(imported.length, 0);

  const accepted = await fetch(openedUrl, {
    method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': url.origin
    },
    body: new URLSearchParams({
      username: 'demo@example.com',
      password: 'secret-api-password',
      csrf_token: csrfToken
    })
  });
  assert.equal(accepted.status, 200);
  const confirmation = await accepted.text();
  assert.match(confirmation, /認証情報を保存しました/);
  assert.ok(!confirmation.includes('secret-api-password'));
  assert.deepEqual(imported, [{
    username: 'demo@example.com',
    password: 'secret-api-password'
  }]);
});

test('prevents cross-origin and guessed-token requests, and disallows repeated reuse', async t => {
  let openedUrl = null;
  let count = 0;
  const portal = new BrowserCredentialPortal({
    preferredPort: 0,
    onCredentials: async () => { count += 1; },
    openExternal: async url => { openedUrl = url; }
  });
  t.after(() => portal.close());
  await portal.open();
  const url = new URL(openedUrl);
  const formHtml = await (await fetch(openedUrl)).text();
  const csrfToken = formHtml.match(/name="csrf_token" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(csrfToken);
  const wrong = new URL(openedUrl);
  wrong.pathname = '/credentials/unknown';
  const missing = await fetch(wrong);
  assert.equal(missing.status, 404);

  const request = () => fetch(openedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: url.origin },
    body: new URLSearchParams({ username: 'x@example.com', password: 'secret', csrf_token: csrfToken })
  });
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 404);
  assert.equal(count, 1);
});

test('rejects oversize submissions without ever forwarding credentials', async t => {
  let url;
  let saved = false;
  const portal = new BrowserCredentialPortal({
    preferredPort: 0,
    openExternal: async opened => { url = opened; },
    onCredentials: async () => { saved = true; }
  });
  t.after(() => portal.close());
  await portal.open();
  const origin = new URL(url).origin;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=test%40example.com&password=' + 'a'.repeat(10000)
  });
  assert.equal(response.status, 413);
  assert.equal(saved, false);
});


test('privacy extensions may omit Origin while one-time CSRF still secures saving', async t => {
  let url;
  let saved;
  const portal = new BrowserCredentialPortal({
    preferredPort: 0,
    openExternal: async link => { url = link; },
    onCredentials: async (username, password) => { saved = { username, password }; }
  });
  t.after(() => portal.close());
  await portal.open();
  const formHtml = await (await fetch(url)).text();
  const csrfToken = formHtml.match(/name="csrf_token" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(csrfToken);
  const data = new URLSearchParams({
    username: 'demo@example.com',
    password: 'api-password',
    csrf_token: csrfToken
  });
  // Forged requests without the form's hidden token are rejected.
  const denied = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'bad@example.com', password: 'bad' })
  });
  assert.equal(denied.status, 403);
  assert.equal(saved, undefined);
  // The legitimate form works even if a browser privacy extension strips Origin.
  const accepted = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(saved, {
    username: 'demo@example.com', password: 'api-password'
  });
});

test('cross-site-looking Origin and Fetch Metadata cannot block a legitimate one-time form', async t => {
  let url;
  let saved = false;
  const portal = new BrowserCredentialPortal({
    preferredPort: 0,
    openExternal: async opened => { url = opened; },
    onCredentials: async () => { saved = true; }
  });
  t.after(() => portal.close());
  await portal.open();
  const html = await (await fetch(url)).text();
  const csrfToken = html.match(/name="csrf_token" value="([0-9a-f]{64})"/)?.[1];
  const payload = new URLSearchParams({
    username: 'any@example.org', password: 'test', csrf_token: csrfToken
  });
  const accepted = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'null',
      'Sec-Fetch-Site': 'cross-site'
    },
    body: payload
  });
  assert.equal(accepted.status, 200);
  assert.equal(saved, true);
});


test('guessed path and mismatched form token always fail even with matching Origin', async t => {
  let url;
  let saves = 0;
  const portal = new BrowserCredentialPortal({
    preferredPort: 0,
    openExternal: async opened => { url = opened; },
    onCredentials: async () => { saves++; }
  });
  t.after(() => portal.close());
  await portal.open();
  const expectedOrigin = new URL(url).origin;

  const missing = await fetch(url, {
    method: 'POST',
    headers: { 'Origin': expectedOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'user@example.jp', password: 'api' })
  });
  assert.equal(missing.status, 403);

  const fabricated = await fetch(url, {
    method: 'POST',
    headers: { 'Origin': expectedOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: 'user@example.jp', password: 'api', csrf_token: '0'.repeat(64)
    })
  });
  assert.equal(fabricated.status, 403);
  assert.equal(saves, 0);
});
