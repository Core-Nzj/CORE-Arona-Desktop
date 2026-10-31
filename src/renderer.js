import './style.css';
import { rectanglesFromAlpha } from './silhouette.mjs';
import { buildIdleVmd, IDLE_FRAMES } from './idle-vmd.mjs';
import { EmotionController } from './emotions.mjs';
import { makeWebAudioBuffer } from './pcm-playback.mjs';
import { LipSyncController, mouthLevelFromSamples } from './lip-sync.mjs';
import { SpeechPlaybackQueue } from './speech-queue.mjs';
import { approachZoom, fovForZoom } from './camera-zoom.mjs';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { RegisterPmxLoader } from 'babylon-mmd/esm/Loader/pmxLoader.pure';
import { RegisterPmdLoader } from 'babylon-mmd/esm/Loader/pmdLoader.pure';
import { RegisterMmdOutlineRenderer } from 'babylon-mmd/esm/Loader/mmdOutlineRenderer.pure';
import { MmdStandardMaterialBuilder } from 'babylon-mmd/esm/Loader/mmdStandardMaterialBuilder';
import { MmdRuntime } from 'babylon-mmd/esm/Runtime/mmdRuntime';
import { VmdLoader } from 'babylon-mmd/esm/Loader/vmdLoader';
import { RegisterMmdRuntimeModelAnimation } from 'babylon-mmd/esm/Runtime/Animation/mmdRuntimeModelAnimation.pure';

RegisterPmxLoader();
RegisterPmdLoader();
RegisterMmdOutlineRenderer();
RegisterMmdRuntimeModelAnimation();

const canvas = document.getElementById('avatar-canvas');
const status = document.getElementById('status');
const placeholder = document.getElementById('placeholder');
const chooseButton = document.getElementById('choose-model');
const quitButton = document.getElementById('quit-app');

const engine = new Engine(canvas, true, {
  stencil: true,
  // Required to sample rendered alpha for the native mouse-hit silhouette.
  preserveDrawingBuffer: true,
  premultipliedAlpha: false
});
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 0);
scene.ambientColor = new Color3(0.5, 0.5, 0.5);

const camera = new ArcRotateCamera(
  'avatar-camera', -Math.PI / 2, Math.PI / 2, 6, Vector3.Zero(), scene
);
const BASE_CAMERA_FOV = 0.7;
camera.fov = BASE_CAMERA_FOV;
camera.minZ = 0.02;
let renderedCameraZoom = 1;
let targetCameraZoom = 1;

const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
ambient.intensity = 1.15;
const keyLight = new DirectionalLight('key', new Vector3(-0.6, -1, 0.8), scene);
keyLight.intensity = 0.65;

const mmdRuntime = new MmdRuntime(scene, null);
mmdRuntime.loggingEnabled = true;
mmdRuntime.register(scene);
const idleLoader = new VmdLoader(scene);
idleLoader.loggingEnabled = true;

let activeContainer = null;
let activeMmdModel = null;
let emotionController = null;
let lipSyncController = null;
let activeRoot = null;
let loadSequence = 0;
let regionDirty = false;
let hitRegion = null;
let dragPointerId = null;
let lastSilhouetteUpdate = 0;
let isSeekingIdleLoop = false;
let idleInfo = '待機モーションの読込待ち';
let observedFrameTime = 0;
let idlePlaybackCheckTimer = null;
let idleAnimationHandle = null;
let customIdleMotion = null;
let activeImportedMotion = null;
let motionRequestId = 0;
let motionTransitionQueue = Promise.resolve();
let isChangingMotion = false;
let activeSpeechSource = null;
let activeSpeechContext = null;
let activeSpeechAnalyser = null;
const speechSamples = new Float32Array(1024);
let speechGeneration = 0;

let activeSpeechResolve = null;

function disposeSpeechAudio() {
  activeSpeechAnalyser = null;
  lipSyncController?.setLevel(0);
  const source = activeSpeechSource;
  activeSpeechSource = null;
  if (source) {
    source.onended = null;
    try { source.stop(); } catch { /* AudioBufferSourceNode may have ended */ }
    source.disconnect();
  }
  const context = activeSpeechContext;
  activeSpeechContext = null;
  if (context && context.state !== 'closed') {
    void context.close().catch(error => console.warn('AudioContext close failed', error));
  }
  const finish = activeSpeechResolve;
  activeSpeechResolve = null;
  if (finish) finish();
}

