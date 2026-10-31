// Motion Lab presentation settings are independent of the desktop avatar's
// transparent window and the VMD generator. Preserve a neutral, well-lit
// reference image for black clothing/shoes and white hair.
export const LAB_STUDIO_VERSION = 2;
export const LAB_BACKGROUND = '#969AA4';
export const LAB_FLOOR_GUIDE = 'rgba(39, 48, 63, 0.55)';
export const LAB_FLOOR_CAPTION = '#353E50';

// The ground line projects the *initial* model-space minimum Y at the center
// of the character. It is a visual reference only, not a contact measurement.
export function projectedGroundPixel(y, sourceHeight, targetHeight) {
  if (!Number.isFinite(y) || !Number.isFinite(sourceHeight) ||
      !Number.isFinite(targetHeight) || sourceHeight <= 0 || targetHeight <= 0) return null;
  const scaled = y * (targetHeight / sourceHeight);
  return scaled >= 8 && scaled <= targetHeight - 8 ? Math.round(scaled) : null;
}
export function gaitPhaseCaption(info) {
  const contact = foot => foot?.planted === true ? 'CONTACT' : 'SWING';
  return 'L: ' + contact(info?.leftFoot) + '   R: ' + contact(info?.rightFoot);
}
