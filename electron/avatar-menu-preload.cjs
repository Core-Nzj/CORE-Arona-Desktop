'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aronaMenu', Object.freeze({
  state: () => ipcRenderer.invoke('avatar-menu:state'),
  action: (name, value) => ipcRenderer.invoke('avatar-menu:action', name, value),
  close: () => ipcRenderer.send('avatar-menu:close')
}));
