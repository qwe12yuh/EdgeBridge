# 本地控制台

控制台用于启动或停止**已经部署好**的 EdgeBridge 双机环境。先按[双机部署指南](SETUP.md)编译、配对并运行一次，确认两个方向均能完成文件拖放。控制台运行在 Mac，依赖已有 SSH 授权和 Windows 交互任务。

将下面的 JSON 保存到仓库之外（默认 `~/.edgebridge-lab/dashboard.local.json`），把示例路径替换为你的绝对路径。保留目录中的既有配置；这个 JSON 无需填入口令。

```json
{
  "stateDirectory": "/Users/you/.edgebridge-lab",
  "routerApp": "/absolute/path/EdgeBridgeRouterLab.app",
  "gestureApp": "/absolute/path/EdgeBridgeGestureLab.app",
  "coordinatorScript": "/absolute/path/EdgeBridge/src/gesture-lab.mjs",
  "windowsHost": "windows-peer",
  "windowsCoordinatorPath": "C:\\path\\to\\EdgeBridge\\src\\gesture-lab.mjs",
  "windowsHelperPath": "C:\\path\\to\\edgebridge-gesture-lab-win.exe",
  "port": 24816
}
```

- Mac 运行目录包含 `bin/deskflow-core`、`core-settings.ini` 和 `source.local.json`。路由启动器使用该目录中的 `route.sock`，手势 App 使用 `native/` 作为 IPC 目录。若环回端口不使用部署指南的默认值，此控制台不能直接管理。
- Windows 需要预先设置两个按需运行的计划任务：`Deskflow-KeyboardMouse` 启动原版 Deskflow 客户端，`EdgeBridge-GestureLab-Test` 启动 Windows 的 `gesture-lab.mjs`。都使用已登录的交互会话，并配置为不自动超时退出。任务名称固定，控制台不安装或编辑任务。
- Mac 若正在运行原版 Deskflow 服务器，请先在 Deskflow 停止服务。控制台只管理当前配置识别出的 EdgeBridge 进程，不更改原版配置。

在 Mac 的仓库目录运行：

```sh
npm run dashboard
```

打开 `http://127.0.0.1:24816/`。页面显示双端组件及键鼠链路，提供启动和停止两项操作。停止会关闭实验键鼠共享和文件拖放，请先完成正在进行的手势；关闭网页不会停止协同。网页提示已连通表示进程和连接均已就绪，实际落地仍可用 Finder 与 Explorer 双向试拖确认。

## 左右布局

在「屏幕位置」选择 Mac 在左或在右，点击「应用布局」。运行中切换会短暂重连，请先松开所有鼠标按键，把指针留在 Mac 上。切换失败时控制台会尝试恢复原布局。停止状态下应用布局只会保存，下次启动生效。

要启用「应用布局」，两端须使用支持双向边缘的新版原生程序和协调器，Mac core 须应用独立适配器的 `selectable-screen-layout.patch`。Mac 专用 core 配置的 `[server]` 应设置 `externalConfig=true`，并让 `externalConfigFile` 指向一个只包含这两台屏幕、互为左右邻居的专用配置文件。使用 `layoutServerConfig` 指向同一文件。控制台仅调整该文件的两条横向连接。

升级现有部署时，可以在主 JSON 增加 `layoutProfile`，指向另一份私有 JSON，其中写新版的 `sourceConfig`、`coreBinary`、`coreSettings`、`layoutServerConfig`、`routerApp`、`gestureApp`、`coordinatorScript`、`windowsTask` 和 Windows 两个程序路径。新版应使用独立的暂存目录与计划任务。首次应用会先验证两个新版 Mac 程序的辅助功能权限，通过后才交接；不覆盖原版 Deskflow 配置。

控制台只接受回环地址上的控制请求。无需开放公共端口，也不要将控制台转发给其他设备。
