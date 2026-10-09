# 发布版本与签名

Mote 保留 npm Monorepo，按独立安装/部署单元发布。根 `package.json` 是私有工作区控制入口，不再代表产品版本；共享内部库随使用它的产品从同一提交构建。

| 发布单元 | 版本来源 | 标签 | DEV 公开附件 |
| --- | --- | --- | --- |
| Central | server 与 web 的 package.json，两者一致 | `central-vX.Y.Z` | `mote-server-X.Y.Z.tar.gz` 源码包 |
| macOS | desktop 的 package.json | `desktop-vX.Y.Z` | Mac DEV ZIP |
| Android | `apps/android/version.properties` | `android-vX.Y.Z` | Android DEV APK |

三个单元分别走 [Central](../.github/workflows/release-central.yml)、[Desktop](../.github/workflows/release-desktop.yml)、[Android](../.github/workflows/release-android.yml) workflow。只推送要发布的组件标签，只构建、验证和上传该组件的产物。当前依然是 DEV prerelease、手动安装/部署，不恢复签名在线更新，也不发布 GHCR 镜像。架构、协议和迁移边界见 [独立发布架构](release-architecture.md)，安装见 [更新说明](updating.md)。

## MVP 阶段的 GitHub 检查开关

2026-10-02 暂停 GitHub 的 `Checks` 和 `Component checks` 工作流，并将仓库变量 `MOTE_PRE_RELEASE_CHECKS` 设为 `false`。三个发布工作流保持启用，默认跳过 Central/Desktop 的测试与独立类型检查、Android 单元测试，以及 Mac 打包后的兼容性 smoke。构建、组件版本、签名、应用身份与发布附件完整性校验继续执行。未设置变量时同样跳过发布测试；本地检查命令仍可手动使用，本地 Mac 打包未设置该环境变量时仍执行 smoke。

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

## 历史完整发布产物（当前 DEV 不发布）

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

## 当前 DEV 发布流程

1. 运行 `npm run release:version -- android patch`（或 `central`、`desktop`，也可给出更高的完整版本）。脚本只修改该发布单元；Central 同步 server/web 和对应 lockfile 条目，Android 单独递增 versionCode。
2. 编写 `release/notes/<组件>/<版本>.md`，记录这个端的变化与实际验证范围。
3. 提交/PR 前运行 `npm run check:local`；发布前运行 `npm run release:verify -- android`。MVP 阶段平台测试由维护者按需手动运行：Central 可运行 `npm run check:central`，macOS 可运行 `npm run check:desktop`；Android 用 Gradle 单元测试、构建与 lint。GitHub 的默认暂停策略见上面的检查开关。
4. 合并后在对应提交推送不可变组件标签，例如 `android-v0.0.78`。手动启动 workflow 也必须选择准确的组件标签，普通分支无法发版。
5. 对应工作流构建、验证并上传唯一组件产物。Mac 使用 `MOTE_MAC_DEVELOPMENT=1`；Android 使用原证书并核验包名、版本码和 16 KiB 对齐；Central 构建 server/web 后从标签归档所需源码，并验证结构与版本。`.asset.json` 等 CI 校验数据不作为公开附件。

例如只修 Android：

```sh
npm run release:version -- android patch
# 按脚本输出的 notes 路径写发布说明
npm run check:local
npm run release:verify -- android
# 合并后，在已验证提交创建并推送脚本输出的 tag
git tag android-v0.0.78
git push origin android-v0.0.78
```

[Component checks](../.github/workflows/component-checks.yml) 恢复启用后按代码输入和 npm 依赖选择平台检查；协议或共享契约变更检查所有消费者，普通端侧改动只检查该端。完整手动检查仍保留在 [Checks](../.github/workflows/checks.yml)，本地 PR 检查仍为 `check:local`。检查所有端不会创建其他端的发布。

已发布 Release 不可覆盖，失败草稿可以重试。各端版本不能相互比较，也不必同时递增。文档修改本身不要求发布安装包；共享库变化需要判断实际受影响产品并分别发版。中央源码包保留 npm lockfile 和跨工作区依赖，以便在目标机器独立构建。升级步骤见 [更新指南](updating.md)。

## 信任与密钥轮换

[发布公钥](../release/release-public-key.pem) 随已安装程序固定。清单 envelope 包含 `schemaVersion`、`keyId`、base64 payload 和 RSA-SHA256 签名；签名覆盖原始 UTF-8 payload 字节，避免不同平台 JSON 序列化差异。单组件 payload 必须声明 `component=central|desktop|android`，使用对应组件标签且只包含该组件资产。版本、渠道、仓库/标签、资产大小与散列、平台身份及可选镜像 digest 仍在签名覆盖范围内。更新器按所属发布流读取，拒绝旧统一清单及缺失组件。当前 DEV workflow 不调用签名清单生成器。

修改更新仓库不会改变信任密钥，任意第三方清单仍不能通过验签。自有 fork 需要建立自己的签名身份，并在首次安装时明确使用对应公钥构建。GitHub Secrets 无法反向导出，维护者应保留受保护的恢复副本；不能通过重新生成密钥来“修复”旧客户端的签名错误。

未来轮换发布密钥需先由旧可信密钥发布支持新公钥的过渡版本；Android 应用签名轮换还受系统支持的签名 lineage 约束。本期不提供忽略签名、降级、自动卸载或重置配置的兜底开关。
