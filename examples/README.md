# 本地配置模板

这些文件是字段示例，不含可用证书或配对令牌。复制到仓库外，修改本机绝对路径、Deskflow 电脑名称和配对材料后使用。不要把模板直接当作已配好的部署。

- `mac.example.json`：Mac 中央协调器。
- `windows.example.json`：Windows 原生节点。
- `uploadReceiver`：引用 CLI `init` 生成的接收配置，分别将 Mac / Windows 端口改为 24814 / 24815，`maxBytes` 设为 67108864。
- `uploadPeer`：引用对应接收端导出的 peer 配置，保持固定证书与令牌，配合 SSH 隧道修改 loopback URL。
- Mac `peerCertificate` 与 `peerToken` 对应 Windows 控制端的证书与口令。它们是独立配置，不要假设已自动发现。

Windows Deskflow 电脑名在 Mac `target` 设置，Mac 电脑名在 `macName` 设置；无需使用开发者的设备名称。
