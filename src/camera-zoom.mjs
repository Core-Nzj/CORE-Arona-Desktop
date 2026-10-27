// Narrowing the field of view zooms without moving through the MMD mesh.
export function fovForZoom(baseFov, zoom) {
  if (!(baseFov > 0 && baseFov < Math.PI) || !(zoom >= 1) ||
      !Number.isFinite(baseFov) || !Number.isFinite(zoom)) {
    throw new RangeError('Invalid optical zoom');
  }
  return 2 * Math.atan(Math.tan(baseFov / 2) / zoom);
}

// Framerate-independent easing for wheel bursts.
export function approachZoom(current, target, seconds, responsiveness = 18) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return current;
  if (Math.abs(target - current) < 0.001) return target;
  const amount = 1 - Math.exp(-Math.min(seconds, 0.1) * responsiveness);
  const next = current + (target - current) * amount;
  return Math.abs(target - next) < 0.001 ? target : next;
}
