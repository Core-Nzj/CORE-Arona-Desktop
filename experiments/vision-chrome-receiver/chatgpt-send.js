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
  // ChatGPT has multiple composer layouts. Search only inside the
  // verified composer/form, never via an unrestricted document-wide button.
  const composerRoot = editor.closest('[data-testid="composer"]') ||
    editor.closest('[data-chatgpt-composer]') || form;
  const buttonSelectors = [
    'button#composer-submit-button',
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="送信"]',
    'button[aria-label="メッセージを送信"]',
    'button.composer-submit-btn',
    'button[type="submit"]'
  ];
  const sendButton = buttonSelectors.map(selector => {
    return form.querySelector(selector) ||
      (composerRoot !== form ? composerRoot.querySelector(selector) : null);
  }).find(button => {
    return button && button.tagName?.toUpperCase() !== 'INPUT' &&
      (typeof button.getClientRects !== 'function' || button.getClientRects().length > 0);
  }) || null;
  if (sendButton && !sendButton.disabled &&
      sendButton.getAttribute('aria-disabled') !== 'true') {
    return { ok: false, reason: 'existing-draft' };
  }
  // ChatGPT clears the file input after React consumes an upload. Track the
  // composer's existing image sources so we can detect a NEW thumbnail without
  // mistaking a static icon or previously displayed image for our transfer.
  const scope = editor.closest('[data-testid="composer"]') || form;
  const baselineImages = [...scope.querySelectorAll('img')]
    .filter(img => !img.closest('button'))
    .map(img => img.currentSrc || img.src || img.getAttribute('src') || '')
    .filter(Boolean);
  return { ok: true, baselineImages };
}

// Only called following a separate explicit 'attach and send' confirmation.
// Fail closed unless the expected file appears in the composer and the send
// button is ready. Never submit the form or use Enter as a fallback.
async function frameSendPreparedImageToChatGPT(expectedUrl, baselineImages = []) {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') {
    return { ok: false, reason: 'wrong-origin' };
  }
  if (typeof expectedUrl !== 'string' || location.href !== expectedUrl) {
    return { ok: false, reason: 'conversation-changed' };
  }
  const name = 'FRAME-vision.png';
  // Image uploads can take longer than 15s; wait for a stable thumbnail and
  // enabled send control, not just the file input's transient FileList.
  const timeoutAt = Date.now() + 45_000;
  const knownImages = new Set(Array.isArray(baselineImages) ? baselineImages : []);
  let readySince = null;
  const diagnostics = {
    imageDetected: false, sendButtonFound: false,
    sendButtonEnabled: false, uploading: false
  };

  while (Date.now() < timeoutAt) {
    if (location.href !== expectedUrl) {
      return { ok: false, reason: 'conversation-changed' };
    }
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
    const selectedFiles = [...document.querySelectorAll('input[type="file"]')]
      .flatMap(input => [...(input.files || [])]);
    if (selectedFiles.some(f => f.name !== name)) {
      return { ok: false, reason: 'other-attachment-added' };
    }
    const selectedFile = selectedFiles.some(f => f.name === name &&
      f.type === 'image/png');
    const chips = [...form.querySelectorAll('[role="group"][aria-label]')];
    if (chips.some(chip => {
      const label = chip.getAttribute('aria-label') || '';
      return /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(label) && label !== name;
    })) {
      return { ok: false, reason: 'other-attachment-added' };
    }
    const matchedChip = chips.some(chip => chip.getAttribute('aria-label') === name);
    const preview = form.querySelector('img[alt="FRAME-vision.png"]') ||
      form.querySelector('img[alt="FRAME-vision"]');

    const scope = editor.closest('[data-testid="composer"]') || form;
    const freshThumbnails = [...scope.querySelectorAll('img')].filter(img => {
      if (img.closest('button')) return false;
      const src = img.currentSrc || img.src || img.getAttribute('src') || '';
      return !!src && !knownImages.has(src) &&
        img.complete !== false && (!Number.isFinite(img.naturalWidth) || img.naturalWidth > 0);
    });
    // React may clear input.files, and image thumbnails often have generic
    // alt text. A NEW image inside the verified composer is still evidence.
    const hasOwnImage = matchedChip || !!preview || selectedFile ||
      freshThumbnails.length > 0;
    const uploading = !!scope.querySelector(
      '[role="progressbar"],[data-testid*="upload-progress"],[data-testid*="uploading"]'
    );
      // ChatGPT has multiple composer layouts. Search only inside the
      // verified composer/form, never via an unrestricted document-wide button.
      const composerRoot = editor.closest('[data-testid="composer"]') ||
        editor.closest('[data-chatgpt-composer]') || form;
      const buttonSelectors = [
        'button#composer-submit-button',
        'button[data-testid="send-button"]',
        'button[data-testid="fruitjuice-send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
        'button[aria-label="送信"]',
        'button[aria-label="メッセージを送信"]',
        'button.composer-submit-btn',
        'button[type="submit"]'
      ];
      const sendButton = buttonSelectors.map(selector => {
        return form.querySelector(selector) ||
          (composerRoot !== form ? composerRoot.querySelector(selector) : null);
      }).find(button => {
        return button && button.tagName?.toUpperCase() !== 'INPUT' &&
          (typeof button.getClientRects !== 'function' || button.getClientRects().length > 0);
      }) || null;
    const buttonReady = !!sendButton && sendButton.isConnected &&
      !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true';
    diagnostics.imageDetected = hasOwnImage;
    diagnostics.sendButtonFound = !!sendButton;
    diagnostics.sendButtonEnabled = buttonReady;
    diagnostics.uploading = uploading;
    if (hasOwnImage && buttonReady && !uploading) {
      if (readySince === null) readySince = Date.now();
      // Verify readiness remains stable before triggering a single send.
      if (Date.now() - readySince >= 1200) {
        if (location.href !== expectedUrl ||
            (editor.innerText || editor.textContent || '').trim() ||
            [...form.querySelectorAll('textarea')].some(t => t.value?.trim())) {
          return { ok: false, reason: 'draft-changed' };
        }
        sendButton.click();
        return { ok: true, status: 'send-clicked' };
      }
    } else {
      readySince = null;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { ok: false, reason: 'attachment-not-ready', diagnostics };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { frameVerifyEmptyChatGPTComposer, frameSendPreparedImageToChatGPT };
}
