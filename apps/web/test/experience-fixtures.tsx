import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {OAuth2Client} from 'google-auth-library';
import {configureLocale, getLocale} from '@mote/shared/i18n';
import {pageHash, type Activity, type QueryResult} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../../server/src/app.js';
import type {ConfigurationPlatformOptions} from '../../server/src/config.js';
import type {HostDependencies} from '../../server/src/host.js';
import type {Api, Device, Status} from '../src/api.js';
import {featuresReady} from '../src/features/bootstrap.js';
import {webFeatures} from '../src/features/registry.js';
import {FeaturePage} from '../src/features/runtime.js';
import type {PageProps} from '../src/features/types.js';
import {readPage, workspaceNavigation, type Page} from '../src/navigation.js';
import {QuickNoteDialog} from '../src/plugins/notes/index.js';
import {NavStateContext, useNavStateRead} from '../src/use-nav-state.js';
import {WorkspaceSidebar} from '../src/WorkspaceSidebar.js';
import {canonicalDestination, workspaceHash} from '../src/workspace-route.js';
import {injectedApi} from './fixtures/chat-dom.js';

export type ExperienceNode = Awaited<ReturnType<typeof buildApp>>;
export type GeneratedQuery = (input: QueryInput, node: ExperienceNode) => Promise<QueryResult & {draftProposal?: unknown}> | QueryResult & {draftProposal?: unknown};

export type ExperienceOptions = {
    query?: GeneratedQuery;
    connectorTesting?: HostDependencies['connectorTesting'];
    connectors?: Record<string, unknown>;
};

const at = () => new Date().toISOString();
export const generatedId = () => randomUUID();

export async function experienceApp(t: TestContext, options: ExperienceOptions = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'mote-experience-journeys-'));
    const token = 'generated-experience-' + randomUUID();
    const config: ConfigurationPlatformOptions = {
        path: join(directory, 'mote.yaml'),
        privateCredential: {token, tokenPath: join(directory, 'owner-token')},
        initialDocument: {
            version: 1, revision: 0,
            storage: {dataDir: directory, maxExportBytes: 2_000_000},
            server: {host: '127.0.0.1', port: 0, allowedOrigins: []},
            execution: {insightIntervalHours: 0},
            models: {
                deployment: {model: 'generated-experience-model', apiKey: '', allowUnauthenticatedLocal: false, protocol: 'deepseek', reasoningEffort: 'high'},
                embedding: {model: '', baseUrl: '', apiKey: ''},
            },
            diagnostics: {level: 'silent'},
            ...(options.connectors ? {connectors: {directory: join(directory, 'connectors'), ...options.connectors}} : {}),
        } as ConfigurationPlatformOptions['initialDocument'],
    };
    let node!: ExperienceNode;
    node = await buildApp(config, {
        backgroundWorker: false,
        ...(options.connectorTesting ? {connectorTesting: options.connectorTesting} : {}),
        agent: {
            configured: true,
            query: async input => {
                const generated = options.query
                    ? await options.query(input, node)
                    : {answer: 'Generated answer', citations: [], trace: [], runId: randomUUID()};
                return {runId: generated.runId ?? randomUUID(), ...generated};
            },
            close: async () => {},
        },
    });
    // The generated model stands in for the model-admission owner in task-only
    // integration journeys; production admission is covered by server tests.
    (node.batchProcessing as unknown as {modelAdmission:() => undefined}).modelAdmission = () => undefined;
    await node.app.ready();
    t.after(async () => {
        await node.app.close();
        await rm(directory, {recursive: true, force: true});
    });
    const api = injectedApi(node.app, {authorization: 'Bearer ' + token}) as Api;
    return {node, api, directory, token};
}

export function answer(text: string, extra: Partial<QueryResult> = {}): QueryResult {
    return {answer: text, citations: [], trace: [], runId: randomUUID(), ...extra};
}

export async function postQuestion(api: Api, question: string, scope: Record<string, unknown> = {kind: 'all'}) {
    const conversation = await api.request<{id: string}>('/api/conversations/main');
    const receipt = await api.request<{id: string; status: string}>('/api/conversations/messages', {
        method: 'POST',
        body: JSON.stringify({conversationId: conversation.id, clientRequestId: randomUUID(), question, scope}),
    });
    return {conversationId: conversation.id, messageId: receipt.id};
}

