# Obscura Desktop · macOS Apple Silicon

本地 Obscura 引擎 + NW.js 独立桌面窗口 + ZenMux AI 工作台。

## 打开应用

双击 `dist/Obscura Desktop.app`，在应用自己的地址栏与标签页中浏览网页。
顶部可打开 AI 工作台、下载和设置，也可直接切换暗色 / 亮色。设置支持跟随系统主题，选择会永久保存。

使用 NW.js SDK 0.120.0，内置 Chromium **157.0.8103.39**，此补丁版本已获用户接受。
网页运行在禁用 Node.js 的独立 webview 中。运行时固定打包，更新需要重新构建应用。

## 导航、翻译与用户词典

地址栏同时接受 HTTP/HTTPS 网址与搜索词。默认 Google，设置页可切换 Bing、DuckDuckGo、百度、Yahoo 或 Brave Search，选择永久保存。
本地开发网址如 `localhost:8080`、`127.0.0.1:9000` 自动使用 HTTP。

点击“翻译 / 词典”，选择目标语言并开始翻译。每批最多 6 段，原始 DOM、链接和样式保持，译文以继承样式的文本段落插入。
支持停止、恢复原文和继续翻译已加载的新内容。导航后停止应用旧页面的译文，翻译需要已配置的 ZenMux Key。
当前覆盖页面顶层文档中的段落、标题、列表、引用和表格单元格，跨域 iframe、封闭 Shadow DOM 和扫描图片未纳入全文翻译。

在网页划选单词或短语后，可点击浮出的“搜索”，使用已配置的搜索引擎在新标签页搜索；也可点击“AI 查词”。查询使用所选模型与原始上下文句子，展示词性、译文和用法解释。
点击“加入用户词典”后保存到本地 `dictionary.json`，包括原词、词性、翻译、原始上下文句子、来源和解释。
词典每页 20 条，支持对原词、翻译和上下文的大小写不敏感、子序列模糊查询。关闭重开后保留词条。
翻译及查词通过已有代理自适应请求管线连接 ZenMux。真实模型结果需配置 Key 后验收。

## AI 设置

1. 打开工作台“设置”，输入 ZenMux API Key 并保存。
2. Key 存储在 **macOS 登录钥匙串**，服务名称为 `ai.obscura.desktop.zenmux`。界面不会取回真实 Key。
3. 没有 Key 时使用设置中的邀请链接：https://zenmux.ai/invite/GBQMC5 。
4. Base URL 固定为 `https://zenmux.ai/api/v1`。
5. 默认模型为 `anthropic/claude-sonnet-4.6`、`z-ai/glm-5v-turbo`、`openai/gpt-5.4`。
6. 模型名称可按行增删，默认模型和列表永久保存在本地。

AI 通过本地 MCP 兼容工具层直接操作当前内置网页，支持导航、快照、点击、填写、按键、JavaScript、截图和滚动。
页面文字及按需截图会发送至 ZenMux。对话保留在当前工作台会话中；应用不会把 Key 放进模型消息或网页。
截图和表单可能包含个人信息，使用时自行选择需要交给模型的网页。

### 输入与附件

AI 输出区与输入区独立显示。支持选择、拖入或粘贴 PNG / JPEG / WebP 图片、文本文件和 PDF。
附件显示缩略图或文件卡片，发送前可用右上角 × 移除。每个文件最多 16 MB，每条消息最多 10 个文件、合计 32 MB。
PDF 提取文字后发送给模型，扫描件需要提供图片。文本最多提取 200000 字符，超出时会提示。
附件缓存保存在本机私有目录，发送消息时会把对应内容提交给 ZenMux。清空对话同时删除缓存。

### 长任务与观察哨

- 每轮最多 80 次工具调用，20 分钟总上限，可手动停止。
- 每 5 步由独立模型上下文核对原目标、执行记录和真实页面。
- 执行者声称完成时，必须再次通过观察哨验收清单。
- 检查未通过会继续补足；需要确认、缺少信息或连续没有进展时会停止并说明原因。
- 达到上限不会标记完成。最近任务目标、步数和验收清单保存到本地，重启后中断任务显示为未验收。
- 观察哨也使用所选 ZenMux 模型，增加模型请求。它是辅助验证，不能保证每次判断正确。

