// Motion Lab: capture the actual Babylon/WebGL body at deterministic VMD
// frames. Never include the rest of the desktop in screenshots.
import { buildWalkingVmd, walkFootAt, WALK_FRAMES } from './walk-vmd.mjs';
import { LAB_FRAMES, LAB_DIRECTIONS, LAB_VIEWS, LAB_TARGET_HEIGHT_SHARE,
  labZoomForBounds, labCameraAlpha, labFileName, labSheetName } from './motion-lab.mjs';

// A neutral background makes black shoes and white hair visible together.
// This is painted only into exported PNGs, never into the live overlay.
export const LAB_BACKGROUND = '#969AA4';
export const LAB_CAMERA_FOV = 0.7;
export const LAB_GROUND_REFERENCE = 'visible silhouette bottom at F00, fixed within each direction and view';
const LAB_MAX_WIDTH = 960;
const LAB_MAX_HEIGHT = 1440;

// Extract actual non-transparent pixel bounds instead of trusting PMX root
// bounds, which may contain invisible helper meshes below the visible feet.
function measureSilhouette(canvas) {
  const factor = Math.min(1, 480 / canvas.width, 720 / canvas.height);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(canvas.width * factor));
  small.height = Math.max(1, Math.round(canvas.height * factor));
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  const { data } = ctx.getImageData(0, 0, small.width, small.height);
  let minX = small.width, minY = small.height, maxX = -1, maxY = -1;
  // A small alpha threshold discards driver-level transparent noise.
  for (let y = 0; y < small.height; y += 2) {
    for (let x = 0; x < small.width; x += 2) {
      if (data[(y * small.width + x) * 4 + 3] < 32) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  const scaleX = canvas.width / small.width;
  const scaleY = canvas.height / small.height;
  return {
    width: (maxX - minX + 2) * scaleX,
    height: (maxY - minY + 2) * scaleY,
    bottom: Math.min(canvas.height, (maxY + 2) * scaleY)
  };
}

function captureCanvas(canvas, baselineY, note) {
  // Preserve all original WebGL pixels up to 960×1440. Never upscale a low-
  // resolution source and pretend it contains details that were not rendered.
  const factor = Math.min(1, LAB_MAX_WIDTH / canvas.width, LAB_MAX_HEIGHT / canvas.height);
  const width = Math.max(1, Math.round(canvas.width * factor));
  const height = Math.max(1, Math.round(canvas.height * factor));
  const shot = document.createElement('canvas');
  shot.width = width;
  shot.height = height;
  const ctx = shot.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('キャプチャ用Canvasを初期化できませんでした');
  ctx.fillStyle = LAB_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  // Draw reference before the avatar; the line must never hide the shoes.
  const y = baselineY === null ? null : baselineY * (height / canvas.height);
  if (y !== null && y >= 0 && y < height) {
    ctx.save();
    ctx.strokeStyle = '#586474';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#354355';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('VISUAL BASELINE (F00)', 9, Math.max(36, Math.round(y) - 6));
    ctx.restore();
  }
  ctx.drawImage(canvas, 0, 0, width, height);
  ctx.save();
  ctx.fillStyle = 'rgba(29,29,31,0.78)';
  ctx.fillRect(0, 0, width, 24);
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(note, 9, 16);
  ctx.restore();
  return shot;
}

function newSheet(image) {
  // Keep contact sheets compact, even if each individual PNG is high-res.
  const factor = Math.min(1, 480 / image.width, 720 / image.height);
  const cellWidth = Math.max(1, Math.round(image.width * factor));
  const cellHeight = Math.max(1, Math.round(image.height * factor));
  const pad = 8, label = 33;
  const sheet = document.createElement('canvas');
  sheet.width = (cellWidth + pad) * 3 + pad;
  sheet.height = (cellHeight + pad + label) * 3 + pad;
  const ctx = sheet.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('比較用Canvasを初期化できませんでした');
  ctx.fillStyle = '#20242c';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  return { sheet, ctx, pad, label, cellWidth, cellHeight };
}

function addSheetFrame(target, image, index, frame) {
  const x = target.pad + (index % 3) * (target.cellWidth + target.pad);
  const y = target.pad + Math.floor(index / 3) *
    (target.cellHeight + target.pad + target.label);
  target.ctx.drawImage(image, x, y, target.cellWidth, target.cellHeight);
  target.ctx.fillStyle = '#f5f5f7';
  target.ctx.font = 'bold 16px sans-serif';
  target.ctx.fillText('F' + String(frame).padStart(2, '0') +
    '  ' + (frame / 30).toFixed(2) + 's', x + 6, y + target.cellHeight + 21);
}

export async function captureWalkingReview({
  model, root, camera, canvas, scene, runtime, loader,
  originalHandle, originalFrame, originalDuration, wasPlaying,
  save
}) {
  if (!model || !root || !originalHandle || !canvas.width || !canvas.height) {
    throw new Error('モデルまたは再生中のMMDモーションが未準備です');
  }
  const savedCamera = {
    alpha: camera.alpha, beta: camera.beta,
    fov: camera.fov, radius: camera.radius
  };
  const heightBounds = root.getHierarchyBoundingVectors(true);
  const modelHeight = heightBounds.max.y - heightBounds.min.y;
  const boneNames = model.runtimeBones.map(bone => bone.name);
  const temporaryHandles = [];
  const variants = [];
  let metadata = null;

  runtime.pauseAnimation();
  try {
    // Fixed observer angle and FOV. Distances are set from the VISIBLE
    // silhouette, not the (sometimes excessively large) rig bounding box.
    camera.beta = Math.PI / 2;
    camera.fov = LAB_CAMERA_FOV;
    for (const direction of LAB_DIRECTIONS) {
      const result = buildWalkingVmd({ boneNames, modelHeight, direction });
      const animation = await loader.loadFromBufferAsync(
        direction === -1 ? 'FRAME motion lab left' : 'FRAME motion lab right', result.buffer);
      const handle = model.createRuntimeAnimation(animation);
      temporaryHandles.push(handle);
      variants.push({ direction, result, handle });
    }

    // Pilot poses cover contact and swing on both sides. Choose ONE camera
    // distance across all views and directions so comparisons remain fair.
    const samples = [];
    for (const variant of variants) {
      model.setRuntimeAnimation(variant.handle);
      runtime.setManualAnimationDuration(WALK_FRAMES);
      for (const view of LAB_VIEWS) {
        camera.alpha = labCameraAlpha(view, variant.direction);
        for (const frame of [0, 9, 18, 27]) {
          await runtime.seekAnimation(frame, true);
          scene.render();
          const bounds = measureSilhouette(canvas);
          if (bounds) samples.push(bounds);
        }
      }
    }
    const zoom = labZoomForBounds(samples, canvas.width, canvas.height);
    camera.radius = savedCamera.radius / zoom;

    for (const variant of variants) {
      const { direction, result, handle } = variant;
      model.setRuntimeAnimation(handle);
      runtime.setManualAnimationDuration(WALK_FRAMES);
      metadata = {
        modelHeight, stride: result.stride, bones: result.rig,
        captureProfile: {
          background: LAB_BACKGROUND,
          cameraFov: LAB_CAMERA_FOV,
          cameraRadius: camera.radius,
          framingZoom: zoom,
          targetHeightShare: LAB_TARGET_HEIGHT_SHARE,
          imageMaxWidth: LAB_MAX_WIDTH,
          imageMaxHeight: LAB_MAX_HEIGHT,
          fixedCameraBeta: Math.PI / 2,
          groundReference: LAB_GROUND_REFERENCE,
          note: 'Visual baseline is the rendered silhouette bottom at F00, NOT the physical floor. Framing is based on actual WebGL silhouette pixels.'
        }
      };

      for (const view of LAB_VIEWS) {
        camera.alpha = labCameraAlpha(view, direction);
        let sheet = null, baselineY = null;
        for (let index = 0; index < LAB_FRAMES.length; index++) {
          const frame = LAB_FRAMES[index];
          await runtime.seekAnimation(frame, true);
          scene.render();
          // F00 always contains a planted foot. Use the ACTUAL rendered
          // lowest point and keep that pixel row fixed for all nine frames.
          if (index === 0) baselineY = measureSilhouette(canvas)?.bottom ?? null;
          const phase = frame / WALK_FRAMES;
          const lift = modelHeight * 0.025;
          const leftFoot = walkFootAt(phase, result.stride, lift, direction);
          const rightFoot = walkFootAt(phase + 0.5, result.stride, lift, direction);
          const note = 'L:' + (leftFoot.planted ? 'CONTACT' : 'SWING') +
            '    R:' + (rightFoot.planted ? 'CONTACT' : 'SWING');
          const shot = captureCanvas(canvas, baselineY, note);
          if (!sheet) sheet = newSheet(shot);
          addSheetFrame(sheet, shot, index, frame);
          const info = { frame, direction, view, leftFoot, rightFoot };
          await save(labFileName(direction, view, frame), shot.toDataURL('image/png'), info);
        }
        if (sheet) await save(labSheetName(direction, view),
          sheet.sheet.toDataURL('image/png'), { direction, view });
      }
    }
    return metadata;
  } finally {
    // All four camera parameters and the initial animation state are restored
    // even if a capture, PNG save or motion seek fails midway.
    camera.alpha = savedCamera.alpha;
    camera.beta = savedCamera.beta;
    camera.fov = savedCamera.fov;
    camera.radius = savedCamera.radius;
    try {
      model.setRuntimeAnimation(originalHandle);
      runtime.setManualAnimationDuration(originalDuration);
      await runtime.seekAnimation(originalFrame, true);
      if (wasPlaying) await runtime.playAnimation();
      else runtime.pauseAnimation();
    } finally {
      for (const handle of temporaryHandles) {
        try { model.destroyRuntimeAnimation(handle); }
        catch (error) { console.warn('[FRAME motion lab] temp cleanup failed:', error); }
      }
      scene.render();
    }
  }
}
