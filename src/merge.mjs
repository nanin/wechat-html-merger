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

const ARCHIVE_ASSIGNMENT = 'window.__WECHAT_EXPORT__ = '
const CONFIG_FILE = 'merge-config.json'
const RESOURCE_DIRS = ['avatars', 'media', 'voices', 'files']
const LOCAL_RESOURCE_PREFIXES = RESOURCE_DIRS.map((name) => `${name}/`)
const LOADING_STYLE = `
.archive-loading {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: #f2f7f4;
  color: #1d2b26;
  opacity: 1;
  visibility: visible;
  transition: opacity .2s ease, visibility .2s ease;
}
.archive-loading.ready { opacity: 0; visibility: hidden; pointer-events: none; }
.archive-loading-inner { display: grid; justify-items: center; gap: 12px; padding: 24px; text-align: center; }
.archive-loading-visual { position: relative; width: 66px; height: 58px; }
.archive-loading-bubble {
  position: absolute;
  inset: 0 4px 10px 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 8px;
  background: #23866f;
  box-shadow: 0 8px 22px #173f3526;
}
.archive-loading-bubble::after {
  content: '';
  position: absolute;
  right: 9px;
  bottom: -8px;
  border-width: 8px 0 0 11px;
  border-style: solid;
  border-color: transparent transparent transparent #23866f;
}
.archive-loading-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fff;
  animation: archive-loading-pulse 1s ease-in-out infinite;
}
.archive-loading-dot:nth-child(2) { animation-delay: .14s; }
.archive-loading-dot:nth-child(3) { animation-delay: .28s; }
.archive-loading-title { font-size: 16px; font-weight: 650; }
.archive-loading-detail { min-height: 20px; color: #6f7e78; font-size: 13px; }
.archive-loading.failed .archive-loading-bubble { background: #b14a3b; }
.archive-loading.failed .archive-loading-bubble::after { border-left-color: #b14a3b; }
.archive-loading.failed .archive-loading-dot { display: none; }
.archive-loading.failed .archive-loading-bubble::before { content: '!'; color: #fff; font-size: 28px; font-weight: 700; }
@keyframes archive-loading-pulse {
  0%, 70%, 100% { opacity: .4; transform: translateY(0); }
  35% { opacity: 1; transform: translateY(-4px); }
}
@media (prefers-reduced-motion: reduce) {
  .archive-loading-dot { animation: none; }
  .archive-loading { transition: none; }
}
`
const LOADING_MARKUP = `
  <div class="archive-loading" id="archive-loading" role="status" aria-live="polite">
    <div class="archive-loading-inner">
      <div class="archive-loading-visual" aria-hidden="true">
        <div class="archive-loading-bubble">
          <span class="archive-loading-dot"></span>
          <span class="archive-loading-dot"></span>
          <span class="archive-loading-dot"></span>
        </div>
      </div>
      <div class="archive-loading-title" id="archive-loading-title">正在加载聊天记录</div>
      <div class="archive-loading-detail" id="archive-loading-detail">消息较多，请稍候</div>
    </div>
  </div>`

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

const writeArchive = async (outputPath, metadata, messages) => {
  const dataDir = join(outputPath, 'data')
  const destinationPath = join(dataDir, 'messages.js')
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`
  await mkdir(dataDir, { recursive: true })
  const stream = createWriteStream(temporaryPath, { encoding: 'utf8' })
  try {
    const metadataJson = safeJson(metadata)
    await writeStreamChunk(
      stream,
      `${ARCHIVE_ASSIGNMENT}${metadataJson.slice(0, -1)},"messages":[`
    )
    for (let index = 0; index < messages.length; index += 1) {
      await writeStreamChunk(stream, `${index ? ',' : ''}${safeJson(messages[index])}`)
    }
    stream.end(']};\n')
    await finished(stream)
    await replaceFileAtomically(temporaryPath, destinationPath, true)
  } catch (error) {
    stream.destroy()
    await rm(temporaryPath, { force: true })
    throw error
  }
}

const patchIndexTemplate = (html, name) => {
  const escapedName = safeHtml(name)
  const namedHtml = html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedName} - 聊天记录</title>`)
    .replace(
      /(<span\s+class="title"\s+id="title">)[\s\S]*?(<\/span>)/i,
      `$1${escapedName}$2`
    )
  const styledHtml = namedHtml.replace(/<\/style>/i, `${LOADING_STYLE}\n</style>`)
  if (styledHtml === namedHtml) throw new Error('源档案页面缺少样式标签，无法添加加载状态')
  const markedHtml = styledHtml.replace(/<body>/i, `<body>${LOADING_MARKUP}`)
  if (markedHtml === styledHtml) throw new Error('源档案页面缺少 body，无法添加加载状态')

  const scriptPattern =
    /<script\s+src=["']data\/messages\.js["']><\/script>\s*<script>([\s\S]*?)<\/script>\s*(?=<\/body>)/i
  const bootstrappedHtml = markedHtml.replace(scriptPattern, (_match, runtime) => `
  <script>
  (() => {
    'use strict';
    const loading = document.querySelector('#archive-loading');
    const loadingTitle = document.querySelector('#archive-loading-title');
    const loadingDetail = document.querySelector('#archive-loading-detail');
    const fail = (message) => {
      loading.classList.add('failed');
      loadingTitle.textContent = '聊天记录加载失败';
      loadingDetail.textContent = message;
    };
    const finish = () => {
      loading.classList.add('ready');
      window.setTimeout(() => loading.remove(), 240);
    };
    const startArchive = () => {
      try {
${runtime}
        finish();
      } catch (error) {
        console.error(error);
        fail(error instanceof Error ? error.message : String(error));
      }
    };
    const loadArchive = () => {
      const dataScript = document.createElement('script');
      dataScript.src = 'data/messages.js';
      dataScript.onload = startArchive;
      dataScript.onerror = () => fail('未能读取 data/messages.js');
      document.head.append(dataScript);
    };
    const begin = () => requestAnimationFrame(() => requestAnimationFrame(loadArchive));
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', begin, { once: true });
    } else {
      begin();
    }
  })();
  </script>
`)
  if (bootstrappedHtml === markedHtml) {
    throw new Error('无法替换源档案中的消息加载脚本，请先重新导出源档案')
  }
  return bootstrappedHtml
}

const writeIndex = async (outputPath, templatePath, name) => {
  const destinationPath = join(outputPath, 'index.html')
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`
  const html = patchIndexTemplate(await readFile(templatePath, 'utf8'), name)
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
  await writeArchive(output, archiveMetadata, messages)
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
  return {
    outputPath: output,
    messageCount: messages.length,
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
