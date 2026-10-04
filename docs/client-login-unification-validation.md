# 统一客户端登录验证记录

日期：2026-10-04。验证使用生成笔记、文件、会话、授权及隔离数据目录；没有采集个人内容或个人截图，没有调用真实模型。

## 全仓检查

`VITEST_MAX_WORKERS=1 npm run check:local` 最终退出码为 0，包括 6031 条双语消息检查、共享库构建、全工作区及脚本类型检查和测试。

| 测试范围 | 最终结果 |
| --- | --- |
| Mac/桌面 | 391 通过，52 个测试文件 |
| 中央服务 | 1032 通过，1 项可选测试跳过 |
| Web | 203 通过 |
| Agent | 213 通过，1 项可选测试跳过 |
| 诊断、本地推理、共享库 | 5、13、90 通过 |
| 发布与运行脚本、CLI | 39、4 通过，中央 runner 压力回归通过 |

跳过项是显式 opt-in 的 macOS 文件沙箱与已安装 Codex 集成测试，未计为通过。最初运行遇到磁盘不足及大量持久队列写入超过旧的 30 秒测试期限；最终运行释放本次创建的模拟器空间、限制测试并发，并为该持久写入用例设置 120 秒期限，所有原有断言保留。失败运行没有计入通过结果。

## 构建与端到端验证

| 验证 | 结果与范围 |
| --- | --- |
| Mac 构建 | TypeScript、界面 bundle、Swift helper/updater、固定版本本地推理构建通过 |
| Web 构建 | 生产 bundle 构建通过 |
| Android 构建 | development APK、测试 APK 与 JNI 本地库构建通过 |
| Android JVM | 246 通过，54 个测试套件，无失败、错误或跳过 |
| Android 原生模拟器 | `NativeCentralInstrumentedTest` 最终 10 通过；其中一项遍历全部 26 个中央页面 |
| Mac 原生 IPC + 真实中央 | `unified-login-smoke.cjs` 通过；采集保持停止，Chrome opener 被测试桩接管 |
| Mac 配对与同步 + 真实中央 | `connection-server-smoke.cjs` 通过；生成文件与笔记、撤销保留队列、同节点重新授权 |
| 浏览器 + 真实中央 | `test-web-login.cjs` 通过；Electron 浏览器、生产页面及隔离中央进程 |

Android 使用本次专门创建的 API 35 arm64 模拟器 `emulator-5582`，中央服务来自 `scripts/android-central-fixture.ts`，答案由注入的确定性 fixture agent 返回。没有访问连接到本机的物理手机。模拟器内生成的画面不是个人截图，也没有进行真机视觉验收。

## 回归矩阵

- 权限：根 Token、新 owner 客户端和历史 collector 客户端拥有相同的中央权限；匿名和 MCP 凭据仍不能批准或取得完整登录。管理、跨设备读取、删除、导入导出及连接器均包含在断言中。
- Mac：已有连接恢复后隐藏两个 Token 入口，直接查询与恢复运行，读取中央截图列表、导出，从客户端打开浏览器免重复登录，共享退出、同节点重新登录和远端撤销。
- Android：完整原生导航、设置保存、邀请生成、问答与草稿的 Activity 重建恢复、返回本机再恢复回答、配对后直接进入中央、统一退出、过期、旧响应隔离和旧管理会话迁移。
- 后台：过期与显式退出阻止同步；本次会话不能跨进程恢复；外部连接器的授权失败不会错误清除节点登录。
- 待同步资料：Mac 本次会话重启后保留来源检查点，同节点重新授权保留确切待传版本；端点规范化不会丢失绑定，切换节点不会继承旧绑定。
- 浏览器：配对凭据直接登录所有页面，原生授权确认、一次性票据交换、重放拒绝、保留引用定位，已打开页面的 hash 跳转也能接续登录；退出与迟到响应不会恢复旧凭据。
- 生命周期：服务端有效期、浏览器本地期限与原生授权期限共同生效；浏览器修改期限或持久存储失败不能延长原生授权。
- 授权交换：60 秒票据、10 分钟请求、单次交换、verifier 校验、并发批准只生成一份授权、轮询重试与确认、撤销父凭据或批准失败后的撤销、容量及频率限制。
- 存储与传输：服务端只保存凭据哈希，URL 不含长期 Token，原生请求拒绝重定向，交换响应大小受限；Mac 放弃的迟到授权被撤销，不残留有效连接。

## 重现入口

先构建共享库及中央、Web 和桌面。运行下列 fixture 时使用隔离节点，不连接个人资料库。

```sh
VITEST_MAX_WORKERS=1 npm run check:local
npm run build -w @mote/desktop
npm run build -w @mote/web
node_modules/.bin/electron apps/desktop/scripts/connection-server-smoke.cjs
node_modules/.bin/electron scripts/test-web-login.cjs
```

原生 Mac 登录与 Android 原生测试共同使用生成中央 fixture：

```sh
node --import tsx scripts/android-central-fixture.ts
node_modules/.bin/electron apps/desktop/scripts/unified-login-smoke.cjs
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
  ANDROID_HOME='/Users/utopiafar/Library/Android/sdk' \
  apps/android/gradlew -p apps/android -Pmote.testBuildType=development \
  --max-workers=2 testDevelopmentUnitTest assembleDevelopment assembleDevelopmentAndroidTest
```

在专门的生成数据模拟器上安装 development 和测试 APK、反向转发端口 47883，再运行：

```sh
adb -s emulator-5582 shell am instrument -w -e nativeCentralFixture true \
  -e class dev.mote.collector.NativeCentralInstrumentedTest \
  dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner
```

## 未执行的验证

未在物理 Android 设备上验证扫码、系统浏览器 Intent、采集权限或后台省电行为；Mac 外部 Chrome 是调用桩，实际页面行为通过 Electron 浏览器验证。未执行真实模型、真实外部 OAuth、公网/TLS 部署、签名安装包或应用商店发布验证。生成回答验证登录与任务生命周期，不代表模型回答质量。