function stopSpeechHardware() {
  // A queued piece must be aborted only on STOP or a genuinely new reply.
  speechGeneration++;
  window.aronaDesktop.cancelVoice();
  disposeSpeechAudio();
}

async function playSpeechChunk(text, voice = null, voiceProfiles = {}) {
  const generation = speechGeneration;
  window.aronaDesktop.reportVoicePlayback('WAV合成中');
  try {
    const speech = await window.aronaDesktop.synthesizeSpeech({ text, voice, voiceProfiles });
    if (generation !== speechGeneration) return;

    const raw = atob(speech.wavBase64);
    const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
    const context = new AudioContext({ latencyHint: 'interactive' });
    activeSpeechContext = context;
    const audioBuffer = makeWebAudioBuffer(context, bytes);
    await context.resume();
    if (generation !== speechGeneration) return;

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(context.destination);
    activeSpeechAnalyser = analyser;
    activeSpeechSource = source;

    await new Promise(resolve => {
      activeSpeechResolve = resolve;
      source.onended = () => {
        if (activeSpeechSource !== source) return resolve();
        disposeSpeechAudio();
      };
      source.start();
      window.aronaDesktop.reportVoicePlayback('Web Audio再生中: ' + speech.voiceName);
    });
  } catch (error) {
    if (generation !== speechGeneration) return;
    disposeSpeechAudio();
    throw error;
  }
}

const speechQueue = new SpeechPlaybackQueue({
  play: playSpeechChunk,
  interrupt: stopSpeechHardware,
  status: status => window.aronaDesktop.reportVoicePlayback(status)
});

function stopSpeech() { speechQueue.stop(); }
function speakLatest(text) { speechQueue.speak(text); }

function handleVoiceCommand(command) {
  if (!command || typeof command !== 'object') return;
  switch (command.type) {
    case 'STOP':
      speechQueue.stop();
      break;
    case 'SPEAK':
      speechQueue.speak(command.text, command.voice, command.voiceProfiles);
      break;
    case 'STREAM_START':
      speechQueue.start(command.streamId, command.voice, command.voiceProfiles);
      break;
    case 'STREAM_APPEND':
      speechQueue.append(command.streamId, command.seq, command.text);
      break;
    case 'STREAM_END':
      speechQueue.end(command.streamId);
      break;
  }
}

function reportIdle(message) {
  idleInfo = String(message);
  console.info('[CORE idle]', idleInfo);
  window.aronaDesktop.reportIdleStatus(idleInfo);
}

function reportEmotionState() {
  if (!emotionController) {
    window.aronaDesktop.reportEmotionState({
      selected: 'neutral',
      available: { neutral: true },
      details: 'モデルに対応する表情コントローラーがありません'
    });
    return;
  }
  window.aronaDesktop.reportEmotionState({
    selected: emotionController.selected,
    available: emotionController.available(),
    details: emotionController.diagnostics()
  });
}

function setEmotion(id) {
  if (!emotionController) return;
  if (emotionController.select(id)) {
    console.info('[CORE emotion]', id);
    reportEmotionState();
  }
}

const alphaCanvas = document.createElement('canvas');
const alphaContext = alphaCanvas.getContext('2d', { willReadFrequently: true });

function showStatus(message) {
  placeholder.hidden = false;
  status.textContent = message;
  window.aronaDesktop.setAvatarRegion(null);
  hitRegion = null;
}

function fitCamera(rootMesh) {
  rootMesh.computeWorldMatrix(true);
  const bounds = rootMesh.getHierarchyBoundingVectors(true);
  const size = bounds.max.subtract(bounds.min);
  const center = bounds.min.add(bounds.max).scale(0.5);
  const height = Math.max(size.y, 0.3);
  const width = Math.max(size.x, 0.3);
  // Model fitting must not depend on the current magnification.
  const halfFov = BASE_CAMERA_FOV / 2;
  const verticalDistance = height / (2 * Math.tan(halfFov));
  const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
  const horizontalDistance = width / (2 * Math.tan(halfFov) * Math.max(aspect, 0.1));

  camera.setTarget(center);
  camera.alpha = -Math.PI / 2;
  camera.beta = Math.PI / 2;
  // Keep this radius fixed while the native window changes size.
  // Its transparent viewport now determines the avatar's on-screen scale.
  camera.radius = Math.max(verticalDistance, horizontalDistance, size.z * 2, 1) * 1.22;
  regionDirty = true;
}

