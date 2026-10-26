'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// No direct Node or Electron access is exposed to the renderer.
contextBridge.exposeInMainWorld('aronaDesktop', Object.freeze({
  currentModel: () => ipcRenderer.invoke('avatar:current'),
  chooseModel: () => ipcRenderer.invoke('avatar:choose'),
  quit: () => ipcRenderer.send('avatar:quit'),
  showMenu: () => ipcRenderer.send('avatar:menu'),
  moveBy: (dx, dy) => ipcRenderer.send('avatar:move-by', dx, dy),
  setClickThrough: (enabled) => ipcRenderer.send('avatar:click-through', enabled),
  onZoom: callback => ipcRenderer.on('avatar:zoom', (_event, action) => callback(action)),
  onModelChanged: callback => ipcRenderer.on('avatar:model-changed', (_event, model) => callback(model))
}));
