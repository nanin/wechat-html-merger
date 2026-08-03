#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
jamie_archive="/Users/bytedance/Documents/WechatExplorer/导出/Jamie_聊天档案"
cherry_archive="/Users/bytedance/Documents/WechatExplorer/导出/Cherry_聊天档案"
merged_archive="/Users/bytedance/Documents/WechatExplorer/导出/Jamie_Cherry_合并档案"

if [[ -f "$merged_archive/merge-config.json" ]]; then
  node --max-old-space-size=2048 "$script_dir/src/cli.mjs" update --output "$merged_archive"
else
  node --max-old-space-size=2048 "$script_dir/src/cli.mjs" create \
    --jamie "$jamie_archive" \
    --cherry "$cherry_archive" \
    --output "$merged_archive" \
    --name "Jamie / Cherry"
fi

