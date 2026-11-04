#!/bin/bash
# Builds dist/LocalTunnel-<version>-<arch>.dmg after tools/pack.mjs <target>.
# Usage: bash packaging/macos/build.sh darwin-arm64|darwin-x64 <version>
set -euo pipefail

target=$1
version=$2
arch=${target#darwin-}
root=$(cd "$(dirname "$0")/../.." && pwd)
stage=$root/dist/$target/dmg
bundle=$stage/LocalTunnel.app
plist=$bundle/Contents/Info.plist

rm -rf "$stage"
mkdir -p "$stage"
osacompile -s -o "$bundle" "$root/packaging/macos/LocalTunnel.applescript"
cp -R "$root/dist/$target/app" "$bundle/Contents/Resources/app"
cp "$root/packaging/icons/icon.icns" "$bundle/Contents/Resources/applet.icns"
plutil -replace CFBundleIdentifier -string io.github.plzy.localtunnel "$plist"
plutil -replace CFBundleName -string LocalTunnel "$plist"
plutil -replace CFBundleShortVersionString -string "$version" "$plist"
plutil -replace CFBundleVersion -string "$version" "$plist"
codesign --force --sign - "$bundle"
ln -s /Applications "$stage/Applications"
hdiutil create -volname LocalTunnel -srcfolder "$stage" -format ULFO -ov "$root/dist/LocalTunnel-$version-$arch.dmg"
