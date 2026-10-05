# 飞书与本地文档扩展实施计划

用户于 2026-10-05 授权 fork 最新分支并拉取到本地进行需求扩展。采用当前 pure-browser-spec 设计。

目标：原浏览器扩展提供本地 Markdown/HTML 及图片导入、飞书在线文档同步、OneNote 在线页面读取；不依赖本机程序。
基线：upstream/v2，a98e42865387285afcc027c61836488748f3b30f。
工作目录：C:\Users\zhang\Documents\Codex\2026-10-05\w\work\Wechatsync-fork。
分支：codex/feishu-local-import。GitHub fork：https://github.com/shuai-yemao/Wechatsync。

## 分工和文件边界

- 本地导入：src/local-import/*、src/lib/local-document.ts、__tests__/local-document.test.ts、HomeNew.tsx 的入口、vite.config.ts 的页面入口。
- 飞书：src/adapters/feishu.ts、src/lib/feishu/*、adapters/index.ts 注册、manifest 权限与图标。
- OneNote：src/lib/onenote/*、__tests__/onenote.test.ts；导入页对接由本地导入任务完成。
- 集成：background/index.ts 的 extension-only 消息，构建兼容、说明与交付包。

## 执行与验证

- [x] 记录基线：核心 28 项测试通过；扩展基线无测试；扩展构建通过。
- [x] 本地文件准备：Markdown AST/安全 HTML、用户所选目录的路径匹配、代码字符不改变、图片缺失阻止同步；独立扩展页面复用 SyncDialog，发送 SYNC_ARTICLE。
- [x] 飞书浏览器会话实现及 Mock 验证；真实租户验收待完成。
- [x] 飞书可信编辑实现及失败恢复测试；真实剪贴板/编辑器/保存回验待账号联调。
- [x] OneNote Graph 只读委托 OAuth/PKCE 与来源解析实现及 Mock 测试；真实应用注册和账户联调待完成。
- [x] 集成回归：扩展 32 项、核心 28 项通过；构建和 diff check 通过；Chromium 独立 profile 验证页面、权限拒绝、真实本地转换连接和生成 ZIP 内容。
- [ ] 交付：扩展 zip、源码补丁/源码包、安装说明、验证报告，均存当前聊天 outputs；未取得真实账号样例的联网验收单独标为 unverified。

## 接口契约

本地准备输出 {title, markdown, html, warnings, missingImages}；安全预览不执行源 HTML。
提交使用原 {type:'SYNC_ARTICLE', payload:{article:{title,markdown,html,content},platforms,source:'local',syncId}}。
OneNote 页面模块导出 {title,markdown,html,sourceUrl}，由导入页进入相同预览与同步链路。
飞书实现 PlatformAdapter.checkAuth/publish；返回原 SyncResult，失败中保留已创建 postUrl。
新后台消息只能由扩展自身页面调用，不向任意网站暴露 OAuth 或写入入口。

## 可验证成功边界

测试/Fake 与扩展真实浏览器运行分别报告。正文已触发粘贴不等于上传成功；飞书必须重新读取验证。
图片数量、图片远端引用及文本/代码匹配失败时不能返回 success:true。
没有真实 OneNote/飞书账号的结果不得描述为端到端验收通过。