function projectAvatarBounds() {
  if (!activeRoot) return null;
  const bounds = activeRoot.getHierarchyBoundingVectors(true);
  const { min, max } = bounds;
  const viewport = camera.viewport.toGlobal(canvas.clientWidth, canvas.clientHeight);
  const matrix = scene.getTransformMatrix();
  const identity = Matrix.Identity();
  const points = [];

  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        const p = Vector3.Project(new Vector3(x, y, z), identity, matrix, viewport);
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) points.push(p);
      }
    }
  }
  if (!points.length) return null;

  const padding = 18;
  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const x1 = Math.max(0, Math.floor(minX - padding));
  const x2 = Math.min(width, Math.ceil(maxX + padding));
  const y1 = Math.max(0, Math.floor(minY - padding));
  const y2 = Math.min(height, Math.ceil(maxY + padding));

  // Never make the model inaccessible due to invalid projection data.
  if (x2 - x1 < 15 || y2 - y1 < 30) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function applyAvatarRegion() {
  if (!placeholder.hidden || !activeRoot) {
    hitRegion = null;
    window.aronaDesktop.setAvatarRegion(null);
    return;
  }

  const screenWidth = Math.round(canvas.clientWidth);
  const screenHeight = Math.round(canvas.clientHeight);
  if (screenWidth < 1 || screenHeight < 1) return;

  const tileSize = 5;
  const columns = Math.ceil(screenWidth / tileSize);
  const rows = Math.ceil(screenHeight / tileSize);

  try {
    // The canvas is a transparent WebGL render. Shrinking it to 5px tiles
    // preserves a coarse alpha mask for hair, sleeves, legs, gaps etc.
    alphaCanvas.width = columns;
    alphaCanvas.height = rows;
    alphaContext.clearRect(0, 0, columns, rows);
    alphaContext.drawImage(canvas, 0, 0, columns, rows);
    const pixels = alphaContext.getImageData(0, 0, columns, rows).data;
    const silhouetteRects = rectanglesFromAlpha(
      pixels, columns, rows, screenWidth, screenHeight,
      { threshold: 8, dilation: 1, maxRectangles: 1800 }
    );
    if (silhouetteRects.length) {
      hitRegion = silhouetteRects;
      window.aronaDesktop.setAvatarRegion(silhouetteRects);
      return;
    }
  } catch (error) {
    console.warn('Silhouette alpha readback unavailable, using bounding box', error);
  }

  // Never make the model impossible to click if a GPU/driver cannot provide
  // alpha data. This fallback is larger than the visible silhouette.
  const bounds = projectAvatarBounds();
  hitRegion = bounds ? [bounds] : null;
  window.aronaDesktop.setAvatarRegion(hitRegion);
}

async function attachIdleMotion(container) {
  const rootMesh = container.meshes[0];
  if (!rootMesh) throw new Error('MMD root mesh is not available');

  const runtimeModel = mmdRuntime.createMmdModel(rootMesh, { buildPhysics: false });
  const boneNames = runtimeModel.runtimeBones.map(bone => bone.name);
  const morphNames = ['まばたき', 'blink', 'Blink'].filter(name =>
    (runtimeModel.morph.getMorphIndices(name)?.length ?? 0) > 0
  );
  const armNames = ['左腕', '右腕', 'LeftArm', 'RightArm'];
  const foundArms = armNames.filter(name => boneNames.includes(name));
  const boneSample = boneNames.slice(0, 28).join(', ');

  const details = [
    '対応腕ボーン: ' + (foundArms.join(' / ') || 'なし'),
    'まばたきモーフ: ' + (morphNames.join(' / ') || 'なし'),
    '検出ボーン数: ' + boneNames.length,
    'ボーン例: ' + boneSample
  ].join('\n');

  reportIdle('MMDランタイムを生成しました\n' + details);

  try {
    // The model is kept local. Our original 12-second motion is created at
    // runtime rather than shipping someone else's VMD motion data.
    const buffer = buildIdleVmd({ boneNames, morphNames });
    const animation = await idleLoader.loadFromBufferAsync('CORE idle', buffer);
    const boneTracks = animation.boneTracks?.length ?? 0;
    const movableTracks = animation.movableBoneTracks?.length ?? 0;
    const morphTracks = animation.morphTracks?.length ?? 0;
    reportIdle('生成VMD解析完了 (骨 ' + boneTracks + ', 移動骨 ' +
      movableTracks + ', 表情 ' + morphTracks + ')\n' + details);

    if (boneTracks + movableTracks + morphTracks === 0) {
      throw new Error('生成モーションのトラック数が0です。標準骨名と表情名の不一致が考えられます');
    }

    const handle = runtimeModel.createRuntimeAnimation(animation);
    runtimeModel.setRuntimeAnimation(handle);
    if (activeContainer === container) idleAnimationHandle = handle;
    mmdRuntime.setManualAnimationDuration(IDLE_FRAMES);
    await mmdRuntime.seekAnimation(0, true);
    await mmdRuntime.playAnimation();

    reportIdle('再生開始 (骨 ' + boneTracks + ', 移動骨 ' +
      movableTracks + ', 表情 ' + morphTracks + ')\n' + details);
    return runtimeModel;
  } catch (error) {
    reportIdle('待機モーション初期化失敗: ' + String(error?.stack ?? error) +
      '\n' + details);
    // Do not destroy the runtime wrapper here because ownership of the
    // underlying skeleton has already moved to MmdRuntime.
    return runtimeModel;
  }
}