## Google 账号

设置页提供“登录 / 添加账号”和“切换账号”，均打开 **Google 官方页面**。
在内置 Google 页面手动输入密码、验证码和完成二次验证；AI 不参与登录。
登录 Cookie 与网站存储保存在应用的独立 NW.js 档案中，退出重开后继续保留。
Google 的安全策略可能要求再次验证或拒绝某些浏览器环境；未使用真实账号完成端到端登录验证。
登录弹窗使用独立应用内窗口，保留 opener、postMessage 与共享 Cookie 分区。登录弹窗对 Google 顶层响应进行定向 COOP 兼容处理，避免跨来源切换清空 opener。跨来源 OAuth 回传与关闭测试已通过。X → Google 的真实账号登录仍需实际账号验收。

**弹窗空白与睡眠恢复。** 笔记本睡眠会断开应用内核的浏览器级调试连接。此前这会关闭整个后端，已打开的 X 登录弹窗留下空白窗口，请求等待 60 秒后失败。现在带标记的弹窗直接按标记定位，不依赖浏览器级连接。已关闭的调试连接立即报错，不再等待超时。浏览器级连接会自动重连，页面连接保持，后端不会因此关闭；只有重连用尽才会关闭后端，且关闭可重试。
服务端拒绝（例如日志中 Google 凭据成功后 `jf.x.com` 的 `begin_signup_sso` 返回意外错误）原因未知，无法在没有真实账号的情况下确认已修复。上述修复只消除本地弹窗空白这一故障。

## 图片与视频

普通网页的新窗口链接进入主窗口标签页。Google 登录完成后到达的 YouTube / Gmail 内容页也会转回主窗口。
X、YouTube 和网页视频的全屏由应用窗口接管，支持网页全屏按钮、Esc 退出与恢复布局。此兼容层避开 NW.js 157 guest 原生全屏路径的浏览器崩溃。

- YouTube 广告检测到播放器广告状态后自动 8 倍速，广告结束恢复 1 倍速，兼容播放器切换视频元素。
- 网页和媒体使用Chromium 媒体播放管线；本地 H.264/AAC 实际播放已验证。
- YouTube / X 的账户、网络、版权和网站策略仍会影响播放。已验证公开 YouTube 视频页播放，登录后的站点媒体仍需实际账号验收。
- X 的媒体图片点击展开原图。其他网页图片使用 **Option + 点击**。
- 查看器支持滚轮缩放、拖拽平移、双击复位、适应窗口和 Esc 关闭。
- 页面工具可以保存当前内置网页截图；原生引擎分区调用 Obscura 自带 MCP，使用独立会话。

## X 登录诊断日志

0.2.1 将 OAuth 保护提前到第三方首段脚本之前，并修复自动页面检查模拟用户手势的问题。

应用内置自动诊断，文件保存于 `~/Library/Application Support/Obscura Desktop/logs/x-login.jsonl`。
设置页可“记录并打开 X 登录”或“打开 X 登录日志”。每行 JSON 按时间记录弹窗、opener、导航、消息类型、Cookie 拦截原因、请求状态、脚本异常分类和 X 返回的错误摘要。
Google 凭据仅记录结构检查结果，例如过期、受众关联及邮箱验证状态。结构检查不验证签名。密码、Cookie 值、API Key、完整凭据、请求正文和 URL 查询参数不会写入日志。
日志目录和文件分别使用 0700 / 0600 权限，每份最多 5 MB，保留当前文件和两个轮转文件。

## X 登录兼容例外

内置页面使用 NW.js 的 Chromium 内核。每个页面在保留真实版本号和平台的同时补上正式版 Chrome 会声明的 `Google Chrome` 品牌，避免只显示 `Chromium` 的登录环境被站点拒绝。

