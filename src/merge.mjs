import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  link,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ARCHIVE_ASSIGNMENT = 'window.__WECHAT_EXPORT__ = '
const MANIFEST_ASSIGNMENT = 'window.__WECHAT_MANIFEST__ = '
const CONFIG_FILE = 'merge-config.json'
const RESOURCE_DIRS = ['avatars', 'media', 'voices', 'files']
const LOCAL_RESOURCE_PREFIXES = RESOURCE_DIRS.map((name) => `${name}/`)

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const safeJson = (value) =>
  JSON.stringify(value).replace(/[\u2028\u2029]/g, (character) =>
    character === '\u2028' ? '\\u2028' : '\\u2029'
  )

const safeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] || character
  )

const parseArchiveSource = (source, dataPath) => {
  if (!source.startsWith(ARCHIVE_ASSIGNMENT)) {
    throw new Error(`不是有效的 WechatExplorer HTML 数据文件：${dataPath}`)
  }
  const json = source.slice(ARCHIVE_ASSIGNMENT.length).replace(/;\s*$/, '')
  const archive = JSON.parse(json)
  if (!archive || !Array.isArray(archive.messages)) {
    throw new Error(`聊天数据格式不完整：${dataPath}`)
  }
  return archive
}

export async function readHtmlArchive(rootPath) {
  const root = resolve(rootPath)
  const dataPath = join(root, 'data', 'messages.js')
  const indexPath = join(root, 'index.html')
  let source = await readFile(dataPath, 'utf8')
  const archive = parseArchiveSource(source, dataPath)
  source = ''
  const indexStat = await stat(indexPath)
  const sourceId = String(archive.sourceId || '').trim()
  if (!sourceId) throw new Error(`档案缺少 sourceId：${dataPath}`)
  return { archive, dataPath, indexPath, indexMtimeMs: indexStat.mtimeMs, root, sourceId }
}

