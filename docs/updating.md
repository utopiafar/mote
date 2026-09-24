# 保留设置地更新 Mote

当前开发阶段只发布 **Mac DEV ZIP 和 Android DEV APK**，发布类型为 DEV prerelease。请打开 [GitHub Releases](https://github.com/utopiafar/mote/releases) 选择版本；`releases/latest` 不保证指向最新 prerelease。当前没有 `mote-release.json`、服务端源码包或新 GHCR 镜像附件，保留的签名更新器不能用于获取当前 DEV 版本。

## Mac App

保存输入，退出使用同一个 App bundle 的全部 Mote 实例，解压下载的 Mac DEV ZIP，用其中的 App 覆盖原 DEV App 后启动。设备身份、配置、凭据、草稿、队列和模型在应用包之外；不要删除用户资料目录，也不要把换 profile 当作更新。当前使用 ad-hoc 签名时，系统可能再次要求运行、Keychain、屏幕或日历授权。

## Android App

下载 Android DEV APK，同包覆盖安装。必须保持包名 `dev.mote.collector.dev`、签名证书一致且 versionCode 不降低；DEV 与日常包不是同一个安装身份。系统可能要求允许安装应用并确认更新。不要先卸载或清除数据，避免丢失本机内容和 Keystore。更新可能中断投屏，会话恢复仍由 Android 权限与后台规则控制。

## 中央节点

当前从源码部署。先在独立检出目录安装依赖并构建中央与 Web：

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
```

受管理的 profile 用 `upgrade --release /absolute/built-checkout` 切换；Docker 先自行构建镜像，再用 `upgrade --image <image>`。沿用原 profile、`--home`、配置、数据目录/卷及密钥。CLI 会停止目标环境并创建一致性备份后切换；直接 `legacy` 部署需自行停止和备份，不能假定 CLI 已接管它。

```sh
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --release /srv/mote/releases/next
# 仅在需要恢复升级前数据时使用：
node scripts/mote.mjs rollback --profile prod --home /srv/mote/profiles --restore-data
```

详细步骤见 [部署与迁移](deployment.md#升级与回退)。新版本可能迁移数据库；回退使用升级前快照，不能让旧程序直接读取新格式数据库。备份不包含私钥和外部授权，存在密文时须单独保留原内容密钥。OCR/ASR 模型和运行时的安装、升级另见 [中央媒体运行时](ocr-asr-implementation-plan.md)。

## 历史签名更新机制

代码仍保留客户端签名清单下载与安装、中央 `check-update` / `update`、独立更新助手及失败回退。它们要求受内置公钥信任的 manifest 和对应资产；切换仓库不会更换信任根，不能跳过签名、证书或版本校验。当前 DEV 发布不使用该通道。历史验证见 [0.5.1 更新验收](update-validation.md)，当前产物与流程见 [发布说明](releasing.md)。

## 验证边界

下载完成不代表已安装；重新启动后核对实际程序版本、原有配置与待同步数据。Fixture、模拟器、物理设备和真实模型检查分别记录，历史通过不代表本次升级已实测。
