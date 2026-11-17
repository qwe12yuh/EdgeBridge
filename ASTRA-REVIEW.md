# Astra 独立审查：连续跨屏拖放的优化路线

日期：2026-11-16。审查模型：GPT-6 Astra。范围：EdgeBridge 源码、失败日志、既有测试、Deskflow 1.27 源码与平台文档。仅做只读分析，没有启动原生程序、修改设备配置或重复桌面实验。此文由主代理整理 Astra 的审查结论。

## 核心建议

先做 **Mac → Windows 的单文件手势实验**：在 Windows 预置一份固定、已校验的小文件，从 Finder 真实按住源文件，跨屏后停住，自主选择 Explorer 文件夹，再松手。预置文件只能验证手势接续与落点选择，不能算作跨机文件传输成功。

只有这一条链通过，才开始接入大文件的原生虚拟文件。先解决输入所有权，再解耦内容传输，能避免在文件传输、Deskflow 切屏和两个系统拖拽循环之间同时排错。

## 根因：哪些已确定，哪些仍待证明

| 判断 | 证据与限制 |
| --- | --- |
| 三次 Mac 捕获均进入 Windows 暂存，未观察到 Windows 原生拖放启动 | 历史日志。旧日志没有逐事件时间戳，不能计算具体停顿时长。 |
| Windows 数组类型转换错误会丢弃合法命令 | `JavaScriptSerializer` 实际返回 `ArrayList`；旧转换与无输入自检已证实。 |
| 不需要模拟松手才能读取文件路径 | Mac 在 `draggingEntered` 已读取 URL，Windows 在 `DragEnter` 已读取 `CF_HDROP`。旧代码把发送绑定在 Drop 回调，才引入了模拟松手的依赖。 |
| 按住状态没有被可靠交接 | Deskflow 默认检查按键锁屏；`enter` 不重放原有左键按下；之后的松手交给当时的活动电脑。本机配置没有关闭按键锁屏。 |
| 接收端检查本机左键状态不能证明原手势还活着 | 可能拒绝真实持续的手势，也可能把用户之后发起的新按下当成原手势。必须使用从物理按下开始的代数与有序会话。 |
| 当前 started 回执不足以证明接续成功 | Windows 在调用 `DoDragDrop` 前上报；Mac 在 `beginDraggingSession` 返回后上报，尚非实际开始通知。 |

不能据此断言三次失败都是 Deskflow 锁屏造成的，也不能断言换一种事件注入层级就能安全结束 Finder 拖拽。新隐藏窗口的真实点击行为与原生接续均未交互验收。

## 推荐单一路线：Deskflow 路由适配 + 独立 EdgeBridge

给 **隔离测试构建** 的 Deskflow 增加按单次手势工作的输入路由接口，EdgeBridge 独立负责文件协议和系统拖放。普通键鼠仍走原路径，拖拽期间由路由器明确分配事件所有权，避免两个进程同时操纵鼠标。

当前上游的 Core IPC 接收命令只有 `stop`；部分 `sendDragInfo`、`dragInfoReceived` 是空实现。这条路线需要开发接口，不是现成插件。永久关闭 `disableLockToComputer` 会改变普通拖动行为，且不会补齐目的端的按键历史；不建议以此作为完整修复，也不建议重写一套完整 KVM。

### 交接时序

1. **源端 prepare。** 在 `DragEnter` 读取描述并建立 UUID；停在边缘、退回时继续保留原生拖动。只有继续向外移动、目的端就绪、仍是同一次按下时才提交交接。边缘内普通释放不算跨屏成功。
2. **物理输入路由接管本次左键。** 接鼠标的 Mac 为真实按下分配代数，以单调序号记录移动、真实释放和 Esc。即使源文件来自 Windows，物理按下的权威仍在 Mac。状态转移、切屏和按钮分流须在同一有序路由中处理，不能依据日志字符串或一次系统按键查询决定。
3. **受控结束源端拖动。** 第一项可证伪实验是保留只接受 copy 的 EdgeBridge 边缘目标：目的端准备完成、旧会话仍命中该目标时，给原拖动交付一次有标识的本地逻辑释放；等待 `performDragOperation` / `DragDrop` 确认接受并结束。它不能被路由器当成物理松手，也不能被转发到另一台电脑。Finder/Explorer 是否能接受且不回弹，必须实测；若无法限定到存活的旧拖动上下文，就不能向光标下任意应用补发 mouse-up。
4. **本次交接越过按住锁，目的端建立新拖动。** Deskflow 提供真实屏幕进入确认与坐标，继续独占普通指针移动。Windows 实验使用 STA、`OleInitialize`、预置文件的 `CF_HDROP`、`DoDragDrop` 和自定义 `IDropSource`，验证按会话 held 状态维持反馈、在真实松手后结束。迟到消息只能结束旧会话。若必须建立本地初始事件，需限定在仍有效的会话和 EdgeBridge 控制的启动上下文中，并验证没有额外桌面点击或残留按键。
5. **反向独立验证。** Windows 上的原始按下由 Mac 经 Deskflow 转发；返回 Mac 时 `PrimaryClient::mouseDown/Up` 是空实现，日常输入依靠 Mac 本机事件。适配器必须明确返回主屏时真实 HID 事件的放行、消费与交付顺序，不能照抄正向。构造一个 `NSEvent` 再直接调用视图方法是否能与真实后续事件形成有效拖动，尚未证实。

