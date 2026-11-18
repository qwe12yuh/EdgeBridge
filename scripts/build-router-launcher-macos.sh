#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app_dir="${EDGE_BRIDGE_BUILD_ROOT:-$project_dir/build}/EdgeBridgeRouterLab.app"
mkdir -p "$app_dir/Contents/MacOS"
swiftc "$project_dir/native/macos/CoreLabLauncher.swift" -o "$app_dir/Contents/MacOS/EdgeBridgeRouterLab"
python3 - "$app_dir" <<'PY'
import os,sys,pathlib,plistlib
info={'CFBundleIdentifier':os.environ.get('EDGE_BRIDGE_BUNDLE_ID','dev.edgebridge.router-lab'),'CFBundleName':os.environ.get('EDGE_BRIDGE_APP_NAME','EdgeBridge Router Lab'),'CFBundleExecutable':'EdgeBridgeRouterLab','CFBundlePackageType':'APPL','LSUIElement':True,'CFBundleVersion':'1'}
for key,env in [('EdgeBridgeCore','EDGE_BRIDGE_CORE'),('EdgeBridgeSettings','EDGE_BRIDGE_SETTINGS'),('EdgeBridgeRouteSocket','EDGE_BRIDGE_ROUTE_SOCKET'),('EdgeBridgeLog','EDGE_BRIDGE_LOG')]:
    info[key]=str(pathlib.Path(os.environ[env]).resolve())
(pathlib.Path(sys.argv[1])/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
PY
# Documents may add Finder display metadata; preserve security/provenance attributes.
xattr -d com.apple.FinderInfo "$app_dir" 2>/dev/null || true
codesign --force --sign - "$app_dir"
printf '%s\n' "$app_dir"
