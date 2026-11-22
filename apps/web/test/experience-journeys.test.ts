import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {randomUUID} from 'node:crypto';
import {pageHash} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {resources} from '../src/resource-cache.js';
import {
    answer, createNote, experienceApp, generatedGoogle, generatedNotion, mountExperience, postQuestion, seedCard, seedCommitment,
    seedMemory, settledTurn,
} from './experience-fixtures.js';

const isDisposition = (input: QueryInput) => input.question.includes('mote.conversation-disposition');
const isBackground = (input: QueryInput) => input.executionLane === 'background';
const backgroundResult = (text: string) => ({
    answer: JSON.stringify({answer: text, actions: []}),
    citations: [], trace: [], runId: randomUUID(),
});

test('QA1-01 J1 first day: add a collector, connect a calendar, start onboarding, then see Memory, Ideas and Feed content', {timeout: 120000}, async t => {
    const google = generatedGoogle();
    const {node, api} = await experienceApp(t, {
        connectorTesting: {google: google.dependencies},
        connectors: google.connectors,
        query: input => isDisposition(input) ? answer(JSON.stringify({kind: 'independent'}))
            : isBackground(input) ? backgroundResult('Generated onboarding result')
            : answer('Generated onboarding answer'),
    });
    const note = await createNote(api, 'Generated first-day observation');
    seedMemory(node, {title: 'Generated owner preference', statement: 'Generated first-day Memory', noteId: note});
    seedCard(node, {kind: 'suggestion', title: 'Generated first-day idea', noteId: note});
    seedCard(node, {kind: 'activity', title: 'Generated first-day activity', noteId: note, category: '工作', gist: 'Generated first-day feed'});
    const invitationResponses: unknown[] = [];
    const request = api.request;
    api.request = (async (path: string, init?: RequestInit) => {
        const value = await request(path, init);
        if (path === '/api/connections/invitations' && init?.method === 'POST') invitationResponses.push(value);
        return value;
    }) as typeof api.request;

    const ui = await mountExperience(t, api, pageHash('library'));
    await ui.until(() => Boolean(ui.d.querySelector('.library-materials')), 'library landing page');

    await ui.click(ui.button('添加设备', ui.d.querySelector('.library-materials')!));
    await ui.until(() => Boolean(ui.d.querySelector('[role=dialog]')), 'device pairing sheet');
    await ui.click(ui.button('生成连接邀请', ui.d.querySelector('[role=dialog]')!));
    await ui.until(() => (invitationResponses[0] as {invitation?: {code?: string}} | undefined)?.invitation?.code !== undefined, 'generated invitation');
    const invitation = (invitationResponses[0] as {invitation: {code: string}}).invitation;
    await api.request('/api/connections/redeem', {
        method: 'POST',
        body: JSON.stringify({code: invitation.code, deviceId: 'generated-mac', deviceName: 'Generated Mac', platform: 'macos'}),
    });
    await ui.click(ui.button('关闭', ui.d.querySelector('[role=dialog]')!));
    await ui.until(() => Boolean(ui.d.querySelector('[data-device-id="generated-mac"]')), 'paired collector appears');

    await ui.click(ui.d.querySelector('[data-nav-item="connections"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.connections-overview')), 'Connections page');
    await ui.click(ui.d.querySelector('.connections-heading a')!);
    await ui.until(() => Boolean(ui.d.querySelector('.discovery-source-catalog')), 'source catalog');

    const calendarCard = [...ui.d.querySelectorAll<HTMLAnchorElement>('.discovery-source-card')]
        .find(card => card.querySelector('h3')?.textContent === 'Google Calendar');
    assert.ok(calendarCard, 'the generated source catalog lists the calendar connector');
    await ui.click(calendarCard);
    await ui.until(() => Boolean(ui.button('连接账号')), 'calendar connector setup');
    await ui.click(ui.button('连接账号'));
    await ui.until(() => Boolean(ui.d.querySelector('a.connector-authorization')), 'calendar authorization link');
    const authorization = new URL(ui.d.querySelector<HTMLAnchorElement>('a.connector-authorization')!.getAttribute('href')!);
    assert.equal(authorization.protocol, 'https:');
    await api.raw('/oauth/google/callback?' + new URLSearchParams({state: authorization.searchParams.get('state')!, code: 'generated-code'}));
    await ui.click(ui.button('刷新状态'));
    await ui.until(() => Boolean(ui.d.querySelector('.connector-check input[type=checkbox]')), 'generated calendar list');
    await ui.click(ui.d.querySelector('.connector-check input[type=checkbox]')!);
    await ui.click(ui.button('保存选择'));
    await ui.until(() => Boolean([...ui.d.querySelectorAll('p')].find(p => /已保存/.test(p.textContent ?? ''))), 'calendar selection saved');
    await ui.click(ui.button('立即同步'));
    await ui.until(() => Boolean([...ui.d.querySelectorAll('p')].find(p => /已同步/.test(p.textContent ?? ''))), 'calendar sync receipt');
    assert.ok(google.calls.some(path => path.endsWith('/calendarList')));
    const sources = await api.request<{items: {id: string; kind: string}[]}>('/api/sources');
    const calendarSource = sources.items.find(source => source.kind === 'google-calendar');
    assert.ok(calendarSource, 'the connected calendar source is durable');

    await ui.click(ui.d.querySelector('[data-nav-item="connections"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.connection-scan')), 'Onboarding card');
    await ui.click(ui.button('开始', ui.d.querySelector('.connection-scan')!));
    await ui.until(() => Boolean(ui.d.querySelector('[role=dialog] input[type=checkbox]')), 'Onboarding source selection');
    await ui.click(ui.d.querySelector(`[role=dialog] input[value="${calendarSource.id}"]`)!);
    await ui.field('[role=dialog] input[name=days]', '30');
    await ui.click(ui.d.querySelector('[role=dialog] button[type=submit]')!);
    await ui.until(() => Boolean(ui.d.querySelector('[data-onboarding-chat-progress]')), 'Onboarding progress in chat');

    await ui.click(ui.d.querySelector('[data-nav-item="memory"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.memory-page-row')), 'Memory content');
    await ui.click(ui.d.querySelector('[data-nav-item="ideas"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.idea-row')), 'Ideas content');
    await ui.click(ui.d.querySelector('[data-nav-item="feed"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.feed-row')), 'Feed content');
});