// Serialize runtime seeks and animation switches so rapid menu clicks cannot
// leave a previous VMD active after a later stop/play command.
function queueMotionTransition(callback) {
  const pending = motionTransitionQueue.then(callback, callback);
  motionTransitionQueue = pending.catch(error => {
    console.warn('[CORE motion] animation transition failed:', error);
  });
  return pending;
}

function returnToIdle(requestId, message) {
  return queueMotionTransition(async () => {
    if (requestId !== motionRequestId || !activeMmdModel || !idleAnimationHandle) return;
    const model = activeMmdModel;
    const previous = activeImportedMotion;
    const target = customIdleMotion || { handle: idleAnimationHandle, endFrame: IDLE_FRAMES };
    isChangingMotion = true;
    try {
      model.setRuntimeAnimation(target.handle);
      mmdRuntime.setManualAnimationDuration(target.endFrame);
      await mmdRuntime.seekAnimation(0, true);
      if (model !== activeMmdModel) return;
      await mmdRuntime.playAnimation();
      activeImportedMotion = null;
      if (previous) model.destroyRuntimeAnimation(previous.handle);
      reportIdle(message);
    } finally {
      isChangingMotion = false;
    }
  });
}

async function playImportedMotion({ name, bytes }, asIdle = false) {
  const requestId = ++motionRequestId;
  const model = activeMmdModel;
  if (!model || !idleAnimationHandle) {
    reportIdle('外部VMDを再生できません: 待機モーションの準備ができていません');
    return;
  }
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 54 || bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error('不正なVMDデータです');
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const animation = await idleLoader.loadFromBufferAsync(name, buffer);
    if (model !== activeMmdModel || requestId !== motionRequestId) return;

    // A VMD may contain only camera tracks, or bones not present in this PMX.
    const modelBones = new Set(model.runtimeBones.map(bone => bone.name));
    const boneMatches = [...animation.boneTracks, ...animation.movableBoneTracks]
      .filter(track => modelBones.has(track.name)).length;
    const morphMatches = animation.morphTracks.filter(track =>
      (model.morph.getMorphIndices(track.name)?.length ?? 0) > 0
    ).length;
    if (!boneMatches && !morphMatches) {
      throw new Error('このモデルに対応するボーン・モーフがありません');
    }
    const sourceEndFrame = animation.endFrame;
    if (!Number.isFinite(sourceEndFrame) || sourceEndFrame < 0 || sourceEndFrame > 18000) {
      throw new Error('モーションの長さが不正です（10分以内のVMDを選択）');
    }
    // Single-pose and very short VMD clips need enough screen time to be seen.
    const endFrame = Math.max(90, sourceEndFrame);

    await queueMotionTransition(async () => {
      if (requestId !== motionRequestId || model !== activeMmdModel || !idleAnimationHandle) return;
      const previous = activeImportedMotion;
      const formerIdle = customIdleMotion;
      let handle = null;
      isChangingMotion = true;
      try {
        handle = model.createRuntimeAnimation(animation);
        model.setRuntimeAnimation(handle);
        if (asIdle) {
          customIdleMotion = { handle, name, endFrame };
          activeImportedMotion = null;
        } else {
          activeImportedMotion = { handle, name, endFrame };
        }
        mmdRuntime.setManualAnimationDuration(endFrame);
        await mmdRuntime.seekAnimation(0, true);
        if (model !== activeMmdModel) return;
        await mmdRuntime.playAnimation();
        if (previous) model.destroyRuntimeAnimation(previous.handle);
        if (asIdle && formerIdle) model.destroyRuntimeAnimation(formerIdle.handle);
        reportIdle((asIdle ? 'カスタム待機モーション: ' : '外部VMD再生中: ') + name +
          '\n対応ボーン: ' + boneMatches + ' / 対応モーフ: ' + morphMatches +
          '\n終端フレーム: ' + endFrame);
      } catch (error) {
        if (model === activeMmdModel && idleAnimationHandle) {
          try {
            const target = formerIdle || { handle: idleAnimationHandle, endFrame: IDLE_FRAMES };
            model.setRuntimeAnimation(target.handle);
            mmdRuntime.setManualAnimationDuration(target.endFrame);
            await mmdRuntime.seekAnimation(0, true);
            await mmdRuntime.playAnimation();
            activeImportedMotion = null;
            customIdleMotion = formerIdle;
            if (previous) model.destroyRuntimeAnimation(previous.handle);
            if (handle) model.destroyRuntimeAnimation(handle);
          } catch (restoreError) {
            console.warn('[CORE motion] unable to restore idle after failure', restoreError);
          }
        }
        throw error;
      } finally {
        isChangingMotion = false;
      }
    });
  } catch (error) {
    if (requestId === motionRequestId && model === activeMmdModel) {
      reportIdle('外部VMDを再生できません: ' + String(error?.message ?? error));
      console.warn('[CORE motion] VMD rejected:', error);
    }
  }
}

