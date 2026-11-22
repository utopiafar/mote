import { contextBridge, ipcRenderer } from 'electron';

/** Keep these channels and the login marker in sync with central-browser.ts. */
const openLocalWindowChannel = 'mote:central:open-local-window';
const loginTicketChannel = 'mote:central:login-ticket';
const loginParameter = 'desktopLogin';
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

  // The Web bootstrap requests the ticket over a port in this document. The
  // host checks the current login identity, origin and document marker.
  window.addEventListener('message', async event => {
    const [reply] = event.ports;
    if (event.source !== window || event.origin !== location.origin || event.data !== loginTicketChannel || !reply) return;
    const attempt = new URLSearchParams(location.hash.split('?')[1] ?? '').get(loginParameter);
    const code = attempt ? await ipcRenderer.invoke(loginTicketChannel, attempt).catch(() => null) : null;
    reply.postMessage(code ?? null);
    reply.close();
  });

  // Route a user's click on a main-document external link through the
  // navigation guard, which can verify the initiating frame.
  window.addEventListener('click', event => {
    if (!event.isTrusted || event.defaultPrevented || !(event.target instanceof Element)) return;
    const link = event.target.closest('a[href][target]');
    if (!(link instanceof HTMLAnchorElement) || link.target.toLowerCase() !== '_blank' || link.hasAttribute('download')) return;
    if (link.origin === location.origin || (link.protocol !== 'http:' && link.protocol !== 'https:')) return;
    event.preventDefault();
    location.assign(link.href);
  });
}
