#!/bin/sh
# Builds dist/Deadbolt.app. Ad-hoc signed: macOS asks again for Accessibility after each rebuild.
# CONF=debug rebuilds in about 2s instead of 14s (measured). Use release for CPU measurements.
set -eu
cd "$(dirname "$0")/.."
CONF=${CONF:-release}
swift build -c "$CONF"
APP=dist/Deadbolt.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp ".build/$CONF/deadbolt" "$APP/Contents/MacOS/Deadbolt"
cp -R ui extension "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Deadbolt</string>
<key>CFBundleIdentifier</key><string>com.deadbolt.app</string>
<key>CFBundleName</key><string>Deadbolt</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
echo "built $APP"
