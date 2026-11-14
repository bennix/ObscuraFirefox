# Obscura Firefox

Independent macOS browser built from Mozilla Firefox release source, with a
built-in AI workspace and a local authenticated backend. Full source compilation and local fixture checks have passed on macOS ARM64.
Windows and Linux ports are not yet released. Website login compatibility and
Touch ID are not guaranteed.

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
Markdown/LaTeX, attachments, translation and dictionary storage. API keys remain
in Keychain. Download services retain MDM, HLS and media request context.

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
