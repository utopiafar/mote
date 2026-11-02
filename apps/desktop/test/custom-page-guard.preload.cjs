const {contextBridge, ipcRenderer} = require('electron');

// Trusted host renderer only: the guard IPC is bound to the main frame of this
// window. Sandboxed plugin frames never receive this preload.
contextBridge.exposeInMainWorld('prepareCustomPage', target => ipcRenderer.invoke('mote:custom-page-prepare', target));
contextBridge.exposeInMainWorld('claimCustomPage', claim => ipcRenderer.invoke('mote:custom-page-claim', claim));
