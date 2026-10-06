# 飞书与本地导入预览版

本分支在 Wechatsync v2 的浏览器扩展上增加本地 Markdown/HTML 导入、飞书在线文档适配器和 OneNote 来源读取。整个操作链路在浏览器扩展内完成，不需要本机 CLI 或连接组件。

## 安装与本地文档

当前构建版本为 `2.0.9-feishu-local-preview.3`，修复飞书保存回读的脚本参数序列化阻断，并完整显示同步失败阶段与原因。更新同一已加载目录后，在扩展管理页重新加载并重新打开导入页。具体证据见 [飞书请求修复报告](feishu-request-fix-preview3.md)；公告与微博启动修复见 [preview.2 报告](startup-fix-preview2.md)。

1. 将构建扩展 zip 解压到固定目录。
2. 在 Chrome/Edge 的扩展管理页开启开发者模式，点击“加载已解压的扩展程序”，选择直接包含 manifest.json 的目录。
3. 打开插件弹窗，点击“导入”，进入独立标签页。
4. 同时选择 `.md`/`.markdown`/`.html` 文档和图片；有相对路径时优先选择包含它们的整个文件夹。可在下拉框中切换文档。
5. 检查标题、代码、图片和链接的安全预览，选择已登录的平台后同步。

支持 PNG/JPEG/GIF/WebP。文档上限 5 MiB，单图 10 MiB，所选文件合计 50 MiB；较大的内嵌图片还会受浏览器消息传输预算限制，需压缩图片或拆分文档。目录选择不会给扩展任意读取磁盘的权限。图片缺失、路径歧义、越出所选目录、活动 HTML、非网站链接会得到明确处理。源文件不会修改。

远程图片在同步时由目标适配器读取；安全预览只显示内嵌图片，预览中的链接不能导航。原有平台继续使用各自的格式转换和图片上传逻辑，其实际兼容性仍需按平台验证。

## 飞书同步

先打开并登录飞书云文档租户页面，再刷新平台列表。支持公有飞书、Lark 域名；多个租户时保持目标租户为唯一活动的飞书页面。登录检测基于浏览器会话，不需要开放平台应用密钥。

Chrome 不允许把 `debugger` 声明为可选权限，因此调试能力在安装时声明为必需权限。首次点击飞书同步只申请 `clipboardRead`、`clipboardWrite` 两项可选权限；没有完整权限不会创建文档。浏览器可能显示调试提示，调试连接仅作用于本次新建文档标签页，任务结束后释放。权限本身会保留在扩展设置中，用户可通过浏览器管理。`preview.1` 修复了首版错误地把 debugger 放入 optional_permissions 的问题。

同步会创建新 docx，执行原生 HTML 粘贴，等待保存，并从服务端回读正文、代码块、图片资源 token 与链接。**创建成功或 DOM 中出现内容都不会单独算作同步成功。** 请等待结果期间保持新文档页面打开，避免同时编辑或切换剪贴板。

剪贴板只允许当前浏览器 Clipboard API 可读取和恢复的文本、HTML、PNG 格式；若含有其他格式会停止。若新标签页关闭或导航，页面中的剪贴板备份可能无法恢复，结果会报告失败。失败若已创建文档，将展示“检查文档”链接。本地导入页面阻止直接重试这份未完成文档；确认确需另建后再重置。插件不会删除、覆盖或公开分享文档。

飞书编辑器使用浏览器会话和内部网页接口，协议可能变化。当前预览版已经完成代码、Mock 和本地浏览器检查，**尚未使用真实飞书租户完成端到端验收**；首次使用应选择短文，检查代码块、图片、链接及刷新后的内容。本地导入页和插件弹窗是本版推荐的飞书入口；网页内嵌编辑器的旧消息桥不会获得新增写入能力。

## OneNote 来源读取

在“从 OneNote 在线页面读取”中填写具体页面链接和 Microsoft Entra 应用 Client ID，点击“登录并读取预览”。读取的是正文 HTML，而不只是保存一个链接。

需要自行注册公开的单页应用（SPA），配置界面显示的 `https://<扩展ID>.chromiumapp.org/onenote` 重定向地址，并添加 Microsoft Graph **委托** `Notes.Read` 权限。个人/组织账户的可登录范围由应用的受支持账户类型决定。无需 Client Secret；不要创建或填写密钥。扩展路径/ID改变后需重新登记重定向地址。

采用授权码 + PKCE + state 校验。访问令牌仅存于当前浏览器会话存储，正文/预览响应不携带令牌；点击“断开 OneNote 登录”会移除本扩展的令牌缓存。需要重新登录时会重新授权，不存 refresh token。SPA 换取 token 对 Origin/CORS 有要求，实际账户与应用配置尚未联网验收。

支持能在当前账户 `/me/onenote/pages` 元数据中匹配的在线页面链接，以及包含 page-id 的页面深链。桌面本地 `.one`、未同步笔记、整个笔记本链接和未展开的短链接不能读取。共享、其他租户页面可能不在当前账户查询范围；此时明确报错，不会按标题猜另一页。

Graph 受保护的图片会先经只读授权读取，再转为内嵌图片。Microsoft 令牌不会发送给外部图片网站。附件、音视频、墨迹及绘图暂不导入，预览会提示；无法导入的图片会阻止同步。读取成功后使用与本地文档相同的预览、平台选择和上传流程。

参考：[Graph 读取页面](https://learn.microsoft.com/en-us/graph/api/page-get?view=graph-rest-1.0)、[获取内容与资源](https://learn.microsoft.com/en-us/graph/onenote-get-content)、[Microsoft 授权码与 PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)、[Chrome Identity](https://developer.chrome.com/docs/extensions/reference/api/identity)。飞书协议参考了 [LarkSnap](https://github.com/AmbroseX/larksnap) 的接口形态，适配代码独立实现。

## 构建与验证

要求 Node 22、pnpm 10，在仓库根执行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @wechatsync/extension test
pnpm --filter @wechatsync/core exec vitest run
pnpm --filter @wechatsync/extension build
git diff --check
```

扩展位于 `packages/extension/dist`。预览版沿用上游 GPL-3.0 许可证。本地扩展可随时在浏览器中停用或移除；功能在独立分支开发，上游 v2 基线未改动。
