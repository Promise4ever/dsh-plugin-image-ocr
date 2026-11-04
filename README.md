# dsh-plugin-image-ocr

给 DeepSeek Harness (DSH) 增加 `read_image_text` 工具。当模型看不清图片中的文字、数字、公式或表格时，调用 PaddleOCR-VL-1.6 取得 Markdown，再据此回答。

纯 Node.js，直连百度 aistudio REST；不需要 PaddleOCR MCP、Python 或本地模型。删除 MCP 配置不会影响本插件。

## 安装

在 DSH「插件」页的安装输入框粘贴这个 **GitHub Release 安装包网址**：

```text
https://github.com/Promise4ever/dsh-plugin-image-ocr/releases/download/v0.2.0/dsh-plugin-image-ocr-0.2.0.tgz
```

完成安装后点击 **立即启用**。若 DSH 提示需要重启，请完整退出并重新打开 DSH；仅刷新浏览器不能替代宿主重启。

也支持输入仓库网址（仓库内已包含运行用 JavaScript，无需构建）：

```text
https://github.com/Promise4ever/dsh-plugin-image-ocr
```

固定版本的 Git 形式：`github:Promise4ever/dsh-plugin-image-ocr#v0.2.0`。不要使用 GitHub 的 `/tree/…`、`/releases/tag/…` 网页、源码 ZIP 或带查询参数的安装包地址。

已运行中的 profile 若由终端管理，也可安装到实际使用的 profile，例如：

```sh
dsh plugin --profile tauri add 'https://github.com/Promise4ever/dsh-plugin-image-ocr/releases/download/v0.2.0/dsh-plugin-image-ocr-0.2.0.tgz'
```

将 `tauri` 换为实际 profile；不要盲目安装进另一个 `web` profile。全局 CLI 不接受 Desktop carrier 专用的 `desktop` profile，Desktop 用户请用应用内安装入口。

## 本地凭据

凭据仅从本机读取，不随插件分发，不要粘贴到聊天或提交到 GitHub。查找顺序：