const archiveMessageTime = (message) => {
  const createTime = Number(message.createTime || 0)
  if (Number.isFinite(createTime) && createTime > 0) return createTime * 1000
  const parsed = Date.parse(String(message.datetime || ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

const rewriteResourceUrl = (value, accountId) => {
  if (typeof value !== 'string' || !value) return value
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!LOCAL_RESOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return value
  if (normalized.includes('../') || normalized.startsWith('/')) return value
  return `accounts/${accountId}/${normalized}`
}

const prepareMessages = (source) => {
  const messages = source.archive.messages
  for (const message of messages) {
    message.archiveAccountId = source.id
    if (!message.isSender && !message.name) message.name = source.label
    for (const field of [
      'exportMediaUrl',
      'voiceDataUrl',
      'exportFileUrl',
      'exportAvatarUrl'
    ]) {
      message[field] = rewriteResourceUrl(message[field], source.id)
    }
  }
  return messages
}

const sortMessages = (messages, accountOrder) => {
  messages.sort((left, right) => {
    const timeDelta = archiveMessageTime(left) - archiveMessageTime(right)
    if (timeDelta) return timeDelta
    const localDelta = Number(left.localId || 0) - Number(right.localId || 0)
    if (localDelta) return localDelta
    return accountOrder.get(left.archiveAccountId) - accountOrder.get(right.archiveAccountId)
  })
  return messages
}

const ensureIndependentOutput = (outputPath, sourcePaths) => {
  const output = resolve(outputPath)
  for (const sourcePath of sourcePaths) {
    const source = resolve(sourcePath)
    if (output === source || output.startsWith(`${source}${sep}`)) {
      throw new Error(`合并档案不能创建在源档案内部：${output}`)
    }
  }
}

const replaceFileAtomically = async (temporaryPath, destinationPath, backup = false) => {
  if (backup && (await exists(destinationPath))) {
    await copyFile(destinationPath, `${destinationPath}.bak`)
  }
  await rename(temporaryPath, destinationPath)
}

const writeStreamChunk = async (stream, chunk) => {
  if (stream.write(chunk)) return
  await new Promise((resolveDrain, rejectDrain) => {
    const onError = (error) => {
      stream.off('drain', onDrain)
      rejectDrain(error)
    }
    const onDrain = () => {
      stream.off('error', onError)
      resolveDrain()
    }
    stream.once('error', onError)
    stream.once('drain', onDrain)
  })
}

const writeMonthChunk = async (outputPath, key, hash, messages) => {
  const monthsDir = join(outputPath, 'data', 'months')
  const fileName = `${key}.${hash.slice(0, 16)}.js`
  const destinationPath = join(monthsDir, fileName)
  if (await exists(destinationPath)) return { fileName, written: false }
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`
  await mkdir(monthsDir, { recursive: true })
  const stream = createWriteStream(temporaryPath, { encoding: 'utf8' })
  try {
    await writeStreamChunk(
      stream,
      `window.__WECHAT_MONTH_CHUNKS__ = window.__WECHAT_MONTH_CHUNKS__ || {};\n` +
        `window.__WECHAT_MONTH_CHUNKS__[${safeJson(key)}] = [`
    )
    for (let index = 0; index < messages.length; index += 1) {
      await writeStreamChunk(stream, `${index ? ',' : ''}${safeJson(messages[index])}`)
    }
    stream.end('];\n')
    await finished(stream)
    await replaceFileAtomically(temporaryPath, destinationPath)
    return { fileName, written: true }
  } catch (error) {
    stream.destroy()
    await rm(temporaryPath, { force: true })
    throw error
  }
}

const messageMonth = (message) => {
  const datetimeMatch = String(message.datetime || '').match(/^(\d{4})[/-](\d{1,2})/)
  if (datetimeMatch) {
    const year = Number(datetimeMatch[1])
    const month = Number(datetimeMatch[2])
    if (year > 0 && month >= 1 && month <= 12) {
      return { key: `${year}-${String(month).padStart(2, '0')}`, month, year }
    }
  }
  const timestamp = archiveMessageTime(message)
  if (!timestamp) throw new Error(`消息缺少有效时间：${message.id || message.localId || '未知消息'}`)
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  return { key: `${year}-${String(month).padStart(2, '0')}`, month, year }
}

const groupMessagesByMonth = (messages) => {
  const groups = new Map()
  for (const message of messages) {
    const period = messageMonth(message)
    if (!groups.has(period.key)) groups.set(period.key, { ...period, messages: [] })
    groups.get(period.key).messages.push(message)
  }
  return Array.from(groups.values()).sort((left, right) => left.key.localeCompare(right.key))
}

const hashMessages = (messages) => {
  const hash = createHash('sha256')
  for (const message of messages) hash.update(safeJson(message)).update('\n')
  return hash.digest('hex')
}

const readManifest = async (outputPath) => {
  const manifestPath = join(outputPath, 'data', 'manifest.js')
  try {
    const source = await readFile(manifestPath, 'utf8')
    if (!source.startsWith(MANIFEST_ASSIGNMENT)) return null
    return JSON.parse(source.slice(MANIFEST_ASSIGNMENT.length).replace(/;\s*$/, ''))
  } catch {
    return null
  }
}

const writeManifest = async (outputPath, manifest) => {
  const destinationPath = join(outputPath, 'data', 'manifest.js')
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`
  await mkdir(dirname(destinationPath), { recursive: true })
  await writeFile(temporaryPath, `${MANIFEST_ASSIGNMENT}${safeJson(manifest)};\n`, 'utf8')
  await replaceFileAtomically(temporaryPath, destinationPath, true)
}

const cleanupOldMonthChunks = async (outputPath, currentFiles, previousFiles) => {
  const monthsDir = join(outputPath, 'data', 'months')
  if (!(await exists(monthsDir))) return
  const keep = new Set([...currentFiles, ...previousFiles])
  for (const entry of await readdir(monthsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js') && !keep.has(entry.name)) {
      await rm(join(monthsDir, entry.name), { force: true })
    }
  }
}

const writeMonthlyArchive = async (outputPath, metadata, messages) => {
  const previousManifest = await readManifest(outputPath)
  const previousFiles = new Set(
    Array.isArray(previousManifest?.months)
      ? previousManifest.months.map((month) => String(month.file || '').split('/').pop())
      : []
  )
  const months = []
  let written = 0
  for (const group of groupMessagesByMonth(messages)) {
    const hash = hashMessages(group.messages)
    const chunk = await writeMonthChunk(outputPath, group.key, hash, group.messages)
    if (chunk.written) written += 1
    months.push({
      key: group.key,
      year: group.year,
      month: group.month,
      count: group.messages.length,
      hash,
      file: `data/months/${chunk.fileName}`,
      firstTime: group.messages[0]?.datetime || '',
      lastTime: group.messages[group.messages.length - 1]?.datetime || ''
    })
  }
  const totalMessages = months.reduce((total, month) => total + month.count, 0)
  if (totalMessages !== messages.length) throw new Error('月份消息总数校验失败')
  const manifest = { ...metadata, totalMessages, months }
  await writeManifest(outputPath, manifest)
  await cleanupOldMonthChunks(
    outputPath,
    months.map((month) => month.file.split('/').pop()),
    previousFiles
  )
  return { manifest, written, reused: months.length - written }
}

const patchIndexTemplate = (html, name) => {
  const escapedName = safeHtml(name)
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedName} - 聊天记录</title>`)
    .replace(
      /(<span\s+class="title"\s+id="title">)[\s\S]*?(<\/span>)/i,
      `$1${escapedName}$2`
    )
}

const writeIndex = async (outputPath, templatePath, name) => {
  const destinationPath = join(outputPath, 'index.html')
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`
  const runtimePath = fileURLToPath(new URL('./browser-runtime.js', import.meta.url))
  const runtime = await readFile(runtimePath, 'utf8')
  const sourceHtml = patchIndexTemplate(await readFile(templatePath, 'utf8'), name)
  const scriptPattern =
    /<script\s+src="data\/messages\.js"><\/script>\s*<script>[\s\S]*?<\/script>\s*(?=<\/body>)/i
  const replacement = `<script src="data/manifest.js"></script>\n  <script>\n${runtime}\n  </script>\n`
  const html = sourceHtml.replace(scriptPattern, () => replacement)
  if (html === sourceHtml) throw new Error('无法替换源档案中的页面运行时，请先重新导出源档案')
  await writeFile(temporaryPath, html, 'utf8')
  await replaceFileAtomically(temporaryPath, destinationPath, true)
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino

const syncFile = async (sourcePath, destinationPath, summary) => {
  const sourceStat = await stat(sourcePath)
  let destinationStat = null
  try {
    destinationStat = await stat(destinationPath)
  } catch {
    // A missing destination is created below.
  }
  if (
    destinationStat &&
    (sameFile(sourceStat, destinationStat) ||
      (sourceStat.size === destinationStat.size &&
        Math.trunc(sourceStat.mtimeMs) === Math.trunc(destinationStat.mtimeMs)))
  ) {
    summary.skipped += 1
    return
  }

  await mkdir(dirname(destinationPath), { recursive: true })
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`
  await rm(temporaryPath, { force: true })
  let method = 'linked'
  try {
    await link(sourcePath, temporaryPath)
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error?.code)) throw error
    method = 'copied'
    await copyFile(sourcePath, temporaryPath)
    await utimes(temporaryPath, sourceStat.atime, sourceStat.mtime)
  }
  await rename(temporaryPath, destinationPath)
  summary[method] += 1
  if (destinationStat) summary.updated += 1
}

const syncTree = async (sourceRoot, destinationRoot, summary) => {
  if (!(await exists(sourceRoot))) return
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(sourceRoot, entry.name)
    const destinationPath = join(destinationRoot, entry.name)
    if (entry.isDirectory()) {
      await syncTree(sourcePath, destinationPath, summary)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await syncFile(sourcePath, destinationPath, summary)
    }
  }
}

const syncResources = async (source, outputPath) => {
  const summary = { linked: 0, copied: 0, updated: 0, skipped: 0 }
  const accountRoot = join(outputPath, 'accounts', source.id)
  for (const directory of RESOURCE_DIRS) {
    await syncTree(join(source.root, directory), join(accountRoot, directory), summary)
  }
  return summary
}

const readConfig = async (outputPath) => {
  const configPath = join(resolve(outputPath), CONFIG_FILE)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (config?.version !== 1 || !Array.isArray(config.sources) || config.sources.length !== 2) {
    throw new Error(`合并配置无效：${configPath}`)
  }
  return config
}

const writeConfig = async (outputPath, config) => {
  const destinationPath = join(outputPath, CONFIG_FILE)
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await replaceFileAtomically(temporaryPath, destinationPath, true)
}

const mergedSourceId = (sources) =>
  `merged:${createHash('sha256')
    .update(sources.map((source) => `${source.id}:${source.sourceId}`).join('|'))
    .digest('hex')
    .slice(0, 24)}`

const loadConfiguredSources = async (sourceConfigs) => {
  const sources = []
  for (const sourceConfig of sourceConfigs) {
    const loaded = await readHtmlArchive(sourceConfig.path)
    if (sourceConfig.sourceId && sourceConfig.sourceId !== loaded.sourceId) {
      throw new Error(
        `${sourceConfig.label} 的 sourceId 已变化，请确认没有选择错误的聊天档案目录`
      )
    }
    sources.push({
      ...loaded,
      id: sourceConfig.id,
      label: sourceConfig.label || loaded.archive.name || sourceConfig.id
    })
  }
  return sources
}

const mergeSources = async ({ createdAt, name, outputPath, sourceConfigs }) => {
  const output = resolve(outputPath)
  ensureIndependentOutput(
    output,
    sourceConfigs.map((source) => source.path)
  )
  const sources = await loadConfiguredSources(sourceConfigs)
  await mkdir(output, { recursive: true })

  const resourceSummary = {}
  for (const source of sources) {
    resourceSummary[source.id] = await syncResources(source, output)
  }

  const accountOrder = new Map(sources.map((source, index) => [source.id, index]))
  const messages = sortMessages(sources.flatMap(prepareMessages), accountOrder)
  const now = new Date().toISOString()
  const archiveMetadata = {
    version: 2,
    sourceId: mergedSourceId(sources),
    name,
    updatedAt: now,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.label,
      sourceId: source.sourceId,
      updatedAt: source.archive.updatedAt || null,
      messageCount: source.archive.messages.length
    }))
  }
  const monthlyArchive = await writeMonthlyArchive(output, archiveMetadata, messages)
  const templateSource = [...sources].sort(
    (left, right) => right.indexMtimeMs - left.indexMtimeMs
  )[0]
  await writeIndex(output, templateSource.indexPath, name)

  const config = {
    version: 1,
    name,
    createdAt: createdAt || now,
    updatedAt: now,
    sources: sources.map((source) => ({
      id: source.id,
      label: source.label,
      path: source.root,
      sourceId: source.sourceId,
      updatedAt: source.archive.updatedAt || null,
      messageCount: source.archive.messages.length
    }))
  }
  await writeConfig(output, config)
  await rm(join(output, 'data', 'messages.js'), { force: true })
  await rm(join(output, 'data', 'messages.js.bak'), { force: true })
  return {
    outputPath: output,
    messageCount: messages.length,
    months: {
      total: monthlyArchive.manifest.months.length,
      written: monthlyArchive.written,
      reused: monthlyArchive.reused
    },
    sources: config.sources,
    resources: resourceSummary
  }
}

export async function createMergedArchive({ cherryPath, jamiePath, name, outputPath }) {
  const output = resolve(outputPath)
  if (await exists(join(output, CONFIG_FILE))) {
    throw new Error(`合并档案已经存在，请使用 update：${output}`)
  }
  if (await exists(output)) {
    const entries = await readdir(output)
    if (entries.length) throw new Error(`输出目录不是空目录：${output}`)
  }
  return mergeSources({
    name: name || 'Jamie / Cherry',
    outputPath: output,
    sourceConfigs: [
      { id: 'jamie', label: 'Jamie', path: resolve(jamiePath) },
      { id: 'cherry', label: 'Cherry', path: resolve(cherryPath) }
    ]
  })
}

export async function updateMergedArchive(outputPath) {
  const output = resolve(outputPath)
  const config = await readConfig(output)
  return mergeSources({
    createdAt: config.createdAt,
    name: config.name,
    outputPath: output,
    sourceConfigs: config.sources
  })
}
