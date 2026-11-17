#!/bin/sh
# SPDX-License-Identifier: MIT
# Archive only a reviewed commit; ignored/untracked runtime files never enter it.
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
commit=$(git rev-parse --verify "${1:-HEAD}^{commit}")
mkdir -p dist
git archive --format=zip --prefix=EdgeBridge/ -o dist/EdgeBridge-source.zip "$commit"
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const name="EdgeBridge-source.zip"; fs.writeFileSync("dist/SHA256SUMS",crypto.createHash("sha256").update(fs.readFileSync("dist/"+name)).digest("hex")+"  "+name+"\n");'
printf '%s\n' "$project_dir/dist/EdgeBridge-source.zip"
