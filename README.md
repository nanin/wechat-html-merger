# WeChat HTML Merger

将 WechatExplorer 分别导出的 Jamie 和 Cherry 两份 HTML 聊天档案合并为一个可离线打开、可增量更新的档案。

## 工作方式

- 两份源档案保持不变，继续由 WechatExplorer 分别增量导出。
- 合并消息按时间排序，并保留每条消息原来的账号名、头像和左右气泡。
- 图片、视频、语音、文件和头像放在独立账号目录，避免同名资源冲突。
- 同一磁盘优先使用硬链接，不额外复制约 5.7 GB 的资源；跨磁盘时自动回退为复制。
- 每次更新都从两份源档案重建消息索引，但通过临时文件原子替换，失败不会破坏上一次成功结果。
- 资源更新是增量的：已有文件直接复用，只新增或替换发生变化的文件。

## 当前档案快捷用法

首次执行会创建合并档案，后续再次执行会自动更新：

```bash
./merge-jamie-cherry.command
```

输出目录：

```text
/Users/bytedance/Documents/WechatExplorer/导出/Jamie_Cherry_合并档案
```

以后 Jamie 或 Cherry 有新消息时：

1. 使用 WechatExplorer 增量导出到原来的 `Jamie_聊天档案` 或 `Cherry_聊天档案`。
2. 再运行一次 `./merge-jamie-cherry.command`。
3. 打开合并目录中的 `index.html`。

## 通用命令

首次创建：

```bash
node --max-old-space-size=2048 src/cli.mjs create \
  --jamie "/path/to/Jamie_聊天档案" \
  --cherry "/path/to/Cherry_聊天档案" \
  --output "/path/to/Jamie_Cherry_合并档案" \
  --name "Jamie / Cherry"
```

增量更新：

```bash
node --max-old-space-size=2048 src/cli.mjs update \
  --output "/path/to/Jamie_Cherry_合并档案"
```

合并目录中的 `merge-config.json` 保存两个源档案的路径和 `sourceId`。如果源目录被移动，请修改其中的 `path` 后再更新；如果 `sourceId` 变化，工具会停止并提示，避免合并错误的聊天档案。

## 开发检查

```bash
npm run check
npm test
```
