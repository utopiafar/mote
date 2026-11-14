# 发布版本与签名

Mote 保留 npm Monorepo，按独立安装/部署单元发布。根 `package.json` 是私有工作区控制入口，不再代表产品版本；共享内部库随使用它的产品从同一提交构建。

## 最简规范：先 Profile，再 Tag

| Profile | 用途 | 默认行为 |
| --- | --- | --- |
| `dev` | 开发、自测 | 详细结构化日志、客户端诊断与调试入口；Mote 自有凭据使用私有本地文件，不调用系统密钥存储 |
| `prod` | Beta 内测与正式使用 | 常规诊断，关闭开发入口和额外采样；客户端保留系统密钥存储 |
| `test` | 自动化 fixture | 独立身份、生成素材；不作为分发 Profile |

Central 的运行 Profile 来自私有 YAML，源码包本身不包含环境配置。Mac / Android 的构建 Profile 用于选择安装身份和默认能力；Mac 正式构建显式选择 `--profile=dev` 时同样使用 Dev 文件凭据。第三方 Lark / DingTalk CLI 等组件继续管理自己的密钥。Central 现有私有 YAML、SQLite 和 secret 文件保持归属，不重写为另一份 JSON。单所有者 Central 的 Dev trace 沿用默认开启；可在私有 YAML 显式关闭。结构化 debug 与 trace 是独立开关，显式 false / silent 会保留。

| 场景 | 标识 | 产物位置 |
| --- | --- | --- |
| 日常 Dev（Central） | `central-dev-<commit SHA>`，不创建 Tag | GitHub Actions Artifact，含 `build-info.json` 和校验元数据 |
| Desktop Dev | `desktop-dev-<workflow run number>-<短 SHA>` | Dev Profile；GitHub Pre-release，直接下载 Mac ZIP |
| Android Dev | `android-dev-<workflow run number>-<短 SHA>` | Dev Profile；GitHub Pre-release，直接下载 APK |
| Beta | `<组件>-vX.Y.Z-beta.N` | Prod Profile；GitHub Pre-release |
| 正式 | `<组件>-vX.Y.Z` | Prod Profile；GitHub Release |

组件为 `central`、`desktop`、`android`，各自递增版本；Android 每次发布还递增 versionCode。Tag 不可覆盖，Pre-release 只是发布状态，不控制 Profile 或 Debug；客户端 Dev 与 Prod Beta 都使用 Pre-release，但安装身份不同。Beta 与正式版使用同一 Prod 安装身份；Dev 与 Prod 的数据、配置、凭据及客户端身份隔离。当前仍手动安装/部署，不恢复签名在线更新或 GHCR 镜像。

| 发布单元 | 版本来源 | Prod 公开附件 |
| --- | --- | --- |
| Central | server / web 的 package.json，两者一致 | `mote-server-X.Y.Z.tar.gz` |
| macOS | desktop 的 package.json | `mote-desktop-macos-<arch>-X.Y.Z.zip` |
| Android | `apps/android/version.properties` | `mote-android-arm64-X.Y.Z.apk` |

版本中的 Beta 后缀原样出现在附件名。三个单元分别走 [Central](../.github/workflows/release-central.yml)、[Desktop](../.github/workflows/release-desktop.yml)、[Android](../.github/workflows/release-android.yml) workflow；一个标签只构建和分发一个组件。架构和升级边界见 [独立发布架构](release-architecture.md)、[Profile 与发版 ADR](adr-profile-release-policy.md) 和 [更新说明](updating.md)。

## MVP 阶段的 GitHub 检查开关

2026-10-02 暂停 GitHub 的 `Checks` 和 `Component checks`，仓库变量 `MOTE_PRE_RELEASE_CHECKS=false`。Profile 规范落地后，该开关只允许 Central Dev 构建跳过可选测试。Desktop Dev 始终执行桌面组件检查和打包后 smoke；Android Dev 始终执行 Development 单测。Beta / 正式标签始终执行对应组件检查；Mac 还必须执行打包后 smoke，Android 执行 release 单测。构建、版本、签名、安装身份和附件完整性检查始终执行。单用户回归恢复 Component checks 的受影响 PR 检查；完整 Checks 保留手动用途。2026-10-23 已通过 GitHub API 确认 Component checks 为 active；完整 Checks 暂未启用。

需要恢复时运行：

```sh
gh workflow enable checks.yml --repo utopiafar/mote
gh workflow enable component-checks.yml --repo utopiafar/mote
gh variable set MOTE_PRE_RELEASE_CHECKS --repo utopiafar/mote --body true
```

这会恢复后续 PR/主分支检查及新发布的测试；完整 `Checks` 仍需手动触发。旧标签保留创建时的工作流，不受新提交中的测试开关控制。

