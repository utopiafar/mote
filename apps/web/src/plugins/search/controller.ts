import { ViewLifetime } from '@mote/shared/plugin-view-lifetime';
import type { Api } from '../../api';
import type { Memory } from '../../Memories';
import type { OwnerBrowsePage } from '../../owner-library-browse';
import { resources, type Resource, type ResourceSnapshot } from '../../resource-cache';

/** Search owns its query, pagination, filters and return ticket. Results stay
 * in a plugin cache keyed by the authenticated Api instance, so a new owner
 * never inherits another owner's pages and a remount reuses the exact read. */
export type SearchState = {
  owner: Api;
  query: string;
  cursor?: string;
  memoryCursor?: string;
  selected?: string;
  deviceId: string;
  sourceId: string;
  after: string;
  before: string;
};

export type SearchMemoryPage = { items: Memory[]; nextCursor: string | null };
export type SearchDevicePage = { items: { deviceId: string; deviceName: string }[] };
export type SearchSnapshot = SearchState & {
  readonly input: string;
  readonly filterOpen: boolean;
  readonly page: ResourceSnapshot<OwnerBrowsePage>;
  readonly memories: ResourceSnapshot<SearchMemoryPage>;
  readonly devices: ResourceSnapshot<SearchDevicePage>;
};

const idle: ResourceSnapshot<never> = { loading: false };
type SearchStream = 'page' | 'memories' | 'devices';

export function emptySearchState(api: Api): SearchState {
  return { owner: api, query: '', deviceId: '', sourceId: '', after: '', before: '' };
}

export function emptySearchSnapshot(api: Api): SearchSnapshot {
  return { ...emptySearchState(api), input: '', filterOpen: false, page: idle, memories: idle, devices: idle };
}

/** One plugin-owned result cache. Reads reuse the host's shared Resource so an
 * operation-change invalidation still reaches the visible search page, while
 * owner switch clears both the plugin handles and the owner's shared entries. */