function onMotionCommand(command) {
  if (command?.type === 'play') {
    void playImportedMotion(command);
  } else if (command?.type === 'idle') {
    void playImportedMotion(command, true);
  } else if (command?.type === 'stop') {
    const requestId = ++motionRequestId;
    void returnToIdle(requestId, '手動停止: 待機モーションに戻りました')
      .catch(error => reportIdle('待機への復帰に失敗: ' + String(error?.message ?? error)));
  } else if (command?.type === 'reset-idle') {
    const oldIdle = customIdleMotion;
    const owner = activeMmdModel;
    customIdleMotion = null;
    const requestId = ++motionRequestId;
    void returnToIdle(requestId, '標準待機モーションに戻りました').then(() => {
      if (requestId === motionRequestId && owner === activeMmdModel && oldIdle) {
        owner.destroyRuntimeAnimation(oldIdle.handle);
      }
    }).catch(error => reportIdle('待機への復帰に失敗: ' + String(error?.message ?? error)));
  }
}

async function loadModel(model) {
  if (!model) return;
  const seq = ++loadSequence;
  chooseButton.disabled = true;
  showStatus('読み込み中: ' + model.name);
  reportIdle('モデルを読み込み中: ' + model.name);
  let nextContainer;
  let nextMmdModel = null;

  try {
    nextContainer = await LoadAssetContainerAsync(model.url, scene, {
      pluginOptions: {
        mmdmodel: {
          materialBuilder: new MmdStandardMaterialBuilder(),
          loggingEnabled: true
        }
      }
    });
    if (seq !== loadSequence) {
      nextContainer.dispose();
      return;
    }
    const root = nextContainer.rootNodes[0];
    if (!root) throw new Error('モデルのルートメッシュがありません');

    // MMD meshes sometimes disable Babylon picking by default.
    for (const mesh of nextContainer.meshes) {
      if (mesh.getTotalVertices?.() > 0) mesh.isPickable = true;
    }
    nextContainer.addAllToScene();

    const oldContainer = activeContainer;
    const oldMmdModel = activeMmdModel;
    ++motionRequestId; // Invalidate pending VMD parses and transitions.
    activeImportedMotion = null;
    idleAnimationHandle = null;
    customIdleMotion = null;
    if (emotionController) {
      emotionController.dispose();
      emotionController = null;
    }
    lipSyncController?.dispose();
    lipSyncController = null;
    reportEmotionState();
    activeMmdModel = null;
    activeContainer = nextContainer;
    activeRoot = root;
    nextContainer = null;
    if (oldMmdModel) mmdRuntime.destroyMmdModel(oldMmdModel);
    if (oldContainer) {
      oldContainer.removeAllFromScene();
      oldContainer.dispose();
    }

    fitCamera(root);
    try {
      nextMmdModel = await attachIdleMotion(activeContainer);
      if (seq !== loadSequence) {
        mmdRuntime.destroyMmdModel(nextMmdModel);
        return;
      }
    } catch (idleError) {
      // Keep the proven Phase 1 model display even when a custom PMX rig
      // cannot be animated. The app is still usable.
      console.warn('Idle motion unavailable; static model retained:', idleError);
      reportIdle('アニメーションの初期化例外: ' + String(idleError?.stack ?? idleError));
    }
    activeMmdModel = nextMmdModel;
    try {
      if (activeMmdModel?.morph) {
        emotionController = new EmotionController(activeMmdModel.morph);
        lipSyncController = new LipSyncController(activeMmdModel.morph);
      }
    } catch (emotionError) {
      console.warn('Unable to initialize emotion controller:', emotionError);
    }
    reportEmotionState();
    if (activeMmdModel) {
      // Verify that the runtime's clock actually advances after activation.
      // If the loader silently failed, the right-click diagnostics will say so.
      if (idlePlaybackCheckTimer !== null) clearTimeout(idlePlaybackCheckTimer);
      const observedModel = activeMmdModel;
      const frameStart = mmdRuntime.currentFrameTime;
      idlePlaybackCheckTimer = setTimeout(() => {
        if (activeMmdModel !== observedModel) return;
        const progress = mmdRuntime.currentFrameTime - frameStart;
        if (!mmdRuntime.isAnimationPlaying || progress <= 1) {
          reportIdle(idleInfo + '\n警告: アニメーション時計が進んでいません（' +
            frameStart.toFixed(1) + ' → ' + mmdRuntime.currentFrameTime.toFixed(1) + '）');
        } else {
          reportIdle(idleInfo + '\n再生時計: 正常に進行 (' +
            frameStart.toFixed(1) + ' → ' + mmdRuntime.currentFrameTime.toFixed(1) + ')');
        }
      }, 1800);
    }
    placeholder.hidden = true;
    regionDirty = true;
    // Restore the saved local idle clip after the runtime and its generated
    // fallback have been initialized. Missing files leave the fallback active.
    const restoreAfterRequest = motionRequestId;
    void window.aronaDesktop.restoreIdleMotion().then(motion => {
      // A manual preview or idle selection made during restore wins.
      if (seq === loadSequence && restoreAfterRequest === motionRequestId && motion) {
        return playImportedMotion(motion, true);
      }
    }).catch(error => console.warn('[CORE motion] idle restore failed:', error));
  } catch (error) {
    if (seq === loadSequence) {
      console.error('Failed to load MMD model:', error);
      const message = error instanceof Error ? error.message : String(error);
      showStatus('読み込めませんでした: ' + message);
    }
  } finally {
    if (nextContainer) nextContainer.dispose();
    if (seq === loadSequence) chooseButton.disabled = false;
  }
}

