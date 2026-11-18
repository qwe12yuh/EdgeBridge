# 交给 Agent 安装 EdgeBridge

如果你是用户：把下面这句话复制给能操作本地终端的 Agent。请让它在 Mac 上开始，并使用你已授权的方式操作 Windows。

```text
请在我的 Mac 和 Windows 上安装并验证 EdgeBridge。按这份指南执行：https://raw.githubusercontent.com/qwe12yuh/EdgeBridge/main/docs/AGENT-INSTALL.md
```

## 给安装 Agent

请按阶段执行并报告结果。以 [双机部署指南](https://github.com/qwe12yuh/EdgeBridge/blob/main/docs/SETUP.md) 为准。安装和启用是两步：先编译并验证，再与用户约定何时切换键鼠服务。

1. **检查环境。** 验证 Mac 在左、Windows 在右、实体键鼠连着 Mac；现有 Deskflow 已能双向切换指针。记录两端实际的 Deskflow 屏幕名、Windows 登录会话和已授权的连接方式。检查 Node.js 22+，以及 Mac 上的 OpenSSL 和 Swift、Windows 上的 .NET Framework 4.x C# 编译器。若无法访问 Windows 或布局不支持，先完成能独立进行的 Mac 检查，并明确剩下的阻塞。
2. **准备源码与构建产物。** 从 [EdgeBridge 源仓库](https://github.com/qwe12yuh/EdgeBridge) 获取含 `init-lab` 的 `main` 源码，在两端使用同一提交并记录 SHA。按部署指南构建原生程序，两端运行 `--self-test`，并运行 `npm test`。在 Mac 上按 [独立 Deskflow 适配器说明](https://github.com/qwe12yuh/EdgeBridge-Deskflow-Adapter/tree/v0.1.0-alpha.1) 校验并应用补丁、构建隔离的 core。Windows 原生构建及最终运行均在 Windows 系统上完成；实际拖放需要用户的交互桌面。
3. **生成并检查配对。** 用实际屏幕名执行 `node src/cli.mjs init-lab <新的私有空目录> <Mac屏幕名> <Windows屏幕名>`。保留 Mac 子目录，将生成的 Windows 子目录经已认证的通道交付到 Windows 本机私有目录；补齐实际的 IPC、路由 socket 和 Windows 辅助程序路径。双端分别运行 `node src/gesture-lab.mjs --check <本端配置文件>`。上传收件目录使用独立的临时暂存区。不要显示、上传或提交配对令牌、私钥及私有配置。
4. **启用双机协同。** 先说明如何停用 EdgeBridge、重启原版 Deskflow，并让用户选择切换时机。保留其原有安装与配置。按部署指南用 SSH 转发回环端口 `24813`、`24814`、`24815`，保留 TLS 固定证书校验。请用户为需要的 Mac 程序授予辅助功能权限。停掉原版 Mac core 后，启动隔离 core 并确认路由 socket 就绪；再依次启动 Windows 协调器（用户交互会话）、Mac 协调器和 Mac 手势 App。保留原版 Windows Deskflow 客户端。不要启用开机自启或开放公共端口。
5. **验收并交付。** 检查键鼠连接、两端握手和辅助程序状态。请用户在 Finder 与 Explorer 间各拖一次小型测试文件，确认目标文件落地、源文件保留、下一次普通点击正常；仅有上传成功或自检通过时，标为「已安装，拖放待实测」。若切换后键鼠失效，停止这次启动的实验进程与隧道，恢复原版 Mac core 并检查 Windows 客户端重新连接。交付时记录所用提交、验证结果及停止和恢复方式。

这是开发者预览。若遇到权限、配对或环境缺失，请给出具体的下一步；无需用户把口令或私钥发到聊天里。详见 [已知问题](https://github.com/qwe12yuh/EdgeBridge/blob/main/docs/KNOWN-ISSUES.md)。
