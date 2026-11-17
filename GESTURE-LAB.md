# 双向原生拖放实验

目标是一次真实按下、跨屏接续、自由选择目标和真实松手。实验与旧 `bridge.mjs` 分开，不能同时运行旧边缘辅助程序。

## 当前结果

2026-11-16–17：

- Mac → Windows 固定样本已两次经人工跨屏落地，桌面副本 SHA-256 与源文件相同，用户确认普通点击正常。此阶段使用预置内容，只证明手势。
- 随后移除固定样本限制，接入带会话上下文的真实 HTTPS 文件暂存。双向中文文件上传探针通过。
- Windows → Mac 普通 TXT 已人工拖入 Finder 目标文件夹，副本 48 字节、SHA-256 为 `fd9f00b0423564c551542657e9df549995ad9d793d9a7aa76f0cb56731762f7f`。
- 用户反馈反向不流畅：一次松手后未正常结束，下一次约晚 1.1 秒结束；暂存阶段仅 12–31ms。不能把这次落地称为流畅度通过。
- App 内投递的启动事件已能触发 `mouseDown`，TXT 一次成功，真实松手到结束约 267ms；但 PPTX 和 DOC 多次失败。失败时内容已暂存、原生循环已开始，底层有 100–256 次真实拖动，AppKit 移动回调仍为零。因此不把 TXT 成功视为系统拖放跟踪已稳定。
- 2026-11-17，受控系统按下版本的 Windows → Mac PPTX 实测通过：原生鼠标按住状态为 1，松手前持续移动，共 68 次 AppKit 移动回调；真实松手后约 33ms 原生 copy 结束。用户确认“很丝滑，可以了”。实际文件为 202,615 字节。
- 用户随后确认普通 PPT 从 Mac 回拖 Windows 也成功。Windows 原生返回 DROP+COPY，但较晚收到结束回执，2 秒 finish 超时又写入 cancelled：这是尚未修正的回执/结果时序问题，不能把该条 cancelled 日志当作文件复制失败。重名提示是否出现未确认。
- 本轮普通 PPT 双向拖放通过，其他文件/目录与异常路径不随之视为通过。当前保留手动运行版本，已取消 Windows 测试任务的 30 分钟自动停止时限，不添加开机触发器。

## 组成与协议

`SourceGesture` 将 UUID、物理 generation、递增 route seq 与源端接受令牌绑定。主要顺序：prepare → 暂存并校验实际内容 → native prepared → route ready → 继续外移 commit → source accepted → route entered → destination activate → 真实 release → native ended → finish。

`realFiles=true` 时，本轮选择的路径仅在源端读取；文件经固定证书 TLS、配对口令、路径和 SHA-256 校验后进入目的端的独立私有目录，再以目的端本地路径准备原生拖放。offer 和 commit 都复核当前手势上下文。取消立即中止传输，旧会话不能延迟启动原生拖放。保留固定 fixture 模式供单独验证手势，二者的验收结论分开。

Mac `GestureLab.swift` 包含右边缘源捕获和反向 AppKit 接收端。边缘只在当前物理候选租约内接收拖动；普通点击穿透。源捕获只有收到本次 commit 才发一次标记逻辑松手。反向启动先创建当前指针下的专用小窗口，再申请绑定 PID、窗口、generation、300ms 截止时间与随机 nonce 的一次系统按下许可。隔离 core 在 HID 入口及最终 annotated tap 检查事件和实际目标；helper 在自身实际 `mouseDown` 中复核标记后启动 AppKit。许可迟到、重放或窗口不符均拒绝。事件源显式允许真实硬件移动，取消/退出仍保留真实松手的平衡责任；不补造模拟移动或自动成功。

Windows `GestureLab.cs` 使用 STA OLE、公开 COM `IDropSource` / `IDropSourceNotify` 和左边缘源捕获。接收端只向自身隐藏 HWND 投递唤醒消息，不移动光标。源端只有在本次 commit token、目标窗口和候选租约匹配后才完成一次本地逻辑松手。

独立 GPL 路由适配器持有物理按下 generation，协调切屏和真实释放。反向 native end 需与同代真实 HID up 的单调时钟匹配。原始 Quartz timestamp 在本机不能直接当纳秒使用；新版在 HID 入口用 `CLOCK_UPTIME_RAW` 取样。GPL 补丁和二进制不进入 MIT 源码包。

## 配置与运行

配对材料放在私有运行目录，不能提交 Git。Mac 中央配置需要：

- `role=source`、`realFiles=true`、`macName`、`target`、`nativeIPC`、`routeSocket`；
- 控制通道 `peerHost`、`peerPort`、`peerCertificate`、`peerToken`；
- `uploadReceiver` 和 `uploadPeer`，分别指向接收/发送 HTTPS 配置。

Windows 配置需要 `role=destination`、`realFiles=true`、`nativeHelper`、控制通道 `certificate` / `key` / `token` / `bind` / `port`，及 `uploadReceiver` / `uploadPeer`。

当前两端只监听 loopback，通过已认证 SSH 隧道连接，并保持 TLS 固定证书校验。手势实验暂存上限 64MiB；必须完整暂存后才能切屏，大文件虚拟流和早松手文件承诺尚未实现。所有操作为复制，源文件不删除。

Mac 构建示例：

```sh
EDGE_BRIDGE_IPC=/private/runtime/native EDGE_BRIDGE_BUILD_ROOT=/private/runtime/apps sh scripts/build-gesture-macos.sh
```

在私有目录构建可避免同步文件夹反复添加 Finder 元数据而干扰临时签名。通过系统设置为当前开发构建配置已有授权；这些程序尚无正式发布签名。

隔离 core 与工作目录放在专用运行目录，启动器使用隔离的 XDG/QSettings 配置。普通 Deskflow 与实验 core 必须互斥；实验结束恢复原版。无开机自启或永久防火墙规则。

## 验收边界

Node 测试 50 项通过；Swift 自检与构建通过；Windows 编译、UTF-8/COM/源端状态自检及四项私有 desktop OLE 实验通过；GPL 路由测试 7 项通过。自动测试不能代替以下人工验收：

1. 双向普通文件连续跨屏，按住改选目标后仅在最终落点出现副本，源文件保留且哈希相符。
2. 松手前图标持续跟随，松手后及时结束，无需额外单击；下一次点击与键盘正常。
3. 退离边缘、提前释放、Esc、静止断线、辅助进程退出均能恢复。
4. 快速边移动边释放单独验收；停住再松手通过不能等同于快甩通过。

`drag-loop-running`、目标窗口观察、原生接受、物理释放和实际文件校验分别记录。Mac 的 window-under-cursor 仅说明光标位置，不是 Finder 接收回执。