function avatarIsInteractive() {
  return activeContainer !== null && placeholder.hidden;
}

// The native shaped window only accepts mouse input on the avatar's silhouette.
canvas.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (avatarIsInteractive()) window.aronaDesktop.showMenu();
});

// Dragging is driven by the Windows cursor in the Electron main process.
// DOM mousemove deltas are unreliable because the window itself moves.
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !avatarIsInteractive()) return;
  event.preventDefault();
  dragPointerId = event.pointerId;
  try { canvas.setPointerCapture(event.pointerId); } catch { /* best effort */ }
  canvas.style.cursor = 'grabbing';
  window.aronaDesktop.startDrag();
});

function endDrag() {
  if (dragPointerId === null) return;
  const id = dragPointerId;
  dragPointerId = null;
  window.aronaDesktop.stopDrag();
  if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  canvas.style.cursor = avatarIsInteractive() ? 'grab' : 'default';
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);
canvas.addEventListener('pointermove', () => {
  if (dragPointerId === null && avatarIsInteractive()) canvas.style.cursor = 'grab';
});

// Native shaped window resizing is expensive, so coalesce wheel bursts.
let pendingWheelSteps = 0;
let wheelFlushTimer = null;
function flushWheelZoom() {
  wheelFlushTimer = null;
  if (!avatarIsInteractive()) { pendingWheelSteps = 0; return; }
  const steps = Math.max(-2, Math.min(2, pendingWheelSteps));
  pendingWheelSteps -= steps;
  if (steps !== 0) window.aronaDesktop.zoom(steps);
  if (pendingWheelSteps !== 0) {
    wheelFlushTimer = setTimeout(flushWheelZoom, 65);
  }
}
canvas.addEventListener('wheel', event => {
  if (!avatarIsInteractive()) return;
  event.preventDefault();
  const direction = -Math.sign(event.deltaY);
  if (direction === 0) return;
  pendingWheelSteps = Math.max(-8, Math.min(8, pendingWheelSteps + direction));
  if (wheelFlushTimer === null) {
    wheelFlushTimer = setTimeout(flushWheelZoom, 65);
  }
}, { passive: false });

