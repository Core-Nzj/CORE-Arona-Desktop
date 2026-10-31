'use strict';

// This function is serialized by chrome.scripting.executeScript and runs only
// after the user clicks "Attach to ChatGPT" in the receiver popup.
// Keep it self-contained; it must not depend on popup scope or external code.
function frameAttachPngToChatGPT(dataUrl) {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') {
    return { ok: false, reason: 'wrong-origin' };
  }
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) ||
      dataUrl.length > 12 * 1024 * 1024) {
    return { ok: false, reason: 'invalid-png-data' };
  }
  const editor = document.querySelector('#prompt-textarea') ||
    document.querySelector('[data-testid="composer"] [contenteditable="true"]') ||
    document.querySelector('form [contenteditable="true"]');
  if (!editor) return { ok: false, reason: 'composer-not-found' };

  let binary;
  try { binary = atob(dataUrl.slice(prefix.length)); }
  catch { return { ok: false, reason: 'invalid-png-base64' }; }
  if (binary.length < 33 || binary.length > 8 * 1024 * 1024 ||
      binary.charCodeAt(0) !== 137 || binary.slice(1, 4) !== 'PNG') {
    return { ok: false, reason: 'invalid-png-file' };
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // The file is constructed in page memory. No file-system path or OS clipboard.
  const file = new File([bytes], 'FRAME-vision.png', { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);

  const form = editor.closest('form');
  const inputs = [...document.querySelectorAll('input[type="file"]')].filter(input => {
    if (input.disabled) return false;
    const accept = (input.accept || '').toLowerCase();
    return !accept || accept.includes('image') ||
      accept.includes('png') || accept.includes('*/*');
  });
  const withinForm = form ? inputs.filter(input => form.contains(input)) : [];
  // Refuse to guess if multiple unrelated upload controls are on the page.
  const targetInput = withinForm.length === 1 ? withinForm[0] :
    withinForm.length > 1 ? null :
      inputs.length === 1 ? inputs[0] : null;

  if (targetInput) {
    try {
      targetInput.files = transfer.files;
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, mode: 'file-input', confirmed: false };
    } catch (error) {
      return { ok: false, reason: 'file-input-rejected' };
    }
  }

  // No suitable input is mounted. Try the same in-memory file drop that a
  // manual drag-and-drop uses. Synthetic events may be ignored by ChatGPT.
  const dropTarget = editor.closest('[data-testid="composer"]') || form || editor;
  try {
    for (const name of ['dragenter', 'dragover', 'drop']) {
      dropTarget.dispatchEvent(new DragEvent(name, {
        bubbles: true, cancelable: true, dataTransfer: transfer
      }));
    }
    return { ok: true, mode: 'drop-attempt', confirmed: false };
  } catch {
    return { ok: false, reason: 'no-compatible-upload-control' };
  }
}

// Export only for isolated Node tests. In Chrome this is a script function,
// not an always-running content script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { frameAttachPngToChatGPT };
}
