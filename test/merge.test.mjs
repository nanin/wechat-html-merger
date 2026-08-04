import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createMergedArchive, readHtmlArchive, updateMergedArchive } from '../src/merge.mjs'

const assignment = 'window.__WECHAT_EXPORT__ = '

const writeSourceArchive = async ({ messages, name, root, sourceId, updatedAt }) => {
  await mkdir(join(root, 'data'), { recursive: true })
  for (const directory of ['avatars', 'media', 'voices', 'files']) {
    await mkdir(join(root, directory), { recursive: true })
  }
  const archive = { version: 1, sourceId, name, updatedAt, messages }
  await writeFile(join(root, 'data', 'messages.js'), `${assignment}${JSON.stringify(archive)};\n`)
  await writeFile(
    join(root, 'index.html'),
    `<!doctype html><html><head><title>${name} - 聊天记录</title><style>body{margin:0}</style></head>` +
      `<body><span class="title" id="title">${name}</span>` +
      `<script src="data/messages.js"></script>` +
      `<script>(() => { window.__sourceRuntimeRan = true })();</script></body></html>`
  )
}

const received = ({ avatar, createTime, id, media, name }) => ({
  id,
  sessionId: `session-${name}`,
  localId: createTime,
  createTime,
  datetime: new Date(createTime * 1000).toISOString(),
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
        createTime: 200,
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
        createTime: 100,
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
  const firstArchive = await readHtmlArchive(output)
  assert.deepEqual(
    firstArchive.archive.messages.map((message) => message.name),
    ['Cherry', 'Jamie']
  )
  assert.equal(
    firstArchive.archive.messages[0].exportAvatarUrl,
    'accounts/cherry/avatars/cherry.jpg'
  )
  assert.equal(
    firstArchive.archive.messages[1].exportMediaUrl,
    'accounts/jamie/media/jamie.jpg'
  )
  assert.equal(
    await readFile(join(output, 'accounts', 'jamie', 'media', 'jamie.jpg'), 'utf8'),
    'jamie-image'
  )
  const indexHtml = await readFile(join(output, 'index.html'), 'utf8')
  assert.match(indexHtml, /<title>同一个人 - 聊天记录<\/title>/)
  assert.match(indexHtml, /id="archive-loading"/)
  assert.match(indexHtml, /正在加载聊天记录/)
  assert.match(indexHtml, /requestAnimationFrame\(\(\) => requestAnimationFrame\(loadArchive\)\)/)
  assert.match(indexHtml, /dataScript\.src = 'data\/messages\.js'/)
  assert.match(indexHtml, /function currentViewportAnchor\(\)/)
  assert.match(indexHtml, /function exactMessageForMode\(anchorKey, selectedMode\)/)
  assert.match(indexHtml, /const savedTabLocations = \{ all: null, media: null, file: null, share: null \}/)
  assert.match(indexHtml, /saveTabLocation\(previousMode, visibleAnchor\)/)
  assert.match(indexHtml, /if \(savedTabLocations\[mode\]\)/)
  assert.match(indexHtml, /anchorOffset: saved\.offset/)
  assert.match(indexHtml, /make\('button', 'locate-message', '⌖'\)/)
  assert.match(indexHtml, /locate\.dataset\.tooltip = '定位到聊天位置'/)
  assert.match(indexHtml, /function locateMessageInAll\(message, article\)/)
  assert.match(indexHtml, /locateMessageInAll\(message, article\)/)
  assert.match(indexHtml, /item\.dataset\.mode === 'all'/)
  assert.match(indexHtml, /message\.archiveAccountId/)
  assert.match(indexHtml, /filterLoadPending = targetIndex < 0/)
  assert.match(indexHtml, /anchorMessage: target/)
  assert.doesNotMatch(indexHtml, /nearestMessageForTimestamp/)
  assert.doesNotMatch(indexHtml, /hasScrolledMoreThanOneMessage/)
  assert.doesNotMatch(indexHtml, /tabAnchorKey|tabScrollBaselineKey/)
  assert.doesNotMatch(indexHtml, /nearestMessageForMode/)
  assert.doesNotMatch(indexHtml, /window\.__sourceRuntimeRan = true/)
  assert.doesNotMatch(indexHtml, /<script src="data\/messages\.js"><\/script>/)
  const inlineScripts = [...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((source) => source.trim())
  assert.equal(inlineScripts.length, 1)
  assert.doesNotThrow(() => new vm.Script(inlineScripts[0], { filename: 'merged-index.js' }))

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
        createTime: 200,
        avatar: 'avatars/jamie.jpg',
        media: 'media/jamie.jpg'
      }),
      received({
        id: 'j2',
        name: 'Jamie',
        createTime: 300,
        avatar: 'avatars/jamie.jpg',
        media: 'media/jamie-new.jpg'
      })
    ]
  })
  await writeFile(join(jamie, 'media', 'jamie-new.jpg'), 'new-image')

  const updated = await updateMergedArchive(output)
  assert.equal(updated.messageCount, 3)
  const secondArchive = await readHtmlArchive(output)
  assert.deepEqual(
    secondArchive.archive.messages.map((message) => message.id),
    ['c1', 'j1', 'j2']
  )
  assert.equal(
    await readFile(join(output, 'accounts', 'jamie', 'media', 'jamie-new.jpg'), 'utf8'),
    'new-image'
  )

  const repeated = await updateMergedArchive(output)
  assert.equal(repeated.messageCount, 3)
  assert.equal((await readHtmlArchive(output)).archive.messages.length, 3)
})