export async function settledTurn(api: Api, conversationId: string, messageId: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const value = await api.request<{id: string; status: string; result?: QueryResult; question: string}>(
            '/api/conversations/' + conversationId + '/messages/' + messageId);
        if (value.status === 'completed') return value;
        if (value.status === 'failed' || value.status === 'cancelled') throw new Error('Generated turn did not complete: ' + value.status);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Generated turn did not settle');
}

export async function createNote(api: Api, text: string) {
    const id = generatedId();
    const observedAt = at();
    await api.request('/api/notes', {
        method: 'POST',
        body: JSON.stringify({
            client: 'web', id, deviceId: 'mote-web', deviceName: 'Mote Web', platform: 'import', capturedAt: observedAt, text,
            metadata: {version: 1, observedAt, collector: {method: 'manual'}, noteOrigin: {kind: 'manual', text}},
        }),
    });
    return id;
}

export function seedMemory(node: ExperienceNode, input: {id?: string; title: string; statement: string; noteId: string; status?: 'published' | 'proposed'; admission?: Record<string, unknown>}) {
    const id = input.id ?? generatedId(), now = at();
    const value = {
        id, version: 1, domain: 'personal', tier: 'episode', kind: 'episodic',
        title: input.title, statement: input.statement, uncertainty: 'Generated only', status: input.status ?? 'published',
        evidenceIds: [input.noteId], evidence: [], createdAt: now, updatedAt: now,
        model: 'generated-experience-fixture', runId: 'generated-experience-fixture', fingerprint: 'a'.repeat(64),
        admission: input.admission ?? {layer: 'memory', reason: 'Generated onboarding observation', scope: 'Generated fixture', attribution: 'observed'},
    };
    node.store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(id, now, JSON.stringify(value));
    node.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(id, input.noteId);
    return value;
}

export function seedCard(node: ExperienceNode, input: {
    id?: string; kind: 'activity' | 'suggestion' | 'question' | 'briefing' | 'artifact';
    title: string; body?: string; noteId?: string; quote?: string;
    category?: string; subject?: string; action?: string; gist?: string; reminderReason?: string;
}) {
    const id = input.id ?? generatedId(), evidence = input.noteId
        ? [{id: input.noteId, offset: 0, quote: input.quote ?? input.title}]
        : [];
    return node.featureServices.assistantCards.publish({
        id, kind: input.kind, matterId: null, version: 'generated:' + id, state: 'open',
        title: input.title, body: input.body ?? input.title,
        evidence, evidenceDependencies: {version: 1, complete: true, ids: evidence.map(proof => proof.id)},
        ...(input.category ? {category: input.category} : {}), ...(input.subject ? {subject: input.subject} : {}),
        ...(input.action ? {action: input.action} : {}), ...(input.gist ? {gist: input.gist} : {}),
        ...(input.reminderReason ? {reminderReason: input.reminderReason} : {}),
    }, undefined, {kind: 'all'}, () => undefined);
}

export function seedCommitment(node: ExperienceNode, input: {
    id?: string; title: string; noteId: string; quote: string; personMemoryId?: string;
    deadlineAt?: string | null; progress?: string; progressAt?: string;
}) {
    const commitmentId = input.id ?? generatedId(), first = generatedId(), proof = {id: input.noteId, offset: 0, quote: input.quote};
    node.featureServices.assistantCommitments.publish({
        commitmentId, eventId: first, kind: 'commitment', occurredAt: null,
        summary: 'Generated promise from a group conversation', evidence: [proof],
        evidenceDependencies: {version: 1, complete: true, ids: [input.noteId]},
        changes: {title: input.title, status: 'confirmed', deadline: {text: 'Generated due date', at: input.deadlineAt ?? null}, matterId: null, personMemoryId: input.personMemoryId ?? null},
    }, undefined, {kind: 'all'}, () => undefined);
    if (input.progress) {
        node.featureServices.assistantCommitments.publish({
            commitmentId, eventId: generatedId(), kind: 'progress', occurredAt: input.progressAt ?? at(),
            summary: input.progress, evidence: [proof], evidenceDependencies: {version: 1, complete: true, ids: [input.noteId]},
            changes: {},
        }, 1, {kind: 'all'}, () => undefined);
    }
    return commitmentId;
}