这条路线仍有必须通过实验验证的原生行为，不是架构已经成立的宣告。不能只改变 `CGEventPost` 的 tap 层级就视为解决。

## 优先级与通过条件

| 阶段 | 代码工作 | 通过条件 |
| --- | --- | --- |
| ① 先观测 | 在路由器和两端原生程序记录代数、序号、来源、活动屏幕、源端接受、目的端进入目标和真实释放；UUID 从源端 prepare 贯穿到落点 | 能分清真实按下、源端逻辑释放和真实释放。跨机按序号关联，本机延迟用单调时钟计算。 |
| ② 正向预置文件实验 | 绕过 hash/upload/commit；Windows 增加 `IDropSourceNotify::DragEnterTarget` 和 `GiveFeedback` 观测 | 一次按住，跨屏停住，从文件夹 A 改选 B 后松手；只有 B 出现预期文件，源文件保留，无二次点击。回执和控制台日志不能替代结果。 |
| ③ 故障恢复 | 去除固定 30ms 松手；补上退离边缘撤销、迟到隔离、失联回收与隔离拖动辅助进程的退出机制 | 越界前松手、源端接受后目标未开始时松手、Esc、静止时断线、辅助程序退出，都不能迟到启动、误点击、卡键或挡住边缘。故障后的首次普通点击也须正常。 |
| ④ 反向预置实验 | 单独实现 Mac primary 的 HID 路由和 AppKit 发起/结束顺序 | Windows → Mac 通过相同的连续手势、改选目录和故障恢复门槛。 |
| ⑤ 双向真实内容与大文件 | 拆分描述与内容。Mac 每文件一个 `NSFilePromiseProvider`；Windows `FILEGROUPDESCRIPTORW` + 按 `lindex` 请求的 `FILECONTENTS` / `IStream` | 首次反馈不等待全量读盘/上传；分别记录落点接受、内容交付、校验完成；真实目录中的文件名、大小、哈希正确，另测拒收、重名和断线。 |

系统可能提前请求内容或异步消费，不能假定所有数据请求都在用户松手之后。

## 当前修复仍遗漏的风险

- 两端 `handing=true` 后退出边缘，不会立即撤销定时松手；光标已经退回本机时仍可能被结束拖动。
- Windows 只在 `QueryContinueDrag` 中读取 `cancelled`，但该回调由键鼠状态变化驱动。只改内存标记，不能保证用户不动鼠标时立即结束 OLE。
- Mac 的 IPC 与心跳依赖普通 run-loop timer，须验证 AppKit 拖动追踪期间仍能处理取消。现有纯解析自检没有验证这一点。
- Windows 的 `native-drag-started` 不是目标接管证明；`IDropSourceNotify` 能证明进入潜在目标窗口，但不能证明选中了哪个目录或内容已落地。Mac 应在 `draggingSession(_:willBeginAt:)` 观测实际开始。
- UUID、2 秒/60 秒超时和本机按钮检查是保护措施，不能补齐手势所有权，也不能代替跨屏协议。
- 现有 20 项 Node 测试与原生自检不覆盖上述交互。预置文件实验、完整复制和连续跨屏应分别报告结果。

## MIT 边界与运行环境

修改的 Deskflow 适配代码宜在独立目录或仓库维护，保留上游许可和声明；分发其修改版二进制须满足所适用的对应源码要求。EdgeBridge 的协议、原生辅助程序和窄 IPC 继续独立编写。进程分离有助于维护边界，但 IPC 本身并不自动给出整体分发的许可结论。

实验使用独立构建，不覆盖目前正常的 Deskflow。此次审查不需要使用者再做重复失败测试；真正的交互验证应等观测与隔离机制就绪后，再用接在 Mac 的鼠标完成单次按住、跨屏改选、松手和故障后的首次点击。

## 平台依据

- [Microsoft DoDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-dodragdrop)
- [Microsoft IDropSource::QueryContinueDrag](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nf-oleidl-idropsource-querycontinuedrag)
- [Microsoft IDropSourceNotify](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nn-oleidl-idropsourcenotify)
- [Microsoft Shell Data Transfer](https://learn.microsoft.com/en-us/windows/win32/shell/datascenarios)
- [Apple beginDraggingSession](https://developer.apple.com/documentation/appkit/nsview/begindraggingsession%28with%3Aevent%3Asource%3A%29)
- [Apple NSFilePromiseProvider](https://developer.apple.com/documentation/appkit/nsfilepromiseprovider)
