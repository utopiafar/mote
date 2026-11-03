/** Host-side invoker for the export package's custom page bridge.
 *
 * The host supplies this narrow function to the custom-page host; the page
 * itself only receives a MessagePort and JSON responses. Closing the page
 * session detaches its invoker. It never quiesces the archive service or its
 * background export loop. */
export const customPageMethods = Object.freeze(['materials', 'read', 'export-now']);

export function createCustomPageInvoker(service) {
  if (!service || typeof service.list !== 'function' || typeof service.read !== 'function'
    || typeof service.exportNow !== 'function') throw TypeError('A reading export service is required');
  return async (method, payload) => {
    switch (method) {
      case 'materials':
        return service.list();
      case 'read':
        return service.read(payload?.id);
      case 'export-now':
        return service.exportNow();
      default:
        throw Error('undeclared custom page method');
    }
  };
}

/** Separate page lifetime. `close` only stops accepting page calls; the
 * service, published port and background timer keep running. */
export function createCustomPageSession(service) {
  const invoke = createCustomPageInvoker(service);
  let open = true;
  return Object.freeze({
    invoke(method, payload) {
      if (!open) return Promise.reject(Error('custom page is closed'));
      return invoke(method, payload);
    },
    close() { open = false; },
    get open() { return open; },
  });
}