export class SearchCache {
  readonly #api: Api;
  readonly #entries = new Map<string, Resource<unknown>>();
  constructor(api: Api) { this.#api = api; }
  get size(): number { return this.#entries.size; }
  paths(): string[] { return [...this.#entries.keys()]; }
  get<T>(path: string): Resource<T> {
    let resource = this.#entries.get(path) as Resource<T> | undefined;
    if (!resource) {
      resource = resources(this.#api).get<T>(path);
      this.#entries.set(path, resource as Resource<unknown>);
    }
    return resource;
  }
  clear(): void {
    this.#entries.clear();
    resources(this.#api).clear();
  }
}

const caches = new WeakMap<Api, SearchCache>();
export function searchCache(api: Api): SearchCache {
  let cache = caches.get(api);
  if (!cache) { cache = new SearchCache(api); caches.set(api, cache); }
  return cache;
}
export function clearSearchCache(api: Api): void {
  const cache = caches.get(api);
  if (!cache) return;
  cache.clear();
  caches.delete(api);
}

export interface SearchControllerOptions {
  readonly api: Api;
  /** A new owner starts empty and clears the previous owner's location; a
   * remount of the same owner resumes its exact hash query. */
  readonly adoptHash?: boolean;
  readonly window?: Window;
  readonly document?: Document;
}

const stateKeys = ['query', 'cursor', 'memoryCursor', 'selected', 'deviceId', 'sourceId', 'after', 'before'] as const;

/** Search controller: hash-backed query/filter/pagination state, the plugin
 * result cache and visibility-gated reads. Components render its snapshot and
 * call these methods; they never issue search reads themselves. */
export class SearchController {
  readonly #window?: Window;
  readonly #document?: Document;
  readonly #lifetime = new ViewLifetime();
  readonly #listeners = new Set<() => void>();
  #api: Api;
  #cache: SearchCache;
  #state: SearchState;
  #input: string;
  #filterOpen = false;
  #started = false;
  #resetPending: boolean;
  #page?: Resource<OwnerBrowsePage>;
  #memories?: Resource<SearchMemoryPage>;
  #devices?: Resource<SearchDevicePage>;
  #paths: Record<SearchStream, string | null> = { page: null, memories: null, devices: null };
  #unsubs: Record<SearchStream, (() => void) | undefined> = { page: undefined, memories: undefined, devices: undefined };
  #snapshot: SearchSnapshot;
  #returnPosition?: { scroll: number; opener: HTMLElement | null };

  constructor(options: SearchControllerOptions) {
    this.#api = options.api;
    this.#window = options.window ?? (typeof window === 'undefined' ? undefined : window);
    this.#document = options.document ?? this.#window?.document;
    this.#cache = searchCache(this.#api);
    this.#state = options.adoptHash === false ? emptySearchState(this.#api) : this.#read();
    this.#input = this.#state.query;
    this.#resetPending = options.adoptHash === false;
    this.#snapshot = this.#compose();
  }

  get owner(): Api { return this.#api; }
  get cache(): SearchCache { return this.#cache; }
  get cachedPaths(): string[] { return this.#cache.paths(); }
  getSnapshot = (): SearchSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #compose(): SearchSnapshot {
    return {
      ...this.#state,
      input: this.#input,
      filterOpen: this.#filterOpen,
      page: this.#page?.getSnapshot() ?? idle,
      memories: this.#memories?.getSnapshot() ?? idle,
      devices: this.#devices?.getSnapshot() ?? idle,
    };
  }

  #emit(): void {
    this.#snapshot = this.#compose();
    for (const listener of this.#listeners) listener();
  }

  #searchHash(): boolean {
    return this.#window?.location.hash.split('?')[0] === '#/search';
  }

  #read(): SearchState {
    if (!this.#searchHash()) return emptySearchState(this.#api);
    const q = new URLSearchParams(this.#window!.location.hash.split('?')[1] ?? '');
    return {
      owner: this.#api,
      query: q.get('query') ?? '',
      cursor: q.get('cursor') ?? undefined,
      memoryCursor: q.get('memoryCursor') ?? undefined,
      selected: q.get('evidence') ?? undefined,
      deviceId: q.get('deviceId') ?? '',
      sourceId: q.get('sourceId') ?? '',
      after: q.get('after') ?? '',
      before: q.get('before') ?? '',
    };
  }

  #write(): void {
    const w = this.#window;
    if (!w) return;
    const q = new URLSearchParams();
    for (const key of ['query', 'cursor', 'memoryCursor', 'deviceId', 'sourceId', 'after', 'before'] as const) {
      const value = this.#state[key];
      if (value) q.set(key, value);
    }
    if (this.#state.selected) q.set('evidence', this.#state.selected);
    w.history.replaceState(null, '', '#/search' + (q.size ? '?' + q : ''));
    const EventConstructor = (w as unknown as { Event: typeof Event }).Event;
    w.dispatchEvent(new EventConstructor('mote:workspace-state'));
  }

  #syncFromHash(): void {
    if (!this.#searchHash()) return;
    const next = this.#read();
    if (stateKeys.every(key => next[key] === this.#state[key])) return;
    this.#state = next;
    this.#input = next.query;
  }

  #visible(): boolean {
    return this.#started && this.#lifetime.state === 'visible';
  }

  #unbind(stream: SearchStream): void {
    this.#unsubs[stream]?.();
    this.#unsubs[stream] = undefined;
    this.#paths[stream] = null;
    if (stream === 'page') this.#page = undefined;
    else if (stream === 'memories') this.#memories = undefined;
    else this.#devices = undefined;
  }

  #detach(): void {
    for (const stream of ['page', 'memories', 'devices'] as const) this.#unbind(stream);
  }

  #bindOne(stream: SearchStream, path: string | null): void {
    if (!this.#visible()) { this.#unbind(stream); return; }
    if (this.#paths[stream] === path && (path === null || this.#unsubs[stream])) return;
    this.#unbind(stream);
    if (!path) return;
    this.#paths[stream] = path;
    const resource = stream === 'page' ? this.#cache.get<OwnerBrowsePage>(path)
      : stream === 'memories' ? this.#cache.get<SearchMemoryPage>(path)
      : this.#cache.get<SearchDevicePage>(path);
    if (stream === 'page') this.#page = resource as Resource<OwnerBrowsePage>;
    else if (stream === 'memories') this.#memories = resource as Resource<SearchMemoryPage>;
    else this.#devices = resource as Resource<SearchDevicePage>;
    this.#unsubs[stream] = resource.subscribe(()=>this.#emit());
  }

  #bind(): void {
    const state = this.#state;
    const scope = { ...(state.deviceId ? { deviceId: state.deviceId } : {}), ...(state.after ? { after: state.after } : {}), ...(state.before ? { before: state.before } : {}) };
    const page = state.query ? '/api/library/browse?' + new URLSearchParams({ query: state.query, limit: '30', ...scope, ...(state.sourceId ? { sourceId: state.sourceId } : {}), ...(state.cursor ? { cursor: state.cursor } : {}) }) : null;
    const memories = state.query ? '/api/memories?' + new URLSearchParams({ query: state.query, limit: '30', level: 'detail', layer: 'memory', includeStale: 'true', ...scope, ...(state.sourceId ? { sourceId: state.sourceId } : {}), ...(state.memoryCursor ? { cursor: state.memoryCursor } : {}) }) : null;
    this.#bindOne('page', page);
    this.#bindOne('memories', memories);
    this.#bindOne('devices', this.#filterOpen ? '/api/devices' : null);
  }

  #apply(next: SearchState, write: boolean): void {
    this.#state = next;
    if (write) this.#write();
    this.#bind();
    this.#emit();
  }

  #onHash = (): void => {
    if (!this.#started) return;
    this.#syncFromHash();
    this.#bind();
    this.#emit();
  };

  #onVisibility = (): void => {
    if (this.#document?.hidden) this.suspend();
    else this.resume();
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#window?.addEventListener('hashchange', this.#onHash);
    this.#document?.addEventListener('visibilitychange', this.#onVisibility);
    if (this.#document?.hidden) {
      this.#lifetime.suspend();
      this.#emit();
      return;
    }
    this.#lifetime.show();
    if (this.#resetPending) {
      this.#resetPending = false;
      this.#resetNavigation();
    } else {
      this.#syncFromHash();
      this.#bind();
      this.#emit();
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#window?.removeEventListener('hashchange', this.#onHash);
    this.#document?.removeEventListener('visibilitychange', this.#onVisibility);
    this.#lifetime.suspend();
    this.#detach();
    this.#emit();
  }

  suspend(): void {
    this.#lifetime.suspend();
    this.#detach();
    this.#emit();
  }

  resume(): void {
    if (!this.#started) return;
    this.#lifetime.show();
    if (this.#resetPending) {
      this.#resetPending = false;
      this.#resetNavigation();
      return;
    }
    this.#syncFromHash();
    this.#bind();
    this.#emit();
  }

  dispose(): void {
    this.stop();
    this.#cache.clear();
    this.#listeners.clear();
  }

  /** A different authenticated owner starts from an empty query and cache;
   * no old cookie/page/ref crosses the switch. */
  setOwner(api: Api): void {
    if (api === this.#api) return;
    this.#detach();
    this.#cache.clear();
    this.#api = api;
    this.#cache = searchCache(api);
    this.#state = emptySearchState(api);
    this.#input = '';
    this.#filterOpen = false;
    this.#resetPending = false;
    this.#write();
    this.#bind();
    this.#emit();
  }

  #resetNavigation(): void {
    this.#state = emptySearchState(this.#api);
    this.#input = '';
    this.#filterOpen = false;
    this.#write();
    this.#detach();
    this.#emit();
  }

  setInput(value: string): void {
    this.#input = value;
    this.#emit();
  }

  submit(): void {
    this.changeScope({ query: this.#input.trim() });
  }

  toggleFilter(): void {
    this.#filterOpen = !this.#filterOpen;
    this.#bind();
    this.#emit();
  }

  changeScope(patch: Partial<SearchState>): void {
    this.update({ ...patch, cursor: undefined, memoryCursor: undefined, selected: undefined });
  }

  update(patch: Partial<SearchState>): void {
    this.#apply({ ...this.#state, ...patch }, true);
  }

  select(ref: string): void {
    this.#returnPosition = { scroll: this.#window?.scrollY ?? 0, opener: (this.#document?.activeElement as HTMLElement | null) ?? null };
    this.update({ selected: ref });
  }

  close(): void {
    this.update({ selected: undefined });
    const at = this.#returnPosition;
    this.#window?.requestAnimationFrame(() => {
      if (!at) return;
      if (at.opener?.isConnected) at.opener.focus({ preventScroll: true });
      this.#window?.scrollTo(0, at.scroll);
    });
  }

  refresh(stream: SearchStream): void {
    if (stream === 'page') this.#page?.refresh();
    else if (stream === 'memories') this.#memories?.refresh();
    else this.#devices?.refresh();
  }
}
