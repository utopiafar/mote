/** Host-side invoker for the package's custom page bridge.
 *
 * The host supplies this narrow function to `customPageContributions`; the
 * page itself only receives a MessagePort and JSON responses, never a host API
 * object, connection credential or the state store. */
export const customPageMethods = Object.freeze(['state', 'select-strategy', 'review']);

export function createCustomPageInvoker(service) {
  if (!service || typeof service !== 'object') throw TypeError('A reading review service is required');
  return async (method, payload) => {
    switch (method) {
      case 'state':
        return service.state();
      case 'select-strategy':
        return service.selectStrategy(payload?.strategy);
      case 'review':
        return service.review(payload);
      default:
        throw Error('undeclared custom page method');
    }
  };
}
