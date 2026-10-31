'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// No direct Node or Electron access is exposed to the renderer.
contextBridge.exposeInMainWorld('aronaDesktop', Object.freeze({
  currentModel: () => ipcRenderer.invoke('avatar:current'),
  currentViewport: () => ipcRenderer.invoke('avatar:viewport'),
  onStageViewport: (callback) => ipcRenderer.on('avatar:stage-viewport', (_event, viewport) => callback(viewport)),
  restoreIdleMotion: () => ipcRenderer.invoke('avatar:motion-restore'),
  chooseModel: () => ipcRenderer.invoke('avatar:choose'),
  quit: () => ipcRenderer.send('avatar:quit'),
  quitReady: () => ipcRenderer.send('avatar:quit-ready'),
  onPrepareQuit: callback => ipcRenderer.on('avatar:prepare-quit', () => callback()),
  showMenu: () => ipcRenderer.send('avatar:menu'),
  reportIdleStatus: (text) => ipcRenderer.send('avatar:idle-status', text),
  synthesizeSpeech: (request) => ipcRenderer.invoke('avatar:voice-synthesize', request),
  onVoiceCommand: callback => ipcRenderer.on('avatar:voice-command', (_event, command) => callback(command)),
  cancelVoice: () => ipcRenderer.send('avatar:voice-cancel'),
  onVoiceTest: (callback) => ipcRenderer.on('avatar:voice-test', () => callback()),
  onVoiceText: (callback) => ipcRenderer.on('avatar:voice-text', (_event, text) => callback(text)),
  onVoiceStop: (callback) => ipcRenderer.on('avatar:voice-stop', () => callback()),
  reportVoicePlayback: (text) => ipcRenderer.send('avatar:voice-playback-status', text),
  reportEmotionState: (state) => ipcRenderer.send('avatar:emotions-state', state),
  onEmotionChange: (callback) => ipcRenderer.on('avatar:emotion-change', (_event, id) => callback(id)),
  onMotionCommand: (callback) => ipcRenderer.on('avatar:motion-command', (_event, command) => callback(command)),
  setWalkVelocity: (direction, speed) => ipcRenderer.send('avatar:walk-velocity', direction, speed),
  onWalkStopped: (callback) => ipcRenderer.on('avatar:walk-stopped', () => callback()),
  onMotionWarpEnabled: (callback) => ipcRenderer.on('avatar:motion-warp-enabled', (_event, enabled) => callback(enabled)),
  onMotionTransitionMode: (callback) => ipcRenderer.on('avatar:motion-transition-mode', (_event, mode) => callback(mode)),
  startDrag: () => ipcRenderer.send('avatar:drag-start'),
  stopDrag: () => ipcRenderer.send('avatar:drag-stop'),
  setAvatarRegion: (rect) => ipcRenderer.send('avatar:set-region', rect),
  zoom: action => ipcRenderer.send('avatar:zoom', action),
  onCameraZoom: callback => ipcRenderer.on('avatar:camera-zoom', (_event, factor) => callback(factor)),
  onModelChanged: callback => ipcRenderer.on('avatar:model-changed', (_event, model) => callback(model))
}));
