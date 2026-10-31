// Deterministic gait-review checkpoints. Sample the VMD at exact 30fps key
// positions, independent of FRAME's selected render FPS or wall-clock delays.
export const LAB_FRAMES = Object.freeze([0, 4, 8, 12, 16, 20, 24, 28, 32]);
export const LAB_DIRECTIONS = Object.freeze([-1, 1]);
export const LAB_VIEWS = Object.freeze(['front', 'three-quarter', 'side']);
export function labCameraAlpha(view, direction) {
  const reverse = direction === -1;
  switch (view) {
    case 'front': return -Math.PI / 2;
    case 'three-quarter': return reverse ? -3 * Math.PI / 4 : -Math.PI / 4;
    case 'side': return reverse ? -Math.PI : 0;
    default: throw new Error('Invalid gait review angle: ' + view);
  }
}
export function labFileName(direction, view, frame) {
  if (!LAB_DIRECTIONS.includes(direction) || !LAB_VIEWS.includes(view) ||
      !LAB_FRAMES.includes(frame)) throw new Error('Invalid gait review checkpoint');
  return 'walk-' + (direction === -1 ? 'left' : 'right') + '-' + view +
    '-f' + String(frame).padStart(2, '0') + '.png';
}
export function labSheetName(direction, view) {
  if (!LAB_DIRECTIONS.includes(direction) || !LAB_VIEWS.includes(view)) {
    throw new Error('Invalid gait review sheet');
  }
  return 'sheet-' + (direction === -1 ? 'left' : 'right') + '-' + view + '.png';
}
