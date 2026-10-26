import './style.css';
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

RegisterPmxLoader();
RegisterPmdLoader();
RegisterMmdOutlineRenderer();

const canvas = document.getElementById('avatar-canvas');
const status = document.getElementById('status');
const placeholder = document.getElementById('placeholder');
const chooseButton = document.getElementById('choose-model');
const quitButton = document.getElementById('quit-app');

const engine = new Engine(canvas, true, {
  stencil: true,
  preserveDrawingBuffer: false,
  premultipliedAlpha: false
});
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 0);
scene.ambientColor = new Color3(0.5, 0.5, 0.5);

const camera = new ArcRotateCamera(
  'avatar-camera', -Math.PI / 2, Math.PI / 2, 6, Vector3.Zero(), scene
);
camera.fov = 0.7;
camera.minZ = 0.02;

const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
ambient.intensity = 1.15;
const keyLight = new DirectionalLight('key', new Vector3(-0.6, -1, 0.8), scene);
keyLight.intensity = 0.65;

let activeContainer = null;
let activeRoot = null;
let loadSequence = 0;
let baseRadius = camera.radius;
let regionDirty = false;
let hitRegion = null;
let drag = null;

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
  const halfFov = camera.fov / 2;
  const verticalDistance = height / (2 * Math.tan(halfFov));
  const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
  const horizontalDistance = width / (2 * Math.tan(halfFov) * Math.max(aspect, 0.1));

  camera.setTarget(center);
  camera.alpha = -Math.PI / 2;
  camera.beta = Math.PI / 2;
  camera.radius = Math.max(verticalDistance, horizontalDistance, size.z * 2, 1) * 1.22;
  baseRadius = camera.radius;
  regionDirty = true;
}

function zoom(action) {
  if (!activeContainer) return;
  if (action === 'reset') camera.radius = baseRadius;
  else if (action === 'in' || action === 'out') {
    const factor = action === 'in' ? 0.85 : 1 / 0.85;
    camera.radius = Math.min(baseRadius * 4, Math.max(baseRadius * 0.3, camera.radius * factor));
  } else return;
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

  hitRegion = projectAvatarBounds();
  // A null rectangle means "keep the whole window interactive".
  window.aronaDesktop.setAvatarRegion(hitRegion);
}

async function loadModel(model) {
  if (!model) return;
  const seq = ++loadSequence;
  chooseButton.disabled = true;
  showStatus('読み込み中: ' + model.name);
  let nextContainer;

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
    activeContainer = nextContainer;
    activeRoot = root;
    nextContainer = null;
    if (oldContainer) {
      oldContainer.removeAllFromScene();
      oldContainer.dispose();
    }

    fitCamera(root);
    placeholder.hidden = true;
    regionDirty = true;
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

// Windows restricts pointer delivery to the model rectangle using setShape.
// This avoids the global click-through trap that swallowed all mouse buttons.
canvas.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (avatarIsInteractive()) window.aronaDesktop.showMenu();
});

canvas.addEventListener('mousedown', event => {
  if (event.button !== 0 || !avatarIsInteractive()) return;
  event.preventDefault();
  drag = { screenX: event.screenX, screenY: event.screenY };
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', event => {
  if (!drag) {
    canvas.style.cursor = avatarIsInteractive() ? 'grab' : 'default';
    return;
  }
  const dx = event.screenX - drag.screenX;
  const dy = event.screenY - drag.screenY;
  drag.screenX = event.screenX;
  drag.screenY = event.screenY;
  if (dx !== 0 || dy !== 0) window.aronaDesktop.moveBy(dx, dy);
});

function endDrag() {
  drag = null;
  canvas.style.cursor = avatarIsInteractive() ? 'grab' : 'default';
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);

canvas.addEventListener('wheel', event => {
  if (!avatarIsInteractive()) return;
  event.preventDefault();
  zoom(event.deltaY < 0 ? 'in' : 'out');
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
window.aronaDesktop.onZoom(zoom);
window.aronaDesktop.onModelChanged(loadModel);

engine.runRenderLoop(() => {
  scene.render();
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
