# 0.3.1 服务端配置与 Tunnel 验证

本轮范围为中央节点、管理界面和部署工具；Mac / Android 采集 App 继续使用 0.3.0。以下测试输入均为合成资料和合成凭据。

## 本机验证

- 工作区测试共 172 项：桌面 63、中央 51、前端 13、Agent 25、诊断 5、本地推理 13、共享配置 2。中央配置测试包含鉴权、只读、生效值、字段来源、URL 清理、密钥只返回布尔、路径不进入支持包以及代理共用 IP 时的限流隔离。
- TypeScript 类型检查、中央与 Web 构建通过。
- `test:profiles` 使用真实临时 Node 进程验证环境隔离、令牌、加密图片、离线备份、空目录恢复、版本切换和回退、PID 保护，以及 0.1 MiB 最小日志配置的实际轮转。
- `test:e2e` 验证合成 Mac/Android 图片与随手记，经实际中央、官方 Harness 工具循环和本地 fixture 模型完成归档、证据、图片与导入导出往返。
- `test:tunnel` 两轮独立执行通过：私有文件导入、权限与符号链接、公开 URL 变更保护、Docker context 优先级、原生 connector 单实例、关闭、wrapper 意外退出后孤儿回收、child 意外终止、配置丢失停机、单次优雅停止、残留停止标记恢复，以及无关 PID 保护。
- 实际 Electron 渲染器连接隔离中央，验证「服务端配置」路径和密钥状态、刷新、桌面与手机布局，再测试请求编号筛选和诊断包下载；导出的支持包没有配置路径、合成私密文本或凭据。

早期失败发现了旧测试依赖 dotenv 引号格式、URL fragment fixture 未加引号以及匿名限流应使用可进入限流器的公开 health 路由，均已修正并复测。运行器的日志容量范围与公开配置参考统一为 0.1–8 MiB。

## 官方 connector 二进制

实际下载并核对 [cloudflared 2026.9.1 官方 release](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1) 的 macOS arm64 包：19,217,478 字节，SHA-256 为 `c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe`，与官方 asset digest 一致。

`--version` 与完整运行参数的 help 检查通过。在 macOS 禁止网络的沙盒中使用合成无效 token，实际二进制正确报告 token 无效；没有未知参数错误或外部连接。此项证明选定版本和参数可运行，不证明 Cloudflare 路由已打通。

## 容器验证

Linux CI 执行既有镜像全链路、Compose 环境与卷隔离、备份恢复、镜像 ID 回退，以及新的容器配置 API 断言。另通过 `test:tunnel:container` 使用真实固定 cloudflared 镜像、真实 Compose 0600 file secret 和 `network_mode: none` 验证凭据可读与无效凭据拒绝，再用单独的带标签容器测试精确停止、孤儿清理、缺失 token 的恢复操作和轮换。

本机没有 Docker；源码 `a674dba` 的 [Linux CI](https://github.com/utopiafar/mote/actions/runs/34770347623) 已全部通过，包含工作区测试、原生部署与 Tunnel 专项测试、真实 Docker 镜像和 Compose 凭据权限、备份恢复及回退。原生节点现在不再把本机数据路径误声明为容器挂载点。

## 当前本机节点与边界

本机 legacy 中央经过停机备份后更新为 0.3.1，继续使用原 data 目录和访问令牌；升级前后均为 0 条记录、0 个图片对象。补建了权限 0600、被 Git 忽略的完整默认配置文件，配置接口已实际可用。

没有用户 Cloudflare token、DNS 路由或公网连通性实测；也未安装 launchd job、测试真实 NAS、采集个人屏幕或调用真实模型。真实 K90 设备与外部模型评估不属于本轮部署测试结果。
