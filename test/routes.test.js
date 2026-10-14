import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'

import {
  ROUTE_PREFIX, ROUTE_TABLE, TEXT_LIMIT, VOICES_TTL_MS, buildT2aBody, createRuntime, isLoopbackRequest, mimeForExt,
} from '../lib/core.js'

const AUDIO_TEXT = 'FAKE-AUDIO'
const AUDIO_HEX = Buffer.from(AUDIO_TEXT, 'utf8').toString('hex')

const json = (payload) => ({ text: async () => JSON.stringify(payload) })
const t2aOk = (hex = AUDIO_HEX, chars = 42) => json({
  base_resp: { status_code: 0, status_msg: 'ok' },
  data: { audio: hex },
  extra_info: { audio_length: 800, usage_characters: chars },
  trace_id: 'trace-1',
})
const voiceOk = (groups = {}) => json({ base_resp: { status_code: 0, status_msg: 'ok' }, ...groups })
const modeOf = (file) => statSync(file).mode & 0o777

function harness({ config = {}, responses = [], clock = { value: 1700000000000 }, openDirImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mtts-routes-'))
  const calls = []
  const opened = []
  const queue = [...responses]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected upstream fetch')
    return next
  }
  const runtime = createRuntime({
    dir, homeDir: join(dir, 'home'), config: { apiKey: 'sk-test', ...config }, fetchImpl, now: () => clock.value,
    // 默认注入假实现：测试里绝不真的去 spawn 系统打开命令
    openDirImpl: openDirImpl ?? (async (target) => { opened.push(target); return true }),
  })
  return {
    dir, calls, opened, runtime, clock,
    send: (req) => runtime.dispatch(req),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('ROUTE_TABLE 与 SPEC §5 的 9 条路径逐条一致', () => {
  assert.equal(ROUTE_TABLE.length, 9)
  const expected = [
    ['/synthesize', 'POST', 'exact'],
    ['/config', 'GET', 'exact'],
    ['/config', 'POST', 'exact'],
    ['/audio', 'GET', 'prefix'],
    ['/cache', 'GET', 'exact'],
    ['/cache/clear', 'POST', 'exact'],
    ['/cache/open', 'POST', 'exact'],
    ['/pending', 'GET', 'exact'],
    ['/pending/claim', 'POST', 'exact'],
    ['/voices', 'POST', 'exact'],
  ]
  const paths = (rows) => [...new Set(rows)].sort()
  assert.deepEqual(
    paths(expected.map(([suffix]) => `${ROUTE_PREFIX}${suffix}`)),
    paths(ROUTE_TABLE.map((entry) => entry.path)),
  )
  for (const [suffix, method, kind] of expected) {
    const route = ROUTE_TABLE.find((entry) => entry.path === `${ROUTE_PREFIX}${suffix}`)
    assert.ok(route, `缺少路由 ${ROUTE_PREFIX}${suffix}`)
    assert.equal(route.kind, kind, `${suffix} 的 kind`)
    assert.equal(typeof route.methods[method], 'string', `${suffix} 缺 ${method} handler`)
  }
})

test('dispatch：SPEC §5 每条路由都被 handler 接下（无一落入 404）', async () => {
  const h = harness({ responses: [t2aOk(), voiceOk({ system_voice: [{ voice_id: 'a', voice_name: 'A' }] })] })
  try {
    const created = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '随便一句话' } })
    const probes = [
      { label: 'POST /synthesize（空文本）', req: { method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '' } } },
      { label: 'POST /voices', req: { method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} } },
      { label: 'GET /config', req: { method: 'GET', path: `${ROUTE_PREFIX}/config` } },
      { label: 'POST /config', req: { method: 'POST', path: `${ROUTE_PREFIX}/config`, body: { patch: { speed: 1.2 } } } },
      { label: 'GET /audio', req: { method: 'GET', path: created.json.url } },
      { label: 'GET /cache', req: { method: 'GET', path: `${ROUTE_PREFIX}/cache` } },
      { label: 'POST /cache/clear', req: { method: 'POST', path: `${ROUTE_PREFIX}/cache/clear`, body: {} } },
      { label: 'POST /cache/open', req: { method: 'POST', path: `${ROUTE_PREFIX}/cache/open`, body: {} } },
      { label: 'GET /pending', req: { method: 'GET', path: `${ROUTE_PREFIX}/pending`, query: { sessionId: 's1' } } },
      { label: 'POST /pending/claim', req: { method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: { sessionId: 's1' } } },
    ]
    for (const { label, req } of probes) {
      const res = await h.send(req)
      assert.equal(res.status, 200, `${label} 未命中 handler（status ${res.status}）`)
    }
    // 一次合成 + 一次音色目录；其余探针不该发请求
    assert.equal(h.calls.length, 2)
  } finally { h.done() }
})

