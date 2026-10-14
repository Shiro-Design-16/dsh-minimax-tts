import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONFIG_DEFAULTS, PARAM_FIELDS, createRuntime, defaultVoiceId, makeJsonStore, normalizeConfig, resolveParams,
} from '../lib/core.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'mtts-store-'))
const modeOf = (file) => statSync(file).mode & 0o777
const tmpLeftovers = (dir) => readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('.tmp'))

function withStore(fn) {
  const dir = tempDir()
  const store = makeJsonStore({ dir, name: 'config.json', fallback: () => ({ tag: 'default' }) })
  try { fn({ dir, store, file: join(dir, 'config.json'), backup: join(dir, 'config.json.bak') }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

test('store：首次写入不产生 .bak，权限 0600，无 .tmp 残留', () => {
  withStore(({ dir, store, file, backup }) => {
    store.write({ a: 1 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 })
    assert.equal(existsSync(backup), false)
    assert.equal(modeOf(file), 0o600)
    assert.deepEqual(tmpLeftovers(dir), [])
  })
})

test('store：首次变更后产生 .bak，内容为变更前快照', () => {
  withStore(({ store, file, backup }) => {
    store.write({ a: 1 })
    store.write({ a: 2 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 })
    assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), { a: 1 })
  })
})

test('store：后续变更不覆盖 .bak', () => {
  withStore(({ store, file, backup }) => {
    store.write({ a: 1 })
    store.write({ a: 2 })
    store.write({ a: 3 })
    store.write({ a: 4 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 4 })
    assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), { a: 1 })
  })
})

test('store：损坏文件自愈——有可用 .bak 时回退到 .bak，且不改写主文件', () => {
  withStore(({ store, file, backup }) => {
    store.write({ a: 1 })
    store.write({ a: 2 })
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    assert.deepEqual(store.read(), { a: 1 })
    assert.equal(readFileSync(file, 'utf8'), '{ 这不是 JSON')
    assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), { a: 1 })
  })
})

test('store：损坏文件自愈——无 .bak 时降级默认值，并把损坏文件留作 .bak 证据', () => {
  withStore(({ store, file, backup }) => {
    store.write({ a: 1 })
    writeFileSync(file, 'null', 'utf8')
    assert.deepEqual(store.read(), { tag: 'default' })
    assert.equal(readFileSync(backup, 'utf8'), 'null')
  })
})

