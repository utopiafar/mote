import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {PluginCenter} from '../plugin-center.js';
import type {MemoryBindings} from '../memory-bindings.js';
import type {MemoryAutomation} from '../memory-automation.js';

export interface PluginControlHttpDeps {
  plugins: PluginCenter;
  bindings: Pick<MemoryBindings,'view'|'prepare'|'action'>;
  automation: Pick<MemoryAutomation,'command'>;
  owner: (request: FastifyRequest) => void;
}

/** Owner-only control plane. Query-agent tools never register these methods.
 * Routes keep their existing paths, while package and trusted build responses
 * project the same durable build/instance records; installation is never
 * treated as enabled. */
export function registerPluginControlHttp(app: FastifyInstance, {plugins, bindings, automation, owner}: PluginControlHttpDeps) {
  const id = (request: FastifyRequest) => z.object({id: z.string().min(1)}).parse(request.params).id;
  app.get('/api/plugins', async request => { owner(request); return plugins.view(); });
  app.get('/api/plugins/host-capabilities', async request => { owner(request); return plugins.hostCapabilities(); });
  app.post('/api/plugins/resolve', async request => { owner(request); return plugins.resolve(request.body); });
  app.post('/api/plugins/install', async request => { owner(request); return plugins.install(request.body); });
  app.post('/api/plugins/:id/uninstall', async request => { owner(request); return plugins.uninstall(id(request), request.body); });
  app.post('/api/plugin-instances', async request => { owner(request); return plugins.configure(undefined, request.body); });
  app.patch('/api/plugin-instances/:id', async request => { owner(request); return plugins.configure(id(request), request.body); });
  for (const action of ['check', 'enable', 'disable'] as const)
    app.post('/api/plugin-instances/:id/' + action, async request => { owner(request); return plugins.action(id(request), action, request.body); });
  // Owner-only outbound export status and explicit retry. Query agents, MCP
  // tokens and collector credentials never register or reach these routes.
  app.get('/api/plugin-instances/:id/outbound-export', async request => { owner(request); return plugins.outboundStatus(id(request)); });
  app.post('/api/plugin-instances/:id/outbound-export/sync', async request => { owner(request); return plugins.outboundSync(id(request), request.body); });

  // Trusted build views are separate from package/instance views: no
  // restartPlan/blockedActions fields are invented here.
  app.get('/api/plugin-builds', async request => { owner(request); return plugins.buildViews(); });
  app.get('/api/plugin-builds/:id', async request => { owner(request); return plugins.buildView(id(request)); });
  app.patch('/api/plugin-builds/:id', async request => { owner(request); return plugins.selectBuild(id(request), request.body); });
  app.post('/api/plugin-builds/:id/retire', async request => { owner(request); return plugins.retireBuild(id(request), request.body); });

  app.get('/api/memory-spaces/default/binding', async request => { owner(request); return bindings.view(); });
  for (const action of ['pause', 'resume', 'stop'] as const)
    app.post('/api/memory-spaces/default/binding/' + action, async request => { owner(request); automation.command(action, request.body); return bindings.view(); });
  app.post('/api/memory-spaces/default/binding/prepare', async request => { owner(request); return bindings.prepare(request.body); });
  for (const action of ['activate', 'retry', 'cancel'] as const)
    app.post('/api/memory-spaces/default/binding/' + action, async request => { owner(request); return bindings.action(action, request.body); });
}