const notionPackageId = 'mote.official.notion';
export const notionContributionId = 'official-notion';
export function seedNotionPlugin(node: ExperienceNode) {
    const source = {repository: 'generated/notion-connector', tag: 'generated-fixture', commit: 'a'.repeat(40), digest: 'b'.repeat(64)};
    const packageView = {
        id: notionPackageId, name: 'Notion', version: '1.0.0', source, runtime: 'service',
        state: 'installed', desired: true, observed: 'ready', issues: [], instanceIds: [], allowedActions: [],
    };
    const instanceView = {
        id: 'generated-notion-instance', packageId: notionPackageId, name: 'Notion', revision: 1, scope: 'default',
        configurationSchema: [], configuration: {}, secretStatus: {}, desired: true, observed: 'ready', issues: [],
        capabilities: [{id: 'source.connector', state: 'verified'}], allowedActions: [],
    };
    const put = node.store.db.prepare('INSERT OR REPLACE INTO plugin_build_instances VALUES(?,?)');
    put.run(notionPackageId, JSON.stringify({
        id: notionPackageId, packageId: notionPackageId, kind: 'package', desired: null, observed: 'stopped', blockers: [],
        package: {view: packageView, manifest: {
            schemaVersion: 1, id: notionPackageId, name: 'Notion', version: '1.0.0', runtime: 'service',
            sourceCatalog: [{id: notionContributionId, title: 'Notion', body: 'Generated Notion connector', note: '', icon: 'file', kinds: ['mote.official.notion'], target: {pageId: 'sources', href: '#/connections?setup=official-notion'}}],
            actionCapabilities: [], configuration: [], dependencies: [], access: [], contributions: [], capabilities: ['source.connector'],
        }},
    }));
    put.run('generated-notion-instance', JSON.stringify({
        id: 'generated-notion-instance', packageId: notionPackageId, kind: 'instance',
        desired: {packageId: notionPackageId, version: '1.0.0', configurationRevision: 1}, observed: 'active', blockers: [],
        instance: {view: instanceView},
    }));
}

