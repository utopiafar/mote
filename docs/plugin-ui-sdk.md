# 插件 UI SDK

日期：2026-11-04。范围：Web、Mac 与 Android 宿主当前共同使用的插件 UI 贡献、声明式 view、数据、命令、native provider、错误、版本、生命周期与 i18n 契约。本文只记录当前 wire/API，不定义第二份包 Manifest、旧格式 reader、兼容层或新的授权权威。

当前唯一包描述来自 [`PackageManifest`](../packages/plugin-api/src/manifest.ts)。UI 贡献是从该 Manifest 投影出的 [`UiContributionDescriptor`](../packages/shared/src/plugin-ui.ts) 元数据：它只包含身份、平台、依赖、声明式数据 schema 引用、命令 ID 和展示 key，不携带回调、SQL、URL、类名或远程代码。可信同 bundle Web 贡献另由 [`WebFeatureHost`](../apps/web/src/features/host.ts) 注册 React entry；外部包只能通过 Manifest 自定义页面或声明式 view 进入宿主。

标有 `// @contract example` 的代码块由 [`apps/web/test/plugin-ui-sdk-contract.test.ts`](../apps/web/test/plugin-ui-sdk-contract.test.ts) 直接提取、类型检查并运行；其余片段只解释字段来源。

## 1. 注册 view（register view）

Web 宿主用 `PluginContributionScope` 安装同一实例的贡献。`bootstrapPlugins` 先检查 `desired`/`compatible`，只有真正安装成功才报告 `observed: 'mounted'`；失败只回滚当前 scope，不删除兄弟实例或旧路由。

```ts
// @contract example: register-view
import { WebFeatureHost } from '../src/features/host';
import { bootstrapPlugins, builtinInstance } from '../src/plugin-host/bootstrap';

export async function run() {
  const host = new WebFeatureHost();
  const instance = builtinInstance('fixture.notes', [
    {
      surface: 'page',
      entry: {
        id: 'notes',
        route: 'library/notes-fixture',
        label: 'Notes',
        section: 'library',
        order: 10,
        featureId: 'fixture.notes',
        render: () => null,
      },
    },
    {
      surface: 'renderer',
      entry: {
        id: 'notes.detail',
        kind: 'fixture.note',
        schemaVersion: 1,
        representation: 'detail',
        render: () => null,
      },
    },
  ]);

  const { reports, scopes } = await bootstrapPlugins(host, [instance]);
  const scope = scopes.get(instance.instanceId);
  if (!scope || reports[0]?.outcome.observed !== 'mounted')
    throw new Error('view contribution was not mounted');

  const page = host.page('notes');
  const renderers = host.views('renderer', {
    kind: 'fixture.note',
    schemaVersion: 1,
    representation: 'detail',
  });
  if (page?.id !== 'notes' || renderers.length !== 1 || renderers[0]?.id !== 'notes.detail')
    throw new Error('registered view identity did not round-trip');

  await scope.rollback();
  if (host.page('notes') !== undefined || host.pages().length !== 0)
    throw new Error('rollback left a dead route');

  return { pageId: page.id, rendererId: renderers[0].id };
}
```

要点：

- `page`、`renderer`、`panel`、`card`、`collection`、`home`、`action` 是不同 surface；`views()` 只按精确 `kind + schemaVersion + representation` 匹配，不按内容猜测。
- 外部实例的 page 公共 ID 会限定到实例；同包两个实例可以共存，回滚一个不会撤掉另一个。
- `loader: 'external'` 必须有显式 `IsolatedLoader`（或 Manifest 自定义页面）才能 mount；未隔离的外部代码返回 `skipped / unsupported-loader`，不会假装已安装。
- 真实应用在启动和退出时分别调用 `bootstrapPlugins` 与 `teardownPlugins`，scope 的 disposer、lifetime 和 install fiber 由同一生命周期释放。

Manifest 侧对应 `PackageManifest.contributions[]` 的 `surface`、`runtime`、`entry`、`requires` 与 `provides`。`UiContributionDescriptor` 使用严格解析，隐藏字段、访问器、函数和超限数组会被拒绝，而不是被当作可执行内容：

```ts
import { parseUiContribution } from '@mote/shared/plugin-ui';

const descriptor = parseUiContribution({
  id: 'notes.reader',
  kind: 'declarative-view',
  apiVersion: '1',
  platforms: ['web', 'mac'],
  presentation: { labelKey: 'notes.reader.title', i18nNamespace: 'fixture.notes' },
});
```

## 2. data

`data` 只声明宿主可兼容的数据 schema 引用，不携带正文或代码：

