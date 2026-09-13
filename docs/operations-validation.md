# 0.3.0 部署、环境隔离与诊断验证

本轮覆盖独立节点部署、客户端环境隔离、运行日志与排错界面。全部新测试使用临时资料库、随机测试凭据和合成输入；没有采集个人屏幕、导入私人日记或调用真实模型。此前真实模型质量记录保留在 [复杂链路验证](live-validation.md)，不以本轮协议测试替代。

## 验证范围

- 服务端配置文件隔离：dev / test 各自生成并保留令牌、端口、数据和日志；缺失配置与非法范围在创建资料库前失败；不读取日常 `.env`。
- 原生节点生命周期：真实子进程启动、健康、关闭与重新打开；检查进程标记，拒绝误用已有端口或终止无关 PID；生成的 launchd plist 通过语法验证。
- 数据恢复：加密图片与 SQLite 一致备份、manifest 校验、损坏备份拒绝、空目录恢复；升级前快照及回滚保留升级后的资料目录。
- 日志：固定字段白名单、并发请求编号隔离、上传/索引/Agent 阶段关联、SDK 错误与 URL 内容排除、禁用、轮转、写失败与关闭行为；原生 stdout/stderr 也有体积上限。
- 中央界面：真实 Electron 渲染器连接临时节点，查看 profile 与诊断状态，按请求编号筛选事件，实际下载诊断包并验证正文/令牌缺席；检查桌面与窄屏布局。
- Mac：两个独立 Electron 实例分别配置测试凭据、保存草稿和离线笔记；重启保持各自设备身份、凭据、草稿与队列，支持包排除私人字段。未开启采集或调用本地模型。
- Android：API 35 模拟器同时安装日常包和 `.dev` 包，验证独立目录、设备 ID、默认地址、草稿/队列与支持包；关闭诊断后不继续写事件。日常包关键文件校验值前后不变。

## 复现入口

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
npm run typecheck
npm test
npm run test:privacy
npm run test:e2e
npm run test:profiles
python3 -m unittest discover -s scripts -p 'test_fact_archive.py'
```

有 Electron 的 macOS 上另运行：

```sh
npm run test:profiles -w @mote/desktop
node_modules/.bin/electron scripts/test-web-diagnostics.cjs
```

电脑端原生 profile 测试需要先按 [电脑端](desktop.md) 完成构建。Web 诊断 smoke 自行创建并关闭中央子进程，截图只包含它自己的合成测试窗口，产物保存在忽略的 `.mote/ops-validation/`。

Android 的构建、JVM、lint、模拟器命令与安装包见 [Android 文档](android.md)。Docker 与 TLS profile 验证需要 Docker Compose，详见 [部署文档](deployment.md)。测试脚本只清理自身建立的临时进程和资料。

## 验证边界

模拟器结果不等同 K90 Pro Max / HyperOS 真机结果。本轮没有重复端上 Qwen 或真实 DeepSeek 质量评估，也没有执行长时耗电测试。launchd 只验证生成配置和原生进程管理，未安装到日常登录项。目标 Mac mini/NAS 的磁盘权限、公网 DNS 与实际证书签发仍取决于现场环境。

## 本机最终结果

0.3.0 工作区 **165 项测试通过**：Mac 63、中央节点 45、前端 12、Agent 25、资源诊断 5、模型交付 13、共享配置 2。TypeScript build/typecheck、隐私网关 22 项、日记归档解析 8 项和合成全链路 E2E 通过。部署 profile 测试另通过真实 Node 子进程验证；中央 Web 和 Mac profile 测试使用实际 Electron 渲染器/主进程。

Android 0.3.0 / versionCode 4：29 项 JVM 通过；debug 和 development lint 各为 0 errors / 38 warnings，两个 APK 均通过 16 KiB ZIP 对齐。开发版 profile/支持包仪器测试在 API35 模拟器通过；模拟器在测试后关闭。

| 产物 | 字节数 | SHA-256 |
|---|---:|---|
| Mac arm64 ZIP | 112480649 | `7dcad06c29775e86863ab2c0c53794385fd93c1f2026ca5a2501985afc806206` |
| Android debug APK | 31803132 | `2128bbf5c6ccca8fedc5ee94ba1a1845c0a7a89bef4d72a5cfd7aab51c1738da` |
| Android development APK | 31803136 | `31a6c4d0983341a8b2c5d9d956d7af97feb998e399eec392ebdbf492e89fc741` |

Mac `.app` 的 ad-hoc 签名完整性检查通过，最终 ASAR 与构建模块核对一致。安装路径见客户端文档；无 Developer ID 签名/公证。

本机 legacy 中央节点已在离线备份后更新至 0.3.0；仍使用原 `data/`，访问令牌校验一致，升级前后均为 0 条资料、0 个图片对象。新诊断接口可用，模型依然未配置，未开始采集。新 profile 测试未使用此节点。

源码 `12fdef7` 对应的 [GitHub Actions](https://github.com/utopiafar/mote/actions/runs/34764645477) 两个 job 均通过：Linux 安装/构建/类型检查、工作区、隐私/E2E/解析与原生 profile 测试；Docker 基础镜像，以及新增 Compose 实际凭据保持、独立卷、容器重建、离线加密备份与空卷恢复、同名镜像标签被覆盖后的不可变镜像 ID 回退、Caddy 配置验证。

首轮 Compose 测试错误地将 `compose config` 为重复使用而输出的 `$$` 与原始 `$` 比较；最终测试改为逐字检查真实容器环境并执行认证请求，已在上述 CI 通过。没有对显示文本做替换来掩盖运行时差异。公网域名与证书签发仍未执行。
