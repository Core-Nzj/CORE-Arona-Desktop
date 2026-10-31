// Motion Lab: capture the actual Babylon/WebGL body at deterministic VMD
// frames, not the entire desktop or an empty transparent Electron surface.
import { buildWalkingVmd, walkFootAt, WALK_FRAMES } from './walk-vmd.mjs';
import { LAB_FRAMES, LAB_DIRECTIONS, LAB_VIEWS,
  labCameraAlpha, labFileName, labSheetName } from './motion-lab.mjs';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';

// Constant lab illumination is a post-process background only: it never
// changes the desktop's transparent 3D overlay or the model's materials.
export const LAB_BACKGROUND = '#969AA4';
export const LAB_CAMERA_FOV = 0.7;
export const LAB_GROUND_REFERENCE = 'projected initial model bounds minimum Y';

// Project the model's original lower extent to an image-space guide line.
// This is only a visual alignment reference; it is NOT a physics ground test.
function referenceLineY({ camera, scene, canvas, point }) {
  const viewport = camera.viewport.toGlobal(canvas.width, canvas.height);
  const projected = Vector3.Project(point, Matrix.Identity(), scene.getTransformMatrix(), viewport);
  return Number.isFinite(projected.y) ? projected.y : null;
}

function captureCanvas(canvas, lineY, note) {
  const factor = Math.min(1, 480 / canvas.width, 720 / canvas.height);
  const width = Math.max(1, Math.round(canvas.width * factor));
  const height = Math.max(1, Math.round(canvas.height * factor));
  const shot = document.createElement('canvas');
  shot.width = width;
  shot.height = height;
  const ctx = shot.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('キャプチャ用Canvasを初期化できませんでした');
  // Neutral mid-gray reveals both black boots/clothes and bright hair.
  // Keep the same profile for every frame, direction, and re-capture.
  ctx.fillStyle = LAB_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  const scaledY = lineY === null ? null : lineY * (height / canvas.height);
  if (scaledY !== null && scaledY >= 0 && scaledY <= height) {
    ctx.save();
    ctx.strokeStyle = '#586474';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(scaledY) + 0.5);
    ctx.lineTo(width, Math.round(scaledY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#354355';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('GROUND REF (approx.)', 9, Math.max(14, Math.round(scaledY) - 6));
    ctx.restore();
  }
  // Draw the avatar AFTER the line, so shoes are not obscured by the guide.
  ctx.drawImage(canvas, 0, 0, width, height);
  if (note) {
    ctx.save();
    ctx.fillStyle = 'rgba(29,29,31,0.78)';
    ctx.fillRect(0, 0, width, 24);
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(note, 9, 16);
    ctx.restore();
  }
  return shot;
}

function newSheet(shotWidth, shotHeight) {
  const pad = 8;
  const label = 33;
  const sheet = document.createElement('canvas');
  sheet.width = (shotWidth + pad) * 3 + pad;
  sheet.height = (shotHeight + pad + label) * 3 + pad;
  const ctx = sheet.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('比較用Canvasを初期化できませんでした');
  ctx.fillStyle = '#20242c';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  return { sheet, ctx, pad, label };
}

function addSheetFrame(target, image, index, frame) {
  const x = target.pad + (index % 3) * (image.width + target.pad);
  const y = target.pad + Math.floor(index / 3) * (image.height + target.pad + target.label);
  target.ctx.drawImage(image, x, y);
  // Index, time, and the matching VMD phase are visible on the contact sheet.
  target.ctx.fillStyle = '#f5f5f7';
  target.ctx.font = 'bold 16px sans-serif';
  target.ctx.fillText('F' + String(frame).padStart(2, '0') +
    '  ' + (frame / 30).toFixed(2) + 's', x + 6, y + image.height + 21);
}

export async function captureWalkingReview({
  model, root, camera, canvas, scene, runtime, loader,
  originalHandle, originalFrame, originalDuration, wasPlaying,
  save
}) {
  if (!model || !root || !originalHandle || !canvas.width || !canvas.height) {
    throw new Error('モデルまたは再生中のMMDモーションが未準備です');
  }
  const savedCamera = { alpha: camera.alpha, beta: camera.beta, fov: camera.fov };
  const heightBounds = root.getHierarchyBoundingVectors(true);
  const modelHeight = heightBounds.max.y - heightBounds.min.y;
  const groundPoint = new Vector3(
    (heightBounds.min.x + heightBounds.max.x) / 2,
    heightBounds.min.y,
    (heightBounds.min.z + heightBounds.max.z) / 2
  );
  const boneNames = model.runtimeBones.map(bone => bone.name);
  const temporaryHandles = [];
  let metadata = null;

  runtime.pauseAnimation();
  try {
    // Ensure results do not vary with the user's zoom setting or camera tilt.
    camera.beta = Math.PI / 2;
    camera.fov = LAB_CAMERA_FOV;
    for (const direction of LAB_DIRECTIONS) {
      const result = buildWalkingVmd({ boneNames, modelHeight, direction });
      const animation = await loader.loadFromBufferAsync(
        direction === -1 ? 'FRAME motion lab left' : 'FRAME motion lab right', result.buffer);
      const handle = model.createRuntimeAnimation(animation);
      temporaryHandles.push(handle);
      model.setRuntimeAnimation(handle);
      runtime.setManualAnimationDuration(WALK_FRAMES);
      metadata = {
        modelHeight, stride: result.stride, bones: result.rig,
        captureProfile: {
          background: LAB_BACKGROUND, cameraFov: LAB_CAMERA_FOV,
          fixedCameraBeta: Math.PI / 2,
          groundReference: LAB_GROUND_REFERENCE,
          note: 'Dashed floor reference is derived from the initial model bounds, not collision geometry.'
        }
      };

      for (const view of LAB_VIEWS) {
        camera.alpha = labCameraAlpha(view, direction);
        let sheet = null;
        for (let index = 0; index < LAB_FRAMES.length; index++) {
          const frame = LAB_FRAMES[index];
          await runtime.seekAnimation(frame, true);
          // seekAnimation(forceEvaluate) applies the pose immediately.
          // A dedicated render makes sampling independent of FPS throttling.
          scene.render();
          const groundY = referenceLineY({ camera, scene, canvas, point: groundPoint });
          const phase = frame / WALK_FRAMES;
          const lift = modelHeight * 0.025;
          const leftFoot = walkFootAt(phase, result.stride, lift, direction);
          const rightFoot = walkFootAt(phase + 0.5, result.stride, lift, direction);
          const note = 'L:' + (leftFoot.planted ? 'CONTACT' : 'SWING') +
            '    R:' + (rightFoot.planted ? 'CONTACT' : 'SWING');
          const shot = captureCanvas(canvas, groundY, note);
          if (!sheet) sheet = newSheet(shot.width, shot.height);
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
    // Even failed captures must not leave FRAME locked in a sideways pose.
    camera.alpha = savedCamera.alpha;
    camera.beta = savedCamera.beta;
    camera.fov = savedCamera.fov;
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
