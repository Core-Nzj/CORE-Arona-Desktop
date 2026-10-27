'use strict';

// Do not speak answers that already existed when the page was opened. In
// particular, merely typing/sending a new prompt must not repeat the old reply.
const ROLE_SELECTOR = '[data-message-author-role]';
const seenUsers = new Set();
const seenAssistants = new Set();
let armed = false;
let candidateKey = null;
let settleTimer = null;
let idCounter = 0;
const fallbackKeys = new WeakMap();

function keyFor(node) {
  const holder = node.closest('[data-turn-key], [data-message-id]') || node;
  const id = holder.getAttribute('data-turn-key') || holder.getAttribute('data-message-id');
  if (id) return id;
  if (!fallbackKeys.has(holder)) fallbackKeys.set(holder, 'fallback-' + (++idCounter));
  return fallbackKeys.get(holder);
}
function all(role) {
  return Array.from(document.querySelectorAll(ROLE_SELECTOR))
    .filter(node => node.getAttribute('data-message-author-role') === role);
}
function textFrom(node) {
  const body = node.querySelector('.markdown, .prose') || node;
  return (body.innerText || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 500);
}
function stopButtonExists() {
  return !!document.querySelector('[data-testid="stop-button"], [data-testid="stop-generating-button"]');
}
function scan() {
  const users = all('user');
  const assistants = all('assistant');
  for (const user of users) {
    const key = keyFor(user);
    if (!seenUsers.has(key)) {
      seenUsers.add(key);
      armed = true;
    }
  }
  if (!armed || !users.length || !assistants.length) return;
  const lastUser = users[users.length - 1];
  const lastAssistant = assistants[assistants.length - 1];
  if (!(lastUser.compareDocumentPosition(lastAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
  const key = keyFor(lastAssistant);
  if (seenAssistants.has(key)) return;
  candidateKey = key;
  clearTimeout(settleTimer);
  if (stopButtonExists()) return;
  const snapshot = textFrom(lastAssistant);
  if (!snapshot) return;
  settleTimer = setTimeout(() => {
    const newest = all('assistant').at(-1);
    if (!newest || keyFor(newest) !== candidateKey || stopButtonExists() ||
        textFrom(newest) !== snapshot) return;
    seenAssistants.add(key);
    armed = false;
    chrome.runtime.sendMessage({ type: 'speak', text: snapshot }).catch(() => {});
  }, 1350);
}

// The initial page state is history, never a new message to announce.
for (const user of all('user')) seenUsers.add(keyFor(user));
for (const assistant of all('assistant')) seenAssistants.add(keyFor(assistant));
new MutationObserver(scan).observe(document.documentElement, {
  childList: true, subtree: true, characterData: true
});
