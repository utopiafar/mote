import type {FastifyInstance} from 'fastify';
import type {Context} from '@deepseek-ai/cordis';

/** A domain-owned HTTP contribution mounted by its feature bridge before listen.
 * The contribution dispatches against its current activation, so disabling and
 * re-enabling the owner never installs a second route table. */
export interface DomainRouteContribution {
  mount(app: FastifyInstance): void;
}

/** Feature id -> route contribution. The trusted assembly provides this once on
 * the same root context as the plugin host. */
export type DomainRouteTable = Readonly<Record<string, DomainRouteContribution>>;

export function contributeDomainRoutes(context:Context,contributions:DomainRouteTable){
  const table=context.get('moteDomainRoutes');
  if(table)Object.assign(table,contributions);
  else context.provide('moteDomainRoutes',{...contributions});
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    moteDomainRoutes?: DomainRouteTable;
  }
}