test('POST /voices：四组按序投影成 { id, name }，空 id 丢弃、同 id 先出现者胜、其余字段不透传', async () => {
  const h = harness({
    responses: [voiceOk({
      voice_slots: [{ voice_id: 'slot-1', voice_name: '插槽音色' }],
      system_voice: [
        { voice_id: 'female-shaonv', voice_name: '少女音色', description: ['描述不透传'] },
        { voice_id: '   ', voice_name: '空白 id 丢弃' },
        { voice_id: 'male-qn-qingse', description: ['无 voice_name'] },
      ],
      voice_cloning: [
        { voice_id: 'female-shaonv', voice_name: '重复 id 先出现者胜' },
        { voice_id: ' copy-a ', voice_name: '克隆 A', created_time: 1712345678 },
      ],
      voice_generation: [{ voice_id: 'gen-a', voice_name: '' }],
      music_generation: [{ voice_id: 'music-a', voice_name: '音乐人声' }],
    })],
  })
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, {
      ok: true,
      fetchedAt: 1700000000000,
      cached: false,
      count: 5,
      voices: [
        { id: 'female-shaonv', name: '少女音色' },
        { id: 'male-qn-qingse', name: '' },
        { id: 'copy-a', name: '克隆 A' },
        { id: 'gen-a', name: '' },
        { id: 'music-a', name: '音乐人声' },
      ],
    })
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, 'https://api.minimax.cn/v1/get_voice')
    assert.equal(h.calls[0].init.method, 'POST')
    assert.equal(h.calls[0].init.headers.authorization, 'Bearer sk-test')
    assert.deepEqual(h.calls[0].body, { voice_type: 'all' })
  } finally { h.done() }
})

test('POST /voices：内存缓存 24h、按 baseUrl 分键，refresh:true 无条件回源', async () => {
  const h = harness({ responses: [
    voiceOk({ system_voice: [{ voice_id: 'a', voice_name: 'A' }] }),
    voiceOk({ system_voice: [{ voice_id: 'b', voice_name: 'B' }] }),
    voiceOk({ system_voice: [{ voice_id: 'c', voice_name: 'C' }] }),
    voiceOk({ system_voice: [{ voice_id: 'd', voice_name: 'D' }] }),
  ] })
  try {
    const first = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} })
    assert.deepEqual(first.json.voices, [{ id: 'a', name: 'A' }])
    assert.equal(first.json.cached, false)

    const second = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices` })
    assert.deepEqual(second.json, { ...first.json, cached: true })
    assert.equal(h.calls.length, 1)

    h.clock.value += VOICES_TTL_MS + 1
    const expired = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} })
    assert.deepEqual(expired.json.voices, [{ id: 'b', name: 'B' }])
    assert.equal(expired.json.cached, false)
    assert.equal(h.calls.length, 2)

    const refreshed = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: { refresh: true } })
    assert.deepEqual(refreshed.json.voices, [{ id: 'c', name: 'C' }])
    assert.equal(refreshed.json.cached, false)
    assert.equal(h.calls.length, 3)

    // 换域名：按 baseUrl 分键 → 重新取（apiKey 保留 DSH 注入值：saveConfig 不再把它盖成空串）
    h.runtime.saveConfig({ baseUrl: 'https://api.example.com/' })
    const other = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} })
    assert.deepEqual(other.json.voices, [{ id: 'd', name: 'D' }])
    assert.equal(other.json.cached, false)
    assert.equal(h.calls.length, 4)
    assert.equal(h.calls[3].url, 'https://api.example.com/v1/get_voice')
  } finally { h.done() }
})

test('POST /voices：apiKey 为空时直接 api-key-missing 且不发请求；GET 得 405', async () => {
  const previous = process.env.MINIMAX_API_KEY
  delete process.env.MINIMAX_API_KEY
  const h = harness({ config: { apiKey: '' } })
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: false, error: 'api-key-missing' })
    assert.equal(h.calls.length, 0)

    const wrongMethod = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/voices` })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.allow, 'POST')
    assert.equal(h.calls.length, 0)
  } finally {
    h.done()
    if (previous === undefined) delete process.env.MINIMAX_API_KEY
    else process.env.MINIMAX_API_KEY = previous
  }
})