export type GeneratedGoogle = ReturnType<typeof generatedGoogle>;
export function generatedGoogle() {
    const calendar = {id: 'generated-calendar', summary: 'Generated calendar', timeZone: 'UTC', primary: true, accessRole: 'owner'};
    const event = {id: 'generated-calendar-event', etag: 'generated-etag', summary: 'Generated planning event',
        start: {dateTime: '2026-11-21T09:00:00Z'}, end: {dateTime: '2026-11-21T10:00:00Z'}, status: 'confirmed'};
    const calls: string[] = [];
    const oauth = new OAuth2Client({clientId: 'generated-client', clientSecret: 'generated-secret',
        redirectUri: 'http://localhost/oauth/google/callback'});
    oauth.getToken = (async () => ({tokens: {refresh_token: 'generated-refresh', access_token: 'generated-access',
        scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly'}})) as never;
    oauth.getAccessToken = (async () => ({token: 'generated-access'})) as never;
    const fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith('/calendarList')) return Response.json({items: [calendar]});
        if (url.pathname.endsWith('/events')) return Response.json({items: [event], nextSyncToken: 'generated-sync'});
        throw new Error('Unexpected generated Google request: ' + url.pathname);
    }) as typeof globalThis.fetch;
    const dependencies = {oauthFactory: () => oauth, fetch};
    const connectors = {
        googleClientId: 'generated-client', googleClientSecret: 'generated-secret',
        googleRedirectUri: 'http://localhost/oauth/google/callback',
    };
    return {dependencies, connectors, calls, calendar};
}

type ShellProps = {api: Api; opened: string[]};
function Shell({api, opened}: ShellProps) {
    const [page, setPage] = React.useState<Page>(() => readPage(location.hash));
    const [archiveTab, setArchiveTab] = React.useState('materials');
    const [revision, setRevision] = React.useState(0);
    const [quick, setQuick] = React.useState(false);
    const [status, setStatus] = React.useState<Status | null>(null);
    const [devices, setDevices] = React.useState<Device[]>([]);
    const [activity, setActivity] = React.useState<Activity>({apps: [], devices: [], totalDurationMs: 0, captures: 0});
    const nav = useNavStateRead(api);
    React.useEffect(() => {
        let active = true;
        void Promise.allSettled([
            api.request<Status>('/api/status').then(value => active && setStatus(value)),
            api.request<{items: Device[]}>('/api/devices').then(value => active && setDevices(value.items)),
            api.request<Activity>('/api/activity').then(value => active && setActivity(value)),
        ]);
        return () => {active = false;};
    }, [api, revision]);
    React.useEffect(() => {
        const navigate = () => setPage(readPage(location.hash));
        window.addEventListener('hashchange', navigate);
        return () => window.removeEventListener('hashchange', navigate);
    }, []);
    const onPage = (next: Page) => {
        const target = canonicalDestination(next, archiveTab, webFeatures.collections().map(entry => entry.id));
        const route = webFeatures.page(target.page)?.route ?? target.page;
        window.history.pushState(null, '', workspaceHash(route, target.page === 'archive' ? target.collection : undefined));
        setArchiveTab(target.collection);
        setPage(target.page);
    };
    const props: PageProps = {
        api, status, devices, activity, insights: [], onPage, onOpen: ref => opened.push(ref),
        range: {}, rangeSelectionKey: 'all', archiveTab, setArchiveTab,
        timelineRevision: revision, refresh: () => setRevision(value => value + 1), disconnect: () => {},
        sessionLifetime: 'session', changeSessionLifetime: () => {},
    };
    return <NavStateContext.Provider value={nav.value}>
        <WorkspaceSidebar groups={workspaceNavigation()} page={page} onPage={onPage}/>
        <header className="generated-topbar"><button type="button" className="generated-quick-note" onClick={() => setQuick(true)}>记录</button></header>
        <div className="content" data-page={page}>
            <FeaturePage page={page} props={props}/>
        </div>
        {quick && <QuickNoteDialog api={api} namespace={location.origin} revision={revision} onSaved={() => setRevision(value => value + 1)} onClose={() => setQuick(false)}/>}
    </NavStateContext.Provider>;
}

export async function mountExperience(t: TestContext, api: Api, hash = pageHash('chat')) {
    await featuresReady;
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {url: 'http://localhost/' + hash, pretendToBeVisual: true});
    const before = new Map<string, PropertyDescriptor | undefined>(), previousLocale = getLocale();
    configureLocale(() => 'zh-CN');
    for (const [key, value] of Object.entries({window: dom.window, location: dom.window.location, document: dom.window.document,
        navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement, localStorage: dom.window.localStorage,
        sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true})) {
        before.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
    }
    Object.assign(dom.window.HTMLElement.prototype, {attachEvent: () => {}, detachEvent: () => {}, scrollIntoView: () => {}});
    dom.window.scrollTo = () => {};
    dom.window.confirm = () => true;
    const d = dom.window.document, w = dom.window, root = createRoot(d.getElementById('root')!);
    const opened: string[] = [];
    t.after(async () => {
        await act(async () => root.unmount());
        for (const [key, value] of before) {if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);}
        configureLocale(() => previousLocale);
        dom.window.close();
    });
    await act(async () => root.render(React.createElement(Shell, {api, opened})));
    const tick = async () => {await act(async () => {await new Promise(resolve => w.setTimeout(resolve, 0)); await Promise.resolve();});};
    const settle = async (ms = 20) => {await act(async () => {await new Promise(resolve => w.setTimeout(resolve, ms));});};
    const until = async (check: () => boolean, label: string, timeout = 10000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            if (check()) return;
            await settle(10);
        }
        throw new Error('Generated journey did not settle: ' + label);
    };
    const syncHash = async () => {
        await act(async () => {w.dispatchEvent(new w.HashChangeEvent('hashchange'));});
        await settle();
    };
    const go = async (next: string) => {
        await act(async () => {w.history.pushState(null, '', next);});
        await syncHash();
    };
    const click = async (element: Element) => {
        await act(async () => {(element as HTMLElement).click();});
        await syncHash();
    };
    const button = (label: string, scope: ParentNode = d) => {
        const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
        if (!value) throw new Error('Generated button not found: ' + label);
        return value;
    };
    const field = async (selector: string, value: string) => {
        const input = d.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
        if (!input) throw new Error('Generated field not found: ' + selector);
        const type = input.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement : w.HTMLInputElement;
        await act(async () => {
            input.focus();
            Object.getOwnPropertyDescriptor(type.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new w.Event('input', {bubbles: true}));
            input.dispatchEvent(new w.KeyboardEvent('keyup', {bubbles: true, key: 'a'}));
        });
    };
    const submit = async (form: HTMLFormElement) => {
        await act(async () => {form.dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));});
    };
    return {root, d, w, opened, tick, settle, until, go, click, button, field, submit, syncHash};
}
