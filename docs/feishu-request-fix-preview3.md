# preview.3：飞书请求桥接阻断修复（2026-10-06）

用户反馈文档无法发送到飞书。用户 Chrome 的浏览器连接仍无法返回标签页，因此此次没有取得用户的真实账号日志；以下原因通过源码和隔离 Chromium 测试确认，不将这些测试等同于账号上传验收。

## 已复现的阻断

`readSaved` 调用请求函数时不提供表单，旧代码仍将 `undefined` 放入 `chrome.scripting.executeScript` 的 args。真实 Chromium 151 在运行页面函数之前拒绝调用：

```text
Error at property 'args': Error at index 3: Value is unserializable.
```

这会阻断新建文档后的空白状态读取，也阻断粘贴后的保存回读。Chrome 官方要求注入参数可 JSON 序列化：https://developer.chrome.com/docs/extensions/reference/api/scripting 。首版 Mock 没有模拟该 API 的参数校验，遗漏了此问题。

另外，页面函数遇到 HTTP 403 后拒绝 Promise，真实 Chrome 返回的注入结果没有原始失败原因，外层只显示“飞书页面没有返回请求结果”。不能通过这种笼统提示判断登录、CSRF 或接口问题。

## 最终修改

- 没有表单时明确传 null，保持 GET 语义。
- 页面函数捕获失败并返回结构化结果，外层保留 HTTP 状态、API code、网络错误和非 JSON 诊断。
- 创建请求补充请求追踪头；读取两个 CSRF cookie 候选。仅收到明确 HTTP 403 + CSRF 拒绝时尝试第二个候选；网络超时、普通 403 和未知状态不重发创建请求。
- 同步失败标注权限检查、准备正文、选择租户、创建文档、打开文档、连接编辑器、空白状态读取、定位正文、剪贴板、粘贴或保存回验的具体阶段。
- 界面完整显示飞书失败提示，保留已经创建的文档链接。后台 Console 和 feishuLastDiagnostic 保留阶段、原因、版本、时间与是否已经创建文档；日志不包含正文、cookie、租户 URL 或文档 token。

保留已有权限声明、正文清洗、服务端保存验证和避免重复创建逻辑。版本名为 `2.0.9-feishu-local-preview.3`。

## 验证

- 生产请求函数的真实 Chromium + 本机 HTTP 测试：修复前 2 项失败、1 项对照通过；修复后 GET 缺省表单、GET null 表单、HTTP 403 诊断 3/3 通过。使用源码摘要检查浏览器没有读取旧测试脚本。
- 扩展回归 43/43，通过；TypeScript 和生产构建通过；diff check 通过。
- 编译扩展的真实 SYNC_ARTICLE 消息与页面请求桥：普通 403 不重发；CSRF 拒绝只换候选；只接受一次创建成功；编辑器失败保留结果链接；诊断不泄露测试地址/token；完整失败原因在界面可见。外部 HTTP 为测试响应，剪贴板授权和编辑器为 Fake。
- 本地文件预览、代码/图片/链接、缺图阻止、后台来源检查、权限拒绝和本地 ZIP 正文转换再次通过。
- 已有 Browserslist 与重复图标构建警告仍存在，无新增类型错误。

以上没有完成真实飞书租户的剪贴板粘贴、编辑器解析及服务端保存验收。用户当前失败是否还包含登录/CSRF/编辑器协议因素，必须根据修复版的真实阶段提示继续确认。

## 使用与回滚

构建文件更新到原先加载的同一 chrome-extension 目录；旧 ZIP 保留，扩展 ID 不变。在 Chrome 扩展管理页重新加载，确认 preview.3，并重新打开“导入”页。若上次失败已有文档链接，先查看那份文档；选择短测试文档验证新版，避免反复上传原稿。

如仍失败，“飞书同步失败”区域会显示完整阶段与原因。该提示和同步历史都可以直接查看，不必从混杂的平台启动日志中猜测。需要后台诊断时，可在本插件 Service Worker 的 Console 中执行只读命令：

```javascript
chrome.storage.local.get('feishuLastDiagnostic').then(console.log)
```

回滚可使用 preview.2 ZIP 覆盖原目录并重新加载。账号设置与同步历史不随构建覆盖清除。