设置中的“X 登录兼容”仅匹配 `x.com` 及其子域。开启后，这些站点使用原生 Canvas、WebGL、离线音频、硬件信息和 WebRTC 构造器，并移除其 HTTPS 顶层响应的 COOP 头以保留 Google 登录弹窗的 opener。这会降低 X 的跨窗口隔离。保存后重启生效。
开启该项后，仅当 `accounts.google.com` 页面位于由 X 页面打开的登录弹窗内（含该弹窗中自动附加的 iframe）时，才临时使用原生 Canvas、WebGL、离线音频和 WebRTC 构造器，也不对其他 Google 页面或其他来源生效。弹窗导航离开 `accounts.google.com` 后恢复严格保护。WebRTC 只使用公网接口。

`claude.ai` 及其子域、Google 认证页与其他站点使用严格保护，登录路径不会自动获得例外。此项已按用户明确选择开启。
实现参考 AstraAIBrowser 的认证兼容策略与 OAuth 弹窗导航保留方式，采用独立实现。
参考 https://github.com/bennix/AstraAIBrowser/commit/353c2bd8fd8f 和 https://github.com/bennix/AstraAIBrowser/blob/main/docs/privacy/site-strict-mode.md 。

## 隐私保护与边界

平时 WebRTC 使用 `disable_non_proxied_udp`。页面出现 Cloudflare 验证时，脚本保护和这项 UDP 限制会暂停，验证页离开后再恢复。
同时禁用摄像头、麦克风、定位和通知默认授权。Canvas、WebGL、WebRTC 和离线音频保持原生，避免 Cloudflare 验证停在转圈。
主页面、跨域 iframe、srcdoc iframe 的相关回归检查已通过。
WebRTC 策略是 `default_public_interface_only`。构造器在各站点都保留。

**不能保证零指纹或绝对无泄露。** 这是官方内核上的脚本与权限防护，不是内核级反指纹浏览器；worker、未覆盖 API、字体、屏幕、IP 等仍可能提供识别信号。
这些限制可能影响依赖像素读回的图形编辑功能。已提供系统代理和手动代理配置，代理路径与完整环境的泄露风险仍需结合实际 VPN / 代理环境验收。

本地桥只监听 `127.0.0.1`，每次启动生成随机认证 Token。应用内核的调试端口也只用于本地。
本机其他进程可能读取用户档案和本地调试端口，不将此应用视为对抗本机恶意程序的安全边界。

## 本地数据

`~/Library/Application Support/Obscura Desktop/`：

- `nw-profile/`：独立 NW.js 档案及登录状态
- `settings.json`：模型配置，无 API Key
- `last-task.json`：最近任务和验收进度，无 API Key
- `extension/`：工作台及当前本地桥连接配置

API Key 在系统钥匙串中。

## 开发与重建

```sh
cd /path/to/ObscuraFirefox
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 CARGO_HTTP_MULTIPLEXING=false cargo build --locked --release -p obscura-cli --bins --features render
cd desktop
npm ci
npm start
npm run package
```

打包时将 NW.js、下载与媒体工具以及 Obscura 两个二进制一起放入 `.app`，无需启动 HTTP 云服务。
应用当前针对 Apple Silicon；是本地临时签名构建，未做 Developer ID 分发签名或公证。

## 验证

```sh
ffmpeg -y -f lavfi -i testsrc=size=320x180:rate=24 -f lavfi -i sine=frequency=440 -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac /tmp/obscura-media-test.mp4
npm test
```

覆盖：Key 的存储边界、模型配置持久化、ZenMux 工具循环、观察哨拒绝虚假完成、步数限制、真实 Obscura 渲染、Chrome 157 视频解码、iframe 隐私保护、认证、MCP 页面操作及 GUI。
ZenMux 流程采用模拟 API 验证；未提供真实 Key，因此未进行实际付费模型调用。

## 网络自适应与流式输出

网页访问与 AI 请求支持系统代理 / VPN 路由。AI 读取 macOS 系统 HTTP、HTTPS、SOCKS 和 PAC 配置。
手动模式可填写 HTTP、HTTPS 或 SOCKS5 地址。代理地址和认证信息保存在 macOS 钥匙串，界面只展示隐藏凭据后的地址。
浏览器 HTTP/HTTPS 代理支持认证。Chrome 本身对带用户名密码的 SOCKS 代理支持有限，建议此类代理通过本地无认证转发端口接入 Chrome。AI 请求支持 SOCKS 认证。
系统代理自动发现（WPAD）缺少明确 PAC 地址时，AI 会提示设置手动代理。TUN 模式 VPN 使用操作系统路由。