test('POST /voices：上游 base_resp 非 0 时透传 statusCode/statusMsg，且不污染已有缓存', async () => {
  const h = harness({ responses: [
    voiceOk({ system_voice: [{ voice_id: 'a', voice_name: 'A' }] }),
    json({ base_resp: { status_code: 1004, status_msg: 'login fail, invalid api key' } }),
  ] })
  try {
    const ok = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.cached, false)

    const bad = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: { refresh: true } })
    assert.equal(bad.status, 200)
    assert.deepEqual(bad.json, {
      ok: false, error: 'minimax-error', statusCode: 1004, statusMsg: 'login fail, invalid api key',
    })
    assert.equal(h.calls.length, 2)

    const stale = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/voices`, body: {} })
    assert.equal(stale.json.cached, true)
    assert.deepEqual(stale.json.voices, [{ id: 'a', name: 'A' }])
    assert.equal(h.calls.length, 2)
  } finally { h.done() }
})

test('POST /synthesize：成功落盘并返回 url/chars/totalChars，上游收到清洗后文本', async () => {
  const h = harness({ responses: [t2aOk()] })
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '你好 `code` 世界' } })
    assert.equal(res.status, 200)
    assert.deepEqual({ ...res.json, url: undefined }, { ok: true, cached: false, chars: 42, totalChars: 42, url: undefined })
    assert.match(res.json.url, /^\/dsh-minimax-tts\/audio\/[a-f0-9]{64}\.mp3$/)

    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, 'https://api.minimax.cn/v1/t2a_v2')
    assert.equal(h.calls[0].init.method, 'POST')
    assert.equal(h.calls[0].init.headers.authorization, 'Bearer sk-test')
    assert.equal(h.calls[0].init.headers['content-type'], 'application/json')
    assert.ok(h.calls[0].init.signal !== undefined)
    const body = h.calls[0].body
    assert.equal(body.text, '你好 世界')
    assert.equal(body.model, 'speech-2.8-hd')
    assert.equal(body.stream, false)
    assert.deepEqual(body.voice_setting, { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0 })
    assert.deepEqual(body.audio_setting, { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 })
    assert.equal(body.language_boost, 'auto')

    const file = join(h.runtime.dir, 'cache', res.json.url.slice(res.json.url.lastIndexOf('/') + 1))
    assert.equal(modeOf(file), 0o600)
    assert.equal(readFileSync(file, 'utf8'), AUDIO_TEXT)
  } finally { h.done() }
})

test('POST /synthesize：命中缓存时不发起任何上游请求', async () => {
  const h = harness({ responses: [t2aOk()] })
  try {
    const first = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '同一句话' } })
    const second = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '同一句话' } })
    assert.equal(h.calls.length, 1)
    assert.equal(first.json.cached, false)
    assert.equal(second.json.cached, true)
    assert.equal(second.json.url, first.json.url)
    assert.equal(second.json.chars, 42)
    assert.equal(second.json.totalChars, 42)
  } finally { h.done() }
})

test('POST /synthesize：base_resp.status_code 非 0 时 ok:false 并透传 statusCode/statusMsg', async () => {
  const h = harness({ responses: [json({ base_resp: { status_code: 1004, status_msg: 'login fail: please check your api key' } })] })
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '你好' } })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error, 'minimax-error')
    assert.equal(res.json.statusCode, 1004)
    assert.equal(res.json.statusMsg, 'login fail: please check your api key')
    assert.equal(h.runtime.cache.stats().count, 0)
  } finally { h.done() }
})

test('POST /synthesize：data 为 null 或 audio 为空时给出 empty-audio', async () => {
  const nullData = harness({ responses: [json({ base_resp: { status_code: 0 }, data: null })] })
  try {
    const res = await nullData.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '你好' } })
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error, 'empty-audio')
  } finally { nullData.done() }

  const blank = harness({ responses: [json({ base_resp: { status_code: 0 }, data: { audio: '' } })] })
  try {
    const res = await blank.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '你好' } })
    assert.equal(res.json.error, 'empty-audio')
  } finally { blank.done() }
})

test('POST /synthesize：清洗后为空 → empty-after-clean，不发任何请求', async () => {
  const h = harness({ responses: [] })
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '```js\nconst a = 1\n```' } })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error, 'empty-after-clean')
    assert.equal(res.json.chars, 0)
    assert.equal(h.calls.length, 0)
  } finally { h.done() }
})

test('POST /synthesize：文本达到上限 → text-too-large，不发任何请求', async () => {
  const h = harness({ responses: [] })
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: 'a'.repeat(TEXT_LIMIT) } })
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error, 'text-too-large')
    assert.equal(res.json.length, TEXT_LIMIT)
    assert.equal(res.json.limit, TEXT_LIMIT)
    assert.equal(h.calls.length, 0)
  } finally { h.done() }
})

test('POST /synthesize：没有 api key → api-key-missing，不发任何请求', async () => {
  const saved = process.env.MINIMAX_API_KEY
  delete process.env.MINIMAX_API_KEY
  const h = harness({ config: { apiKey: '' }, responses: [] })
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '你好' } })
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error, 'api-key-missing')
    assert.equal(h.calls.length, 0)
  } finally {
    h.done()
    if (saved === undefined) delete process.env.MINIMAX_API_KEY
    else process.env.MINIMAX_API_KEY = saved
  }
})

test('POST /synthesize：请求级 params 覆盖生效并夹到合法区间，format 决定落盘后缀', async () => {
  const h = harness({ responses: [t2aOk()] })
  try {
    const res = await h.send({
      method: 'POST',
      path: `${ROUTE_PREFIX}/synthesize`,
      body: {
        text: '换音色',
        params: {
          voiceId: 'male-qn-qingse', model: 'speech-2.6-hd', emotion: 'happy', speed: 99, vol: 0, pitch: 20,
          format: 'wav', sampleRate: 16000, bitrate: 64000, channel: 2, languageBoost: 'Chinese',
        },
      },
    })
    assert.equal(res.json.ok, true)
    assert.match(res.json.url, /\.wav$/)
    const body = h.calls[0].body
    assert.equal(body.model, 'speech-2.6-hd')
    assert.deepEqual(body.voice_setting, { voice_id: 'male-qn-qingse', speed: 2, vol: 0.01, pitch: 12, emotion: 'happy' })
    assert.deepEqual(body.audio_setting, { sample_rate: 16000, bitrate: 64000, format: 'wav', channel: 2 })
    assert.equal(body.language_boost, 'Chinese')
  } finally { h.done() }
})

test('synthesize：languageBoost 为空串 = 不带 language_boost（官方默认 null＝不增强）', async () => {
  const h = harness({ responses: [t2aOk()] })
  try {
    const res = await h.send({
      method: 'POST',
      path: `${ROUTE_PREFIX}/synthesize`,
      body: { text: '不增强', params: { languageBoost: '' } },
    })
    assert.equal(res.json.ok, true)
    assert.equal('language_boost' in h.calls[0].body, false)
  } finally { h.done() }
})

test('GET /audio/<hash>.<ext>：回二进制 + content-type，并拒绝路径穿越与伪造名', async () => {
  const h = harness({ responses: [t2aOk()] })
  try {
    const created = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '要回放的话' } })
    const res = await h.send({ method: 'GET', path: created.json.url })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'audio/mpeg')
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(AUDIO_TEXT)))
    assert.equal(res.headers['x-tts-chars'], '42')
    assert.equal(res.headers['cache-control'], 'private, max-age=3600')
    assert.ok(Buffer.isBuffer(res.body))
    assert.equal(res.body.toString('utf8'), AUDIO_TEXT)

    const denied = [
      `${ROUTE_PREFIX}/audio/../config.json`,
      `${ROUTE_PREFIX}/audio/%2e%2e%2fconfig.json`,
      `${ROUTE_PREFIX}/audio/nothex.mp3`,
      `${ROUTE_PREFIX}/audio/${'0'.repeat(64)}.mp3`,
      `${ROUTE_PREFIX}/audio/`,
    ]
    for (const path of denied) {
      const miss = await h.send({ method: 'GET', path })
      assert.equal(miss.status, 404, `${path} 不该被放行`)
      assert.equal(miss.json.error, 'not-found')
      assert.equal(miss.body, undefined)
    }
    assert.equal(mimeForExt('mp3'), 'audio/mpeg')
    assert.equal(mimeForExt('wav'), 'audio/wav')
    assert.equal(mimeForExt('opus'), 'audio/ogg')
  } finally { h.done() }
})

test('GET /config 与 POST /config：默认值、浅合并、voices 整体替换、patch 必填', async () => {
  const h = harness({ config: { apiKey: '' } })
  try {
    const initial = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/config` })
    assert.equal(initial.json.ok, true)
    assert.equal(initial.json.config.baseUrl, 'https://api.minimax.cn')
    assert.equal(initial.json.config.model, 'speech-2.8-hd')
    assert.deepEqual(initial.json.config.voices, [{ id: 'female-shaonv', label: '', isDefault: true }])

    const patched = await h.send({
      method: 'POST',
      path: `${ROUTE_PREFIX}/config`,
      body: { patch: { speed: 1.5, voices: [{ id: 'male-qn-qingse', isDefault: true }] } },
    })
    assert.equal(patched.json.config.speed, 1.5)
    assert.deepEqual(patched.json.config.voices, [{ id: 'male-qn-qingse', label: '', isDefault: true }])
    assert.equal(existsSync(join(h.runtime.dir, 'config.json')), true)
    assert.equal(modeOf(join(h.runtime.dir, 'config.json')), 0o600)

    const again = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/config` })
    assert.equal(again.json.config.speed, 1.5)

    const bad = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/config`, body: {} })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error, 'patch-required')
  } finally { h.done() }
})