test('QA1-02 J2 every morning: land in chat, start one idea, ignore two, then read the unread Feed', {timeout: 120000}, async t => {
    const {node, api} = await experienceApp(t, {
        query: input => isDisposition(input) ? answer(JSON.stringify({kind: 'independent'}))
            : isBackground(input) ? backgroundResult('Generated started idea result')
            : answer('Generated morning brief'),
    });
    const brief = await postQuestion(api, 'Generated morning question');
    await settledTurn(api, brief.conversationId, brief.messageId);
    const note = await createNote(api, 'Generated idea evidence');
    const ideas = [
        seedCard(node, {kind: 'suggestion', title: 'Generated first idea', noteId: note}),
        seedCard(node, {kind: 'suggestion', title: 'Generated second idea', noteId: note}),
        seedCard(node, {kind: 'suggestion', title: 'Generated third idea', noteId: note}),
    ];
    seedCard(node, {kind: 'activity', title: 'Generated unread activity', noteId: note, gist: 'Generated unread gist'});

    const ui = await mountExperience(t, api, pageHash('chat'));
    await ui.until(() => Boolean(ui.d.querySelector('textarea[aria-label="向 Mote 提问"]')), 'chat landing page');
    await ui.until(() => Boolean(ui.d.querySelector('[data-nav-badge="ideas"]')), 'ideas badge');
    assert.equal(ui.d.querySelector('[data-nav-badge="ideas"]')!.textContent, '3');

    await ui.click(ui.d.querySelector('[data-nav-item="ideas"]')!);
    await ui.until(() => ui.d.querySelectorAll('.idea-row[data-card-id]').length === 3, 'three ideas');
    await ui.click(ui.d.querySelector(`.idea-row[data-card-id="${ideas[0]!.id}"] .idea-start`)!);
    await ui.until(() => Boolean(ui.d.querySelector('.idea-row[data-idea="started"]')), 'started idea');
    for (const ignored of [ideas[1]!, ideas[2]!]) {
        await ui.click(ui.d.querySelector(`.idea-row[data-card-id="${ignored.id}"] .idea-ignore`)!);
        await ui.until(() => !ui.d.querySelector(`.idea-row[data-card-id="${ignored.id}"]`), 'ignored idea removed');
    }

    await ui.click(ui.d.querySelector('[data-nav-item="feed"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.feed-row')), 'feed rows');
    await ui.click(ui.button('未读'));
    await ui.until(() => Boolean(ui.d.querySelector('.feed-row[data-unread="true"]')), 'unread feed row');
});

