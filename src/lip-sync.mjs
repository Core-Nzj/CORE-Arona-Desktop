// Lightweight speech-energy lip sync. The MMD runtime keeps ownership of
// animation tracks, while this controller writes only one detected vowel morph.
const MOUTH_ALIASES = ['あ', 'あいうえお', '口あ', 'mouth_a', 'A', 'a', 'Ah', 'ah'];
const clamp = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

export function mouthLevelFromSamples(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (const value of samples) sum += value * value;
  const rms = Math.sqrt(sum / samples.length);
  // Quiet background noise should leave the mouth closed.
  return clamp((rms - 0.012) / 0.16);
}

export class LipSyncController {
  constructor(morph) {
    if (!morph?.getMorphIndices || !morph?.setMorphWeight) {
      throw new TypeError('MMD morph controller required');
    }
    this.morph = morph;
    this.name = MOUTH_ALIASES.find(alias => (morph.getMorphIndices(alias)?.length ?? 0) > 0) ?? null;
    this.target = 0;
    this.weight = 0;
    this.disposed = false;
  }

  setLevel(value) { this.target = clamp(value); }

  tick(dt) {
    if (this.disposed || !this.name) return;
    const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    const timeConstant = this.target > this.weight ? 0.055 : 0.105;
    this.weight += (this.target - this.weight) * (1 - Math.exp(-seconds / timeConstant));
    if (this.target === 0 && this.weight < 0.004) this.weight = 0;
    this.morph.setMorphWeight(this.name, this.weight);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.name) this.morph.setMorphWeight(this.name, 0);
  }
}
