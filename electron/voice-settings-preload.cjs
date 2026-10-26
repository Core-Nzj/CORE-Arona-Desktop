'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// This capability is available only to the local, isolated settings window.
contextBridge.exposeInMainWorld('voiceSettings', Object.freeze({
  status: () => ipcRenderer.invoke('voice-settings:status'),
  save: (username, password) => ipcRenderer.invoke('voice-settings:save', { username, password }),
  clear: () => ipcRenderer.invoke('voice-settings:clear'),
  connect: () => ipcRenderer.invoke('voice-settings:connect'),
  openBrowserAutofill: () => ipcRenderer.invoke('voice-settings:browser-autofill'),
  onCredentialsImported: callback => ipcRenderer.on('voice-settings:credentials-imported', () => callback())
}));