AI 根据实际响应耗时调整等待窗口，遇到网络异常、429 或临时服务错误最多退避重试 3 次，并遵循 Retry-After。
手动代理失败时保持代理路径，不回退直连。SOCKS5 的 AI 请求通过代理解析域名。
浏览器导航会根据耗时调整等待时间，并对暂时失败的导航重试。点击、填写等页面操作不会因传输重连被自动重放。

AI 文本通过 SSE 接收，并经本地流式连接逐段显示。工具参数需要完整接收后才执行。
本地流式连接断开后，界面查询同一任务的状态与结果，保留已收到的内容和任务进度。
工作台关闭后重新打开，可恢复仍在运行的任务及当前应用会话中的对话。退出整个应用后的任务会显示为中断。

支持 Markdown 标题、列表、表格、引用、链接和代码块，以及 LaTeX 的 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`。
使用本地 Marked、DOMPurify 和 KaTeX 资源，渲染公式无需访问 CDN。
AI 输出会经过 HTML 清理，公式使用受限渲染。流式接收期间未闭合的 Markdown / LaTeX 会在后续片段到达时更新。

已通过真实 Chrome 界面的流式显示、公式、Markdown 和恶意 HTML 清理测试，以及本地 HTTP / SOCKS 代理与中断恢复测试。
真实 ZenMux 模型在具体 VPN、代理和账号额度下的表现，仍需配置 API Key 后验证。

## 内置下载与媒体嗅探

工作台的“下载”页内置 Mister Download Manager 0.5.2。其 Rust 引擎在应用内部后台运行，无需另外安装或打开 MDM。
上游 macOS 发行包标为 experimental。本机已经验证普通文件下载、暂停/继续、HLS 分段获取和合并结果。

打开网页并播放媒体，然后在“下载 → 当前页嗅探媒体”点击刷新。
列表标识 HLS、DASH、视频或音频。可以解析可用清晰度，勾选需要的资源并点击“下载所选媒体”，也可以单独下载某一条。
嗅探本身不会自动开始下载，TS / m4s 小分段会被过滤，HLS 使用播放列表作为任务入口。
YouTube 分段播放请求按轨道合并展示，并通过对应页面和轨道格式交给媒体下载器解析。

普通文件交给内置 MDM 引擎。媒体使用打包在应用内的 yt-dlp 2026.10.26 与 FFmpeg 8.0.1。
HLS 支持分段并发下载、失败重试、暂停/继续、续传缓存及音视频合并。默认并发 8 个分段，分段失败最多重试 10 次。
退出整个应用会停止任务，保留记录和媒体缓存，重开后可在任务列表继续。移除记录保留下载文件。

文件默认保存在 `~/Downloads/Obscura/`，媒体任务各有独立子目录。任务数据保存在应用数据目录的 `downloads/`。
需要登录的资源会复用当前浏览器的匹配 Cookie、User-Agent 和 Referer。临时 Cookie 文件位于应用的私有数据目录，不传给 AI。
下载会遵循已有代理设置。媒体任务按所选播放列表的 PAC 路由选择代理，并保持该代理下载分段。

AI 的内置 MCP 工具新增 `downloads_list`、`downloads_add`、`downloads_pause`、`downloads_resume` 和 `downloads_remove`。
AI 使用下载工具时，会将任务名称、地址和进度按需发送至 ZenMux，不包含浏览器 Cookie。观察哨会在下载任务的验收中读取真实下载状态。添加成功与完整下载完成分别依据任务目标验收。

MDM 的许可证及作者署名保存在 `third-party/mdm/`，原始源码对应 https://github.com/anefzaoui/misterdownloadmanager/tree/v0.5.2 。
不同站点的签名链接、登录、地区和保护机制会影响媒体嗅探与下载结果，真实站点仍需逐个验证。
