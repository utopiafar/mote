# NV2 导航状态接口 — 完成记录

- PR：https://github.com/utopiafar/mote/pull/1127
- 冻结提交：`1cf62b019`（Match only the trusted storage foundation port）
- 分支：`plan/nv2-nav-state`
- 基线：`origin/main` `10ca691da`

## 改动文件

- 新建 `apps/server/src/nav-state.ts`
- 新建 `packages/shared/src/nav-state.ts`
- 新建 `apps/server/test/nav-state.test.ts`
- 修改 `apps/server/src/features/index.ts`（挂载路由）
- 修改 `packages/shared/src/index.ts`（一行导出）

## 实际跑过的命令

- `npm ci`：通过（1375 packages）。
- `npm run build:libs`：通过。
- `npm run build -w @mote/shared`：通过。
- `npm run test:file -w @mote/server -- test/nav-state.test.ts`：8/8 通过。
- `npm run typecheck -w @mote/server`：通过。
- 额外回归：`test/plugin-domain-routes.test.ts`、`test/feature-packs.test.ts`、`test/plugin-coding-source.test.ts`、`test/api.test.ts` 一起跑，29/31 通过。两个失败（`api.test.ts` 的 source pack 列表、`feature-packs.test.ts` 的 insight 生命周期）已在基线 `10ca691da` 上暂存本卡改动后复现，和本卡无关；未删除、未跳过，已写进 PR。

## 不要碰的文件

- `apps/server/src/host.ts`：未改。
- `apps/server/src/assistant-cards.ts`：未改。
- 开工手册 §6 的公共清单：未改。
- 没有改词条、schema、设计 token 或生成物清单里的其他文件。

## 未验证

- Web / Mac / Android 客户端读取（由 NV3、PF1、AN1 接入）。
- 真实浏览器/代理缓存下的 ETag 往返；测试用 `app.inject` 验证了 200/304 和响应头。
- CN1 后续的连接卡片视图；本卡只读现有来源健康状态。
- 没有连接真实实例、真实模型或真实设备。
