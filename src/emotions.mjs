/**
 * CORE Desktop emotion presets.
 * Each character brings its own PMX/PMD facial morphs. We only control
 * detected emotion morphs; blink and vowel/lip-sync channels remain untouched.
 * This module deliberately has no dependency on Electron or Babylon.
 */

export const EMOTION_PRESETS = Object.freeze({
  neutral: Object.freeze({ label: '通常', aliases: Object.freeze([]) }),
  happy: Object.freeze({
    label: '笑顔',
    aliases: Object.freeze(['にこり', '笑顔', '微笑み', 'にやり', 'スマイル', '笑い', 'smile', 'Smile', 'happy', 'Happy'])
  }),
  angry: Object.freeze({
    label: '怒り',
    aliases: Object.freeze(['怒り', '怒る', '怒', 'むっ', 'angry', 'Angry', 'anger'])
  }),
  sad: Object.freeze({
    label: '悲しみ',
    aliases: Object.freeze(['悲しい', '悲しみ', '困る', '泣き', '泣く', 'sad', 'Sad', 'sadness'])
  }),
  surprised: Object.freeze({
    label: '驚き',
    aliases: Object.freeze(['びっくり', '驚き', '驚く', 'はぅ', 'surprise', 'Surprise', 'surprised', 'Surprised'])
  })
});
export const EMOTION_IDS = Object.freeze(Object.keys(EMOTION_PRESETS));

const clamp = value => Math.max(0, Math.min(1, value));

export class EmotionController {
  /**
   * @param {{ getMorphIndices(name:string): readonly number[] | undefined,
   *            setMorphWeight(name:string, weight:number):void }} morph
   * @param {{ transitionSeconds?:number }} options
   */
  constructor(morph, { transitionSeconds = 0.22 } = {}) {
    if (!morph?.getMorphIndices || !morph?.setMorphWeight) {
      throw new TypeError('An MMD morph controller is required');
    }
    this.morph = morph;
    this.transitionSeconds = Math.max(0.01, transitionSeconds);
    this.selected = 'neutral';
    this.resolved = {};
    this.weights = new Map();
    this.disposed = false;

    for (const id of EMOTION_IDS) {
      if (id === 'neutral') continue;
      const name = EMOTION_PRESETS[id].aliases.find(alias => {
        const indices = morph.getMorphIndices(alias);
        return indices !== undefined && indices.length > 0;
      });
      this.resolved[id] = name ?? null;
      if (name && !this.weights.has(name)) this.weights.set(name, 0);
    }
  }

  available() {
    return Object.fromEntries(EMOTION_IDS.map(id => [
      id, id === 'neutral' || this.resolved[id] !== null
    ]));
  }

  diagnostics() {
    return EMOTION_IDS.filter(id => id !== 'neutral').map(id => {
      const name = this.resolved[id];
      return EMOTION_PRESETS[id].label + '：' + (name ?? '対応モーフなし');
    }).join('\n');
  }

  select(id) {
    if (this.disposed || !Object.hasOwn(EMOTION_PRESETS, id)) return false;
    if (id !== 'neutral' && this.resolved[id] === null) return false;
    this.selected = id;
    return true;
  }

  tick(deltaSeconds) {
    if (this.disposed) return;
    const delta = Number.isFinite(deltaSeconds) ? clamp(deltaSeconds) : 0;
    const t = 1 - Math.exp(-delta / this.transitionSeconds);
    const targetName = this.resolved[this.selected] ?? null;
    for (const [name, current] of this.weights) {
      const target = name === targetName ? 1 : 0;
      let next = current + (target - current) * t;
      if (Math.abs(next - target) < 0.001) next = target;
      if (next === current) continue;
      this.morph.setMorphWeight(name, next);
      this.weights.set(name, next);
    }
  }

  dispose() {
    if (this.disposed) return;
    for (const name of this.weights.keys()) this.morph.setMorphWeight(name, 0);
    this.disposed = true;
    this.weights.clear();
  }
}
