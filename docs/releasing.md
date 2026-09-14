# 发布版本与签名

Mote 的客户端、中央节点和中央前端使用同一个产品版本。发布使用 `vX.Y.Z` Git 标签；撤下的试验 Release 仍可保留历史标签用于追溯。发布入口是 [Release workflow](../.github/workflows/release.yml)，安装与更新入口见 [更新说明](updating.md)。

## 开发早期版本编号

2026-09-14 将对外版本重新从 **0.0.1** 开始，保留已实现功能和代码历史，撤下此前的 GitHub 试验 Release。版本编号较小不会改变应用签名、数据格式或用户目录；Android 内部 `versionCode` 从 11 递增到 12，后续每次发布继续递增。

此前 Mac 和中央节点的自动更新按语义版本比较，因此不会将 0.0.1 当作更新；切换时应手动更新中央部署、退出并覆盖替换 Mac App，保留配置、凭据、模型与数据目录。Android 按内部版本码比较，原有更新流程仍可识别 code 12。不要绕过签名校验、复用较低 Android 版本码或卸载应用来完成切换。项目仍处于开发早期，当前版本不承诺功能和协议稳定。

## 发布产物

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

## GitHub Secrets

签名材料保存在 GitHub 仓库的 **release Environment Secrets**。该环境只允许 `v*` 标签的部署。普通分支和 Pull Request 的测试无需签名私钥。Workflow 只写 Secret 名称，通过环境变量或临时文件使用值；临时签名文件在构建结束后清理，不作为 artifact 上传。不要把私钥粘贴到 YAML 或 Release 附件。

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

GitHub 的 `GITHUB_TOKEN` 由工作流自动取得，用于当前仓库的 Release 和 GHCR 发布，不另存一个个人 PAT。镜像首次发布后需确认包可见性满足部署需求；如果 GHCR 包保持私有，部署机需要自己的只读 registry 凭据，不能将发布 token 写入客户端。

本仓库的 `ghcr.io/utopiafar/mote:0.5.1` 已验证可匿名读取 amd64/arm64 镜像清单。实际安装与升级使用发布签名中的 digest；fork 或新软件包仍需单独检查其可见性。

配置方式见 [GitHub Secrets 官方说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。例如使用 `gh secret set NAME --env release --repo utopiafar/mote`，通过标准输入提交值；不要把值写在 shell 参数中。

Android 0.5.1 延续本项目 0.4.0 包的原有签名密钥，转换为强密码 PKCS#12 后供 CI 使用。私钥身份保持相同，发布版不启用调试标志。CI 会核对实际 APK 的包名、版本和固定证书 SHA-256，防止每次 runner 自动生成新 debug key，造成用户无法覆盖升级。证书公开指纹与应用标识位于 [签名策略](../release/signing-policy.json)。[Android 要求更新包保持签名身份](https://developer.android.com/studio/publish/app-signing)。

Mac 默认 adhoc 只提供本期可构建的分发方式，不代表 Apple 认可的正式签名。选择 `developer-id` 后，缺少证书或公证凭据会使构建失败，不会静默降级为 adhoc；构建验证签名、公证票据和 Gatekeeper。Apple 账户、证书费用与公证服务由应用维护者配置，流程不会代为创建这些账户。[electron-builder v26 签名说明](https://www.electron.build/v26/docs/code-signing)。

## 一次发布

1. 更新根目录、Mac、中央和 Web 的 package 版本，以及 Android `versionName`；每次 Android 发布都增加 `versionCode`，同一身份不能复用更低版本码。
2. 更新 lockfile 和 `release/notes/X.Y.Z.md`。运行 `node scripts/release/verify-version.mjs`、类型检查与相关回归。
3. 提交并推送代码，然后创建不可变版本标签，例如 `git tag vX.Y.Z` 与 `git push origin vX.Y.Z`。
4. Release workflow 运行完整检查，并行构建 Mac、Android、源码包和双架构镜像。所有必要作业成功后才签署清单、上传资产并发布 Release。
5. 实际从 GitHub 下载清单，验证内置发布公钥；检查各包的 SHA-256、Android 证书和 Mac 包版本，再在隔离环境验证升级保留状态。

Workflow 可从已有版本标签手动重跑。失败可重试尚未发布的草稿；已发布版本禁止覆盖资产，修复应使用新版本和新标签。预览版本使用 `X.Y.Z-rc.N` 等后缀，对应 `preview` 渠道；正式渠道不自动切换到预览。

## 信任与密钥轮换

[发布公钥](../release/release-public-key.pem) 随已安装程序固定。清单 envelope 包含 `schemaVersion`、`keyId`、base64 payload 和 RSA-SHA256 签名；签名覆盖原始 UTF-8 payload 字节，避免不同平台 JSON 序列化差异。Payload 指定版本、渠道、GitHub 仓库/标签、每个资产的大小和散列、平台身份以及不可变镜像 digest。

修改更新仓库不会改变信任密钥，任意第三方清单仍不能通过验签。自有 fork 需要建立自己的签名身份，并在首次安装时明确使用对应公钥构建。GitHub Secrets 无法反向导出，维护者应保留受保护的恢复副本；不能通过重新生成密钥来“修复”旧客户端的签名错误。

未来轮换发布密钥需先由旧可信密钥发布支持新公钥的过渡版本；Android 应用签名轮换还受系统支持的签名 lineage 约束。本期不提供忽略签名、降级、自动卸载或重置配置的兜底开关。
