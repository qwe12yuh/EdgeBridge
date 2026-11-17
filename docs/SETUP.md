# 双机开发部署

当前构建面向开发者，没有一键安装器。先完成 README 的传输层测试，再接入手势；不要同时启动旧 `bridge.mjs`。

## 前置条件

- Mac 与 Windows 可互通，已有正常运行的 Deskflow 键鼠共享配置。
- Node.js 22+；配对初始化需要 OpenSSL。
- Mac：Xcode Command Line Tools（Swift）；原生程序需要用户在系统设置授予辅助功能权限。
- Windows：.NET Framework 4.x C# 编译器。
- 跨屏手势依赖独立 GPL Deskflow 适配器，按其 README 构建。原版安装与配置应保留，原版 core 与实验 core 不同时运行。

本轮验证的布局为 **Mac 在左、Windows 在右，实体键鼠连接 Mac**。目前的边缘原生窗口也是 Mac 右侧与 Windows 左侧；其他布局需要相应修改窗口和路由设置。

## 构建原生程序

macOS，用本地私有目录承载 IPC 和开发 App：

```sh
mkdir -p "$HOME/.edgebridge/native"
EDGE_BRIDGE_IPC="$HOME/.edgebridge/native" \
EDGE_BRIDGE_BUILD_ROOT="$HOME/.edgebridge/apps" \
sh scripts/build-gesture-macos.sh
"$HOME/.edgebridge/apps/EdgeBridgeGestureLab.app/Contents/MacOS/EdgeBridgeGestureLab" --self-test
```

Windows PowerShell：

```powershell
.\scripts\build-gesture-lab-windows.ps1
.\build\edgebridge-gesture-lab-win.exe --self-test
```

可选的 `-Test` 还会运行私有 desktop 上的 OLE 测试，不会替代人工跨屏验收。

## 配对和控制通道

推荐使用 `init-lab` 在仓库外的私有空目录一次性生成配对好的 `mac/` 与 `windows/` 双端证书、私钥、随机口令与配置骨架：

```sh
node src/cli.mjs init-lab "$HOME/.edgebridge/lab" mac-peer windows-peer
```

也可通过 `node src/cli.mjs init <新的空目录>` 单独为每个接收端生成材料。配置要点：

- 私钥留在各自接收端，只通过已认证通道（如 `scp` / `sftp`）将生成的 `windows/` 子目录交付至 Windows 本机私有目录。
- 配置文件内的相对路径均相对于该 JSON 文件所在目录解析；仅需确认 Mac 端 `nativeIPC`、`routeSocket` 与 Windows 端 `nativeHelper` 指向实际构建产物。字段说明见 [examples](../examples/README.md)。
- `source` 配置表示 Mac 中央协调器，`destination` 配置表示 Windows 节点；当前两者都支持双向文件流，不表示只允许单向发送。
- 上传接收/发送配置分别是 `uploadReceiver` 与 `uploadPeer`，手势模式上限 64MiB。**手势模式的 `uploadReceiver.inbox` 必须使用专用暂存目录**（协调器会自动清理已取消手势及超过 30 分钟的历史 `incoming-*` 批次），不要与 `cli.mjs serve` 的长期收件目录混用。
- 所有配置放在仓库之外，文件名用 `*.local.json`，不要提交或公开。

当前部署经过 SSH 隧道连接 loopback：Mac 控制客户端连接 Windows 24813，Windows 上传接收端 24815，Mac 上传接收端 24814。通过你已配置的 SSH 主机别名建立：

```sh
ssh -N \
  -L127.0.0.1:24813:127.0.0.1:24813 \
  -L127.0.0.1:24815:127.0.0.1:24815 \
  -R127.0.0.1:24814:127.0.0.1:24814 \
  -oExitOnForwardFailure=yes your-windows-host
```

隧道内仍进行证书固定校验和配对认证。不要关闭 TLS 校验来排除配置错误。

## 接入路由

外部 core 使用 `EDGEBRIDGE_ROUTE_SOCKET` 指向当前用户私有目录下的 Unix socket。以隔离配置启动它，并沿用已信任的 Deskflow TLS 对端；不要公开复制自己的 TLS 私钥或配置。

本仓的可选开发启动器通过以下变量构建：

```sh
EDGE_BRIDGE_CORE=/private/runtime/bin/deskflow-core \
EDGE_BRIDGE_SETTINGS=/private/runtime/core-settings.ini \
EDGE_BRIDGE_ROUTE_SOCKET=/private/runtime/route.sock \
EDGE_BRIDGE_LOG=/private/runtime/core.log \
sh scripts/build-router-launcher-macos.sh
```

配置好 Windows 节点后，可先用 `--check` 校验双端配置字段、证书有效期、私钥配对关系与配对口令（同时输出证书 SHA-256 指纹供核对）：

```sh
node src/gesture-lab.mjs --check /private/runtime/windows.local.json
node src/gesture-lab.mjs --check /private/runtime/mac.local.json
```

校验通过后，先运行 `node src/gesture-lab.mjs <Windows配置>`，再在 Mac 运行 `node src/gesture-lab.mjs <Mac配置>`，最后启动当前构建的 Mac 手势 App。协调器准备好后再启动 App，避免心跳过期。

源代码中的 `build/`、日志和配对材料不属于发布包。当前发布不提供正式签名二进制；重新构建 ad-hoc App 后，macOS 可能需要重新关联当前构建的已有辅助功能授权。

## 验收和停止

先用小文件双向拖放，验证持续跟随、实际目标、源文件保留和下一次普通点击。文件上传成功不等于原生落地成功。测试重名处理时，也检查目标应用是否正等待用户选择；当前迟到回执问题见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)。

停止时退出协调器和原生程序，再停止隔离 core，恢复原版 Deskflow。不开机自启，不自动注册系统服务；自定义任务的生命周期由部署者管理。
