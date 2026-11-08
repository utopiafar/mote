# iOS 开发与测试（实验）

iOS 客户端是实验性客户端，不进入首发正式支持矩阵；Central、macOS 与 Android 为正式支持产品。客户端使用原生 SwiftUI 和 Swift 6，最低支持 iOS 18.0。核心逻辑位于 `apps/ios/MoteKit`，分为 `MoteDesign`、`MoteCore`、`MoteCentral`、`MoteStorage` 四个模块；App 与 UI 测试分别位于 `apps/ios/App` 和 `apps/ios/MoteUITests`。

开发版 Bundle ID 为 `dev.mote.ios`，App Group 为 `group.dev.mote`。当前以模拟器验证为主，不包含真机发布配置。

## 环境

- 安装完整 Xcode，并确保路径为 `/Applications/Xcode.app`。
- 安装 XcodeGen，命令为 `xcodegen`。
- 命令前设置 `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`。仅指向 CommandLineTools 时，`xcodebuild` 和 `simctl` 无法完成这些检查。
- 默认 UI 测试目的地为 iPhone 17 模拟器；本机需有与该名称匹配的可用模拟器。

`apps/ios/project.yml` 是工程定义的源文件，生成的 `apps/ios/Mote.xcodeproj` 不提交到 Git。修改工程结构或构建设置后重新运行：

```sh
cd apps/ios
xcodegen generate
```

## 检查命令

从仓库根目录运行完整 iOS 检查：

```sh
apps/ios/scripts/test.sh
```

脚本会设置 `DEVELOPER_DIR`，生成 Xcode 工程，依次执行 MoteKit 的 `swift test` 和模拟器上的 `xcodebuild test`，并禁用本次构建的代码签名。

只运行核心逻辑测试：

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
swift test --package-path apps/ios/MoteKit
swift test --package-path apps/ios/MoteKit --filter MoteKitTests
```

只运行一个 UI 测试类：

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd apps/ios
xcodegen generate
xcodebuild test \
  -project Mote.xcodeproj \
  -scheme Mote \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MoteUITests/MoteUITests \
  CODE_SIGNING_ALLOWED=NO
```

`apps/ios/**` 变更会由根目录的 `npm run check:affected` 选择上述完整 iOS 检查。

## 签名边界

以下项目在模拟器上不需要 Apple 开发者账号或代码签名：

- 模拟器构建、MoteKit 单元测试和 UI 测试。
- 小组件预览。
- 实时活动在模拟器里的展示。

以下项目需要 Apple 开发者账号、有效签名及相应能力配置，不能由当前模拟器检查替代：

- 真机安装，以及 App Group 在真机上的共享容器验证。
- 分享扩展的真机验证。
- 控制中心控件、锁屏控件与操作按钮。
- Siri 和快捷指令的真机触发。
- 后台录音的真机验证。
- TestFlight 构建与分发。