test('QA1-03 J3 delegate one task: assignment, progress line, mid-course supplement and the result card', {timeout: 120000}, async t => {
    let planningNote = '', supplemented = false;
    const {api} = await experienceApp(t, {
        query: input => {
            if (isDisposition(input)) return answer(JSON.stringify({kind: 'independent'}));
            if (isBackground(input)) return backgroundResult('Generated outline with cost focus');
            if (input.question.includes('重点放成本')) {supplemented = true; return answer('Generated supplement acknowledged');}
            return {...answer('Generated planning answer', {evidenceDependencies: {version: 1, complete: true, ids: [planningNote]}}), draftProposal: {goal: 'Generated review outline'}};
        },
    });
    planningNote = await createNote(api, 'Generated review planning evidence');
    const taskId = randomUUID();
    let taskStarted = false, taskCompleted = false;
    const request = api.request;
    api.request = (async (path: string, init?: RequestInit) => {
        if (path === '/api/assistant/commands') {
            const value = await request(path, init);
            const command = JSON.parse(String(init?.body)) as {capability?: string};
            if (command.capability === 'assistant.task.start') taskStarted = true;
            return value;
        }
        if (path.includes('/assistant-tasks?')) {
            if (!taskStarted) return {items: []};
            return taskCompleted
                ? {items: [{task: {id: taskId, state: 'completed', goal: 'Generated review outline'},
                    result: {answer: 'Generated outline with cost focus', citations: [], trace: [], runId: randomUUID()}}]}
                : {items: [{task: {id: taskId, state: 'running', goal: 'Generated review outline'}}]};
        }
        return request(path, init);
    }) as typeof api.request;
    const ui = await mountExperience(t, api, pageHash('chat'));
    await ui.until(() => Boolean(ui.d.querySelector('textarea[aria-label="向 Mote 提问"]')), 'chat landing page');
    await ui.field('textarea[aria-label="向 Mote 提问"]', 'Generated assignment to prepare the review');
    await ui.submit(ui.d.querySelector<HTMLFormElement>('form.ask-form')!);
    await ui.until(() => Boolean(ui.d.querySelector('.assistant-draft')), 'assistant draft');
    await ui.until(() => !ui.d.querySelector<HTMLButtonElement>('.assistant-draft-actions button.primary')?.disabled, 'start enabled');
    await ui.click(ui.d.querySelector('.assistant-draft-actions button.primary')!);
    await ui.until(() => Boolean(ui.d.querySelector('.assistant-task-result[data-state="running"]')), 'task progress line');
    assert.equal(ui.d.querySelector('.chat-task-result'), null, 'the task has no result before the mid-course supplement');

    // The owner supplements the running task with an ordinary chat message
    // from the same landing page; the result may only complete afterwards.
    await ui.field('textarea[aria-label="向 Mote 提问"]', 'Generated mid-course supplement: 重点放成本');
    await ui.submit(ui.d.querySelector<HTMLFormElement>('form.ask-form')!);
    await ui.until(() => ui.d.body.textContent!.includes('Generated supplement acknowledged'), 'mid-course supplement acknowledgement');
    assert.equal(supplemented, true, 'the supplement was sent through the chat composer while the task was running');
    assert.ok([...ui.d.querySelectorAll('.asked-question')].some(node => node.textContent?.includes('重点放成本')), 'the supplement is its own visible chat message');
    assert.ok(ui.d.querySelector('.assistant-task-result[data-state="running"]'), 'the task stays in progress while the supplement is accepted');
    assert.equal(ui.d.querySelector('.chat-task-result'), null, 'the supplement acknowledgement is not the task result');

    taskCompleted = true;
    await ui.until(() => Boolean(ui.d.querySelector('.chat-task-result')), 'task result card', 20000);
    assert.match(ui.d.querySelector('.chat-task-result')!.textContent!, /Generated outline with cost focus/);
});

