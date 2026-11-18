# 同系统双机实验

目标是在两台 Mac 或两台 Windows 之间，用同一套键鼠把文件按住拖过相邻屏幕，在目标桌面或文件夹松手完成复制。实验手势代码单独启用，控制台暂不为这两种组合提供入口。

## 验证双向传输

两台电脑需可互通，并安装 Node.js 22+。生成配对材料的机器还需要 OpenSSL。

1. 在第一台电脑从仓库目录运行 `node src/cli.mjs init-pair <全新的私有目录>`。它生成 `first/` 和 `second/`，每端有自己的接收证书、私钥和令牌。保留 `first/`，通过已认证的传输方式把 `second/` 交给第二台。两个目录都可以搬到各自的私有配置目录内，保持目录中的文件相对位置即可。
2. 用现有 SSH 信任关系，从第一台向第二台建立下面的隧道。将 `second-host` 替换为实际 SSH 主机名：

   ```sh
   ssh -N -oExitOnForwardFailure=yes -L127.0.0.1:24818:127.0.0.1:24818 -R127.0.0.1:24817:127.0.0.1:24817 second-host
   ```

3. 两端分别用 `node src/cli.mjs check <本机包>/receiver.local.json` 和 `node src/cli.mjs check <本机包>/peer.local.json` 校验配置，再运行 `node src/cli.mjs serve <本机包>/receiver.local.json`。两端服务均只绑定回环地址。私钥、含令牌的配置和本地包不得提交到仓库。
4. 在任意一端另开终端，运行 `node src/cli.mjs send <本机包>/peer.local.json <文件或文件夹>`。另一台电脑会在自己的 `inbox/incoming-*/` 生成一份已校验的副本。两个方向都试一次；收到文件只证明传输成功。

## 原生手势实验

现有 Deskflow 键鼠共享应先工作。主机指实体键鼠所连的电脑，第二台在其右侧；若走镜像，`primaryEdge`（Windows）或 `macEdge`（Mac）必须与 Deskflow 布局一致。使用隔离的测试配置和没有重要文件的目录，不与日常协同共用服务或暂存目录。

### Windows ↔ Windows

1. 在装有 OpenSSL 的电脑上运行 `node src/cli.mjs init-windows-lab <私有空目录> <主机名> <第二台名>`。把生成的 `primary/` 与 `secondary/` 分别交给对应设备。将 Windows OLE 手势程序放在两个配置旁，文件名为 `edgebridge-gesture-lab-win.exe`。
2. 在独立 Deskflow 源码树依次应用现有适配器、左右布局补丁与 `same-system-ole-experiment.patch`，构建 Windows x64 的 `deskflow-core`。主机用同一个已登录桌面用户运行新版 core 和协调器，将 core 的 `EDGEBRIDGE_ROUTE_SOCKET` 设为私有命名管道 `\\.\pipe\edgebridge-gesture`，与 `primary.local.json` 对应。第二台运行正常的 Deskflow 客户端。
3. 按[双机开发部署](SETUP.md)的 SSH 转发示例转发 24813、24814、24815。两端分别运行 `node src/gesture-lab.mjs --check <本机配置>`。先在第二台运行 `node src/gesture-lab.mjs <secondary.local.json>`，再在主机运行 `node src/gesture-lab.mjs <primary.local.json>`。两端都必须在交互桌面运行。

主机物理鼠标钩子为每次按住分配代次，对合成输入不建立新手势。逻辑松手只在指定源窗口内消耗一次提交令牌。两端 OLE 以主机的真实松手为落地授权。

本轮 Windows 原生验证通过：命名管道双向读写与重连、窗口和令牌拒绝错配及重放、OLE 私有桌面的取消与松手，以及两个协调器用真实 OLE 辅助程序通过 TLS 握手。协调器联调使用模拟路由，没有发送鼠标事件。完整的 Windows Deskflow core 尚未在本轮编译，两台独立 Windows 桌面的原生拖放仍待验收。

### Mac ↔ Mac：第二台 → 主机

1. 生成配对：`node src/cli.mjs init-mac-peer-lab <私有空目录> <主机名> <第二台名>`。将 `primary/` 留在主机，`secondary/` 经已认证通道交付到第二台。主机使用带原有路由补丁的 Deskflow 和普通 Mac 手势 App。
2. 第二台使用当前源码、对应 `nativeIPC`，并加 `EDGE_BRIDGE_PEER_SOURCE=1` 构建 Mac 手势 App。两个 App 各自需要在所在 Mac 被授予辅助功能权限。从主机向第二台建立 SSH 隧道，只保留[部署指南](SETUP.md)中 24813 的本地转发和 24814 的反向转发。
3. 依次启动第二台的 `gesture-lab.mjs <secondary.local.json>` 和它的手势 App，然后启动主机路由、`gesture-lab.mjs <primary.local.json>` 和主机的手势 App。先检查各自日志是否就绪。由于 IPC 启动时会跳过旧日志，协调器先于 App 启动。

第二台只捕获源拖动。AppKit 的注释事件监听器只放行本进程为匹配窗口、当前令牌发出的一次逻辑松手。代次和时间戳沿用主机的观察值，不比较两台机器的单调时钟。**主机 → 第二台仍未开启**：第二台作为接收端还要把 Deskflow 的远端指针和本地 AppKit 按下/松手绑定为同一次拖动。

## 原生拖放的验收边界

| 组合 | 可复用 | 待完成的系统接力 |
| --- | --- | --- |
| Mac ↔ Mac | 第二台到主机的手势接线、AppKit 窗口令牌自检、双向传输 | 实测第二台源拖动；增加主机到第二台的原生接收。 |
| Windows ↔ Windows | Win32 主机路由源码、双端 OLE 手势接线、路由模拟、双向传输 | 编译 Windows Deskflow core，再在两台交互桌面验收。 |

对每种组合，验收要在两台独立桌面上各拖一次小文件并核对落点、源文件保留、真实松手与后续普通点击。另测提前松手、取消和断线，确认没有遗留按住状态。配对和传输测试通过之前不启用手势；通过之后也不把它当作原生拖放验收。