```json
{"schemaRef":"fixture.note","schemaVersion":1}
```

`acceptUiContribution(accepted, candidate, supportedDataVersions)` 使用宿主声明的兼容表做确定性准入；声明了 `data` 但缺少 schema 引用、宿主没有声明该 schema、或版本不在列表中时整条拒绝为 `api_incompatible`，不会默认放行。重复的 `packageId + contribution.id` 拒绝为 `conflict`，保留已接受条目。

声明式 view 的数据由宿主以普通对象传入，字段由 `list.itemKey`、`detail.fields` 等引用。缺失数据按 `pending` 显示；存在但不是普通数组显示 `error`；空数组显示 `empty`，不会使 renderer 崩溃。

```ts
// @contract example: data
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseUiContribution } from '@mote/shared/plugin-ui';
import {
  DeclarativeView,
  DeclarativeViewSession,
  parseDeclarativeView,
} from '../src/plugin-host/declarative-view';

const descriptor = parseUiContribution({
  id: 'notes.data-view',
  kind: 'declarative-view',
  apiVersion: '1',
  platforms: ['web'],
  presentation: { labelKey: 'notes.title', i18nNamespace: 'fixture.notes' },
  data: { schemaRef: 'fixture.note', schemaVersion: 1 },
});

export async function run() {
  const schema = descriptor.data;
  if (!schema) throw new Error('data schema declaration is missing');

  const spec = parseDeclarativeView({
    components: [
      { type: 'list', itemKey: 'items', fields: [{ key: 'title', labelKey: 'notes.title' }] },
    ],
  }, descriptor);
  const session = new DeclarativeViewSession(descriptor, spec, async () => ({ ok: true }));
  session.lifetime.show();

  const data = { items: [{ title: 'Generated note' }] };
  const markup = renderToStaticMarkup(
    createElement(DeclarativeView, { session, data, translate: key => key }),
  );
  if (!markup.includes('Generated note'))
    throw new Error('declared data did not reach the view');

  return { schemaRef: schema.schemaRef, schemaVersion: schema.schemaVersion, markup };
}
```

数据 schema 的版本是宿主兼容性事实，不是安装、启用或授权事实；能渲染数据不代表可以执行命令。

## 3. action

命令在 descriptor 的 `commands` 中显式声明 `{id, apiVersion}`：

```ts
const actionDescriptor = parseUiContribution({
  id: 'notes.actions',
  kind: 'declarative-view',
  apiVersion: '1',
  platforms: ['web'],
  presentation: { labelKey: 'notes.actions', i18nNamespace: 'fixture.notes' },
  commands: [{ id: 'notes.save', apiVersion: '1' }],
});
```

`DeclarativeViewSession.command(id, input)` 只解析已声明 ID；未声明返回 `{ok: false, reason: 'undeclared'}`，宿主 invoker 失败返回 `'failed'`。视图隐藏或 remount 后，旧 generation 的晚到结果返回 `'stale'`，不会回写当前 view。UI 命令声明不是授权：真正的写操作仍由命令所属领域在调用时检查 owner、revision、权限和提交 fence。

```ts
// @contract example: action
import { parseUiContribution } from '@mote/shared/plugin-ui';
import { DeclarativeViewSession, parseDeclarativeView } from '../src/plugin-host/declarative-view';

const descriptor = parseUiContribution({
  id: 'notes.action-view',
  kind: 'declarative-view',
  apiVersion: '1',
  platforms: ['web'],
  presentation: { labelKey: 'notes.actions', i18nNamespace: 'fixture.notes' },
  commands: [{ id: 'notes.save', apiVersion: '1' }],
});

export async function run() {
  const spec = parseDeclarativeView({
    components: [{ type: 'action', command: 'notes.save', labelKey: 'notes.save' }],
  }, descriptor);
  let calls = 0;
  const session = new DeclarativeViewSession(descriptor, spec, async (command, input) => {
    calls += 1;
    return { id: command.id, apiVersion: command.apiVersion, input };
  });
  session.lifetime.show();

  const saved = await session.command('notes.save', { title: 'Generated note' });
  const unknown = await session.command('notes.delete');
  if (!saved.ok || calls !== 1)
    throw new Error('declared action did not invoke the host command');
  if (unknown.ok || unknown.reason !== 'undeclared')
    throw new Error('undeclared action must never be dispatched');

  return { saved, unknown, calls };
}
```

## 4. native provider

原生能力随客户端 build 发行，不从网络注册。贡献通过 `nativeRequires` 声明能力、API 版本、适用平台和 fallback：

