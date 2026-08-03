#!/usr/bin/env node

import { resolve } from 'node:path'
import { createMergedArchive, updateMergedArchive } from './merge.mjs'

const usage = `
WechatExplorer 双账号 HTML 档案合并工具

首次创建：
  node src/cli.mjs create \\
    --jamie <Jamie_聊天档案目录> \\
    --cherry <Cherry_聊天档案目录> \\
    --output <合并档案目录> \\
    [--name "Jamie / Cherry"]

增量更新：
  node src/cli.mjs update --output <合并档案目录>
`

const parseOptions = (args) => {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) throw new Error(`无法识别的参数：${argument}`)
    const key = argument.slice(2)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`)
    options[key] = value
    index += 1
  }
  return options
}

const required = (options, key) => {
  const value = options[key]
  if (!value) throw new Error(`缺少参数 --${key}`)
  return resolve(value)
}

const printResult = (result) => {
  console.log(`合并完成：${result.outputPath}`)
  console.log(`消息总数：${result.messageCount.toLocaleString('zh-CN')}`)
  console.log(
    `月份文件：共 ${result.months.total} 个，本次写入 ${result.months.written}，复用 ${result.months.reused}`
  )
  for (const source of result.sources) {
    const resources = result.resources[source.id]
    console.log(
      `${source.label}：${source.messageCount.toLocaleString('zh-CN')} 条消息，` +
        `资源新增 ${resources.linked + resources.copied}，更新 ${resources.updated}，` +
        `复用 ${resources.skipped}`
    )
  }
  console.log(`打开：${resolve(result.outputPath, 'index.html')}`)
}

const main = async () => {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') {
    console.log(usage.trim())
    return
  }
  const options = parseOptions(args)
  if (command === 'create') {
    printResult(
      await createMergedArchive({
        jamiePath: required(options, 'jamie'),
        cherryPath: required(options, 'cherry'),
        outputPath: required(options, 'output'),
        name: options.name || 'Jamie / Cherry'
      })
    )
    return
  }
  if (command === 'update') {
    printResult(await updateMergedArchive(required(options, 'output')))
    return
  }
  throw new Error(`未知命令：${command}\n\n${usage.trim()}`)
}

main().catch((error) => {
  console.error(`合并失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
