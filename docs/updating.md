# 更新 Mote 与存储代际边界

Central、macOS、Android 独立发布。Dev 构建从对应 [GitHub Actions](https://github.com/utopiafar/mote/actions) 运行下载 Artifact，包含提交 SHA 与构建信息。Beta / 正式版从 [GitHub Releases](https://github.com/utopiafar/mote/releases) 下载对应组件的 Prod 产物。各端版本号不能相互比较；当前不分发签名更新清单或 GHCR 镜像。

## MVP 单用户回归

本次回归使用单实例、单所有者的当前格式和全新私有 profile。旧多用户数据、旧凭据和旧配置不迁移、不兼容，也不自动转换。Git 历史通过 revert 保留；部署数据与 Git 历史是不同的边界。开发和验证只使用新建的隔离目录，不修改已有日常环境。参见 [单用户 ADR](adr-single-owner-mvp.md)。

## Mac App

Dev 与 Prod App 分开安装。下载对应身份和架构的 ZIP，退出使用该 App 的实例后替换应用包。Dev build 或精确的 `dev` runtime profile 使用私有 JSON 凭据；Prod 使用系统加密存储。任意 `dev-*` 名称不等于 Dev profile。系统可能要求运行、屏幕或日历权限，Prod 还可能要求 Keychain。新 MVP 环境从空目录开始；之后同一当前格式的更新可保留该环境的配置和队列。

## Android App

Dev 包名为 `dev.mote.collector.dev`，Beta / 正式包名为 `dev.mote.collector`；Test 的 `dev.mote.collector.test` 只用于生成 fixture。Dev 的 Mote 凭据及私有 AES 密钥保存在应用私有文件，Prod / Test 保留 Keystore。覆盖同一身份安装时必须保持签名证书一致且 versionCode 不降低。新 MVP 使用全新环境；不提供旧格式转换。更新可能中断投屏，恢复仍受 Android 权限与后台规则约束。

## 中央节点

从 `central-vX.Y.Z` 发布下载 `mote-server-X.Y.Z.tar.gz`，解压到独立目录，或检出对应 Git 标签。源码包保留构建所需的 Monorepo 依赖，产品版本读取 `apps/server/package.json`；网页与服务属于同一个 Central 版本。先安装依赖并构建中央与 Web：

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
npm run connectors:prepare
```

受管理的 profile 用 `upgrade --release /absolute/built-checkout` 切换；Docker 先自行构建镜像，再用 `upgrade --image <image>`。同代切换沿用原 profile、`--home`、主 YAML、数据目录/卷及密钥，CLI 会停止目标环境并创建一致性备份后切换；尚未转换旧配置时必须先离线准备新 YAML。跨越历史存储基线仍须先用旧程序完成旧备份，再为新版本选择新空目录/卷并重设模型和文件 policy；不能直接将新版本 `upgrade` 指向不兼容旧库。非 CLI 托管进程需管理员自行停止与备份，不能假定 CLI 已接管它。直接启动默认 `profile=default`，读取工作目录的 `mote.yaml`，或使用 `MOTE_CONFIG_FILE` 显式选择文件；普通环境变量和根 `.env` 不提供配置覆盖。

```sh
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --release /srv/mote/releases/next
# 仅在需要恢复升级前数据时使用：
node scripts/mote.mjs rollback --profile prod --home /srv/mote/profiles --restore-data
```

详细步骤见 [部署与迁移](deployment.md#升级与回退)。当前程序不迁移旧数据库。上述回退事务用于同代部署，恢复升级前快照并另外保留新增资料；跨代回滚必须恢复完整旧目录并使用配套旧程序，不能让旧程序直接读取新格式数据库。备份不包含私钥和外部授权，存在密文时须单独保留原内容密钥。OCR/ASR 模型和运行时的安装、升级另见 [中央媒体运行时](ocr-asr-implementation-plan.md)。

## 签名清单更新通道

代码仍保留客户端签名清单下载与安装、中央 `check-update` / `update`、独立更新助手及失败回退。它们要求受内置公钥信任的 manifest 和对应资产；切换仓库不会更换信任根，不能跳过签名、证书或版本校验。验证器只接受所属端的独立标签与必填组件身份：`central-vX.Y.Z`、`desktop-vX.Y.Z`、`android-vX.Y.Z`。旧统一 `vX.Y.Z` 标签与缺组件的清单拒绝；清单不能夹带其他端资产。当前 Profile 发布不使用该通道。当前产物与流程见 [发布说明](releasing.md)。

## 验证边界

下载完成不代表已安装；重新启动后核对实际程序版本、原有配置与待同步数据。Fixture、模拟器、物理设备和真实模型检查分别记录，历史通过不代表本次升级已实测。
