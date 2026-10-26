'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// No direct Node or Electron access is exposed to the renderer.
contextBridge.exposeInMainWorld('aronaDesktop', Object.freeze({
  currentModel: () => ipcRenderer.invoke('avatar:current'),
  chooseModel: () => ipcRenderer.invoke('avatar:choose'),
  quit: () => ipcRenderer.send('avatar:quit'),
  showMenu: () => ipcRenderer.send('avatar:menu'),
  reportIdleStatus: (text) => ipcRenderer.send('avatar:idle-status', text),
  reportEmotionState: (state) => ipcRenderer.send('avatar:emotions-state', state),
  onEmotionChange: (callback) => ipcRenderer.on('avatar:emotion-change', (_event, id) => callback(id)),
  startDrag: () => ipcRenderer.send('avatar:drag-start'),
  stopDrag: () => ipcRenderer.send('avatar:drag-stop'),
  setAvatarRegion: (rect) => ipcRenderer.send('avatar:set-region', rect),
  onZoom: callback => ipcRenderer.on('avatar:zoom', (_event, action) => callback(action)),
  onModelChanged: callback => ipcRenderer.on('avatar:model-changed', (_event, model) => callback(model))
}));
