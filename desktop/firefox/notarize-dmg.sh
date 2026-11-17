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
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait --output-format json > "$staging/notary.json"
python3 - "$staging/notary.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
print('Notarization:', result.get('id'), result.get('status'))
if result.get('status') != 'Accepted':
    raise SystemExit('Notarization was not accepted; no ticket will be stapled.')
PY
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
python3 - "$dmg" <<'PYHASH'
import pathlib, subprocess, sys
file = pathlib.Path(sys.argv[1])
digest = subprocess.check_output(['shasum', '-a', '256', str(file)], text=True).split()[0]
file.with_name(file.name + '.sha256').write_text(digest + '  ' + file.name + '\n')
PYHASH
