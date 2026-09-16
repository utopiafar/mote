# Session 与压缩预览验证

2026-09-16，在生成数据与独立临时资料库中验证。

## 实现范围

- Web、Mac、Android 默认按 Session 展示截图。按设备隔离，同应用连续采样合并；应用切换、未知应用身份或超过 5 分钟的间隔分段。先分组再分页，应用 A → B → A 保留三个分组。同时间戳以记录 ID 排序，并按真实成员读取图片，避免混入另一段。
- Session 卡片展示起止观察时间、记录数和图片数，打开后再加载当前页图片和详情。Web、Android 保留 App 相册，Mac 保留全部截图，Web 另保留全部记录筛选。日期和数据保留范围会影响分组；观察范围不能换算为实际连续使用时长。
- Mac、Android 开发者选项新增压缩预览。对生成样张实际缩放并编码 JPEG，展示像素尺寸、文件字节数和比例，支持放大查看。参数先回到设置草稿，保存后应用。
- 已完成的回顾状态展示保留：异步启动、固定执行阶段、实际工具返回计数、刷新恢复、断线重连与失败重试。用户确认旧前端是按钮现象的原因，未继续使用个人资料排查。

## 已执行检查

| 检查 | 结果 |
|---|---|
| 工作区 `npm run typecheck` | 通过；后续 Web 构建、桌面 TypeScript 编译也通过 |
| 工作区 `npm test` | 618 项通过：桌面 205、服务端 256、Web 47、Agent 67、诊断 5、本地推理 13、共享 25 |
| 最后修改后的针对性回归 | 服务端 Session/回顾 11 项、Agent 67 项、桌面实际压缩编码 1 项通过 |
| Web 生产构建 | 通过 |
| Web 真实渲染器 + 临时服务端 | Session 分组、20+11 张分页、全部记录、窄屏布局通过；已有运行状态、导航/刷新/断线恢复、失败重试通过 |
| Mac 真实渲染器 + IPC | 压缩统计、200% 放大、参数回填、Session 首屏不加载图片、30+1 张分页、图片/OCR 详情通过 |
| Android development / developmentAndroidTest APK | 构建通过 |
| Android JVM 测试 | 147 项通过，0 失败/跳过 |
| Android development lint | 0 错误 |
| 专用 API 35 模拟器 | 压缩预览/放大/不自动保存，以及 Session 图片分页、详情与返回共 2 项通过 |
| 开发站点静态页面 | HTTPS 200，入口 HTML 为 `no-store`，公网脚本与本地 Web 构建 SHA-256 一致 |

测试启动需允许临时 loopback 端口。服务端使用仓库的 `tsx --test` 运行器；直接使用 Vitest 无法加载该 Agent 包的 `import.meta.resolve`。桌面 UI 测试关闭窗口后台节流，保证截图和动画帧检查在应用失焦时也能完成。

复现 UI 检查（先构建相关工作区）：

```sh
node_modules/.bin/electron scripts/test-web-sessions-insights.cjs
node_modules/.bin/electron apps/desktop/scripts/ui-smoke.cjs
```

生成界面图保存在 `.mote/session-review-ui/` 和 `apps/desktop/release/`，均不纳入版本控制。Android 图来自生成预览页的 `View.draw(Canvas)`，未调用系统截图或采集接口。

## 实机与真实模型边界

未采集或上传个人截图，未在实体手机上验证，未把客户端安装到用户日常设备或发布新版本。真实模型只执行过无个人数据的连接测试并通过；完整回顾的流程验证使用受控模型响应，不代表真实模型生成质量验证。开发站点已读取到本次构建，桌面和 Android 的客户端更新仍需使用对应新构建。
