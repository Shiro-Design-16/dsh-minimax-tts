import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NON_KEY_FIELDS, audioUrl, cacheKeyFor, createCache, normalizeConfig, resolveParams } from '../lib/core.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'mtts-cache-'))
const modeOf = (file) => statSync(file).mode & 0o777
const fakeKey = (seed) => createHash('sha256').update(String(seed)).digest('hex')
const audio = (text) => Buffer.from(text, 'utf8')

function harness({ limits = () => ({}), clock = { value: Date.parse('2026-01-01T00:00:00Z') } } = {}) {
  const dir = tempDir()
  const cache = createCache({ dir, now: () => clock.value, limits })
  return { dir, cache, clock, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('cacheKeyFor：同参数同 key，key 为 sha256 hex', () => {
  const a = cacheKeyFor({ text: '你好', params: { speed: 1 }, model: 'speech-2.8-hd', voiceId: 'female-shaonv' })
  const b = cacheKeyFor({ text: '你好', params: { speed: 1 }, model: 'speech-2.8-hd', voiceId: 'female-shaonv' })
  assert.equal(a, b)
  assert.match(a, /^[a-f0-9]{64}$/)
})

test('cacheKeyFor：改 text / params / model / voiceId 任一即变', () => {
  const base = { text: '你好', params: { speed: 1, format: 'mp3' }, model: 'speech-2.8-hd', voiceId: 'female-shaonv' }
  const key = cacheKeyFor(base)
  assert.notEqual(cacheKeyFor({ ...base, text: '你好呀' }), key)
  assert.notEqual(cacheKeyFor({ ...base, params: { speed: 1.5, format: 'mp3' } }), key)
  assert.notEqual(cacheKeyFor({ ...base, params: { speed: 1, format: 'wav' } }), key)
  assert.notEqual(cacheKeyFor({ ...base, model: 'speech-2.6-hd' }), key)
  assert.notEqual(cacheKeyFor({ ...base, voiceId: 'male-qn-qingse' }), key)
})

test('cacheKeyFor：改非 key 字段一律不影响缓存（SPEC §4 非 key 清单）', () => {
  const config = normalizeConfig({})
  const baseline = cacheKeyFor({ text: '你好', ...resolveParams(config, {}) })
  // 每项都必须是**合法**值：非法值会被 normalizeConfig 打回默认，那就等于什么都没测
  const patches = {
    apiKey: 'sk-changed',
    baseUrl: 'https://example.com',
    cleanup: { days: 1, maxItems: 1, maxBytes: 1 },
    emotionTts: { scope: 'global' },
    role: 'skill-only',
    previewText: '换一段试听文案',
    'advance.subtitleEnable': true,
    'advance.aigcWatermark': true,
    'advance.outputFormat': 'pcm',
  }
  // 清单加字段时这里会先失败，逼着补一个合法值，不留静默跳过的洞
  assert.deepEqual(Object.keys(patches).sort(), [...NON_KEY_FIELDS].sort())
  for (const field of NON_KEY_FIELDS) {
    const [head, tail] = field.includes('.') ? field.split('.') : [field, null]
    const patch = tail === null ? { [head]: patches[field] } : { [head]: { [tail]: patches[field] } }
    const next = normalizeConfig({ ...config, ...patch })
    assert.notDeepEqual(next, config, `字段 ${field} 的测试值没生效（被归一化打回默认）`)
    assert.equal(
      cacheKeyFor({ text: '你好', ...resolveParams(next, {}) }),
      baseline,
      `字段 ${field} 不应影响缓存 key`,
    )
  }
})

test('cache：put → lookup 命中，落盘 0600，索引与音频命名一致，无 .tmp', () => {
  const h = harness()
  try {
    const key = fakeKey('a')
    const item = h.cache.put({ key, ext: 'mp3', data: audio('HELLO'), chars: 5, model: 'speech-2.8-hd', voiceId: 'female-shaonv' })
    assert.equal(item.file, `${key}.mp3`)
    assert.equal(item.bytes, 5)
    assert.equal(item.hits, 0)
    assert.equal(modeOf(join(h.cache.dir, `${key}.mp3`)), 0o600)
    assert.equal(modeOf(h.cache.indexFile), 0o600)
    assert.deepEqual(readdirSync(h.cache.dir).filter((n) => n.endsWith('.tmp')), [])

    const hit = h.cache.lookup(key)
    assert.equal(hit.data.toString('utf8'), 'HELLO')
    assert.equal(hit.item.chars, 5)
    assert.equal(hit.item.hits, 1)
    assert.equal(h.cache.stats().hits, 1)
    assert.equal(h.cache.stats().totalChars, 5)
    assert.equal(h.cache.stats().items[0].url, audioUrl(key, 'mp3'))
  } finally { h.done() }
})

test('cache：同 key 重复落盘不重复累计 totalChars，保留 createdAt', () => {
  const h = harness()
  try {
    const key = fakeKey('dup')
    const first = h.cache.put({ key, ext: 'mp3', data: audio('AAAA'), chars: 7 })
    h.clock.value += 1000
    const second = h.cache.put({ key, ext: 'mp3', data: audio('AAAA'), chars: 7 })
    assert.equal(second.createdAt, first.createdAt)
    assert.equal(h.cache.stats().totalChars, 7)
    assert.equal(h.cache.stats().count, 1)
  } finally { h.done() }
})

test('cache：音频文件被外部删除时 lookup 返回 null 并清掉索引条目', () => {
  const h = harness()
  try {
    const key = fakeKey('gone')
    h.cache.put({ key, ext: 'mp3', data: audio('X') })
    rmSync(join(h.cache.dir, `${key}.mp3`), { force: true })
    assert.equal(h.cache.lookup(key), null)
    assert.equal(h.cache.entry(key), null)
    assert.equal(h.cache.stats().count, 0)
  } finally { h.done() }
})

test('cache：put 拒绝非法 key 与空音频，不落盘', () => {
  const h = harness()
  try {
    assert.equal(h.cache.put({ key: 'not-a-hash', ext: 'mp3', data: audio('X') }), null)
    assert.equal(h.cache.put({ key: fakeKey('empty'), ext: 'mp3', data: Buffer.alloc(0) }), null)
    assert.equal(h.cache.stats().count, 0)
    assert.deepEqual(readdirSync(h.cache.dir).filter((n) => n !== 'index.json'), [])
  } finally { h.done() }
})

test('cache：索引损坏时用 .bak 自愈（回退到上一次快照）', () => {
  const h = harness()
  try {
    const keyA = fakeKey('A')
    const keyB = fakeKey('B')
    h.cache.put({ key: keyA, ext: 'mp3', data: audio('A') })
    h.cache.put({ key: keyB, ext: 'mp3', data: audio('B') })
    writeFileSync(h.cache.indexFile, '{ 坏掉的索引', 'utf8')
    assert.equal(h.cache.entry(keyB), null)
    assert.notEqual(h.cache.entry(keyA), null)
  } finally { h.done() }
})

test('cache 淘汰：超 days 即删（含音频文件）', () => {
  const h = harness({ limits: () => ({ days: 30, maxItems: 500, maxBytes: 1e9 }) })
  try {
    const key = fakeKey('old')
    h.cache.put({ key, ext: 'mp3', data: audio('OLD') })
    h.clock.value += 31 * 24 * 60 * 60 * 1000
    assert.equal(h.cache.sweep(), 1)
    assert.equal(h.cache.entry(key), null)
    assert.equal(existsSync(join(h.cache.dir, `${key}.mp3`)), false)
  } finally { h.done() }
})

test('cache 淘汰：超 maxItems 按 lastHitAt 从旧到新删', () => {
  const h = harness({ limits: () => ({ days: 0, maxItems: 2, maxBytes: 1e9 }) })
  try {
    const keys = ['k1', 'k2', 'k3'].map(fakeKey)
    for (const key of keys) {
      h.clock.value += 1000
      h.cache.put({ key, ext: 'mp3', data: audio('X') })
    }
    assert.equal(h.cache.stats().count, 2)
    assert.equal(h.cache.entry(keys[0]), null)
    assert.notEqual(h.cache.entry(keys[1]), null)
    assert.notEqual(h.cache.entry(keys[2]), null)
  } finally { h.done() }
})

test('cache 淘汰：超 maxBytes 即删', () => {
  const h = harness({ limits: () => ({ days: 0, maxItems: 500, maxBytes: 10 }) })
  try {
    const keys = ['b1', 'b2'].map(fakeKey)
    h.cache.put({ key: keys[0], ext: 'mp3', data: audio('12345678') })
    h.clock.value += 1000
    h.cache.put({ key: keys[1], ext: 'mp3', data: audio('12345678') })
    assert.equal(h.cache.stats().count, 1)
    assert.equal(h.cache.entry(keys[0]), null)
    assert.notEqual(h.cache.entry(keys[1]), null)
  } finally { h.done() }
})

test('cache 淘汰：preview 条目优先删（即使它更新）', () => {
  const h = harness({ limits: () => ({ days: 0, maxItems: 1, maxBytes: 1e9 }) })
  try {
    const formal = fakeKey('formal')
    const preview = fakeKey('preview')
    h.cache.put({ key: formal, ext: 'mp3', data: audio('F') })
    h.clock.value += 1000
    h.cache.put({ key: preview, ext: 'mp3', data: audio('P'), preview: true })
    assert.equal(h.cache.stats().count, 1)
    assert.notEqual(h.cache.entry(formal), null)
    assert.equal(h.cache.entry(preview), null)
  } finally { h.done() }
})

test('cache：clear 默认只清 preview，all 时连孤儿文件一起清', () => {
  const h = harness()
  try {
    const formal = fakeKey('keep')
    const preview = fakeKey('drop')
    h.cache.put({ key: formal, ext: 'mp3', data: audio('F') })
    h.cache.put({ key: preview, ext: 'mp3', data: audio('P'), preview: true })
    assert.equal(h.cache.clear({}), 1)
    assert.notEqual(h.cache.entry(formal), null)
    assert.equal(h.cache.entry(preview), null)

    writeFileSync(join(h.cache.dir, 'orphan.bin'), 'orphan')
    assert.equal(h.cache.clear({ all: true }), 1)
    assert.equal(h.cache.stats().count, 0)
    assert.equal(existsSync(join(h.cache.dir, `${formal}.mp3`)), false)
    assert.equal(existsSync(join(h.cache.dir, 'orphan.bin')), false)
    assert.equal(existsSync(h.cache.indexFile), true)
    assert.equal(JSON.parse(readFileSync(h.cache.indexFile, 'utf8')).items && true, true)
  } finally { h.done() }
})