chooseButton.addEventListener('click', async () => {
  try {
    const model = await window.aronaDesktop.chooseModel();
    if (model) await loadModel(model);
  } catch (error) {
    console.error(error);
    showStatus('モデル選択に失敗しました');
    chooseButton.disabled = false;
  }
});

quitButton.addEventListener('click', () => window.aronaDesktop.quit());
window.aronaDesktop.onModelChanged(loadModel);
window.aronaDesktop.onCameraZoom(factor => {
  if (typeof factor === 'number' && Number.isFinite(factor)) {
    targetCameraZoom = Math.max(1, Math.min(5, factor));
  }
});
window.aronaDesktop.onEmotionChange(setEmotion);
window.aronaDesktop.onMotionCommand(onMotionCommand);
window.aronaDesktop.onVoiceTest(() => speakLatest('先生、こんにちは！ コア・アロナ・デスクトップから、お話ししています。'));
window.aronaDesktop.onVoiceText(text => { void speakLatest(text); });
window.aronaDesktop.onVoiceStop(stopSpeech);
window.aronaDesktop.onVoiceCommand(handleVoiceCommand);

// Keep emotion morphs separate from VMD-driven blinking and future lip sync.
// MmdRuntime is registered earlier, so this observer applies emotion weights
// during the scene update without taking over the MMD animation tracks.
scene.onBeforeRenderObservable.add(() => {
  const delta = Math.min(0.1, engine.getDeltaTime() / 1000);
  const nextZoom = approachZoom(renderedCameraZoom, targetCameraZoom, delta);
  if (nextZoom !== renderedCameraZoom) {
    renderedCameraZoom = nextZoom;
    camera.fov = fovForZoom(BASE_CAMERA_FOV, renderedCameraZoom);
    regionDirty = true;
  }
  emotionController?.tick(delta);
  if (activeSpeechAnalyser && lipSyncController) {
    activeSpeechAnalyser.getFloatTimeDomainData(speechSamples);
    lipSyncController.setLevel(mouthLevelFromSamples(speechSamples));
  } else lipSyncController?.setLevel(0);
  lipSyncController?.tick(delta);
});

engine.runRenderLoop(() => {
  scene.render();
  if (activeMmdModel && !isChangingMotion && !isSeekingIdleLoop) {
    const endFrame = activeImportedMotion?.endFrame ?? customIdleMotion?.endFrame ?? IDLE_FRAMES;
    if (mmdRuntime.currentFrameTime >= endFrame - 1) {
      isSeekingIdleLoop = true;
      if (activeImportedMotion) {
        const finished = activeImportedMotion.name;
        const requestId = ++motionRequestId;
        void returnToIdle(requestId, '外部VMD再生完了: ' + finished +
          '\n待機モーションに戻りました')
          .catch(error => reportIdle('待機への復帰に失敗: ' + String(error?.message ?? error)))
          .finally(() => { isSeekingIdleLoop = false; });
      } else {
        void mmdRuntime.seekAnimation(0, true).catch(error => {
          console.warn('Idle animation loop could not be reset', error);
        }).finally(() => { isSeekingIdleLoop = false; });
      }
    }
  }
  // Update the hit silhouette at 5 Hz while animating; a resting model
  // no longer has a truly static outline.
  if (activeMmdModel && performance.now() - lastSilhouetteUpdate >= 200) {
    lastSilhouetteUpdate = performance.now();
    regionDirty = true;
  }
  if (regionDirty) {
    regionDirty = false;
    applyAvatarRegion();
  }
});
window.addEventListener('resize', () => { engine.resize(); regionDirty = true; });

window.aronaDesktop.currentModel()
  .then(model => { if (model) return loadModel(model); })
  .catch(error => {
    console.error(error);
    showStatus('前回のモデルを復元できませんでした');
  });