旧 `vX.Y.Z` Release、标签和 `release/notes/X.Y.Z.md` 保留追溯；新发布不再使用统一标签。初始拆分保持各端原安装版本与 Android 版本码，调整发布流程本身不创建安装包。后续只递增实际发布的组件。

## 开发早期版本编号

2026-09-14 将对外版本重新从 **0.0.1** 开始，保留已实现功能和代码历史，撤下此前的 GitHub 试验 Release。版本编号较小不会改变应用签名、数据格式或用户目录；Android 内部 `versionCode` 从 11 递增到 12，后续每次发布继续递增。

此前 Mac 和中央节点的自动更新按语义版本比较，因此不会将 0.0.1 当作更新；切换时应手动更新中央部署、退出并覆盖替换 Mac App，保留配置、凭据、模型与数据目录。Android 按内部版本码比较，原有更新流程仍可识别 code 12。不要绕过签名校验、复用较低 Android 版本码或卸载应用来完成切换。项目仍处于开发早期，当前版本不承诺功能和协议稳定。

## 历史完整发布产物（含尚未恢复的在线更新附件）

| 产物 | 用途 |
| --- | --- |
| `mote-desktop-macos-<arch>-X.Y.Z.zip` | 对应架构的独立 Mac App，含本地原生助手和更新助手 |
| `mote-android-arm64-X.Y.Z.apk` | 日常 Android 应用 |
| `mote-android-dev-arm64-X.Y.Z.apk` | 独立开发环境应用，不与日常设置混用 |
| `mote-server-X.Y.Z.tar.gz` | 目标机器上构建的中央源码包，内含前端与部署工具 |
| `mote-release.json` | 带 RSA 签名的发布清单；客户端依据它验证版本、资产和镜像 |
| `SHA256SUMS` | 供人工核对下载；自动更新仍须验证签名清单 |
| `ghcr.io/utopiafar/mote:X.Y.Z` | Linux amd64/arm64 中央镜像；更新实际按签名中的不可变 digest 拉取 |

模型权重由模型管理器另行下载或离线导入；更新安装包不会重复分发或清理已下载模型。源码包仅从 Git 标签归档，忽略目录、个人配置和签名材料不在其中。

## 签名配置与历史清单密钥

签名材料保存在 GitHub 仓库的 **release Environment Secrets**。该环境允许历史 `v*` 及 `central-v*`、`desktop-v*`、`android-v*` 标签的部署。首次启用独立工作流时，维护者需在 Environment 的 Deployment branches and tags 中添加三个组件标签规则；此设置不在 Git 仓库中，版本验证器仍要求准确的组件版本标签。普通分支和 Pull Request 的测试无需签名私钥。Workflow 只写 Secret 名称，通过环境变量或临时文件使用值；临时签名文件在构建结束后清理，不作为 artifact 上传。不要把私钥粘贴到 YAML 或 Release 附件。

| Secret / Variable | 内容 |
| --- | --- |
| `MOTE_RELEASE_SIGNING_KEY`（Secret） | RSA 3072 PKCS#8 PEM 私钥，签署原始 manifest payload 字节 |
| `MOTE_ANDROID_KEYSTORE_BASE64`（Secret） | 保持同一应用签名身份的 PKCS#12 文件，以 base64 存储 |
| `MOTE_ANDROID_KEYSTORE_PASSWORD`（Secret） | 随机生成的 keystore 密码 |
| `MOTE_ANDROID_KEY_ALIAS`（Secret） | 签名条目的别名 |
| `MOTE_ANDROID_KEY_PASSWORD`（Secret） | 私钥条目密码 |
| `MOTE_MAC_SIGNING_MODE`（Variable） | `adhoc` 或 `developer-id`；未设置时为 adhoc，并在 Release 中标明 |
| `MOTE_MAC_CERTIFICATE_P12_BASE64`（Secret） | Apple Developer ID Application 证书及私钥，仅正式签名模式使用 |
| `MOTE_MAC_CERTIFICATE_PASSWORD`（Secret） | Apple 证书容器密码 |
| `MOTE_APPLE_TEAM_ID`（Variable） | Apple 团队标识 |
| `MOTE_APPLE_API_KEY_P8` / `MOTE_APPLE_API_KEY_ID` / `MOTE_APPLE_API_ISSUER`（Secrets） | Apple 公证 API 凭据 |

GitHub 的 `GITHUB_TOKEN` 由工作流自动取得，当前用于仓库 Release 发布；旧完整发行流程还曾用于 GHCR 发布，不另存一个个人 PAT。镜像首次发布后需确认包可见性满足部署需求；如果 GHCR 包保持私有，部署机需要自己的只读 registry 凭据，不能将发布 token 写入客户端。

