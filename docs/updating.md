# 更新 Mote 与存储代际边界

当前开发阶段按 **Central、macOS、Android** 独立创建 DEV prerelease。请打开 [GitHub Releases](https://github.com/utopiafar/mote/releases)，选择 `central-v…`、`desktop-v…` 或 `android-v…` 对应的发布；各端的版本号不能相互比较。`releases/latest` 不代表某个端的最新 prerelease。当前发布不附 `mote-release.json` 或 GHCR 镜像，保留的签名更新器不能用于获取当前 DEV 版本。

## 本轮 MVP 破坏升级

本轮中央使用 `backend_epoch=4`，Desktop/Android 本机与队列格式为 3，模型 registry 为 version 2，HTTP 便携归档为完整 version 2。旧 schema、客户端/模型/文件处理配置、队列、内容包装和精简/旧便携包明确拒绝，不自动迁移或清空目录。先用旧版本导出需保留内容，停止全部写入，备份完整旧目录、凭据与密钥，再使用新空目录或新 profile；明确放弃资料时才执行 reset。中央手动 reset、新目录和客户端清理步骤见 [本次清理实施记录](audits/mvp-baseline-cleanup-2026-10-09.md)。旧二进制与完整旧备份须一起保留，才能跨代回滚。

## Mac App

保存输入，退出使用同一个 App bundle 的全部 Mote 实例，解压下载的 Mac DEV ZIP，用其中的 App 覆盖原 DEV App 后启动。设备身份、配置、凭据、草稿、队列和模型在应用包之外；同代更新不要删除资料目录；客户端本机格式仍为 3；本次只清理已退役的处理字段，当前格式队列和凭据保留。更早的非格式 3 目录仍须先备份再显式重置。默认 profile 仍使用原 userData 路径，换 App bundle 不会把旧资料变成新格式。当前使用 ad-hoc 签名时，系统可能再次要求运行、Keychain、屏幕或日历授权。

## Android App

下载 Android DEV APK，同包覆盖安装。必须保持包名 `dev.mote.collector.dev`、签名证书一致且 versionCode 不降低；DEV 与日常包不是同一个安装身份。系统可能要求允许安装应用并确认更新。同代更新不要先卸载或清除数据。本次 Android 本机格式仍为 3，可保留当前队列和设置；遇到更早的非格式 3 安装时须先用旧版本导出，再显式清除应用存储或选择全新独立安装；清除/卸载会丢失 Keystore，不能保证以旧目录恢复凭据、私有草稿和操作 ledger，需要重新授权。更新可能中断投屏，会话恢复仍由 Android 权限与后台规则控制。

## 中央节点

从 `central-vX.Y.Z` 发布下载 `mote-server-X.Y.Z.tar.gz`，解压到独立目录，或检出对应 Git 标签。源码包保留构建所需的 Monorepo 依赖，产品版本读取 `apps/server/package.json`；网页与服务属于同一个 Central 版本。先安装依赖并构建中央与 Web：

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
```

受管理的 profile 用 `upgrade --release /absolute/built-checkout` 切换；Docker 先自行构建镜像，再用 `upgrade --image <image>`。同代切换沿用原 profile、`--home`、当前配置、数据目录/卷及密钥，CLI 会停止目标环境并创建一致性备份后切换。跨代必须先用旧程序完成旧备份，再为新版本选择新空目录/卷并重设模型和文件 policy；不能直接将新版本 `upgrade` 指向旧库。非 CLI 托管进程需管理员自行停止与备份，不能假定 CLI 已接管它。直接启动默认 `profile=default`，要求显式 `MOTE_ENV_FILE` 或 `MOTE_DATA_DIR` 之一，不再自动读取根 `.env`。

```sh
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --release /srv/mote/releases/next
# 仅在需要恢复升级前数据时使用：
node scripts/mote.mjs rollback --profile prod --home /srv/mote/profiles --restore-data
```

详细步骤见 [部署与迁移](deployment.md#升级与回退)。当前程序不迁移旧数据库。上述回退事务用于同代部署，恢复升级前快照并另外保留新增资料；跨代回滚必须恢复完整旧目录并使用配套旧程序，不能让旧程序直接读取新格式数据库。备份不包含私钥和外部授权，存在密文时须单独保留原内容密钥。OCR/ASR 模型和运行时的安装、升级另见 [中央媒体运行时](ocr-asr-implementation-plan.md)。

## 签名清单更新通道

代码仍保留客户端签名清单下载与安装、中央 `check-update` / `update`、独立更新助手及失败回退。它们要求受内置公钥信任的 manifest 和对应资产；切换仓库不会更换信任根，不能跳过签名、证书或版本校验。验证器只接受所属端的独立标签与必填组件身份：`central-vX.Y.Z`、`desktop-vX.Y.Z`、`android-vX.Y.Z`。旧统一 `vX.Y.Z` 标签与缺组件的清单拒绝；清单不能夹带其他端资产。当前 DEV 发布不使用该通道。历史验证见 [0.5.1 更新验收](update-validation.md)，当前产物与流程见 [发布说明](releasing.md)。

## 验证边界

下载完成不代表已安装；重新启动后核对实际程序版本、原有配置与待同步数据。Fixture、模拟器、物理设备和真实模型检查分别记录，历史通过不代表本次升级已实测。
