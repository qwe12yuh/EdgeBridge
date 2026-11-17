#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app_dir="$project_dir/build/EdgeBridge.app"
mkdir -p "$app_dir/Contents/MacOS"
swiftc "$project_dir/native/macos/main.swift" -o "$app_dir/Contents/MacOS/EdgeBridge"
python3 - "$app_dir" "${EDGE_BRIDGE_IPC:-}" <<'PY'
import sys,plistlib,pathlib
app=pathlib.Path(sys.argv[1])
info={'CFBundleIdentifier':'dev.edgebridge.native','CFBundleName':'EdgeBridge','CFBundleExecutable':'EdgeBridge','CFBundlePackageType':'APPL','LSUIElement':True,'CFBundleVersion':'2'}
if sys.argv[2]:info['EdgeBridgeIPC']=str(pathlib.Path(sys.argv[2]).resolve())
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
PY
# Finder may attach this display metadata to a previously inspected development bundle.
xattr -d com.apple.FinderInfo "$app_dir" 2>/dev/null || true
codesign --force --sign - "$app_dir"
printf '%s\n' "$app_dir"