test('QA1-04 J4 follow a promise by person, hand it to Mote, then see the overdue reminder in Feed', {timeout: 120000}, async t => {
    const {node, api} = await experienceApp(t, {
        query: input => isDisposition(input) ? answer(JSON.stringify({kind: 'independent'}))
            : isBackground(input) ? backgroundResult('Generated follow-up result')
            : answer('Generated promise answer'),
    });
    const promiseText = 'Generated group conversation promise';
    const note = await createNote(api, promiseText);
    const person = seedMemory(node, {title: '周雨', statement: 'Generated person', noteId: note});
    const deadline = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const commitment = seedCommitment(node, {
        title: 'Generated design draft promise', noteId: note, quote: promiseText,
        personMemoryId: person.id, deadlineAt: deadline, progress: 'Generated progress from yesterday',
        progressAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const ui = await mountExperience(t, api, '#/goals');
    await ui.until(() => Boolean(ui.d.querySelector('.goals-page')), 'Goals landing page');
    await ui.click(ui.button('人'));
    await ui.until(() => Boolean(ui.d.querySelector('[data-group="person:周雨"]')), 'person grouping');
    const row = ui.d.querySelector(`.goals-row[data-item-id="${commitment}"]`);
    assert.ok(row, 'the promise belongs to the person group');
    assert.match(row!.textContent!, /Generated progress from yesterday/);
    await ui.click(ui.button('照做', row!));
    await ui.until(() => Boolean(row!.querySelector('.goals-follow')?.textContent?.includes('已交给 Mote')), 'follow handed to Mote');

    const reminder = seedCard(node, {kind: 'activity', title: 'Generated overdue reminder', noteId: note, reminderReason: 'Generated deadline passed', category: '工作'});
    await ui.click(ui.d.querySelector('[data-nav-item="feed"]')!);
    await ui.until(() => Boolean(ui.d.querySelector(`.feed-row[data-card-id="${reminder.id}"]`)), 'overdue reminder in Feed');
    await ui.click(ui.button('未读'));
    await ui.until(() => ui.d.querySelector(`.feed-row[data-card-id="${reminder.id}"]`)?.getAttribute('data-unread') === 'true', 'reminder is unread');
});

test('QA1-05 J5 correct an understanding in chat, see the Memory update, and use it in the next answer', {timeout: 120000}, async t => {
    let memoryId = '';
    let corrected = false;
    const {node, api} = await experienceApp(t, {
        query: async input => {
            if (isDisposition(input)) return answer(JSON.stringify({kind: 'independent'}));
            if (isBackground(input)) return backgroundResult('Generated correction result');
            if (input.question.includes('是我朋友')) {
                // The generated model records the corrected understanding as a
                // new published interpretation; the exact correction UI is
                // covered by the Memory page tests.
                seedMemory(node, {title: '林舟', statement: 'Generated: 林舟是我的朋友。', noteId: correctionNote});
                corrected = true;
                return answer('Generated correction saved');
            }
            if (input.question.includes('林舟')) {
                const row = node.store.db.prepare("SELECT json FROM memories WHERE json_extract(json,'$.title')='林舟' AND json_extract(json,'$.status')='published' AND json_extract(json,'$.supersededBy') IS NULL ORDER BY rowid DESC LIMIT 1").get() as {json?: string} | undefined;
                const statement = row?.json ? (JSON.parse(row.json) as {statement: string}).statement : 'Generated missing understanding';
                return answer('Generated understanding: ' + statement, {evidenceDependencies: {version: 1, complete: true, ids: [note]}});
            }
            return answer('Generated answer');
        },
    });
    const note = await createNote(api, 'Generated person evidence');
    const correctionNote = await createNote(api, 'Generated: 林舟是我的朋友。');
    memoryId = seedMemory(node, {title: '林舟', statement: 'Generated: 林舟是同事。', noteId: note}).id;
    const ui = await mountExperience(t, api, pageHash('chat'));
    await ui.until(() => Boolean(ui.d.querySelector('textarea[aria-label="向 Mote 提问"]')), 'chat landing page');

    await ui.field('textarea[aria-label="向 Mote 提问"]', 'Generated question: 林舟是谁');
    await ui.submit(ui.d.querySelector<HTMLFormElement>('form.ask-form')!);
    await ui.until(() => ui.d.body.textContent!.includes('Generated: 林舟是同事。'), 'initial understanding');
    await ui.field('textarea[aria-label="向 Mote 提问"]', 'Generated correction: 林舟是我朋友');
    await ui.submit(ui.d.querySelector<HTMLFormElement>('form.ask-form')!);
    await ui.until(() => ui.d.body.textContent!.includes('Generated correction saved'), 'correction answer');
    assert.equal(corrected, true);

    await ui.click(ui.d.querySelector('[data-nav-item="memory"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.memory-page-row')), 'Memory page after correction');
    assert.match(ui.d.querySelector('.memory-page')!.textContent!, /Generated: 林舟是我的朋友。/);

    // Owner-local chat identity is deletable; the follow-up starts a clean
    // conversation instead of inheriting a stale evidence lineage.
    node.store.db.prepare('DELETE FROM conversation_turns').run();
    node.store.db.prepare('DELETE FROM conversations').run();
    node.store.db.prepare("DELETE FROM settings WHERE key='main-conversation-id'").run();
    resources(api).invalidate(key => key.startsWith('/api/conversations'));
    await ui.click(ui.d.querySelector('[data-nav-item="chat"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('textarea[aria-label="向 Mote 提问"]')), 'chat after memory correction');
    await ui.field('textarea[aria-label="向 Mote 提问"]', 'Generated follow-up: 林舟是谁');
    await ui.submit(ui.d.querySelector<HTMLFormElement>('form.ask-form')!);
    await ui.until(() => ui.d.body.textContent!.includes('Generated: 林舟是我的朋友。'), 'next answer uses the corrected understanding');
});

test('QA1-06 J6 record one note, find it in the library, then ask for it in chat', {timeout: 120000}, async t => {
    const dining = 'Generated 青禾餐厅';
    const {api} = await experienceApp(t, {
        query: input => isDisposition(input) ? answer(JSON.stringify({kind: 'independent'}))
            : isBackground(input) ? backgroundResult('Generated note result')
            : input.question.includes('餐厅') ? answer('Generated answer: ' + dining)
            : answer('Generated answer'),
    });
    const ui = await mountExperience(t, api, pageHash('chat'));
    await ui.until(() => Boolean(ui.d.querySelector('textarea[aria-label="向 Mote 提问"]')), 'chat landing page');
    await ui.click(ui.d.querySelector('.generated-quick-note')!);
    await ui.until(() => Boolean(ui.d.querySelector('.quick-note-dialog')), 'quick note dialog');
    await ui.field('#note-text', dining + ' 的订位是周六。');
    await ui.click(ui.button('保存', ui.d.querySelector('.quick-note-dialog')!));
    await ui.until(() => !ui.d.querySelector('.quick-note-dialog'), 'quick note saved');

    await ui.click(ui.d.querySelector('[data-nav-item="library"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.library-materials')), 'library landing page');
    await ui.field('input[aria-label="搜索资料"]', '青禾');
    await ui.submit(ui.d.querySelector<HTMLFormElement>('form.library-search')!);
    await ui.until(() => ui.d.querySelector('.library-materials')!.textContent!.includes('青禾'), 'note found in library');

    await ui.click(ui.d.querySelector('[data-nav-item="chat"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('textarea[aria-label="向 Mote 提问"]')), 'chat after library search');
    await ui.field('textarea[aria-label="向 Mote 提问"]', 'Generated question: 上周我说的那个餐厅叫什么');
    await ui.submit(ui.d.querySelector<HTMLFormElement>('form.ask-form')!);
    await ui.until(() => ui.d.body.textContent!.includes('Generated answer: ' + dining), 'chat answer finds the note');
});

test('QA1-07 J7 add Notion: install from Skills, configure and connect it, then the Connections overview gains one service card while the sidebar stays the same', {timeout: 180000}, async t => {
    const notion = generatedNotion(t);
    const {api} = await experienceApp(t, {
        connectorTesting: {fetch: notion.fetch},
        query: input => isDisposition(input) ? answer(JSON.stringify({kind: 'independent'})) : answer('Generated answer'),
    });
    const ui = await mountExperience(t, api, pageHash('skills'));
    await ui.until(() => Boolean(ui.d.querySelector('.skills-page')), 'skills landing page');
    assert.equal(ui.d.querySelector('[data-skill-id="package:mote.official.notion"]'), null, 'Notion is not installed before the journey starts');
    const sidebarBefore = [...ui.d.querySelectorAll('[data-nav-item]')].map(item => [item.getAttribute('data-nav-item'), item.getAttribute('aria-label')]);
    const overviewCards = () => [...ui.d.querySelectorAll('.connections-overview .connection-card[data-service-id]')]
        .map(card => card.getAttribute('data-service-id') ?? '');

    // The owner-visible connection overview has no Notion service card before
    // install; the source catalog's pre-listed official slot is not a card.
    await ui.click(ui.d.querySelector('[data-nav-item="connections"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.connections-overview')), 'Connections landing page');
    const cardsBefore = overviewCards();
    assert.equal(cardsBefore.includes('official-notion'), false, 'Notion has no connection service card before install');

    // Back to the landing Skills page, then use its Add surface to install Notion.
    await ui.click(ui.d.querySelector('[data-nav-item="skills"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.skills-page')), 'skills landing page again');
    await ui.click(ui.button('添加', ui.d.querySelector('.skills-page')!));
    await ui.until(() => Boolean(ui.d.querySelector('.plugin-official-catalog')), 'official plugin catalog');
    const notionEntry = [...ui.d.querySelectorAll('.plugin-official-catalog article')]
        .find(entry => entry.querySelector('h3')?.textContent?.includes('Notion'));
    assert.ok(notionEntry, 'the official catalog lists Notion');
    await ui.click(ui.button('预览并安装', notionEntry));
    await ui.until(() => Boolean(ui.d.querySelector('[role=dialog] button.primary:not([disabled])')), 'Notion install preview');
    await ui.click(ui.button('安装此版本', ui.d.querySelector('[role=dialog]')!));
    await ui.until(() => [...ui.d.querySelectorAll('.provider-card')].some(card => card.textContent?.includes('Notion') && card.textContent?.includes('已安装')), 'installed Notion package in the plugin center', 20000);

    const sidebarAfter = [...ui.d.querySelectorAll('[data-nav-item]')].map(item => [item.getAttribute('data-nav-item'), item.getAttribute('aria-label')]);
    assert.deepEqual(sidebarAfter, sidebarBefore, 'installing Notion adds no sidebar destination');

    // Installation alone is not a connection. Follow the connection page's
    // own Notion setup entry, then its visible link to the plugin center.
    await ui.click(ui.d.querySelector('[data-nav-item="connections"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.connections-overview')), 'Connections landing page after install');
    assert.equal(overviewCards().includes('official-notion'), false, 'installing Notion alone adds no connection service card');
    await ui.click(ui.d.querySelector('.connections-heading a')!);
    await ui.until(() => Boolean(ui.d.querySelector('.discovery-source-catalog')), 'connection catalog after install');
    const notionCard = () => [...ui.d.querySelectorAll<HTMLElement>('.discovery-source-card')]
        .find(card => card.querySelector('h3')?.textContent?.includes('Notion'));
    assert.ok(notionCard(), 'the official catalog lists the Notion connector');
    await ui.click(notionCard()!);
    await ui.until(() => Boolean(ui.d.querySelector('.sources-page')), 'Notion connection setup');
    const pluginCenterLink = [...ui.d.querySelectorAll<HTMLAnchorElement>('.sources-page a')]
        .find(link => link.getAttribute('href')?.startsWith('#/system/plugins'));
    assert.ok(pluginCenterLink, 'the installed Notion package points to its plugin center configuration');
    await ui.click(pluginCenterLink!);
    await ui.until(() => Boolean(ui.d.querySelector('.plugin-center')), 'plugin center from the Notion setup');

    // Configure the generated Notion instance through the plugin center form.
    const notionProvider = [...ui.d.querySelectorAll<HTMLElement>('.provider-card')]
        .find(card => card.textContent?.includes('Notion'));
    assert.ok(notionProvider, 'the installed Notion package is listed');
    await ui.click(notionProvider!);
    await ui.until(() => Boolean(ui.d.querySelector('.plugin-package-detail')), 'Notion package detail');
    const addInstance = [...ui.d.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === '新增实例');
    assert.ok(addInstance, 'the installed package offers a new instance');
    await ui.click(addInstance!);
    await ui.until(() => Boolean(ui.d.querySelector('.plugin-modal form')), 'Notion configuration form');
    const notionFields = [...ui.d.querySelectorAll<HTMLLabelElement>('.plugin-modal .plugin-fields > label')]
        .filter(label => label.textContent?.includes('Notion'));
    assert.equal(notionFields.length, 3, 'the generated Notion configuration has three fields');
    const notionValues = [notion.configuration.clientId, notion.configuration.clientSecret, notion.configuration.redirectUri];
    for (const [index, label] of notionFields.entries()) {
        const input = label.querySelector<HTMLInputElement>('input');
        assert.ok(input, 'Notion configuration input');
        await ui.fill(input!, notionValues[index]!);
    }
    await ui.submit(ui.d.querySelector<HTMLFormElement>('.plugin-modal form')!);
    await ui.until(() => !ui.d.querySelector('.plugin-modal'), 'Notion instance saved', 30000);

    const instance = () => ui.d.querySelector('.plugin-instance');
    const instanceAction = (label: string) => [...(instance()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find(button => button.textContent?.trim() === label);
    await ui.until(() => Boolean(instanceAction('核验能力')), 'Notion instance check action', 30000);
    await ui.click(instanceAction('核验能力')!);
    await ui.until(() => {const action = instanceAction('启用'); return Boolean(action && !action.disabled);}, 'Notion instance checked and ready to enable', 30000);
    await ui.click(instanceAction('启用')!);
    await ui.until(() => Boolean(instanceAction('停用')), 'Notion instance enabled', 30000);

    // Back on the connection page, authorize the generated Notion account,
    // choose the generated page and save; the source sync is generated.
    await ui.click(ui.d.querySelector('[data-nav-item="connections"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.connections-overview')), 'Connections landing page after Notion configuration');
    assert.equal(overviewCards().includes('official-notion'), false, 'a configured instance without an authorized source still adds no service card');
    await ui.click(ui.d.querySelector('.connections-heading a')!);
    await ui.until(() => Boolean(ui.d.querySelector('.discovery-source-catalog')), 'connection catalog after Notion configuration');
    await ui.click(notionCard()!);
    await ui.until(() => Boolean(ui.d.querySelector('.official-source-connector')), 'active Notion connector setup', 60000);
    const connectAccount = () => [...ui.d.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === '连接账号');
    await ui.until(() => {const action = connectAccount(); return Boolean(action && !action.disabled);}, 'Notion account authorization', 60000);
    await ui.click(connectAccount()!);
    await ui.until(() => Boolean(ui.d.querySelector('a.connector-authorization')), 'Notion authorization link');
    const authorization = new URL(ui.d.querySelector<HTMLAnchorElement>('a.connector-authorization')!.getAttribute('href')!);
    assert.equal(authorization.protocol, 'https:');
    assert.equal(authorization.hostname, 'api.notion.com');
    await api.raw('/oauth/notion/callback?' + new URLSearchParams({state: authorization.searchParams.get('state')!, code: 'generated-code'}));
    await ui.click(ui.button('刷新状态'));
    const candidateButton = () => [...ui.d.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === '加载可选内容');
    await ui.until(() => Boolean(candidateButton()), 'generated Notion candidates available', 30000);
    await ui.click(candidateButton()!);
    await ui.until(() => Boolean(ui.d.querySelector('.connector-check input[type=checkbox]')), 'generated Notion page candidate');
    await ui.click(ui.d.querySelector('.connector-check input[type=checkbox]')!);
    const saveSelection = () => [...ui.d.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === '保存并同步');
    await ui.until(() => {const action = saveSelection(); return Boolean(action && !action.disabled);}, 'generated Notion selection ready to save');
    await ui.click(saveSelection()!);
    await ui.until(() => Boolean(ui.d.querySelector('.official-source-connector a[href^="#/connections?sourceId="]')), 'generated Notion source archived', 30000);

    // The owner-facing overview now renders the one new durable service card.
    await ui.click(ui.d.querySelector('[data-nav-item="connections"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.connections-overview')), 'Connections landing page after connecting Notion');
    await ui.until(() => Boolean(ui.d.querySelector('.connection-card[data-service-id="official-notion"]')), 'Notion service card on the Connections overview', 30000);
    const cardsAfter = overviewCards();
    assert.equal(cardsAfter.length, cardsBefore.length + 1, 'the Connections overview gains exactly one service card: ' + JSON.stringify(cardsAfter));
    assert.deepEqual(cardsAfter.filter(id => !cardsBefore.includes(id)), ['official-notion']);
    assert.equal(ui.d.querySelector('.connection-card[data-service-id="official-notion"]')!.getAttribute('data-state'), 'connected');
    const sources = await api.request<{items: {kind: string; enabled: boolean}[]}>('/api/sources');
    assert.equal(sources.items.filter(source => source.kind === 'mote.official.notion' && source.enabled).length, 1, 'the connected Notion source is durable');
    assert.ok(notion.calls.includes('/v1/oauth/token'), 'the generated OAuth exchange ran');
    assert.ok(notion.calls.includes('/v1/search'), 'the generated candidate list ran');
    assert.ok(notion.calls.some(path => path.endsWith('/children')), 'the generated page body ran');
    const sidebarFinal = [...ui.d.querySelectorAll('[data-nav-item]')].map(item => [item.getAttribute('data-nav-item'), item.getAttribute('aria-label')]);
    assert.deepEqual(sidebarFinal, sidebarBefore, 'connecting Notion adds no sidebar destination');
});