```ts
const nativeDescriptor = parseUiContribution({
  id: 'notes.playback',
  kind: 'reader',
  apiVersion: '1',
  platforms: ['web', 'mac'],
  presentation: { labelKey: 'notes.playback', i18nNamespace: 'fixture.notes' },
  nativeRequires: [{
    capability: 'media.playback',
    apiVersion: '1',
    platforms: ['mac'],
    fallback: 'generic-reader',
  }],
});
```

`NativeProviderDescriptor` 的匹配必须是精确的 `capability + apiVersion + platform`；`nativeProviderKey` 是 TS loader 与 Kotlin decoder 共用的身份键。Mac 宿主用 [`NativeProviderRegistry.register`](../apps/desktop/src/plugin-host/native-registry.ts) 注册随 build 发行的 provider；Android 使用同身份字段的 `NativePluginProvider` / `NativePluginRegistry`。`osGrants` 只是宿主展示权限状态的提示，不是授权证明，也不参与能力满足判断。

`uiContributionAvailability` 把事实投影为不同状态：必需 native provider 缺失是 `requires-build`，平台不匹配是 `unsupported`，依赖不可用、撤权和等待设备分别保留各自原因；`optional` requirement 不阻止其他平台可用。缺 provider 时使用声明的 fallback 保留通用读取，而不是伪造已启用。

```ts
// @contract example: native-provider
import { parseNativeProvider, nativeProviderKey, nativeProviderSatisfies } from '@mote/shared/plugin-native';
import { parseUiContribution, uiContributionAvailability } from '@mote/shared/plugin-ui';

const descriptor = parseUiContribution({
  id: 'notes.native-view',
  kind: 'reader',
  apiVersion: '1',
  platforms: ['web', 'mac'],
  presentation: { labelKey: 'notes.native', i18nNamespace: 'fixture.notes' },
  nativeRequires: [{
    capability: 'media.playback',
    apiVersion: '1',
    platforms: ['mac'],
    fallback: 'generic-reader',
  }],
});

export async function run() {
  const requirement = descriptor.nativeRequires?.[0];
  if (!requirement) throw new Error('native requirement is missing');

  const provider = parseNativeProvider({
    capability: 'media.playback',
    apiVersion: '1',
    platform: 'mac',
    buildId: 'mac-fixture-2026.11.04',
    osGrants: ['screen-recording'],
  });
  if (!nativeProviderSatisfies(requirement, provider))
    throw new Error('registered provider did not satisfy the exact requirement');

  const missing = uiContributionAvailability(descriptor, 'mac', {
    requirementsAvailable: true,
    registeredNativeCapabilities: new Set(),
  });
  const active = uiContributionAvailability(descriptor, 'mac', {
    requirementsAvailable: true,
    registeredNativeCapabilities: new Set([nativeProviderKey(provider)]),
  });
  if (missing.state !== 'requires-build' || active.state !== 'active')
    throw new Error('native availability projection is incorrect');

  return { missing, active, provider };
}
```

## 5. 错误

跨进程/跨端只公开 [`PluginErrorCode`](../packages/plugin-api/src/contracts/errors.ts)，不把异常文本、路径或凭据当作失败 payload。`PluginFailure` 只携带 code 和可选的宿主 operationId。本地合同校验使用 `PluginContractError`；实例状态使用 `StateError`；宿主生命周期使用 `PluginHostError`。

写操作结果未知时不能自动重放：`WriteAck = 'ack' | 'nack' | 'unknown'`，`resolveWriteAck('unknown')` 返回 `'hold'`，调用方保留原 request identity 并显式对账。

```ts
// @contract example: errors
import { PluginContractError } from '@mote/plugin-api/contracts';
import { StateError } from '@mote/plugin-api';
import { acceptUiContribution, parseUiContribution } from '@mote/shared/plugin-ui';

const descriptor = parseUiContribution({
  id: 'notes.error-view',
  kind: 'declarative-view',
  apiVersion: '1',
  platforms: ['web'],
  presentation: { labelKey: 'notes.error', i18nNamespace: 'fixture.notes' },
  data: { schemaRef: 'fixture.note', schemaVersion: 9 },
});

export async function run() {
  const admission = acceptUiContribution([], { packageId: 'fixture.notes', descriptor }, {
    'fixture.note': [1],
  });
  if (admission.accepted) throw new Error('unsupported data schema was admitted');
  if (admission.rejection.reason !== 'api_incompatible')
    throw new Error('unsupported data schema did not keep the canonical rejection');

  const contractError = new PluginContractError('invalid_contract', 'id');
  const stateError = new StateError('invalid_namespace');
  if (contractError.code !== 'invalid_contract' || stateError.code !== 'invalid_namespace')
    throw new Error('public error code identity changed');

  return {
    reason: admission.rejection.reason,
    contractCode: contractError.code,
    stateCode: stateError.code,
  };
}
```