test('POST /cache/open：调用注入的 openDirImpl 一次、参数是缓存目录绝对路径，失败收敛为 open-failed', async () => {
  const h = harness({})
  try {
    const res = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/cache/open`, body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, dir: join(h.runtime.dir, 'cache') })
    assert.equal(isAbsolute(res.json.dir), true)
    assert.deepEqual(h.opened, [join(h.runtime.dir, 'cache')])
    assert.equal(h.opened.length, 1)
    assert.equal(existsSync(join(h.runtime.dir, 'cache')), true)
  } finally { h.done() }

  const throwing = harness({ openDirImpl: async () => { throw new Error('no opener here') } })
  try {
    const res = await throwing.send({ method: 'POST', path: `${ROUTE_PREFIX}/cache/open` })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error, 'open-failed')
    assert.equal(res.json.dir, join(throwing.runtime.dir, 'cache'))
  } finally { throwing.done() }

  const refused = harness({ openDirImpl: async () => ({ ok: false }) })
  try {
    const res = await refused.send({ method: 'POST', path: `${ROUTE_PREFIX}/cache/open` })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: false, error: 'open-failed', dir: join(refused.runtime.dir, 'cache') })
  } finally { refused.done() }

  const wrongMethod = harness({})
  try {
    const res = await wrongMethod.send({ method: 'GET', path: `${ROUTE_PREFIX}/cache/open` })
    assert.equal(res.status, 405)
    assert.equal(res.json.allow, 'POST')
    assert.deepEqual(wrongMethod.opened, [])
  } finally { wrongMethod.done() }
})

test('GET /cache 与 POST /cache/clear：统计口径与清理', async () => {
  const h = harness({ responses: [t2aOk()] })
  try {
    const created = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/synthesize`, body: { text: '计量的句子' } })
    await h.send({ method: 'GET', path: created.json.url })

    const stats = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/cache` })
    assert.equal(stats.json.ok, true)
    assert.equal(stats.json.count, 1)
    assert.equal(stats.json.bytes, Buffer.byteLength(AUDIO_TEXT))
    assert.equal(stats.json.hits, 1)
    assert.equal(stats.json.totalChars, 42)
    assert.equal(stats.json.items.length, 1)
    assert.equal(stats.json.items[0].url, created.json.url)
    assert.equal(stats.json.items[0].preview, false)

    const cleared = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/cache/clear`, body: { all: true } })
    assert.equal(cleared.json.removed, 1)
    const after = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/cache` })
    assert.equal(after.json.count, 0)
    assert.equal(existsSync(join(h.runtime.dir, 'cache', created.json.url.slice(created.json.url.lastIndexOf('/') + 1))), false)
    assert.equal(existsSync(join(h.runtime.dir, 'cache', 'index.json')), true)
  } finally { h.done() }
})

test('GET /pending 与 POST /pending/claim：off 是绝对闸，开启后认领即消费 + 回放账本（SPEC §11.5）', async () => {
  const h = harness({})
  try {
    // 关闭态：不是 403/400，而是「什么都没有」——客户端据此回落读可见文本
    const closed = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/pending`, query: { sessionId: 's1' } })
    assert.deepEqual(closed.json, { ok: true, items: [] })
    const closedClaim = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: { sessionId: 's1' } })
    assert.equal(closedClaim.status, 200)
    assert.deepEqual(closedClaim.json, { ok: true, item: null })

    h.runtime.saveConfig({ emotionTts: { scope: 'global' } })
    const item = h.runtime.pending.add('s1', { text: '灵动模式待播', params: { speed: 0.95 } })
    const listed = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/pending`, query: { sessionId: 's1' } })
    assert.equal(listed.json.items.length, 1)
    assert.equal(listed.json.items[0].id, item.id)
    assert.equal(listed.json.items[0].text, '灵动模式待播')

    // 线上响应只给契约里的三个字段（不再有 claimed / binding 中间态）
    const claimed = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: { sessionId: 's1' } })
    assert.deepEqual(claimed.json, {
      ok: true,
      item: { text: '灵动模式待播', params: { speed: 0.95 }, createdAt: item.createdAt },
    })
    // 认领即消费：第二次得到 null，同一份稿子不会被播两遍
    const again = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: { sessionId: 's1' } })
    assert.deepEqual(again.json, { ok: true, item: null })

    // 客户端拿不到 sessionId 时 body 是空对象：走 current.json 降级，不能报 400
    h.runtime.pending.add(undefined, { text: '无会话降级' })
    const degraded = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: {} })
    assert.equal(degraded.status, 200)
    assert.equal(degraded.json.item.text, '无会话降级')

    // 回放账本（SPEC §11.5）：带 messageId 认领后，同一条消息再问拿回同一份稿子，且不动队列
    h.runtime.pending.add('s3', { text: '给 m1 的稿子', params: { emotion: 'happy' } })
    const first = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: { sessionId: 's3', messageId: 'm1' } })
    assert.equal(first.json.item.text, '给 m1 的稿子')
    h.runtime.pending.add('s3', { text: '给 m2 的稿子' })
    const replay = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: { sessionId: 's3', messageId: 'm1' } })
    assert.equal(replay.json.item.text, '给 m1 的稿子')
    assert.deepEqual(replay.json.item.params, { emotion: 'happy' })
    const next = await h.send({ method: 'POST', path: `${ROUTE_PREFIX}/pending/claim`, body: { sessionId: 's3', messageId: 'm2' } })
    assert.equal(next.json.item.text, '给 m2 的稿子')

    const other = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/pending`, query: { sessionId: 's2' } })
    assert.deepEqual(other.json.items, [])
  } finally { h.done() }
})

