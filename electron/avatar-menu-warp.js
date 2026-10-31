'use strict';

// FRAME menu transfer: use the same 260ms/300ms cadence and cyan-heavy
// blue/turquoise palette as the avatar's DigitalBodyWarp. The window is
// preloaded; the first visible frame is always the animated transfer.
class PanelDigitalWarp {
  constructor(shell, canvas) {
    this.shell = shell;
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    this.phase = 'closed';
    this.started = 0;
    this.readyAt = 0;
    this.closingDone = null;
    this.frame = 0;
    this.canvas.hidden = true;
  }

  static wave(n) {
    const value = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  }

  static color(seed) {
    return seed < 0.6 ? '65,197,255' : seed < 0.9 ? '48,142,224' : '64,221,207';
  }

  beginFrame() {
    if (!this.frame) this.frame = requestAnimationFrame(now => this.render(now));
  }

  open() {
    this.closingDone = null;
    this.phase = 'opening';
    this.started = performance.now();
    this.readyAt = 0;
    this.shell.style.opacity = '0';
    this.shell.style.pointerEvents = 'none';
    this.canvas.hidden = false;
    this.beginFrame();
  }

  ready() {
    if (this.phase !== 'opening') return;
    this.readyAt = performance.now();
    // Keep the effect visible for a few frames only when state restore is
    // faster than animation itself; never wait for the voice engine.
    this.beginFrame();
  }

  close(onDone) {
    if (this.phase === 'closed' || this.phase === 'closing') return;
    this.closingDone = onDone;
    this.phase = 'closing';
    this.started = performance.now();
    this.shell.style.opacity = '1';
    this.shell.style.pointerEvents = 'none';
    this.canvas.hidden = false;
    this.beginFrame();
  }

  settle() {
    this.phase = 'closed';
    this.canvas.hidden = true;
    this.shell.style.opacity = '0';
    this.shell.style.pointerEvents = 'none';
    this.context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const done = this.closingDone;
    this.closingDone = null;
    done?.();
  }

  render(now) {
    this.frame = 0;
    if (this.phase === 'closed' || this.phase === 'visible') return;
    const closing = this.phase === 'closing';
    const elapsed = Math.max(0, now - this.started);
    const progress = Math.min(1, elapsed / (closing ? 260 : 300));
    if (closing) {
      this.shell.style.opacity = ((1 - progress) ** 1.6).toFixed(3);
      if (progress >= 1) { this.settle(); return; }
    } else if (this.readyAt && elapsed >= 180) {
      // No post-restore hold. Replace the transfer with the fully restored UI.
      this.phase = 'visible';
      this.shell.style.opacity = '1';
      this.shell.style.pointerEvents = '';
      this.canvas.hidden = true;
      return;
    }
    this.draw(now, closing, progress);
    this.beginFrame();
  }

  draw(now, closing, progress) {
    const ctx = this.context;
    if (!ctx) return; // A transparent-shell fade is still available.
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const pw = Math.round(w * pixelRatio);
    const ph = Math.round(h * pixelRatio);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const oscillation = Math.sin(Math.PI * Math.min(1, progress));
    const tick = Math.floor(now / 42);
    // A dark translucent silhouette appears immediately, then resolves
    // into scattered digital slices and bright scanlines.
    if (!closing) {
      ctx.fillStyle = 'rgba(29,29,31,0.56)';
      ctx.fillRect(5, 5, w - 10, h - 10);
    }
    const bandHeight = Math.max(7, Math.ceil(h / 62));
    for (let y = 7, band = 0; y < h - 7; y += bandHeight, band++) {
      const seed = PanelDigitalWarp.wave(band * 7.7 + tick * 0.21);
      if (seed < 0.38) continue;
      const color = PanelDigitalWarp.color(PanelDigitalWarp.wave(band * 17.13 + tick * 0.37));
      const offset = (PanelDigitalWarp.wave(band * 13.4 + tick) - 0.5) * 44 * oscillation;
      const x = Math.max(5, 5 + offset);
      const length = Math.max(12, (w - 12) * (0.12 + seed * 0.83));
      const alpha = (0.18 + seed * 0.42) * (closing ? oscillation : 0.5 + 0.5 * oscillation);
      ctx.fillStyle = 'rgba(' + color + ',' + alpha.toFixed(3) + ')';
      ctx.fillRect(x, y, Math.min(length, w - x - 5), Math.min(bandHeight, h - y - 7));
    }
    for (let i = 0; i < 14; i++) {
      const y = PanelDigitalWarp.wave(i * 11.3 + tick * 0.08) * h;
      const color = PanelDigitalWarp.color(PanelDigitalWarp.wave(i * 21.47 + tick * 0.16));
      ctx.fillStyle = 'rgba(' + color + ',' + (0.25 + 0.5 * oscillation).toFixed(3) + ')';
      ctx.fillRect(5, y, w - 10, Math.max(1, Math.round(h / 700)));
    }
  }
}

window.PanelDigitalWarp = PanelDigitalWarp;
