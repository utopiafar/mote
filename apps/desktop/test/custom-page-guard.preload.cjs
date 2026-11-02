const {contextBridge, ipcRenderer} = require('electron');

// Trusted host renderer only: the guard IPC is bound to the main frame of this
// window. Sandboxed plugin frames never receive this preload.
contextBridge.exposeInMainWorld('prepareCustomPage', target => ipcRenderer.invoke('mote:custom-page-prepare', target));
contextBridge.exposeInMainWorld('claimCustomPage', claim => ipcRenderer.invoke('mote:custom-page-claim', claim));
contextBridge.exposeInMainWorld('onCustomPageRevoked', callback => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on('mote:custom-page-revoked', handler);
  return () => ipcRenderer.removeListener('mote:custom-page-revoked', handler);
});