test('GET /pending/claim 只认 POST：GET 得 405（客户端只发 POST）', async () => {
  const h = harness({})
  try {
    const res = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/pending/claim` })
    assert.equal(res.status, 405)
    assert.equal(res.json.error, 'method-not-allowed')
    assert.equal(res.json.allow, 'POST')
  } finally { h.done() }
})

test('dispatch：方法不符 405（带 allow），未知路径 404', async () => {
  const h = harness({})
  try {
    const wrongMethod = await h.send({ method: 'GET', path: `${ROUTE_PREFIX}/synthesize` })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.error, 'method-not-allowed')
    assert.equal(wrongMethod.json.allow, 'POST')

    const deleteCache = await h.send({ method: 'DELETE', path: `${ROUTE_PREFIX}/cache` })
    assert.equal(deleteCache.status, 405)
    assert.equal(deleteCache.json.allow, 'GET')

    for (const path of [`${ROUTE_PREFIX}/nope`, ROUTE_PREFIX, `${ROUTE_PREFIX}/cache/x`, '/']) {
      const miss = await h.send({ method: 'GET', path })
      assert.equal(miss.status, 404, `${path} 不该被路由`)
      assert.equal(miss.json.error, 'not-found')
    }
  } finally { h.done() }
})

test('isLoopbackRequest：只放行本机回环且同源', () => {
  const base = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3080' } }
  assert.equal(isLoopbackRequest(base), true)
  assert.equal(isLoopbackRequest({ remoteAddress: '::ffff:127.0.0.1', headers: { host: 'localhost:3080' } }), true)
  assert.equal(isLoopbackRequest({ remoteAddress: '::1', headers: { host: '[::1]:3080' } }), true)
  assert.equal(isLoopbackRequest({ remoteAddress: '::1', headers: { host: '[::1]:3080', origin: 'http://[::1]:3080' } }), true)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), false)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: 'evil.example' } }), false)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isLoopbackRequest({ remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:3080' } }), false)
  assert.equal(isLoopbackRequest({ remoteAddress: '127.0.0.1', headers: {} }), false)
  assert.equal(isLoopbackRequest({}), false)
})

test('buildT2aBody：SPEC §8 的请求体形状与 advance 开关', () => {
  const params = { speed: 1.2, vol: 3, pitch: -2, emotion: 'happy', format: 'mp3', sampleRate: 32000, bitrate: 128000, channel: 1, languageBoost: 'auto' }
  assert.deepEqual(
    buildT2aBody({ text: '你好', model: 'speech-2.8-hd', voiceId: 'female-shaonv', params }),
    {
      model: 'speech-2.8-hd',
      text: '你好',
      stream: false,
      voice_setting: { voice_id: 'female-shaonv', speed: 1.2, vol: 3, pitch: -2, emotion: 'happy' },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      language_boost: 'auto',
    },
  )
  assert.deepEqual(
    buildT2aBody({
      text: 'x', model: 'speech-2.8-hd', voiceId: 'v',
      params: { ...params, emotion: '' },
      advance: {
        textNormalizationMode: 'normalize', latexRead: true, pronunciationTone: ['处理/(chu3)(li3)', ''],
        aigcWatermark: true, outputFormat: 'hex', forceCbr: true, voiceModify: { pitch: 1 }, subtitleEnable: true,
      },
    }),
    {
      model: 'speech-2.8-hd',
      text: 'x',
      stream: false,
      voice_setting: { voice_id: 'v', speed: 1.2, vol: 3, pitch: -2, latex_read: true },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1, force_cbr: true },
      language_boost: 'auto',
      text_normalization_mode: 'normalize',
      pronunciation_dict: { tone: ['处理/(chu3)(li3)'] },
      voice_modify: { pitch: 1 },
      subtitle_enable: true,
      output_format: 'hex',
      aigc_watermark: true,
    },
  )
})
