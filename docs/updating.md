# 更新与回退

Central、macOS、Android独立更新。Desktop/Android Dev从对应Dev Pre-release下载ZIP/APK；Central Dev使用Actions Artifact。Beta/正式版下载对应组件Prod附件。当前不发布签名更新清单或GHCR镜像，具体产物见[发布](releasing.md)。

## 格式与资料

MVP维护一个当前格式：Central epoch 7，Mac/Android本机格式4；当前wire 1、Ingress 2、便携归档v2各自独立。不兼容时保留旧数据并拒绝打开，不自动转换、清空或卸载。未来长期使用需要保留资料的升级路径，见[开发入口](development.zh-CN.md#格式与升级的阶段)。

更新前保留完整一致性备份和单独的私有配置/密钥。普通HTTP资料导出不替代全库备份。旧格式使用匹配的程序和原目录；不要让新版本直接接管不兼容的旧库。

历史发布中的旧权限别名、旧epoch、旧媒体引擎和旧更新通道不自动延续到当前版本。新默认/重建不补授历史模型权限；重新组织和收费语义重做分别判断。先升级提供新协议的Central，再使用依赖该协议的新客户端，不能靠丢弃待传资料绕过不兼容。

## Mac与Android

Mac按构建身份和架构下载ZIP，退出目标App后替换应用包，保留包外资料目录。Dev与Prod分开，精确dev运行profile使用文件凭据，Prod保留系统保护。覆盖更新可保留同一当前格式的配置和队列。

Android覆盖同一包名需相同签名证书及递增的versionCode；Dev、Prod、Test身份独立。更新可能中断投屏，恢复遵守系统权限和后台规则。不能用卸载绕过签名或版本冲突。

## Central

下载central组件源码包或检出对应标签，在独立目录构建：

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
```

需要连接器运行时时再运行`npm run connectors:prepare`。CLI管理的同代profile沿用原home、YAML、数据目录/卷与密钥：

```sh
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --release /srv/mote/releases/next
# 需要恢复升级前资料时：
node scripts/mote.mjs rollback --profile prod --home /srv/mote/profiles --restore-data
```

CLI停止目标环境并创建一致性备份后切换；Docker先构建镜像，再用`upgrade --image IMAGE`。非CLI托管进程由其管理器停止和备份。配置升级不重置数据库，旧env/JSON配置需明确准备YAML。直接启动由`MOTE_CONFIG_FILE`或当前目录YAML选择配置，普通环境变量不覆盖。

同代回退恢复升级前快照，并另存新增资料。跨代回退恢复完整旧目录和匹配程序，不能让旧程序读新格式。备份不包含私钥与外部授权，密文资料需单独保留内容密钥。媒体运行时和模型单独管理，见[媒体配置](media-setup.md)。完整操作见[部署与回退](deployment.md#升级与回退)。

下载完成不等于已安装；启动后核对程序版本、有效配置和待同步资料。验证按实际范围选择，历史构建或设备结果不冒充本次升级证据。