本仓库的 `ghcr.io/utopiafar/mote:0.5.1` 已验证可匿名读取 amd64/arm64 镜像清单。实际安装与升级使用发布签名中的 digest；fork 或新软件包仍需单独检查其可见性。

配置方式见 [GitHub Secrets 官方说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。例如使用 `gh secret set NAME --env release --repo utopiafar/mote`，通过标准输入提交值；不要把值写在 shell 参数中。

Android 0.5.1 延续本项目 0.4.0 包的原有签名密钥，转换为强密码 PKCS#12 后供 CI 使用。私钥身份保持相同，发布版不启用调试标志。CI 会核对实际 APK 的包名、版本和固定证书 SHA-256，防止每次 runner 自动生成新 debug key，造成用户无法覆盖升级。证书公开指纹与应用标识位于 [签名策略](../release/signing-policy.json)。[Android 要求更新包保持签名身份](https://developer.android.com/studio/publish/app-signing)。

Mac 默认 adhoc 只提供本期可构建的分发方式，不代表 Apple 认可的正式签名。选择 `developer-id` 后，缺少证书或公证凭据会使构建失败，不会静默降级为 adhoc；构建验证签名、公证票据和 Gatekeeper。Apple 账户、证书费用与公证服务由应用维护者配置，流程不会代为创建这些账户。[electron-builder v26 签名说明](https://www.electron.build/v26/docs/code-signing)。

## 日常 Dev 构建

Central：在对应 workflow 的 Run workflow 中选择分支与 `profile=dev`。工作流校验该组件和锁文件，构建 Dev 包并保留为 `central-dev-<完整提交 SHA>` Artifact（保留 7 天）；不创建 Git Tag 或 GitHub Release。源码包保留组件版本；确切提交以 Artifact 名和 `build-info.json` 为准。Central 的文件名与 Prod 相同，因为它是同一份不带配置的源码。

Desktop：在 `Release Desktop` 的 Run workflow 中选择 `main` 和 `profile=dev`，或执行：

```sh
gh workflow run release-desktop.yml --repo utopiafar/mote --ref main -f profile=dev
```

只验证候选、暂不分发时加 `-f publish=false`：仍执行完整组件检查、签名、打包后 smoke 并保留 Artifact，跳过公开发布步骤。验收通过后再从同一提交发布。

桌面组件检查、签名与打包后 smoke 通过后，发布 `desktop-dev-<run number>-<短 SHA>` Pre-release，公开附件只有当前构建架构的 `mote-desktop-macos-dev-<arch>-<组件版本>.zip`。收藏 [Mac Dev 下载入口](https://github.com/utopiafar/mote/releases?q=desktop-dev-+prerelease%3Atrue+draft%3Afalse&expanded=true)，打开最新发布，点击 **Download Mac ZIP**；退出 Mote Collector Dev 后解压并覆盖应用目录中的同名 App，保留包外资料目录。App 版本沿用组件版本，每次分发由独立 Tag、构建序号和完整提交区分；不要求递增 Prod 版本。发布说明明确实际签名模式，默认 ad-hoc 不代表 Apple 公证。

Desktop Dev 与 Android Dev 均只允许可信仓库 `main` 的手动触发公开分发，不设置全仓库 Latest，不覆盖已发布版本；失败草稿只允许原提交修复，旧构建不能晚于新构建发布。其他允许分支保留 Actions Artifact。公开 ZIP / APK 不随 7 天 Artifact 过期。

Android：在 `Release Android` 的 Run workflow 中选择 `main` 和 `profile=dev`，或执行：

```sh
gh workflow run release-android.yml --repo utopiafar/mote --ref main -f profile=dev
```

通过 Development 单测、签名和 APK 身份校验后，自动发布独立的 `android-dev-<run number>-<短 SHA>` Pre-release。手机收藏 [Android Dev 下载入口](https://github.com/utopiafar/mote/releases?q=android-dev-+prerelease%3Atrue+draft%3Afalse&expanded=true)，打开最上面的发布，点击说明里的 **Download APK**，下载后确认覆盖安装。公开附件只有 APK，无需登录 Actions 或解压 Artifact；构建元数据仍在 Actions 保留 7 天，Release APK 不随 Artifact 过期。

每个 workflow run 对应一个不可变分发版本，`versionName` 为 `<组件版本>-dev.<run number>`，`versionCode` 为 `1000000000 + run number`，独立于 Prod 的版本码。重复运行同一次 workflow 只能修复未发布草稿；已经发布、已有更新构建或 Tag 指向不同提交时拒绝覆盖，应重新 Run workflow。Dev 发布不设置全仓库 Latest。仅可信仓库 `main` 的手动触发可以公开 Dev；其他允许的分支仍只保留 Artifact。

本地 `assembleDevelopment` 默认仍使用组件版本码及 `-dev`；需要覆盖 CI Dev 包时，可显式设置 `MOTE_ANDROID_DEV_RUN=<比已安装构建更大的编号>`，并配置相同签名证书。该参数只改变 Development 的版本码，不改变 Prod 或 Test。

Mac Dev 使用 `dev.mote.collector.dev` / `Mote Collector Dev`；Android 使用 `dev.mote.collector.dev`，本地 versionName 带 `-dev`，CI 带 `-dev.<run number>`。Android 沿用已有固定签名证书，避免换 runner 后无法覆盖安装。

本地 Mac 出包：

```sh
MOTE_BUILD_PROFILE=dev node scripts/release/mac-package.mjs
# Beta / 正式包使用正式安装身份：
MOTE_BUILD_PROFILE=prod node scripts/release/mac-package.mjs
```

签名 Secret 仍从 `release` Environment 读取。该 Environment 必须允许可信开发分支；2026-10-24 已确认 `main` 在允许列表中。其他分支构建 Mac / Android Dev 签名包前，维护者须在 Deployment branches and tags 中额外允许受信任的开发分支，或采用单独受控环境并相应配置 workflow。不要开放不受信任分支。此设置不在 Git 中，发布改动不自动扩大线上 Secret 的访问范围；未允许的 Mac / Android 分支 Dev 签名打包会被 GitHub 拒绝；Central 的 Dev 源码打包不使用该 Environment，可直接运行。

## Beta / 正式发布

1. 选择组件。运行 `npm run release:version -- desktop 0.1.0-beta.1`；正式发布使用 `npm run release:version -- desktop 0.1.0`。替换组件名即可发布 Central / Android；版本必须高于该组件当前版本。
2. 编写脚本输出的 `release/notes/<组件>/<版本>.md`，说明用户变化、安装/升级步骤和实际验证范围。
3. 运行 `npm run check:affected` 及受影响用户流程验证，再运行 `npm run release:verify -- desktop`。只改文档时检查格式、语法、链接和渲染，无需应用构建。
4. 合并后，在已验证提交创建并推送脚本输出的不可变 Tag，例如 `desktop-v0.1.0-beta.1`。普通分支不能发布 Prod；手动重跑也必须选准确组件 Tag。Tag 构建固定采用 Prod，与 dispatch 默认选项无关。
5. 工作流执行组件测试、构建、版本与真实产物身份校验，再上传唯一组件附件。Beta 自动标记 Pre-release；正式 Tag 自动清除此标记。已发布版本拒绝覆盖；失败草稿可以重试。

Beta 验收后准备正式版本、同步元数据和说明，再检查并打正式 Tag；不能把 Dev 包改个名称当正式包。各端版本不必同时递增；共享修改检查所有消费者，但只为实际需要升级的产品发版。GitHub 全局 Latest 不表示任何一个组件的最新版本，发布器不修改该指向。

安全校验元数据和 `build-info.json` 保留在 Actions，不作为公开 Release 附件。Mac 验证签名、Bundle ID、版本和架构；Android 验证包名、证书、版本码、非 debuggable 及 16 KiB 对齐；Central 从提交归档构建所需 Monorepo 并校验内容。当前工作流不上传签名更新清单，升级仍按 [更新指南](updating.md) 手动进行。

## 信任与密钥轮换

[发布公钥](../release/release-public-key.pem) 随已安装程序固定。清单 envelope 包含 `schemaVersion`、`keyId`、base64 payload 和 RSA-SHA256 签名；签名覆盖原始 UTF-8 payload 字节，避免不同平台 JSON 序列化差异。单组件 payload 必须声明 `component=central|desktop|android`，使用对应组件标签且只包含该组件资产。版本、渠道、仓库/标签、资产大小与散列、平台身份及可选镜像 digest 仍在签名覆盖范围内。更新器按所属发布流读取，拒绝旧统一清单及缺失组件。当前 Profile 发布 workflow 不调用签名清单生成器。

修改更新仓库不会改变信任密钥，任意第三方清单仍不能通过验签。自有 fork 需要建立自己的签名身份，并在首次安装时明确使用对应公钥构建。GitHub Secrets 无法反向导出，维护者应保留受保护的恢复副本；不能通过重新生成密钥来“修复”旧客户端的签名错误。

未来轮换发布密钥需先由旧可信密钥发布支持新公钥的过渡版本；Android 应用签名轮换还受系统支持的签名 lineage 约束。本期不提供忽略签名、降级、自动卸载或重置配置的兜底开关。
