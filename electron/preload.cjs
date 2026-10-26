'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only expose narrowly-scoped actions; never expose raw ipcRenderer or Node.
contextBridge.exposeInMainWorld('aronaDesktop', Object.freeze({
  currentModel: () => ipcRenderer.invoke('avatar:current'),
  chooseModel: () => ipcRenderer.invoke('avatar:choose'),
  quit: () => ipcRenderer.send('avatar:quit')
}));
