import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {randomUUID} from 'node:crypto';
import {pageHash} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {resources} from '../src/resource-cache.js';
import {
    answer, createNote, experienceApp, generatedGoogle, mountExperience, postQuestion, seedCard, seedCommitment,
    seedMemory, seedNotionPlugin, settledTurn,
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
    const {api} = await experienceApp(t, {
        query: input => {
            if (isDisposition(input)) return answer(JSON.stringify({kind: 'independent'}));
            if (isBackground(input)) return backgroundResult('Generated outline with cost focus');
            if (input.question.includes('重点放成本')) return answer('Generated supplement acknowledged');
            return {...answer('Generated planning answer'), draftProposal: {goal: 'Generated review outline'}};
        },
    });
    const taskId = randomUUID();
    let taskCompleted = false;
    const request = api.request;
    api.request = (async (path: string, init?: RequestInit) => {
        if (path.includes('/assistant-tasks?')) {
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
    // The mid-course supplement changes the working instruction before start.
    await ui.field('.assistant-draft textarea[aria-label="工作目标"]', 'Generated review outline · 重点放成本');
    await ui.click(ui.d.querySelector('.assistant-draft-actions button.primary')!);
    await ui.until(() => Boolean(ui.d.querySelector('.assistant-task-result[data-state="running"]')), 'task progress line');
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

test('QA1-07 J7 add Notion: the connection catalog gains its card while the sidebar stays the same', {timeout: 120000}, async t => {
    const {node, api} = await experienceApp(t, {
        query: input => isDisposition(input) ? answer(JSON.stringify({kind: 'independent'})) : answer('Generated answer'),
    });
    seedNotionPlugin(node);
    const ui = await mountExperience(t, api, pageHash('skills'));
    await ui.until(() => Boolean(ui.d.querySelector('[data-skill-id="package:mote.official.notion"]')), 'installed Notion skill');
    const before = [...ui.d.querySelectorAll('[data-nav-item]')].map(item => [item.getAttribute('data-nav-item'), item.getAttribute('aria-label')]);

    await ui.click(ui.d.querySelector('[data-nav-item="connections"]')!);
    await ui.until(() => Boolean(ui.d.querySelector('.connections-overview')), 'Connections landing page');
    await ui.click(ui.d.querySelector('.connections-heading a')!);
    await ui.until(() => Boolean(ui.d.querySelector('.discovery-source-catalog')), 'connection catalog');
    const notion = [...ui.d.querySelectorAll('.discovery-source-card')].find(card => card.textContent?.includes('Notion'));
    assert.ok(notion, 'the connection catalog lists Notion');
    const after = [...ui.d.querySelectorAll('[data-nav-item]')].map(item => [item.getAttribute('data-nav-item'), item.getAttribute('aria-label')]);
    assert.deepEqual(after, before, 'installing Notion adds no sidebar destination');
});
