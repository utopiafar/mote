/** Official fixture connector for production install + declarative source catalog.
 * It does not poll, read credentials, call a model or scan history. */
export const sdkVersion = '0.1.0';

const connector = {
  apiVersion: 1,
  id: 'official-fixture-connector',
  statusKey: 'official-fixture-connector',
  sourceKinds: [{
    kind: 'mote.official.fixture-connector',
    capabilities: {
      lifecycle: 'external-push',
      discovery: 'explicit-selection',
      listening: 'none',
      readOriginal: 'none',
      synchronization: 'push-only',
      externalWrite: false,
    },
  }],
  create(ctx) {
    if (!ctx.state) throw Error('The Central host did not provide instance state');
    let launches = 0;
    const actionCalls = [];
    const status = () => ({ready: true, sdkVersion, source: 'mote.official.fixture-connector', launches, actionCalls: actionCalls.length, connected: false});
    return {
      async init() {
        const current = await ctx.state.get('launches');
        launches = (typeof current?.value === 'number' ? current.value : 0) + 1;
        if (current) await ctx.state.compareAndSet('launches', current.revision, launches);
        else await ctx.state.compareAndSet('launches', null, launches);
      },
      status,
      /** Local receipt only: the host owns authorization, operation identity and
       * idempotency; this fixture never sends or writes an external service. */
      executeAction(request) {
        if (!request || request.capability?.id !== 'calendar.manage' && request.capability?.id !== 'message.send') {
          throw Error('Unsupported fixture action capability');
        }
        if (typeof request.operationId !== 'string') throw Error('Missing host operation identity');
        actionCalls.push({capability: request.capability.id, operationId: request.operationId});
        const prefix = request.capability.id === 'message.send' ? 'fixture-message-' : 'fixture-event-';
        return {status: 'succeeded', externalId: prefix + request.operationId};
      },
      configure(host) {
        host.ownerRoute({
          method: 'GET',
          path: '/api/connectors/official-fixture-connector/status',
          handler: status,
        });
      },
    };
  },
};

export {connector, connector as default};
