# 0.0.9 登录、页面职责与配对验证

本轮修复将中央网页的管理登录与采集客户端的设备配对分开。此前未登录导航只修改页面状态却继续显示同一欢迎页；初始化把状态、设备、活动、记录和回顾串成一次整体加载，任意请求失败都会妨碍独立页面显示。

## 已执行

- 全工作区类型检查及 `npm test` 通过；Mac 190 项单元测试通过。
- `scripts/test-web-login.cjs`：真实隔离中央服务与 Electron 浏览器，覆盖未登录导航、错误令牌、设备凭据拒绝、登录后进入目标页、状态及回顾同时失败时仍可进入资料库和设备、登录过期清除资料、退出登录及恢复会话权限重验；生成桌面和手机尺寸的登录截图；并将同一网页装入实际 Mac 中央窗口，验证原生管理权限与退出后关闭窗口、停止网络授权。
- `scripts/test-web-navigation.cjs`：管理页面、模型配置、草稿、同步状态和移动布局回归通过。
- `scripts/test-web-connections.cjs`：网页生成二维码、JSON 下载、一次领取、模拟 Android 协议写入合成笔记和心跳、禁止管理接口、撤销连接、重新授权已有设备及真实 MCP SDK 只读调用通过。
- Mac `connection-server-smoke.cjs`：实际客户端配对代码与临时中央服务，验证离线队列确认、来源同步、撤销后保留队列和原设备重新授权。
- Mac `connection-smoke.cjs`：真实 App renderer / preload / IPC、原生 Vision 解码生成二维码、邀请预览、配对失败保留配置、权限隔离及待同步资料禁止切换节点，通过。
- Mac `offline-sync-smoke.cjs`：本机离线笔记与来源、首次绑定、手动同步、SQLite 确认和队列排空，通过。
- Mac `central-smoke.cjs`：原生窗口的同源授权注入、跨站阻断、草稿隔离和关闭窗口后禁网，通过。
- Android development APK、instrumentation APK 构建通过，89 项 JVM 测试通过。

所有联调使用生成图片、合成文本、独立令牌和临时资料目录；未开启真实屏幕采集，未读取真实 Keychain 或调用真实模型。

## 限制

没有连接 Android 物理设备。专用 API 35 模拟器因宿主可用磁盘约 5 GiB、系统镜像所需约 7.2 GiB 而无法创建 userdata 分区；Android instrumentation 没有运行，不将其构建成功当作执行通过。手机摄像头实际扫码、Android 系统后台和个人屏幕采集仍需真机验收。

此前部署的 DeepSeek 真实模型工具调用测试超时；本轮登录与配对修复未声称解决或验证模型响应质量。