1. 插件配置 `token`（不推荐明文写进可同步配置）。
2. 非空环境变量 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`、`AISTUDIO_ACCESS_TOKEN`、`PADDLEOCR_AISTUDIO_TOKEN`。
3. `$DSH_HOME/ocr-token.txt`；未设置 `DSH_HOME` 时为 `~/.dsh/ocr-token.txt`。文件内容为一行有效 aistudio 凭据。

不再扫描或依赖 MCP 配置。设置环境变量后需重新启动宿主；凭据文件在调用时读取。可通过管理员配置 `tokenFile` 指向其他绝对路径。文件以本机权限保护，勿放进公共目录；POSIX 上可设为 `0600`，Windows 上需检查 NTFS ACL，POSIX mode 不等同于 Windows ACL。

## 使用

对模型说「看不清的文字用 read_image_text 识别后再回答」，或显式调用：

```json
{"image":"/absolute/path/page.png","mode":"document"}
```

参数：

- `image`：本地图片或 PDF 的绝对路径，或相对于当前会话工作目录的路径。不能传 `attachmentId`，也不接受任意 URL。
- `mode`：`screen`（默认，截图/UI/聊天记录，关闭版面切块）、`document`（扫描页、多栏、PDF，开启版面分析）、`raw`（服务端默认）。模型固定为 `PaddleOCR-VL-1.6`。
- `pageRanges`：可选 PDF 页码，例如 `1-3,5`，从 1 开始。仅选择页码不会改变整文件上传这一事实。
- `refresh`：`true` 跳过本地结果缓存与已保存任务，重新提交；不保证绕过云服务内部缓存。

支持 PNG、JPEG、GIF、WebP、TIFF、BMP、PDF，单文件不超过 25 MiB，读取时校验文件头。工具通过 DSH 的 filesystem capability 读取所选文件，不绕过读取失败去直接访问宿主路径。

`read_image` / `acp_read_original_image` 成功后，插件最多每个 agent 每十分钟注入一次文字提示；成功 OCR 后也会冷却。提示由 `createUserMessage` 构造完整消息，只提醒模型选择工具，不会自动上传图片，也不能保证模型一定触发 OCR。模型不能访问原图路径时，应请用户提供可读取的文件，而不是猜路径。

## 运行方式和限制

- 默认总期限 300 秒，轮询间隔 2 秒。取消信号传入 HTTPS 与等待逻辑；取消本地等待不能保证停止已提交的云端任务，也不能撤回已上传数据。
- 仅下载文字结果 JSONL，不下载结果图片，不把 API 凭据转发给对象存储。允许的结果 URL 为 HTTPS 的 `aistudio-app.com`、`bcebos.com`、`baidubce.com` 及子域；没有自动跳转或任意 URL 代理。
- 单个插件实例按序提交，限流时有限退避重试。网络中断导致 POST 是否成功不明确时，不盲目重提，避免重复任务。
- 本地缓存默认 30 天，键包含文件内容、模式参数、页码、模型版本和账号的摘要。目录 `$DSH_HOME/ocr-cache/` 保存 OCR 文字及临时任务 ID，不含凭据。临时任务可在次日以前续查；`refresh` 可主动重新提交。
- 新文件通常仍需几十秒到数分钟，速度主要取决于云端排队和推理；本插件不能把 VL 推理保证为秒级。相同输入命中本地缓存时不重新上传。
- OCR 可能漏字、错字、误识公式，关键数字应核对原文。OCR 内容是引用数据，不能作为新指令执行。
- **所选整文件会上传百度 aistudio。涉密或未经授权的材料不要使用。** 结果文字也保存在本地缓存；按数据敏感性清理缓存目录。

## 可选配置

默认无需修改配置即可加载。管理员可在 profile 的 patch 覆盖稳定 id（不要重复插入同 id 的插件）：

```yaml
- id: dsh-plugin-image-ocr
  config:
    mode: screen
    timeoutMs: 300000
    pollIntervalMs: 2000
    cacheTtlDays: 30
    hintOnReadImage: true
    hintCooldownMs: 600000
```

关闭提示设 `hintOnReadImage: false`，工具仍可直接调用。`cacheTtlDays: 0` 不保存识别结果（仍暂存续查所需的任务 ID）。

## V4 会话安全修复

旧私用版曾把字符串写入 `tools/post-execute` 的 `additionalContexts`，导致会话中 `agent/inbox/spliced.inserted` 不符合 V4 格式，以及 `reading 'kind'` 异常。

本版只生成完整的 `UserMessage`：非空 `id`、`role: user`、文本块数组 `content`、`source.kind: image-ocr`。使用 DSH 的 `createUserMessage` 和额外的运行时断言；保留下游决策与已有上下文，失败、阻断、取消的调用不注入提示。不会使用已废弃的 `source.kind: plugin`。

宿主回归验证除了完整结构断言，还对真实插件 hook 的结果执行 DSH `sessionFormatCatalog` 的 `strict + current` 编解码回放，并调用 `finish()`。注意 catalog 自身并非完整消息 schema validator，不能仅以回放通过代替生产者的结构检查。

此修复防止生成同类新记录，**不会自动修改以前损坏的会话日志**。升级已加载旧模块的进程后，按 DSH 提示完成重新启用或重启。

## 开发与验证

运行环境 Node.js >=22.19.0；宿主集成验证针对 DSH 0.2.1-rc.5。运行产物直接位于 `lib/`，无需 prepare/build，也没有安装时下载模型或执行程序的脚本。

```sh
npm run check
npm test
npm run test:host
npm pack
```

`test:host` 使用当前 DSH 的真实消息构造器、工具定义与 V4 catalog（可用 `DSH_IMPLEMENTATION_ROOT` 指定安装根）。单元测试全部使用合成输入、模拟 HTTP 和临时目录，不消耗 OCR 配额；真实请求需主动执行 `node scripts/live-ocr.mjs <文件路径> document`，该命令会上传所选文件。

许可证 MIT。
