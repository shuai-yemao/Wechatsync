# Power Notes 注册及 AI 连接（preview.7）

此版本保留飞书、OneNote 和本地批量导入，并增加 Power Notes 自建站类型。博客是 GitHub Pages 静态网站，发布目录索引使用 `agent-notes.js`，导入笔记使用 `notes/agent-imports`。它不使用 WordPress/Typecho 的 XML-RPC 接口。

## 注册与使用

在插件设置的「自建站点」中选择「Power Notes · GitHub Pages」，填写站点名称、HTTPS 地址、`owner/repository`、GitHub Token 和分类。连接检查只读取仓库；确认配置后账户可用于本地 Markdown 导入或 MCP 同步。已注册的账户可在设置中更新 Token 或分类，凭据字段不会回填显示旧 Token。

建议使用只授权该仓库的 fine-grained Token，Contents 读写权限。凭据保存到本机 `chrome.storage.local`，它不是加密保险库；请求只发送给固定的 `api.github.com`，拒绝 HTTP 重定向。连接检查会读取仓库权限、默认分支、完整文件树和索引，但不通过试写文件来探测 Token 的能力；实际写入仍可能因为 Token 权限、仓库规则或网络失败而被拒绝。

提供 Markdown 正文即可保留 fenced code block 和网站链接。本地图片需在导入时同时选择，或在 MCP 调用前转换为 base64 data URI。HTML 图片请改用 Markdown 图片语法；直接提供只有 HTML 的正文会明确报错。默认分类为「工具与方法」，可以改为嵌入式、软件工程或思考与随笔。

每次同步生成独立 `codex/wechatsync-*` 草稿分支。一次提交包含笔记、图片和追加后的 `agent-notes.js`；沿用父提交和基础文件树。比较链接用于审查，合并后才由博客现有 CI 发布。插件不会自动合并，不覆盖现有笔记。参考 [GitHub Git trees API](https://docs.github.com/en/rest/git/trees) 和 [Git references API](https://docs.github.com/en/rest/git/refs)。

单篇上限为 1 MiB Markdown、30 张配图、每张 5 MiB、图片 base64 总量 16 MiB。出现已创建草稿链接但结果失败时先检查分支，批量导入不会直接重试该项。

## MCP 与 skill

打开插件的「CLI / MCP 连接」开关，将 Token 与本机服务配置保持一致。此 fork 默认仅监听 `127.0.0.1`，HTTP 转发也校验 Token，不接受网站 Origin，WebSocket 只接受扩展 Origin。Codex 的启动器应把扩展 Token 保存在本机独立配置中，避免写进公开源码或文章。

MCP 提供 `list_platforms`、`check_auth`、`sync_article`、`extract_article` 和 `upload_image_file`。自建站点使用动态 `cms_*` ID；本机注册的 Power Notes ID 为 `cms_powernotes`。使用前先检查该 ID 的授权状态。

`skills/wechatsync/SKILL.md` 是仓库配套的 CLI 工作流，已经补充本 fork 的飞书和 Power Notes 说明。Codex 新会话加载安装的 skill 与新增 MCP 配置。CLI 可直接使用 `wechatsync platforms` 或 `wechatsync auth cms_powernotes`。

若旧后台不能回答消息，可在用户明确要恢复本机 MCP 时打开插件打包的 `mcp-reconnect.html`：它保留已有 Token，恢复本机 9527 地址并调用 Chrome 自身的 `runtime.reload()`。不会申请新权限或改变 GitHub 账户。

## 验证与范围

扩展 82 项测试通过；新增测试覆盖目录索引的纯数据读取、代码/链接/图片保留、重复笔记保护、完整文件树、权限失败、草稿提交、未知写入结果和凭据诊断。生产构建和 MCP TypeScript 检查通过。MCP/CLI 运行产物采用不生成声明文件的 tsup 构建；原有完整 build 的声明生成阶段在此主机未成功。

独立 Chromium 实际验证编译后的 MV3 后台、MCP 开关状态、WebSocket 连接、账户列表、待授权提示、预填配置页和多实例转发。旧单篇导入的编译浏览器回归也通过。浏览器导出中的 DOM 字符解码依赖已固定为同一包的纯数据实现，避免 Service Worker 在模块加载时访问 `document`。

本机 Chrome 已安装版本并注册 Power Notes，真实 MCP 与 CLI 已能读取账户。仓库写入凭据等待用户选择；没有上传文章，也没有修改博客默认分支。真实 GitHub 写入未在本次执行，不能把 Mock API 测试描述为真实发布验证。本机凭据、配置备份和完整浏览器日志不会包含在交付 ZIP 中。
