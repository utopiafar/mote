# 组件发布

Central（server与web同版本）、macOS、Android独立发布，内部workspace库随产品从同一提交构建。产品版本不代替协议或权限；跨端修改检查实际消费者，只发布需要升级的组件。iOS为实验客户端。

| 组件 | 版本来源 | Prod附件 |
| --- | --- | --- |
| Central | apps/server与apps/web的package.json | mote-server-X.Y.Z.tar.gz |
| Desktop | apps/desktop/package.json | mote-desktop-macos-<arch>-X.Y.Z.zip |
| Android | apps/android/version.properties | mote-android-arm64-X.Y.Z.apk |

Beta标签为`<组件>-vX.Y.Z-beta.N`，正式标签为`<组件>-vX.Y.Z`，组件名central、desktop、android。标签和已发布附件不可覆盖，Beta与正式都使用Prod安装身份；Pre-release状态不决定Profile。根package.json是私有工作区，不代表产品版本。

## Dev、Test与Prod

Dev与Prod身份、资料和凭据隔离；Test只作生成fixture，不分发。客户端Dev使用私有文件凭据，Prod使用系统保护；第三方CLI维护自己的存储。Central的配置始终由所选私有YAML提供，普通debug与详细trace默认关闭，显式设置保持有效。

Central Dev手动构建仅保存`central-dev-<SHA>` Actions Artifact。Desktop/Android Dev从可信main手动分发为不可变Pre-release：

```sh
gh workflow run release-desktop.yml --ref main -f profile=dev
gh workflow run release-android.yml --ref main -f profile=dev
```

标签为`desktop-dev-<run>-<短SHA>`或`android-dev-<run>-<短SHA>`。其他允许分支保留Artifact；Dev不设置全仓库Latest。公开附件不随7天Artifact过期。失败草稿仅原提交可修复，已发布或已有更新构建时拒绝覆盖。

Mac Dev的Bundle ID为`dev.mote.collector.dev`，Android Dev包名同为`dev.mote.collector.dev`。Android CI的versionName带`-dev.<run>`，versionCode为`1000000000 + run`；本地Development可显式设置更大的`MOTE_ANDROID_DEV_RUN`并使用同一证书。Prod版本码独立递增。Mac本地出包可用`MOTE_BUILD_PROFILE=dev node scripts/release/mac-package.mjs`。

## Beta与正式版本

```sh
npm run release:version -- desktop 0.1.0-beta.1
npm run release:verify -- desktop
```

将desktop换成所选组件。版本脚本更新该组件元数据并给出`release/notes/<组件>/<版本>.md`及标签；说明包含用户变化、升级注意和实际验证范围。标签指向已验证提交，Prod只从准确组件标签构建；workflow手动重跑不能把普通分支变成Prod。

[Central](../.github/workflows/release-central.yml)、[Desktop](../.github/workflows/release-desktop.yml)、[Android](../.github/workflows/release-android.yml)分别执行对应组件检查、构建及真实产物校验。Desktop Dev含打包smoke，Android Dev含Development单测；Central Dev的可选检查受`MOTE_PRE_RELEASE_CHECKS`控制，Prod组件检查不跳过。工作流文件不代表线上开关状态或某次运行成功。

Mac校验签名、Bundle ID、版本与架构；Android校验包名、固定证书、版本码、non-debuggable与16 KiB对齐；Central归档所需工作区与锁文件，不包含个人配置、模型权重或归档资料。build-info和安全校验元数据保存在Actions。当前不发布签名更新清单或GHCR镜像，按[更新指南](updating.md)安装。

## 签名与信任

签名材料由release Environment提供；环境的分支/标签访问规则需由维护者配置，仓库改动不会扩大Secret访问。普通PR无需签名私钥。

| Secret或Variable | 用途 |
| --- | --- |
| `MOTE_ANDROID_KEYSTORE_BASE64`、`MOTE_ANDROID_KEYSTORE_PASSWORD`、`MOTE_ANDROID_KEY_ALIAS`、`MOTE_ANDROID_KEY_PASSWORD` | 固定Android应用签名身份 |
| `MOTE_MAC_SIGNING_MODE` | adhoc或developer-id，默认adhoc |
| `MOTE_MAC_CERTIFICATE_P12_BASE64`、`MOTE_MAC_CERTIFICATE_PASSWORD` | Developer ID证书 |
| `MOTE_APPLE_TEAM_ID`、`MOTE_APPLE_API_KEY_P8`、`MOTE_APPLE_API_KEY_ID`、`MOTE_APPLE_API_ISSUER` | Apple公证 |

Developer ID缺少材料时失败，不静默降为adhoc；adhoc不代表Apple公证。私钥不进入源码、日志或附件。应用标识和公开证书指纹见[signing-policy](../release/signing-policy.json)。

保留的签名更新代码信任内置[公钥](../release/release-public-key.pem)，要求单组件身份、准确标签、散列和RSA签名；换仓库不更换信任根。fork需建立自己的签名身份，未来轮换须有可信过渡版本；不能靠忽略签名、卸载或重置资料解决身份冲突。

当前wire/Ingress能力由[协议](protocol.md)和[contract.json](../protocol/contract.json)声明，不能比较产品版本来猜兼容性。默认插件组合构建与干净启动是[手工验证](testing-runbook.md#manual-plugin-stage-and-release-journeys)，不自动签名或发布。
