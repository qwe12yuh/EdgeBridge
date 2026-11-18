#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app_dir="${EDGE_BRIDGE_BUILD_ROOT:-$project_dir/build}/EdgeBridgeGestureLab.app"
mkdir -p "$app_dir/Contents/MacOS"
swiftc "$project_dir/native/macos/GestureLab.swift" -o "$app_dir/Contents/MacOS/EdgeBridgeGestureLab"
python3 - "$app_dir" "${EDGE_BRIDGE_IPC:-}" <<'PY'
import sys,plistlib,pathlib
app=pathlib.Path(sys.argv[1])
import os
info={'CFBundleIdentifier':os.environ.get('EDGE_BRIDGE_BUNDLE_ID','dev.edgebridge.gesture-lab'),'CFBundleName':os.environ.get('EDGE_BRIDGE_APP_NAME','EdgeBridge Gesture Lab'),'CFBundleExecutable':'EdgeBridgeGestureLab','CFBundlePackageType':'APPL','LSUIElement':True,'CFBundleVersion':'1'}
if sys.argv[2]: info['EdgeBridgeIPC']=str(pathlib.Path(sys.argv[2]).resolve())
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
PY
# Documents may add Finder display metadata; preserve security/provenance attributes.
xattr -d com.apple.FinderInfo "$app_dir" 2>/dev/null || true
codesign --force --sign - "$app_dir"
printf '%s\n' "$app_dir"
