// Motion Lab: capture the actual Babylon/WebGL body at deterministic VMD
// frames, not the entire desktop or an empty transparent Electron surface.
import { buildWalkingVmd, walkFootAt, WALK_FRAMES } from './walk-vmd.mjs';
import { LAB_FRAMES, LAB_DIRECTIONS, LAB_VIEWS,
  labCameraAlpha, labFileName, labSheetName } from './motion-lab.mjs';

function captureCanvas(canvas) {
  const factor = Math.min(1, 480 / canvas.width, 720 / canvas.height);
  const width = Math.max(1, Math.round(canvas.width * factor));
  const height = Math.max(1, Math.round(canvas.height * factor));
  const shot = document.createElement('canvas');
  shot.width = width;
  shot.height = height;
  const ctx = shot.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('キャプチャ用Canvasを初期化できませんでした');
  // A solid dark background makes the light and transparent parts of MMD
  // models legible in screenshot viewers and the contact sheet.
  ctx.fillStyle = '#242936';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, 0, 0, width, height);
  return shot;
}

function newSheet(shotWidth, shotHeight) {
  const pad = 8;
  const label = 27;
  const sheet = document.createElement('canvas');
  sheet.width = (shotWidth + pad) * 3 + pad;
  sheet.height = (shotHeight + pad + label) * 3 + pad;
  const ctx = sheet.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('比較用Canvasを初期化できませんでした');
  ctx.fillStyle = '#171c28';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  return { sheet, ctx, pad, label };
}

function addSheetFrame(target, image, index, frame) {
  const x = target.pad + (index % 3) * (image.width + target.pad);
  const y = target.pad + Math.floor(index / 3) * (image.height + target.pad + target.label);
  target.ctx.drawImage(image, x, y);
  target.ctx.fillStyle = '#e3ebf8';
  target.ctx.font = 'bold 16px sans-serif';
  target.ctx.fillText('F' + String(frame).padStart(2, '0') +
    ' / ' + (frame / 30).toFixed(3) + 's', x + 6, y + image.height + 19);
}

export async function captureWalkingReview({
  model, root, camera, canvas, scene, runtime, loader,
  originalHandle, originalFrame, originalDuration, wasPlaying,
  save
}) {
  if (!model || !root || !originalHandle || !canvas.width || !canvas.height) {
    throw new Error('モデルまたは再生中のMMDモーションが未準備です');
  }
  const savedCamera = { alpha: camera.alpha, beta: camera.beta };
  const heightBounds = root.getHierarchyBoundingVectors(true);
  const modelHeight = heightBounds.max.y - heightBounds.min.y;
  const boneNames = model.runtimeBones.map(bone => bone.name);
  const temporaryHandles = [];
  const createdResults = [];
  let metadata = null;

  runtime.pauseAnimation();
  try {
    for (const direction of LAB_DIRECTIONS) {
      const result = buildWalkingVmd({ boneNames, modelHeight, direction });
      const animation = await loader.loadFromBufferAsync(
        direction === -1 ? 'FRAME motion lab left' : 'FRAME motion lab right', result.buffer);
      const handle = model.createRuntimeAnimation(animation);
      temporaryHandles.push(handle);
      model.setRuntimeAnimation(handle);
      runtime.setManualAnimationDuration(WALK_FRAMES);
      createdResults.push(result);
      metadata = { modelHeight, stride: result.stride, bones: result.rig };

      for (const view of LAB_VIEWS) {
        camera.alpha = labCameraAlpha(view, direction);
        const images = [];
        let sheet = null;
        for (let index = 0; index < LAB_FRAMES.length; index++) {
          const frame = LAB_FRAMES[index];
          await runtime.seekAnimation(frame, true);
          // seekAnimation(forceEvaluate) applies the pose immediately.
          // A dedicated render makes sampling independent of FPS throttling.
          scene.render();
          const shot = captureCanvas(canvas);
          if (!sheet) sheet = newSheet(shot.width, shot.height);
          addSheetFrame(sheet, shot, index, frame);
          const phase = frame / WALK_FRAMES;
          const lift = modelHeight * 0.025;
          const info = {
            frame, direction, view,
            leftFoot: walkFootAt(phase, result.stride, lift, direction),
            rightFoot: walkFootAt(phase + 0.5, result.stride, lift, direction)
          };
          await save(labFileName(direction, view, frame), shot.toDataURL('image/png'), info);
          images.push(frame);
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
    model.setRuntimeAnimation(originalHandle);
    runtime.setManualAnimationDuration(originalDuration);
    await runtime.seekAnimation(originalFrame, true);
    if (wasPlaying) await runtime.playAnimation();
    else runtime.pauseAnimation();
    for (const handle of temporaryHandles) {
      try { model.destroyRuntimeAnimation(handle); }
      catch (error) { console.warn('[FRAME motion lab] temp cleanup failed:', error); }
    }
    scene.render();
  }
}
