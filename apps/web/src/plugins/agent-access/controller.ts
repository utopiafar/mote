/** Owns the Agent access page's route-backed tab/scope state and the hash
 * subscription. Retained-run reads stay explicit in the workspace components;
 * this controller never expands a run or reconstructs missing history. */
export type AgentAccessTab = 'catalog' | 'startup' | 'input';

export interface AgentAccessState {
  readonly tab: AgentAccessTab;
  readonly deviceId: string;
  readonly after: string;
  readonly before: string;
  readonly catalogOpen: boolean;
  readonly browserOpen: boolean;
  readonly runId: string;
}

export interface AgentAccessScope {
  readonly deviceId?: string;
  readonly after?: string;
  readonly before?: string;
}

export interface AgentAccessSnapshot extends AgentAccessState {
  readonly tracePage: boolean;
  readonly scope: AgentAccessScope;
  readonly scopeKey: string;
}

export interface AgentAccessControllerOptions {
  readonly window?: Window;
}

const emptyState = (): AgentAccessState => ({
  tab: 'catalog',
  deviceId: '',
  after: '',
  before: '',
  catalogOpen: false,
  browserOpen: false,
  runId: '',
});

const scopeOf = (state: AgentAccessState): AgentAccessScope => ({
  ...(state.deviceId ? { deviceId: state.deviceId } : {}),
  ...(state.after ? { after: new Date(state.after).toISOString() } : {}),
  ...(state.before ? { before: new Date(state.before).toISOString() } : {}),
});

/** Hash-backed page controller. activate subscribes to the route; the page
 * only renders the snapshot and calls update(). */
export class AgentAccessController {
  readonly #window?: Window;
  readonly #listeners = new Set<() => void>();
  #state: AgentAccessState;
  #snapshot: AgentAccessSnapshot;
  #previousTrace: boolean;
  #started = false;
  #disposed = false;

  constructor(options: AgentAccessControllerOptions = {}) {
    this.#window = options.window ?? (typeof window === 'undefined' ? undefined : window);
    const query = this.#query();
    this.#state = {
      ...emptyState(),
      tab: query.has('runId') || query.get('tab') === 'input' ? 'input' : 'catalog',
      runId: query.get('runId') ?? '',
    };
    this.#previousTrace = this.#isTrace(query);
    this.#snapshot = this.#buildSnapshot();
  }

  getSnapshot = (): AgentAccessSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#window?.addEventListener('hashchange', this.#onHash);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#window?.removeEventListener('hashchange', this.#onHash);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    this.#listeners.clear();
  }

  update(patch: Partial<AgentAccessState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    this.#snapshot = this.#buildSnapshot();
    this.#emit();
  }

  #query(): URLSearchParams {
    return new URLSearchParams(this.#window?.location.hash.split('?')[1] ?? '');
  }

  #isTrace(query: URLSearchParams): boolean {
    return query.has('runId') || query.get('tab') === 'input';
  }

  #onHash = (): void => {
    if (!this.#started || this.#disposed) return;
    const query = this.#query();
    const trace = this.#isTrace(query);
    const changed = this.#previousTrace !== trace;
    this.#previousTrace = trace;
    this.#state = {
      ...this.#state,
      tab: trace ? 'input' : changed ? 'catalog' : this.#state.tab,
      ...(query.has('runId') ? { runId: query.get('runId') ?? '' } : {}),
    };
    this.#snapshot = this.#buildSnapshot();
    this.#emit();
  };

  #buildSnapshot(): AgentAccessSnapshot {
    const tracePage = this.#isTrace(this.#query());
    const scope = scopeOf(this.#state);
    return { ...this.#state, tracePage, scope, scopeKey: JSON.stringify(scope) };
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export function createAgentAccessController(options: AgentAccessControllerOptions = {}): AgentAccessController {
  return new AgentAccessController(options);
}