## 6. 版本

版本事实彼此分开：

- `PLUGIN_SDK_VERSION` 是公共 SDK 包表面版本。
- `PLUGIN_CONTRACT_VERSION` 是宿主 snapshot schema 版本。
- contribution `apiVersion` 是服务/命令/描述合同的精确版本。
- `data.schemaVersion` 是数据兼容表的精确版本。
- Manifest contribution `version` 是包内贡献版本；安装身份由插件中心单独记录。

宿主不做版本范围协商或静默 fallback。API 版本不兼容返回 `api_incompatible`，数据 schema 不在宿主兼容表同样拒绝；`restartRequired` 只说明升级是否需要重启，不代表已安装、已验证或已授权。

```ts
// @contract example: version
import { PLUGIN_CONTRACT_VERSION } from '@mote/plugin-api/contracts';
import { PLUGIN_SDK_VERSION } from '@mote/plugin-sdk';
import { acceptUiContribution, parseUiContribution } from '@mote/shared/plugin-ui';

const v1 = parseUiContribution({
  id: 'fixture.notes.v1',
  kind: 'declarative-view',
  apiVersion: '1',
  platforms: ['web'],
  presentation: { labelKey: 'notes.v1', i18nNamespace: 'fixture.notes' },
  data: { schemaRef: 'fixture.note', schemaVersion: 1 },
});
const v2 = parseUiContribution({
  id: 'fixture.notes.v2',
  kind: 'declarative-view',
  apiVersion: '2',
  platforms: ['web'],
  presentation: { labelKey: 'notes.v2', i18nNamespace: 'fixture.notes' },
  data: { schemaRef: 'fixture.note', schemaVersion: 2 },
});

export async function run() {
  const accepted = acceptUiContribution(
    [{ packageId: 'fixture.notes', descriptor: v1 }],
    { packageId: 'fixture.notes', descriptor: v2 },
    { 'fixture.note': [1, 2] },
  );
  const rejected = acceptUiContribution([], { packageId: 'fixture.notes', descriptor: v2 }, {
    'fixture.note': [1],
  });
  if (!accepted.accepted) throw new Error('declared compatible data version was rejected');
  if (rejected.accepted || rejected.rejection.reason !== 'api_incompatible')
    throw new Error('undeclared data version was not rejected');
  if (PLUGIN_CONTRACT_VERSION !== 1 || PLUGIN_SDK_VERSION !== '0.1.0')
    throw new Error('SDK or snapshot contract version changed');

  return {
    sdk: PLUGIN_SDK_VERSION,
    contract: PLUGIN_CONTRACT_VERSION,
    accepted: accepted.accepted,
    rejected: rejected.rejection.reason,
  };
}
```

## 7. 生命周期

插件 factory 的生命周期顺序是 `prepare → start → quiesce → stop → dispose`：`prepare` 取得可回收资源，`start` 才发布可用贡献；`quiesce` 停止新准入和定时器，允许已接纳的固定版本工作排空；`stop` 撤销提交资格并取消/排空；`dispose` 反向释放且保持幂等。`PluginContributionScope` 负责一次 mount 的贡献、资源、install fiber 和回滚，失败不会关闭兄弟 scope。

view 生命周期由 [`ViewLifetime`](../packages/shared/src/plugin-view-lifetime.ts) 和 [`PluginViewSession`](../apps/web/src/plugin-host/view-session.ts) 持有：

- `mounted / visible / suspended / disposed` 与 generation 明确分开；隐藏会 abort view-scoped read 和 poll，旧 generation 的晚到结果返回 `stale`，不会覆盖新状态。
- `durableSignal` 只随 dispose 取消，独立授权的采集/上传/传输不会被页面隐藏误停。
- 草稿/返回票据按 owner/connection/plugin-instance/view scope 保存；owner 切换不清空其他 owner 的草稿，保存失败会阻止有损切换。
- 未知写 ACK 保留原 request identity，不自动重放。

