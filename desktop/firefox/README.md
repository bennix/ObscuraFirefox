# Obscura Firefox

Independent browser built from Mozilla Firefox release source, with a built-in
AI workspace and a local authenticated backend. Version 0.3.15 is available for
macOS ARM64 and Intel x86_64, Windows x64, and Linux amd64/x86_64 in DEB and RPM formats.
Both macOS DMGs are Developer ID signed and Apple notarized. Native Windows and
Ubuntu CI runtime checks passed; the DEB also passed after installation.
Windows installers are unsigned. Physical Windows installation and additional
Linux distributions remain outside the verified scope. Website login compatibility
varies by site. macOS Touch ID passkeys are unavailable pending Apple browser entitlement approval.

Published installers and per-platform build records:
https://github.com/bennix/ObscuraFirefox/releases/tag/firefox-v0.3.15

Pasting an image into a web chat offers PDF conversion, the original image, or cancellation. Local PDF conversion preserves Canvas fingerprint protection and sets the upload picker directory to the generated PDF folder.

Right-click supported X and YouTube media to choose quality and merge audio automatically. X discovery follows visible viewport media and supports clear/rescan. Webpages, AI and downloads share automatic system, environment and supported running local-core proxy routing on all desktop platforms; explicit manual settings take priority.

## Source and build

- Upstream: https://github.com/mozilla-firefox/firefox
- Release revision: `dc1259aee26fc94e00047ad4da433ceac1583eb4`
- Observed version: `160.0.1`
- Full native build, not artifact mode.

Apply the branding, built-in extension and privacy defaults with:

```sh
node desktop/firefox/apply-source.cjs /path/to/firefox-source
```

Build with `mach build`, then `mach package` in the source workspace. Extract
the packaged app before passing it to `desktop/firefox/package.cjs`. Do not ship
the raw object-directory app, which can contain build-tree symlinks.

The packaged app disables stock Mozilla updates because they would replace the
custom launcher and built-in workspace. Updates currently require rebuilding and
repackaging the selected upstream release; no automatic update service is provided.

## Browser control

The built-in extension controls real native tabs through an authenticated local
WebSocket. Native messaging supplies the per-run connection details. The app
starts without WebDriver, Marionette or remote-debugging flags. Tools include
snapshot, click, fill, native keyboard input, evaluate, screenshot, navigation,
tab management, media listing and user-attachment upload. Upload accepts existing
attachment IDs rather than unrestricted filesystem paths.

The existing ZenMux backend handles AI streaming, task observation, cancellation,
Markdown/LaTeX, attachments, translation and dictionary storage. API keys use
macOS Keychain, Windows DPAPI for the current user, or Linux Secret Service.
Download services retain MDM, HLS and media request context.

## Windows and Linux installers

`Firefox native source builds` builds the pinned Firefox revision on Windows
and Ubuntu runners. Successful builds trigger `Firefox desktop installers`.
The installer workflow can also be started manually with a successful source
run ID. It overlays the current workspace code and bundles platform-matched
Node, MDM, yt-dlp and FFmpeg before running the browser tests.

Windows produces an x64 Inno Setup EXE; Linux produces an amd64 DEB and an
x86_64 RPM. Windows installers are currently unsigned. Linux builds use
Ubuntu 24.04; compatibility with older glibc distributions is not established.
Linux credentials require a running Secret Service, such as GNOME Keyring.

FFmpeg is bundled with its codec libraries rather than relying on the system
FFmpeg installation. Linux packaging rejects a binary linked to system
libavcodec/libavformat libraries. Downloads run in the local native backend,
outside web content, through authenticated local IPC. Windows subprocesses
use hidden windows and argument arrays rather than shell command strings.

Release tests run the package from a directory containing Chinese characters
and spaces. They sniff a local HLS stream, observe its active entry in Firefox
downloads, merge it to a Chinese filename and decode the resulting video to
verify its duration. Sandbox-disable environment variables are rejected;
setting `MOZ_DISABLE_CONTENT_SANDBOX=0` also disables Firefox's Linux sandbox
and must not be used. These native CI tests do not replace broader testing on
physical Windows machines and additional Linux distributions.

References reviewed:
- https://github.com/mozilla/firefox-devtools-mcp
- https://github.com/ThinkerYzu/foxmcp

These informed the adapter design; they are not bundled as additional runtimes.

## Privacy and authentication

Native WebRTC is disabled, including on X. Native fingerprint resistance,
tracking protection and partitioned cookies are enabled. The saved, explicitly
opted-in login compatibility setting exempts only X from fingerprint resistance;
Claude has no exception. Proxy routing and native runtime behavior still require
live acceptance checks. Defaults alone are not proof of leak prevention.

Do not port the old Chromium UA overrides or COOP workarounds without evidence.
Do not delete challenge cookies at startup. Fresh X username and Google login,
Google account switching and Grok challenges must be tested in the packaged app.
An imported session or HTTP 200 is not proof of successful fresh login.

## Verification

```sh
node --test desktop/test/firefox-bridge.test.cjs
OBSCURA_FIREFOX_BIN=/path/to/firefox node --test desktop/test/firefox-runtime.test.cjs
```

The runtime test uses a separate profile and a local fixture. Set
`OBSCURA_TEST_BACKEND` to the packaged app's `Contents/Resources/obscura-desktop`
directory to test the bundled backend as well as the packaged browser.
`firefox-proxy-runtime.test.cjs` checks HTTP/SOCKS4/SOCKS5 routing, HTTP/SOCKS5 authentication and proxy-down behavior. Set `OBSCURA_CERTUTIL` to the built NSS certutil executable to include HTTPS proxy verification with a temporary test CA; this does not change system trust.
`firefox-live-ai.test.cjs` is opt-in with `OBSCURA_LIVE_AI=1`; it makes real ZenMux
requests using the saved model/key, operates only a local fixture, and requires
actual streaming plus a successful observer checklist. A skipped runtime
test is not a pass. Existing Rust gates passed: full release nextest 2668 passed,
5 skipped; normal obstacle course 33/33; stealth network nextest 173/173 and
stealth obstacle course 33/33. These do not establish Firefox UI correctness.
