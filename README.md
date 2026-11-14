# Obscura Firefox

[English / 中文 website](https://bennix.github.io/ObscuraFirefox/) · [Downloads](https://github.com/bennix/ObscuraFirefox/releases)

An independent Firefox source build with a built-in AI workspace, browser control,
media discovery, HLS downloads with Firefox download progress, immersive translation,
and a personal dictionary. Uses the original Obscura Firefox icon.

基于 Firefox 源码构建的独立浏览器，内置 AI 工作区、网页操控、媒体识别、HLS 下载、
Firefox 原生下载进度、沉浸式翻译与个人词典。界面跟随浏览器主题和语言，未知语言回退英语。

## Status / 当前状态

macOS ARM64 is the currently tested platform. Only artifacts actually present in
Releases are available. Windows and Linux DEB/RPM ports are in progress.
Touch ID and successful authentication on every website are not guaranteed.

目前已测试的平台为 macOS ARM64。以 Releases 实际文件为准；Windows、Linux DEB/RPM
仍在移植中。Touch ID 和所有网站的登录兼容性尚不能保证。

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
