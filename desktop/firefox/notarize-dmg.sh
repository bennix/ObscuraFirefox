#!/bin/bash
# Usage: notarize-dmg.sh SIGNED_APP OUTPUT_DMG KEYCHAIN_PROFILE SIGNING_IDENTITY
set -euo pipefail
app="$1"
dmg="$2"
profile="$3"
identity="$4"
codesign --verify --deep --strict "$app"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
/usr/bin/ditto "$app" "$staging/Obscura Firefox.app"
ln -s /Applications "$staging/Applications"
hdiutil create -volname 'Obscura Firefox' -srcfolder "$staging" -ov -format UDZO "$dmg"
codesign --force --timestamp --sign "$identity" "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
shasum -a 256 "$dmg" > "$dmg.sha256"
