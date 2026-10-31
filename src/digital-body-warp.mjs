// FRAME digital-body transfer: the character is converted into temporary
// screen-space fragments while the next MMD pose is loaded invisibly.
// No external assets or shader packages are required.
const clamp = value => Math.max(0, Math.min(1, value));
const wave = number => {
  const x = Math.sin(number * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export class DigitalBodyWarp {
  constructor(source, overlay, { disappearMs = 230, appearMs = 280 } = {}) {
    this.source = source;
    this.overlay = overlay;
    this.context = overlay.getContext('2d', { alpha: true });
    this.disappearMs = disappearMs;
    this.appearMs = appearMs;
    this.phase = 'idle';
    this.since = 0;
    this.pending = null;
    this.enabled = this.context !== null;
    this.overlay.hidden = true;
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
    this.source.style.opacity = '';
    this.overlay.hidden = true;
    this.context?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.settle();
  }

  conceal() {
    if (!this.enabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return Promise.resolve();
    }
    this.cancel();
    this.phase = 'out';
    this.since = performance.now();
    this.overlay.hidden = false;
    this.source.style.opacity = '0';
    return new Promise(resolve => { this.pending = resolve; });
  }

  reveal() {
    if (!this.enabled || this.phase !== 'hidden') return Promise.resolve();
    this.phase = 'in';
    this.since = performance.now();
    return new Promise(resolve => { this.pending = resolve; });
  }

  render(now) {
    if (this.phase === 'idle') return;
    const ctx = this.context;
    if (!ctx) { this.cancel(); return; }

    const width = Math.max(1, Math.round(this.overlay.clientWidth));
    const height = Math.max(1, Math.round(this.overlay.clientHeight));
    if (this.overlay.width !== width || this.overlay.height !== height) {
      this.overlay.width = width;
      this.overlay.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    if (this.phase === 'hidden') return;

    const outgoing = this.phase === 'out';
    const duration = outgoing ? this.disappearMs : this.appearMs;
    const progress = clamp((now - this.since) / duration);
    if (progress >= 1) {
      if (outgoing) {
        this.phase = 'hidden';
        this.settle();
      } else {
        this.cancel();
      }
      return;
    }

    // The source WebGL canvas is still animated, even though CSS hides it.
    // Copy only its translucent character pixels onto a temporary 2D canvas.
    const visibility = outgoing ? Math.pow(1 - progress, 1.2) : Math.pow(progress, 0.85);
    const glitch = Math.sin(Math.PI * progress);
    try {
      ctx.globalAlpha = visibility;
      ctx.drawImage(this.source, 0, 0, width, height);
      ctx.globalAlpha = 1;

      const bandHeight = Math.max(8, Math.round(height / 62));
      const sourceHeight = this.source.height;
      const tick = Math.floor(now / 42);
      for (let y = 0, band = 0; y < height; y += bandHeight, band++) {
        const heightHere = Math.min(bandHeight, height - y);
        const seed = wave(band * 7.7 + tick * 0.21);
        if (seed < 0.38) continue;
        const offset = Math.round((wave(band * 13.4 + tick) - 0.5) * 34 * glitch);
        const sy = Math.floor(y * sourceHeight / height);
        const sh = Math.max(1, Math.ceil(heightHere * sourceHeight / height));
        ctx.globalAlpha = clamp(visibility * glitch * (0.28 + 0.35 * seed));
        ctx.drawImage(this.source, 0, sy, this.source.width, sh,
          offset, y, width, heightHere);
      }
      ctx.globalAlpha = 1;

      // Cyan scan fragments are clipped to the character silhouette.
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(48, 191, 255, ' + (0.12 * glitch).toFixed(3) + ')';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(130, 226, 255, ' + (0.30 * glitch).toFixed(3) + ')';
      for (let i = 0; i < 12; i++) {
        const yy = Math.round(wave(i * 11.3 + tick * 0.08) * height);
        ctx.fillRect(0, yy, width, Math.max(1, Math.round(height / 600)));
      }
    } catch (error) {
      console.warn('[FRAME warp] drawing failed, continuing without effect', error);
      this.cancel();
    } finally {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