```ts
// @contract example: lifecycle
import { PluginViewSession, type ViewScheduler } from '../src/plugin-host/view-session';

export async function run() {
  const saved = new Map<string, unknown>();
  const writer = {
    save: async (key: string, value: unknown) => {
      saved.set(key, value);
      return { ok: true as const };
    },
    load: async (key: string) => saved.get(key) ?? null,
    clear: async (key: string) => { saved.delete(key); },
  };
  const scheduled = new Map<object, () => void>();
  const scheduler: ViewScheduler = {
    schedule: tick => {
      const handle = {};
      scheduled.set(handle, tick);
      return handle;
    },
    cancel: handle => { scheduled.delete(handle as object); },
  };
  const session = new PluginViewSession({
    ownerKey: 'owner-fixture',
    scope: 'owner',
    writer,
    scheduler,
  });
  session.lifetime.show();

  let reads = 0;
  const applied: number[] = [];
  session.poll(async () => ++reads, value => applied.push(value as number), 1000);
  [...scheduled.values()][0]?.();
  await new Promise(resolve => setTimeout(resolve, 0));

  let release!: (value: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const late = session.requestRead(() => gate, () => applied.push(-1));
  session.saveDraft('note-draft', { text: 'Generated draft' });
  const suspended = await session.suspend();
  release('late');
  const lateOutcome = await late;
  const hold = session.resolveWrite('operation-1', 'unknown');
  const committed = session.resolveWrite('operation-1', 'ack');
  session.resume();

  const draft = session.draft('note-draft') as { text?: string } | null;
  if (!suspended.ok || reads !== 1 || applied.length !== 1)
    throw new Error('polling did not stop cleanly on suspend');
  if (lateOutcome !== 'stale' || scheduled.size !== 1)
    throw new Error('late response or resume scheduling leaked the old generation');
  if (hold !== 'hold' || committed !== 'commit' || session.pendingWrites.size !== 0)
    throw new Error('unknown write acknowledgement was replayed or lost');
  if (draft?.text !== 'Generated draft' || saved.size !== 1)
    throw new Error('owner-scoped draft did not survive the hide/show transition');

  return { suspended, lateOutcome, hold, committed, draft, saved: [...saved.keys()] };
}
```

## 8. i18n

插件文案使用自己的 namespace，键是宿主/插件作者声明的稳定标识，不是采集内容。`PluginI18nRegistry.register(namespace, locale, catalog)` 接受不可变快照；英文目录定义键集合，其他 locale 只能翻译英文已有的键。解析顺序是当前 locale → English → key 本身，并返回显式 `fallback` 原因：`namespace_missing`、`locale_missing`、`key_missing`。

`resolveContributionPresentation` 只解析 label/glyph/a11y 角色；`routeId` 始终是 descriptor 的贡献 ID，不随翻译改变。缺少可读 a11y 时使用可见 label，不把内部 key 当作无障碍名称。

```ts
// @contract example: i18n
import { PluginI18nRegistry, resolveContributionPresentation } from '@mote/shared/plugin-i18n';
import { parseUiContribution } from '@mote/shared/plugin-ui';

const catalogs = new PluginI18nRegistry();
catalogs.register('fixture.notes', 'en', {
  'notes.title': 'Notes',
  'notes.a11y': 'Notes navigation',
});
catalogs.register('fixture.notes', 'zh-CN', {
  'notes.title': '笔记',
  'notes.a11y': '笔记导航',
});
const descriptor = parseUiContribution({
  id: 'notes.navigation',
  kind: 'page',
  apiVersion: '1',
  platforms: ['web'],
  presentation: {
    labelKey: 'notes.title',
    a11yKey: 'notes.a11y',
    i18nNamespace: 'fixture.notes',
  },
});

export async function run() {
  const zh = resolveContributionPresentation(descriptor, catalogs, 'zh-CN');
  const en = resolveContributionPresentation(descriptor, catalogs, 'en');
  const missing = catalogs.resolve('fixture.notes', 'notes.missing', 'en');
  if (zh.routeId !== descriptor.id || en.routeId !== descriptor.id)
    throw new Error('translation changed the contribution route identity');
  if (zh.label.text !== '笔记' || en.label.text !== 'Notes' || zh.fallbackReasons.length !== 0)
    throw new Error('locale resolution did not use the registered catalogs');
  if (missing.fallback !== 'key_missing')
    throw new Error('missing plugin key did not report its fallback reason');

  return { zh, en, missing };
}
```

## 9. 契约检查

```bash
cd apps/web && npx tsx --test test/plugin-ui-sdk-contract.test.ts
```

该测试从本文提取所有 `@contract example` 代码块，对每个模块执行 TypeScript 类型检查与运行；示例中的断言与测试断言共同确认注册、data、action、native provider、错误、版本、生命周期和 i18n 仍引用真实 API。
