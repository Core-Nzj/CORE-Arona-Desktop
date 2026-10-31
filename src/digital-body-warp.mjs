// Decide whether the transition can run while the model, rather than the
// model-selection placeholder, is visible. Keep this gate independently
// testable so a reversed hidden check cannot silently disable every effect.
export function shouldAnimateMotionWarp({ animate, enabled, available, placeholderHidden }) {
  return Boolean(animate && enabled && available && placeholderHidden);
}

// FRAME digital-body transfer. The WebGL canvas itself fades in every
// environment, even when Chromium cannot copy a GPU canvas into 2D Canvas.
// Fragments and scanning highlights are optional, never a reason to skip fade.
const clamp = value => Math.max(0, Math.min(1, value));
const wave = number => {
  const x = Math.sin(number * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export class DigitalBodyWarp {
  constructor(source, overlay, { disappearMs = 260, appearMs = 300 } = {}) {
    this.source = source;
    this.overlay = overlay;
    this.context = overlay?.getContext('2d', { alpha: true }) ?? null;
    this.disappearMs = disappearMs;
    this.appearMs = appearMs;
    this.phase = 'idle';
    this.since = 0;
    this.pending = null;
    this.fragmentsEnabled = Boolean(this.context);
    // A model without overlay support still fades. The preference switch,
    // rather than the OS reduced-motion hint, controls this explicit effect.
    this.enabled = Boolean(this.source?.style);
    if (this.overlay) this.overlay.hidden = true;
  }

  get active() { return this.phase !== 'idle'; }

  settle() {
    if (!this.pending) return;
    const resolve = this.pending;
    this.pending = null;
    resolve();
  }

  cancel() {
    this.phase = 'idle';
    if (this.source) this.source.style.opacity = '';
    if (this.overlay) this.overlay.hidden = true;
    this.context?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.settle();
  }

  conceal() {
    if (!this.enabled) return Promise.resolve();
    this.cancel();
    this.phase = 'out';
    this.since = performance.now();
    // Start from a completely visible body; render() fades it to zero.
    this.source.style.opacity = '1';
    if (this.overlay) this.overlay.hidden = !this.fragmentsEnabled;
    console.info('[FRAME warp] conceal start; fragments:', this.fragmentsEnabled);
    return new Promise(resolve => { this.pending = resolve; });
  }

  reveal() {
    if (!this.enabled || this.phase !== 'hidden') return Promise.resolve();
    this.phase = 'in';
    this.since = performance.now();
    this.source.style.opacity = '0';
    if (this.overlay) this.overlay.hidden = !this.fragmentsEnabled;
    console.info('[FRAME warp] reveal start');
    return new Promise(resolve => { this.pending = resolve; });
  }

  render(now) {
    if (this.phase === 'idle') return;

    const outgoing = this.phase === 'out';
    const duration = outgoing ? this.disappearMs : this.appearMs;
    const progress = clamp((now - this.since) / duration);
    if (this.phase === 'hidden') {
      this.source.style.opacity = '0';
      return;
    }
    if (progress >= 1) {
      if (outgoing) {
        this.source.style.opacity = '0';
        this.context?.clearRect(0, 0, this.overlay.width, this.overlay.height);
        this.phase = 'hidden';
        this.settle();
      } else {
        this.cancel();
      }
      return;
    }

    const visibility = outgoing ? (1 - progress) ** 1.6 : progress ** 1.5;
    // Guaranteed fallback: the body itself fades. This does not depend on a
    // 2D context, GPU canvas readback, image assets or Windows animations.
    this.source.style.opacity = visibility.toFixed(3);
    if (!this.context || !this.fragmentsEnabled) return;
    const ctx = this.context;
    const width = Math.max(1, Math.round(this.overlay.clientWidth));
    const height = Math.max(1, Math.round(this.overlay.clientHeight));
    if (this.overlay.width !== width || this.overlay.height !== height) {
      this.overlay.width = width;
      this.overlay.height = height;
    }
    ctx.clearRect(0, 0, width, height);

    const glitch = Math.sin(Math.PI * progress);
    try {
      const bandHeight = Math.max(8, Math.round(height / 62));
      const tick = Math.floor(now / 42);
      const srcHeight = this.source.height;
      ctx.globalAlpha = clamp(glitch * 0.34);
      ctx.drawImage(this.source, 0, 0, width, height);
      for (let y = 0, band = 0; y < height; y += bandHeight, band++) {
        const seed = wave(band * 7.7 + tick * 0.21);
        if (seed < 0.38) continue;
        const h = Math.min(bandHeight, height - y);
        const offset = Math.round((wave(band * 13.4 + tick) - 0.5) * 44 * glitch);
        const sy = Math.floor(y * srcHeight / height);
        const sh = Math.max(1, Math.ceil(h * srcHeight / height));
        ctx.globalAlpha = clamp((0.25 + seed * 0.4) * glitch);
        ctx.drawImage(this.source, 0, sy, this.source.width, sh,
          offset, y, width, h);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(65, 197, 255, ' + (0.22 * glitch).toFixed(3) + ')';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(155, 229, 255, ' + (0.45 * glitch).toFixed(3) + ')';
      for (let i = 0; i < 14; i++) {
        const y = Math.round(wave(i * 11.3 + tick * 0.08) * height);
        ctx.fillRect(0, y, width, Math.max(1, Math.round(height / 700)));
      }
    } catch (error) {
      // GPU-to-2D copies can fail on some graphics drivers. Retain the
      // guaranteed main-canvas fade, and avoid continuously retrying.
      console.warn('[FRAME warp] fragments unavailable, using fade:', error);
      this.fragmentsEnabled = false;
      this.overlay.hidden = true;
    } finally {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
