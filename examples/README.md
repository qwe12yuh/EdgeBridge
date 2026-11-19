# 本地配置模板

这些文件是字段示例，不含可用证书或配对令牌。可在仓库外运行 `node src/cli.mjs init-lab <空目录> [mac名称] [windows名称]` 一键生成完整配对的 `mac/` 与 `windows/` 配置包，或复制以下模板修改本机路径、Deskflow 电脑名称和配对材料后使用。不要把模板直接当作已配好的部署。

- `mac.example.json`：Mac 中央协调器。
- `windows.example.json`：Windows 原生节点。
- `uploadReceiver`：引用接收配置，分别将 Mac / Windows 端口设为 24814 / 24815，`maxBytes` 设为 67108864；`inbox` 须为手势专用暂存目录（会自动定期回收过期 `incoming-*` 批次），不可与 `cli.mjs serve` 收件目录共用。
- `uploadPeer`：引用对应接收端导出的 peer 配置，保持固定证书与令牌，配合 SSH 隧道修改 loopback URL。
- Mac `peerCertificate` 与 `peerToken` 对应 Windows 控制端的证书与口令。它们是独立配置，不要假设已自动发现。
- Mac 协调器可选 `stagingTimeoutMs`：双向暂存等待上限，默认 `4500`，正整数且不超过 `4800`；路由器准备阶段有独立的约 5 秒硬期限，不影响其他阶段超时。

Windows Deskflow 电脑名在 Mac `target` 设置，Mac 电脑名在 `macName` 设置；无需使用开发者的设备名称。
