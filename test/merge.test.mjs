import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createMergedArchive, updateMergedArchive } from '../src/merge.mjs'

const assignment = 'window.__WECHAT_EXPORT__ = '
const manifestAssignment = 'window.__WECHAT_MANIFEST__ = '

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const readManifest = async (root) => {
  const source = await readFile(join(root, 'data', 'manifest.js'), 'utf8')
  assert.ok(source.startsWith(manifestAssignment))
  return JSON.parse(source.slice(manifestAssignment.length).replace(/;\s*$/, ''))
}

const readMonth = async (root, entry) => {
  const context = { window: {} }
  vm.runInNewContext(await readFile(join(root, entry.file), 'utf8'), context)
  return context.window.__WECHAT_MONTH_CHUNKS__[entry.key]
}

const writeSourceArchive = async ({ messages, name, root, sourceId, updatedAt }) => {
  await mkdir(join(root, 'data'), { recursive: true })
  for (const directory of ['avatars', 'media', 'voices', 'files']) {
    await mkdir(join(root, directory), { recursive: true })
  }
  const archive = { version: 1, sourceId, name, updatedAt, messages }
  await writeFile(join(root, 'data', 'messages.js'), `${assignment}${JSON.stringify(archive)};\n`)
  await writeFile(
    join(root, 'index.html'),
    `<!doctype html><html><head><title>${name} - 聊天记录</title></head><body>` +
      `<span class="title" id="title">${name}</span>` +
      `<script src="data/messages.js"></script><script>(() => {})();</script></body></html>`
  )
}

const received = ({ avatar, createTime, id, media, name }) => ({
  id,
  sessionId: `session-${name}`,
  localId: createTime,
  createTime,
  datetime: new Date(createTime * 1000).toISOString().replace('T', ' ').replace('.000Z', ''),
  isSender: false,
  name,
  type: media ? '图片' : '文字',
  content: media ? '[图片]' : `${name}-${id}`,
  exportAvatarUrl: avatar,
  exportMediaUrl: media,
  exportMediaType: media ? 'image' : undefined
})

test('creates and incrementally refreshes a two-account archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-html-merger-'))
  const jamie = join(root, 'Jamie_聊天档案')
  const cherry = join(root, 'Cherry_聊天档案')
  const output = join(root, 'Jamie_Cherry_合并档案')

  await writeSourceArchive({
    root: jamie,
    sourceId: 'source-jamie',
    name: 'Jamie',
    updatedAt: '2026-08-03T01:00:00.000Z',
    messages: [
      received({
        id: 'j1',
        name: 'Jamie',
        createTime: 1738368000,
        avatar: 'avatars/jamie.jpg',
        media: 'media/jamie.jpg'
      })
    ]
  })
  await writeFile(join(jamie, 'avatars', 'jamie.jpg'), 'jamie-avatar')
  await writeFile(join(jamie, 'media', 'jamie.jpg'), 'jamie-image')

  await writeSourceArchive({
    root: cherry,
    sourceId: 'source-cherry',
    name: 'Cherry',
    updatedAt: '2026-08-03T02:00:00.000Z',
    messages: [
      received({
        id: 'c1',
        name: 'Cherry',
        createTime: 1735689600,
        avatar: 'avatars/cherry.jpg'
      })
    ]
  })
  await writeFile(join(cherry, 'avatars', 'cherry.jpg'), 'cherry-avatar')

  const created = await createMergedArchive({
    jamiePath: jamie,
    cherryPath: cherry,
    outputPath: output,
    name: '同一个人'
  })
  assert.equal(created.messageCount, 2)
  assert.deepEqual(created.months, { total: 2, written: 2, reused: 0 })
  const firstManifest = await readManifest(output)
  assert.equal(firstManifest.totalMessages, 2)
  assert.deepEqual(firstManifest.months.map((month) => month.key), ['2025-01', '2025-02'])
  const firstArchive = {
    messages: (await Promise.all(firstManifest.months.map((entry) => readMonth(output, entry)))).flat()
  }
  assert.deepEqual(
    firstArchive.messages.map((message) => message.name),
    ['Cherry', 'Jamie']
  )
  assert.equal(
    firstArchive.messages[0].exportAvatarUrl,
    'accounts/cherry/avatars/cherry.jpg'
  )
  assert.equal(
    firstArchive.messages[1].exportMediaUrl,
    'accounts/jamie/media/jamie.jpg'
  )
  assert.equal(
    await readFile(join(output, 'accounts', 'jamie', 'media', 'jamie.jpg'), 'utf8'),
    'jamie-image'
  )
  const indexHtml = await readFile(join(output, 'index.html'), 'utf8')
  assert.match(indexHtml, /<title>同一个人 - 聊天记录<\/title>/)
  assert.match(indexHtml, /<script src="data\/manifest\.js"><\/script>/)
  assert.match(indexHtml, /跳转到最新/)
  const inlineScripts = [...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((source) => source.trim())
  assert.equal(inlineScripts.length, 1)
  assert.doesNotThrow(() => new vm.Script(inlineScripts[0], { filename: 'merged-index.js' }))
  assert.equal(await exists(join(output, 'data', 'messages.js')), false)

  const sourceAsset = await stat(join(jamie, 'media', 'jamie.jpg'))
  const mergedAsset = await stat(join(output, 'accounts', 'jamie', 'media', 'jamie.jpg'))
  assert.equal(sourceAsset.ino, mergedAsset.ino)

  await writeSourceArchive({
    root: jamie,
    sourceId: 'source-jamie',
    name: 'Jamie',
    updatedAt: '2026-08-03T03:00:00.000Z',
    messages: [
      received({
        id: 'j1',
        name: 'Jamie',
        createTime: 1738368000,
        avatar: 'avatars/jamie.jpg',
        media: 'media/jamie.jpg'
      }),
      received({
        id: 'j2',
        name: 'Jamie',
        createTime: 1740787200,
        avatar: 'avatars/jamie.jpg',
        media: 'media/jamie-new.jpg'
      })
    ]
  })
  await writeFile(join(jamie, 'media', 'jamie-new.jpg'), 'new-image')

  const updated = await updateMergedArchive(output)
  assert.equal(updated.messageCount, 3)
  assert.deepEqual(updated.months, { total: 3, written: 1, reused: 2 })
  const secondManifest = await readManifest(output)
  assert.equal(secondManifest.totalMessages, 3)
  const secondArchive = {
    messages: (await Promise.all(secondManifest.months.map((entry) => readMonth(output, entry)))).flat()
  }
  assert.deepEqual(
    secondArchive.messages.map((message) => message.id),
    ['c1', 'j1', 'j2']
  )
  assert.equal(
    await readFile(join(output, 'accounts', 'jamie', 'media', 'jamie-new.jpg'), 'utf8'),
    'new-image'
  )

  const repeated = await updateMergedArchive(output)
  assert.equal(repeated.messageCount, 3)
  assert.deepEqual(repeated.months, { total: 3, written: 0, reused: 3 })
  assert.equal((await readManifest(output)).totalMessages, 3)
})
