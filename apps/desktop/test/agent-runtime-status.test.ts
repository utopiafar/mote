import { expect, it } from 'vitest';
import { agentRuntimeReadinessLabel, agentRuntimeStatusSummary, readAgentRuntimeStatus } from '../src/agent-runtime-status';
import { agentRuntimeFeatureState } from '@mote/shared/agent-runtime-status';
import { ConnectionError } from '../src/connection';
import { runtimeStatusReceipt } from './fixtures';
import { configureLocale } from '@mote/shared/i18n';

configureLocale(() => 'zh-CN');
const config = { serverUrl: 'https://central.example', token: 'generated-owner-token-' + 'a'.repeat(32) };
const respond = (value: unknown, status = 200) => async () => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

it('consumes the shared runtime receipt and summarizes the current selection with readiness', async () => {
  const receipt = await readAgentRuntimeStatus(config, respond(runtimeStatusReceipt()));
  expect(receipt.features.chat.configured).toBe(true);
  expect(agentRuntimeStatusSummary(receipt)).toBe('当前生效值：部署配置 · generated-model · 已就绪');
});

it('accepts unknown runtime providers and capabilities for display', async () => {
  const body = runtimeStatusReceipt();
  (body.features as Record<string, unknown>)['transcribe-audio'] = { profileId: 'env:deployment', provider: 'future-runtime', model: '', configured: false };
  const receipt = await readAgentRuntimeStatus(config, respond(body));
  expect(receipt.features['transcribe-audio'].provider).toBe('future-runtime');
  expect(agentRuntimeFeatureState(receipt, 'transcribe-audio')).toBe('unconfigured');
  expect(agentRuntimeFeatureState(receipt, 'summarize-later')).toBe('unknown');
});

it('keeps the current selection readable while readiness stays honest', async () => {
  const body = runtimeStatusReceipt();
  body.runtime.configured = false; body.runtime.preparedAgents = 0;
  const receipt = await readAgentRuntimeStatus(config, respond(body));
  expect(agentRuntimeReadinessLabel('unconfigured')).toBe('未配置');
  expect(agentRuntimeStatusSummary(receipt)).toBe('当前生效值：部署配置 · generated-model · 未配置');
  const restarting = runtimeStatusReceipt();
  restarting.configuration.domain.status = 'restart-required';
  expect(agentRuntimeStatusSummary(await readAgentRuntimeStatus(config, respond(restarting)))).toContain('重启后生效');
  const missingDomain = runtimeStatusReceipt() as Record<string, any>;
  delete missingDomain.configuration.domain; missingDomain.configuration.domains = [];
  expect(agentRuntimeStatusSummary(await readAgentRuntimeStatus(config, respond(missingDomain)))).toContain('失败');
});

it('fails closed on bad revisions, secret- or path-shaped fields and malformed bodies', async () => {
  for (const mutate of [
    (body: ReturnType<typeof runtimeStatusReceipt>) => { (body as { revision: unknown }).revision = -1; },
    (body: ReturnType<typeof runtimeStatusReceipt>) => { (body as { revision: unknown }).revision = 1.5; },
    (body: ReturnType<typeof runtimeStatusReceipt>) => { (body as { revision: unknown }).revision = '3'; },
    (body: ReturnType<typeof runtimeStatusReceipt>) => { (body.saved.settings as Record<string, unknown>).apiKey = 'generated-private-do-not-echo'; },
    (body: ReturnType<typeof runtimeStatusReceipt>) => { (body.features.chat as Record<string, unknown>).executable = '/private/tmp/agent'; },
    (body: ReturnType<typeof runtimeStatusReceipt>) => { (body.features.chat as Record<string, unknown>).profileId = '/private/tmp/generated.mjs'; },
    (body: ReturnType<typeof runtimeStatusReceipt>) => { (body.features.chat as Record<string, unknown>).configured = 'yes'; },
  ]) {
    const body = runtimeStatusReceipt(); mutate(body);
    await expect(readAgentRuntimeStatus(config, respond(body))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  }
  await expect(readAgentRuntimeStatus(config, async () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

it('surfaces HTTP and auth failures without inventing a receipt', async () => {
  await expect(readAgentRuntimeStatus(config, respond({ error: 'unauthorized' }, 403))).rejects.toMatchObject({ code: 'AUTH' });
  await expect(readAgentRuntimeStatus(config, respond({ error: 'boom' }, 503))).rejects.toMatchObject({ code: 'HTTP' });
  await expect(readAgentRuntimeStatus(config, async () => { throw new TypeError('offline'); })).rejects.toBeInstanceOf(ConnectionError);
});
