# Power Notes 注册与 AI 调用

范围：在原浏览器扩展中新增 Power Notes 自建站类型，注册 `shuai-yemao/power-notes`，保留飞书及批量导入；启用扩展 MCP，配置 Codex 与 CLI、安装仓库 skill。博客公开地址为 `https://shuai-yemao.github.io/power-notes/`，Markdown 导入目录为 `notes/agent-imports`，目录索引为 `agent-notes.js`。

可选接入是调用博客现有本地 MCP，或让浏览器直接调用 GitHub API。采用后者使上传在扩展内完成，不要求博客服务器或本机导入组件。同步生成独立 `codex/wechatsync-*` 草稿分支及比较链接，用户审查后再合并；注册时仅检查连接，不上传文章或改动博客。

凭据由用户选择复用 gh 登录或单仓库 Token。只发送到固定 GitHub API 域名，禁止重定向；不把凭据写入公开源码、日志或交付包。浏览器账户存储沿用 CMS 凭据槽，连接状态如实反映读取与写入权限。

实施顺序：安装扩展与 skill；打开 MCP 并配置本机回环桥接；实现 Power Notes Markdown/配图/索引打包与 GitHub 草稿写入；接入 CMS 设置、单篇、编辑器及 MCP 共用同步入口；运行测试、构建和浏览器连接验证；注册博客、回读配置、记录证据并交付。

验收：MCP 已连接且真实只读调用成功；CMS 列表与 MCP 列表显示博客；Markdown、代码和网站链接保留，本地图片转为仓库附件；草稿提交包含 Markdown、配图与合并后的索引，禁止更新默认分支、覆盖现有笔记或静默重复创建。未知写入结果返回明确错误和检查地址。

本次不发布文章、不修改 power-notes 默认分支。真实写入流程由 Mock GitHub API 回归验证，凭据和仓库连接采用实际只读 API 验证。撤回方式：关闭 MCP、删除 Codex 对应服务器配置，或从插件移除 CMS 账户；旧 preview.6 安装包保留。
