import { contextBridge, ipcRenderer } from 'electron';

/** Keep in sync with centralWindowOpenLocalChannel in central-browser.ts. The
 * sandboxed bridge deliberately imports nothing else and exposes no generic
 * IPC surface to the untrusted Central document. */
const openLocalWindowChannel = 'mote:central:open-local-window';
const deviceIdPrefix = '--mote-device-id=';
const candidate = process.argv.find(value => value.startsWith(deviceIdPrefix))?.slice(deviceIdPrefix.length) ?? '';
const deviceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate) ? candidate : '';

// `nodeIntegrationInSubFrames` stays off, but an explicit guard keeps the
// bridge and the device id out of any future subframe as well.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('moteDesktop', Object.freeze({
    deviceId,
    openLocalWindow: () => ipcRenderer.send(openLocalWindowChannel),
  }));
}
