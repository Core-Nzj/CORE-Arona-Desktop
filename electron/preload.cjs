'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// No direct Node or Electron access is exposed to the renderer.
contextBridge.exposeInMainWorld('aronaDesktop', Object.freeze({
  currentModel: () => ipcRenderer.invoke('avatar:current'),
  chooseModel: () => ipcRenderer.invoke('avatar:choose'),
  quit: () => ipcRenderer.send('avatar:quit'),
  showMenu: () => ipcRenderer.send('avatar:menu'),
  reportIdleStatus: (text) => ipcRenderer.send('avatar:idle-status', text),
  synthesizeSpeech: (text) => ipcRenderer.invoke('avatar:voice-synthesize', text),
  cancelVoice: () => ipcRenderer.send('avatar:voice-cancel'),
  onVoiceTest: (callback) => ipcRenderer.on('avatar:voice-test', () => callback()),
  onVoiceText: (callback) => ipcRenderer.on('avatar:voice-text', (_event, text) => callback(text)),
  onVoiceStop: (callback) => ipcRenderer.on('avatar:voice-stop', () => callback()),
  reportVoicePlayback: (text) => ipcRenderer.send('avatar:voice-playback-status', text),
  reportEmotionState: (state) => ipcRenderer.send('avatar:emotions-state', state),
  onEmotionChange: (callback) => ipcRenderer.on('avatar:emotion-change', (_event, id) => callback(id)),
  startDrag: () => ipcRenderer.send('avatar:drag-start'),
  stopDrag: () => ipcRenderer.send('avatar:drag-stop'),
  setAvatarRegion: (rect) => ipcRenderer.send('avatar:set-region', rect),
  zoom: action => ipcRenderer.send('avatar:zoom', action),
  onCameraZoom: callback => ipcRenderer.on('avatar:camera-zoom', (_event, factor) => callback(factor)),
  onModelChanged: callback => ipcRenderer.on('avatar:model-changed', (_event, model) => callback(model))
}));