test('store：目录不存在时自动创建，写入后 load() 反映最新值', () => {
  const dir = join(tempDir(), 'nested', 'deep')
  try {
    const store = makeJsonStore({ dir, name: 'x.json', fallback: () => ({}) })
    store.write({ n: 1 })
    assert.equal(existsSync(join(dir, 'x.json')), true)
    store.write({ n: 2 })
    assert.deepEqual(store.load(), { n: 2 })
    assert.deepEqual(tmpLeftovers(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runtime：saveConfig 原子落盘 0600，config() 能读回并夹值', () => {
  const dir = tempDir()
  try {
    const runtime = createRuntime({ dir, homeDir: join(dir, 'home'), config: {} })
    runtime.saveConfig({ speed: 1.5, vol: 99, sampleRate: 12345 })
    assert.equal(modeOf(join(dir, 'config.json')), 0o600)
    const config = runtime.config()
    assert.equal(config.speed, 1.5)
    assert.equal(config.vol, 10)
    assert.equal(config.sampleRate, CONFIG_DEFAULTS.sampleRate)
    assert.deepEqual(tmpLeftovers(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runtime：saveConfig 不写未设过的键——DSH 注入的 apiKey 不被空串盖掉', () => {
  const dir = tempDir()
  try {
    const runtime = createRuntime({ dir, homeDir: join(dir, 'home'), config: { apiKey: 'FROM-DSH-FORM' } })
    assert.equal(runtime.apiKey(), 'FROM-DSH-FORM')
    runtime.saveConfig({ model: 'speech-2.8-turbo' })
    assert.equal(runtime.apiKey(), 'FROM-DSH-FORM')
    assert.equal(runtime.config().model, 'speech-2.8-turbo')
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.deepEqual(onDisk, { model: 'speech-2.8-turbo' })
    assert.equal('apiKey' in onDisk, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runtime：store 里的空串 apiKey 视为没设过，回退到 DSH 注入值', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ apiKey: '', speed: 1.2 }), { mode: 0o600 })
    const runtime = createRuntime({ dir, homeDir: join(dir, 'home'), config: { apiKey: 'FROM-DSH-FORM' } })
    assert.equal(runtime.apiKey(), 'FROM-DSH-FORM')
    assert.equal(runtime.config().apiKey, 'FROM-DSH-FORM')
    assert.equal(runtime.config().speed, 1.2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runtime：显式 saveConfig({ apiKey }) 写入 store 并生效', () => {
  const dir = tempDir()
  try {
    const runtime = createRuntime({ dir, homeDir: join(dir, 'home'), config: { apiKey: 'FROM-DSH-FORM' } })
    runtime.saveConfig({ apiKey: 'sk-x' })
    assert.equal(runtime.apiKey(), 'sk-x')
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).apiKey, 'sk-x')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('normalizeConfig：默认值逐字段等于 SPEC §4', () => {
  assert.deepEqual(normalizeConfig({}), {
    baseUrl: 'https://api.minimax.cn',
    apiKey: '',
    model: 'speech-2.8-hd',
    voices: [{ id: 'female-shaonv', label: '', isDefault: true }],
    previewText: '你好，这是一段语音合成测试，听到说明朗读功能已经正常工作了。',
    emotion: '',
    speed: 1,
    vol: 1,
    pitch: 0,
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
    languageBoost: 'auto',
    cleanup: { days: 30, maxItems: 500, maxBytes: 524288000 },
    advance: {
      textNormalizationMode: '', latexRead: false, pronunciationTone: [], aigcWatermark: false,
      outputFormat: 'hex', forceCbr: false, voiceModify: null, subtitleEnable: false,
    },
    emotionTts: { scope: 'off' },
    role: 'full',
  })
})

test('normalizeConfig：previewText 空串回落默认值，多行原样保留（只 trim 首尾）', () => {
  // 与客户端 client.js 的 DEFAULT_PREVIEW_TEXT 逐字相同
  assert.equal(CONFIG_DEFAULTS.previewText, '你好，这是一段语音合成测试，听到说明朗读功能已经正常工作了。')
  assert.equal(normalizeConfig({}).previewText, CONFIG_DEFAULTS.previewText)
  assert.equal(normalizeConfig({ previewText: '' }).previewText, CONFIG_DEFAULTS.previewText)
  assert.equal(normalizeConfig({ previewText: '  \n\t ' }).previewText, CONFIG_DEFAULTS.previewText)
  assert.equal(normalizeConfig({ previewText: 42 }).previewText, CONFIG_DEFAULTS.previewText)

  const custom = '第一行\n\n第二行，内部  空白保留'
  assert.equal(normalizeConfig({ previewText: custom }).previewText, custom)
  assert.equal(normalizeConfig({ previewText: `  ${custom}\n` }).previewText, custom)
  assert.equal(resolveParams(normalizeConfig({ previewText: custom }), {}).params.previewText, undefined)
})

test('normalizeConfig：越界值夹到区间内，非法枚举回退默认', () => {
  const config = normalizeConfig({
    baseUrl: 'https://api.minimaxi.com/', apiKey: 42, model: '  ',
    voices: [], emotion: 'screaming', speed: 9, vol: 0, pitch: -99,
    sampleRate: 12345, bitrate: 1, format: 'ogg', channel: 7,
    cleanup: { days: -1, maxItems: 2.9, maxBytes: -5 },
  })
  assert.equal(config.baseUrl, 'https://api.minimaxi.com')
  assert.equal(config.apiKey, '')
  assert.equal(config.model, 'speech-2.8-hd')
  assert.deepEqual(config.voices, CONFIG_DEFAULTS.voices)
  assert.equal(config.emotion, '')
  assert.equal(config.speed, 2)
  assert.equal(config.vol, 0.01)
  assert.equal(config.pitch, -12)
  assert.equal(config.sampleRate, 32000)
  assert.equal(config.bitrate, 128000)
  assert.equal(config.format, 'mp3')
  assert.equal(config.channel, 1)
  assert.deepEqual(config.cleanup, { days: 0, maxItems: 2, maxBytes: 0 })
})

test('normalizeConfig：voices 无默认标记时把第一条设为默认', () => {
  const config = normalizeConfig({ voices: [{ id: 'male-qn-qingse' }, { id: 'female-shaonv', isDefault: true }] })
  assert.deepEqual(config.voices, [
    { id: 'male-qn-qingse', label: '', isDefault: false },
    { id: 'female-shaonv', label: '', isDefault: true },
  ])
  assert.equal(defaultVoiceId(config), 'female-shaonv')
  assert.equal(defaultVoiceId(normalizeConfig({ voices: [{ id: 'x' }, { id: 'y' }] })), 'x')
})

test('resolveParams：只产出 PARAM_FIELDS + model/voiceId，请求级覆盖生效', () => {
  const config = normalizeConfig({})
  const { voiceId, model, params } = resolveParams(config, { voiceId: 'male-qn-qingse', model: 'speech-2.6-hd', speed: 9, emotion: 'happy' })
  assert.equal(voiceId, 'male-qn-qingse')
  assert.equal(model, 'speech-2.6-hd')
  assert.equal(params.speed, 2)
  assert.equal(params.emotion, 'happy')
  assert.deepEqual(Object.keys(params).sort(), [...PARAM_FIELDS].sort())
  const fallback = resolveParams(config, {})
  assert.equal(fallback.voiceId, 'female-shaonv')
  assert.equal(fallback.model, 'speech-2.8-hd')
  assert.equal(fallback.params.languageBoost, 'auto')
  assert.equal(fallback.params.format, 'mp3')
  // '' = 用户显式选「不增强」：保留空串（不回落 auto），请求层据此不带该字段
  assert.equal(normalizeConfig({ languageBoost: '' }).languageBoost, '')
  assert.equal(resolveParams(normalizeConfig({ languageBoost: '' }), {}).params.languageBoost, '')
})
