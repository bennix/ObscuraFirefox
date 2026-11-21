# Obscura Firefox

[English / 中文 website](https://bennix.github.io/ObscuraFirefox/) · [Downloads](https://github.com/bennix/ObscuraFirefox/releases)

An independent Firefox source build with a built-in AI workspace, browser control,
media discovery, HLS downloads with Firefox download progress, immersive translation,
and a personal dictionary. Uses the original Obscura Firefox icon.

基于 Firefox 源码构建的独立浏览器，内置 AI 工作区、网页操控、媒体识别、HLS 下载、
Firefox 原生下载进度、沉浸式翻译与个人词典。界面跟随浏览器主题和语言，未知语言回退英语。

## Status / 当前状态

[Version 0.3.9](https://github.com/bennix/ObscuraFirefox/releases/tag/firefox-v0.3.9)
provides Apple-notarized macOS ARM64 and Intel x86_64 DMGs, a Windows x64 EXE, and Linux
amd64 DEB / x86_64 RPM packages. Windows native runtime checks passed; the
installer is unsigned. Linux checks passed on Ubuntu 24.04 and after DEB
installation; RPM engine and FFmpeg binaries match the installed DEB.
Physical Windows installation and additional Linux distributions have not been
validated. macOS Touch ID passkeys are unavailable pending Apple browser entitlement approval; website login compatibility varies.

0.3.9 已发布 Apple 公证的 macOS ARM64 与 Intel x86_64 DMG、Windows x64 EXE，以及 Linux
amd64 DEB / x86_64 RPM。Windows 原生运行时检查通过，安装程序暂未签名；Linux
在 Ubuntu 24.04 和 DEB 实际安装后通过检查，RPM 的引擎及 FFmpeg 与已安装 DEB 一致。
尚未完成物理 Windows 机器安装和其他 Linux 发行版验收；macOS Touch ID 通行密钥因缺少 Apple 浏览器授权暂不可用，网站登录兼容性取决于具体站点。平台源码提交与工作流记录见发布附件，当前采用手动更新。

自动模式会检查本机 HTTP 代理端口；需要认证时，尝试同端口免密 SOCKS5 或正在运行的免密桌面代理。

网页聊天粘贴图片时可选择转为 PDF、发送原图或取消。PDF 在本地转换，Canvas 抗指纹保护保持开启，上传文件选择器默认定位到生成的 PDF 文件夹。

右键下载 X、YouTube 与受支持的视频，可选择清晰度并自动合并音轨。X 嗅探列表仅保留当前视口可见内容，支持清空与重新嗅探。macOS、Windows、Linux 的网页、AI 和下载共用自动代理路由；手动设置优先，自动模式依次读取系统代理、环境变量和受支持的运行中本地代理核心。

## Build / 构建

See [Firefox build instructions](desktop/firefox/README.md). Firefox source is
pinned to revision `dc1259aee26fc94e00047ad4da433ceac1583eb4` (160.0.1).
Install desktop dependencies with `npm ci --prefix desktop`.
The repository contains integration scripts; fetch Mozilla source separately.

## Privacy / 隐私

WebRTC is disabled. Firefox tracking protection, cookie partitioning and fingerprint
resistance are configured. An opt-in X login compatibility exception affects X only.
These settings cannot promise anonymity or eliminate all fingerprinting.
AI prompts, attachments and requested page context are sent to the configured AI
provider. macOS API keys are stored in Keychain. No stock Mozilla automatic updates
are installed; update manually from this project's verified releases.

WebRTC 默认禁用，启用跟踪保护、Cookie 分区和指纹保护。X 登录兼容例外需主动开启，
仅作用于 X。保护设置不能保证完全匿名。AI 请求及附件会发送至配置的服务商；
macOS 密钥保存在钥匙串。当前需手动更新本项目版本。

## Attribution

Independent project, not affiliated with Mozilla. Firefox is a Mozilla trademark.
Firefox-derived source retains its upstream license notices. See [LICENSE](LICENSE),
[upstream Obscura documentation](README.obscura-upstream.md), and
[download manager attribution](desktop/third-party/mdm/ATTRIBUTION.md).
