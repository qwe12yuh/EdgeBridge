> 历史记录：本文描述早期失败原型，不代表当前版本。最新状态见 [VALIDATION.md](VALIDATION.md) 和 [GESTURE-LAB.md](GESTURE-LAB.md)。

# 双机拖放失败分析 — 2026-11-16

## 结论与证据

这次失败主要发生在“已暂存文件 → Windows 原生拖放”之间，同时源端提前结束拖拽、边缘窗口拦截点击放大了问题。三次 Mac → Windows 实验的日志顺序一致：

```text
Mac:      drag-entered(accessibility=true) → outgoing → sending → sent
Windows:  incoming-ready(暂存路径)
Windows:  没有 native-drag-started，也没有 native-drag-ended
```

三个不同的 Windows 暂存目录说明传输进入了接收后的通知阶段；`incoming-ready` 仅说明桥接进程发出了命令，不代表原生程序接受命令。测试源文件仍在，大小为 65 字节。“消失”发生在拖拽图标/会话层面，原文件没有被移动或删除。

最后三次捕获时辅助功能权限已是 `true`。早期确实有授权问题，但不能用它解释这三次的 Windows 原生接续失败。日志没有逐事件时间戳，因此无法从旧日志计算具体延迟。

| 问题 | 已确定的原因 | 修正与验证范围 |
| --- | --- | --- |
| Windows 未接续 | `JavaScriptSerializer` 实际返回 `ArrayList`，旧代码转换成 `object[]` 得到 `null` 后静默忽略命令 | 改为枚举数组并验证元素；Windows 实机无输入自检通过 |
| Windows 左边点不到 | 置顶边缘窗空闲时也参与鼠标命中 | 空闲时使用点击穿透，失效时复位；隐藏窗样式自检通过，真实桌面点击仍待验证 |
| 到边缘拖拽消失 | 源端在进入边缘时已取得路径，但旧代码把发送绑定到 Drop 回调，再通过 30ms 后模拟松手触发它，原系统拖拽因此结束；目的端没有成功开启替代会话 | 路径捕获不需要松手；源端结束旧拖拽与目的端接续仍需明确协议 |
| 按住时难以跨屏 | Deskflow 源码在鼠标键按住时锁定当前电脑；本机 `disableLockToComputer=false`，没有关闭此行为 | 当前没有更改正常使用的 Deskflow 配置；集成测试必须协调跨屏锁定与独立拖拽会话 |
| 可能出现迟到点击 | 先全量 SHA-256 读取、再上传、再盲目模拟一次按下，没有持续的按键会话 | 移除目的端全局鼠标按下注入；只在本机左键仍按住时尝试原生拖放，否则明确失败 |
| 旧完成事件影响新尝试 | 旧版只有一个无编号等待项 | 每次交接 UUID，匹配 `started → ended` 才能确认成功；迟到/重复事件测试通过 |
| 无回执或退出后残留 | 没有启动回执期限，GUI 启动的 Mac 辅助程序不属于 Node 子进程 | 2 秒启动期限、60 秒完成期限、cancel/shutdown 命令；端口占用和退出清理测试通过。Mac GUI 心跳退出尚未实测 |

## 这轮代码优化

- 原生协议验证会话编号、路径数组和命令有效期。旧命令不再在 Mac 辅助程序重新启动时重放。
- 传输成功与原生落点成功分别返回；没有对应启动回执的 `copied=true` 也不接受。
- 原生启动失败、按键已松开、写管道失败、超时、辅助程序退出都有失败结果。超时发送带编号的取消命令。
- Windows 目的端通过隐藏控件调用 `DoDragDrop`；Mac 目的端构造仅供 AppKit 使用的初始事件，均不再向系统发送新的全局鼠标按下。该接续方式仅编译和边界自检通过，尚未实机验收。
- 边缘捕获未得到后续回调也会复位。Mac 空闲时忽略鼠标；Windows 空闲时开启点击穿透。
- Mac GUI 辅助程序通过独立心跳文件检测桥接进程失联，失联时退出。没有把高频心跳追加到命令日志。
- 记录新原生事件的观察时间和交接编号，下一次测试可以准确区分捕获、暂存、启动和落点。

## 为什么还不能称为丝滑跨屏

当前源端在 `draggingEntered` / `DragEnter` 就已经取得文件路径，提前松手并不是读取路径的必要条件。旧实现把发送放在 Drop 回调中，再通过模拟松手触发回调；目的端仍等待文件全部暂存完毕。这会打断按键状态，也使接续速度取决于文件大小。增加延时或重试无法补齐这个交接协议。

Astra 独立审查还指出：Windows 当前在调用 `DoDragDrop` 前就发出 `native-drag-started`，Mac 在 `beginDraggingSession` 返回后上报，也未使用实际开始回调。所以即使收到这些消息，也不能证明目标系统已经接管、目标应用收到 DragEnter 或最后实际生成了文件。UUID 关联能排除迟到事件，仍不能替代这些原生阶段与最终落点的验证。完整推荐路线见 [ASTRA-REVIEW.md](ASTRA-REVIEW.md)。

另外，检查本机 Deskflow 配置与独立下载的上游源码后确认：默认配置下，按住鼠标会阻止跨电脑切换，见 [Deskflow 1.27 Computer.cpp](https://github.com/deskflow/deskflow/blob/v1.27.0/src/lib/deskflow/Computer.cpp#L358) 与 [Server.cpp](https://github.com/deskflow/deskflow/blob/v1.27.0/src/lib/server/Server.cpp#L366)。旧版模拟松手使其可以切换，却也丢失了原来的拖拽。即使关闭锁定，Deskflow 的普通屏幕进入消息也不能当作“接收端已经继承本次按住”的证明。本轮加入的本机按键检查是拒绝迟到操作的保护，仍不能替代发送端持续的手势状态。只读检查过上游实现，没有把其 GPL 代码复制进本项目。

下一步应改为“先传文件描述与拖拽会话 → 目的端立即建立原生拖拽 → 用户松手选定落点 → 按需获取内容并校验”。Mac 使用 `NSFilePromiseProvider`；Windows 使用 `FILEDESCRIPTOR` / `FILECONTENTS` 和流式数据对象。这些平台机制允许拖入尚未完整保存在本机的文件，但跨 Deskflow 的按住/松开同步仍需单独设计和验证。

参考平台文档：[Apple NSFilePromiseProvider](https://developer.apple.com/documentation/appkit/nsfilepromiseprovider)、[Microsoft Shell Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard)、[Microsoft QueryContinueDrag](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.control.querycontinuedrag)。本项目实现独立编写，MIT 许可。

下一次桌面验收必须同时确认：普通点击和跨屏键鼠不受影响；按住跨屏后可落入实际选择的文件夹；提前松手、Esc、断线和重试不会迟到启动拖拽或留下挡鼠标的窗口。现有程序未达到这些条件，开发代理保持停用。
