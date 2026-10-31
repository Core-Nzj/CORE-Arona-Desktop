'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aronaMenu', Object.freeze({
  state: () => ipcRenderer.invoke('avatar-menu:state'),
  action: (name, value) => ipcRenderer.invoke('avatar-menu:action', name, value),
  close: () => ipcRenderer.send('avatar-menu:close'),
  resizeStart: edge => ipcRenderer.send('avatar-menu:resize-start', edge),
  resizeMove: () => ipcRenderer.send('avatar-menu:resize-move'),
  resizeEnd: () => ipcRenderer.send('avatar-menu:resize-end'),
  zoom: direction => ipcRenderer.send('avatar-menu:zoom', direction),
  setTextSize: percent => ipcRenderer.send('avatar-menu:text-size', percent),
  saveViewState: state => ipcRenderer.send('avatar-menu:view-state', state)
}));
