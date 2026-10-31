'use strict';

// The two functions below are serialized independently by chrome.scripting.
// They must not reference variables or helpers from this extension's popup.
function frameVerifyEmptyChatGPTComposer() {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') {
    return { ok: false, reason: 'wrong-origin' };
  }
  const editor = document.querySelector('#prompt-textarea') ||
    document.querySelector('[data-testid="composer"] [contenteditable="true"]') ||
    document.querySelector('form [contenteditable="true"]');
  if (!editor) return { ok: false, reason: 'composer-not-found' };
  const form = editor.closest('form');
  if (!form) return { ok: false, reason: 'composer-form-not-found' };

  // Never send an existing draft, an existing attachment or other user content.
  if ((editor.innerText || editor.textContent || '').trim()) {
    return { ok: false, reason: 'existing-text' };
  }
  if ([...form.querySelectorAll('textarea')].some(t => t.value?.trim())) {
    return { ok: false, reason: 'existing-text' };
  }
  if ([...document.querySelectorAll('input[type="file"]')]
    .some(input => input.files?.length > 0)) {
    return { ok: false, reason: 'existing-attachment' };
  }
  if (form.querySelector(
    '[data-testid*="attachment"],[data-testid*="file-chip"],' +
    '[role="group"][aria-label$=".png"],[role="group"][aria-label$=".jpg"],' +
    '[role="group"][aria-label$=".jpeg"],[role="group"][aria-label$=".pdf"]'
  )) {
    return { ok: false, reason: 'existing-attachment' };
  }
  const sendButton = form.querySelector(
    'button[data-testid="send-button"],button[data-testid="fruitjuice-send-button"]'
  );
  if (sendButton && !sendButton.disabled &&
      sendButton.getAttribute('aria-disabled') !== 'true') {
    return { ok: false, reason: 'existing-draft' };
  }
  return { ok: true };
}

// Only called following a separate explicit 'attach and send' confirmation.
// Fail closed unless the expected file appears in the composer and the send
// button is ready. Never submit the form or use Enter as a fallback.
async function frameSendPreparedImageToChatGPT() {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') {
    return { ok: false, reason: 'wrong-origin' };
  }
  const name = 'FRAME-vision.png';
  const timeoutAt = Date.now() + 15_000;

  while (Date.now() < timeoutAt) {
    const editor = document.querySelector('#prompt-textarea') ||
      document.querySelector('[data-testid="composer"] [contenteditable="true"]') ||
      document.querySelector('form [contenteditable="true"]');
    const form = editor?.closest('form');
    if (!editor || !form) return { ok: false, reason: 'composer-disappeared' };
    if ((editor.innerText || editor.textContent || '').trim() ||
        [...form.querySelectorAll('textarea')].some(t => t.value?.trim())) {
      return { ok: false, reason: 'text-added' };
    }

    // Match only this transfer's file, not a generic image or old attachment.
    const selectedFile = [...document.querySelectorAll('input[type="file"]')]
      .some(input => [...(input.files || [])].some(f => f.name === name &&
        f.type === 'image/png'));
    const chips = [...form.querySelectorAll('[role="group"][aria-label]')];
    const matchedChip = chips.some(chip => chip.getAttribute('aria-label') === name);
    const preview = form.querySelector('img[alt="FRAME-vision.png"]') ||
      form.querySelector('img[alt="FRAME-vision"]');
    const hasOwnImage = matchedChip || !!preview || selectedFile;

    const sendButton = form.querySelector(
      'button[data-testid="send-button"],button[data-testid="fruitjuice-send-button"]'
    );
    if (hasOwnImage && sendButton && sendButton.isConnected &&
        !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
      // The send button becoming available indicates ChatGPT accepted the
      // attachment well enough to send; no page-private API is called.
      sendButton.click();
      return { ok: true, status: 'send-clicked' };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { ok: false, reason: 'attachment-not-ready' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { frameVerifyEmptyChatGPTComposer, frameSendPreparedImageToChatGPT };
}
