/**
 * dsh-minimax-tts · 宿主半边纯逻辑
 *
 * 本文件**零外部 import**（只用 node 内建），所以 `node --test test/` 在工作区里直接就能跑，
 * 不需要 profile 的 node_modules。这里住着：文本清洗、缓存 key、JSON store（原子写 + .bak 自愈）、
 * 缓存索引与淘汰、pending 状态迁移、MiniMax 调用，以及 SPEC §5 的全部路由 handler。
 *
 * 路由形态（冻结）：`async handler(req) → res`，`req = { method, path, query, body }`，
 * `res = { status, headers?, json?, body? }`（`body` 为 Buffer 时表示二进制）。
 * index.js 只做接线：Config schema、webServer 注册适配、ctx.effect 清理。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────── 常量（SPEC §4 / §8）

export const NS = 'dsh-minimax-tts'
export const ROUTE_PREFIX = `/${NS}`

/** MiniMax 支持的模型枚举（SPEC §8）。 */
export const MODELS = Object.freeze([
  'speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo',
  'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo',
])

/** emotion 枚举（SPEC §8）。 */
export const EMOTIONS = Object.freeze([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper',
])

/**
 * 模型级情绪限制（SPEC §8；2026-10-15 用本机配置实测）：
 * `whisper` 在 `speech-2.8` 系列被上游拒绝（`status_code 2013`，`invalid params, speech 2.8 don't support whisper`；
 * 2.8-hd 与 2.8-turbo 都测了）；`fluent` 在 2.8 / 2.6 / 02 三个系列上都返回 `status_code 0`，
 * 所以官方文档那句「fluent / whisper 仅 2.6」对 `fluent` 是错的，别照抄。
 */
export const MODEL_BLOCKED_EMOTIONS = Object.freeze({ whisper: /^speech-2\.8/ })

/** `emotion` 在该模型上是否可用；模型为空（未知）时不拦，交给上游判定。 */
export function emotionAllowedByModel(model, emotion) {
  const blocked = MODEL_BLOCKED_EMOTIONS[str(emotion)]
  return blocked === undefined || !blocked.test(str(model))
}

/** 该模型可用的 emotion 列表：工具 schema 枚举与技能正文都用它收敛。 */
export function emotionsForModel(model) {
  return EMOTIONS.filter((emotion) => emotionAllowedByModel(model, emotion))
}

export const SAMPLE_RATES = Object.freeze([8000, 16000, 22050, 24000, 32000, 44100])
export const BITRATES = Object.freeze([32000, 64000, 128000, 256000])
export const FORMATS = Object.freeze(['mp3', 'pcm', 'flac', 'wav', 'pcmu_raw', 'pcmu_wav', 'opus'])

/** language_boost 枚举（SPEC §8，与客户端 `LANGUAGE_BOOSTS` 逐字一致）；空串 = 请求里不带该字段。 */
export const LANGUAGE_BOOSTS = Object.freeze([
  '', 'auto', 'Chinese', 'Chinese,Yue', 'English', 'Japanese', 'Korean', 'Arabic', 'Russian', 'Spanish',
  'French', 'Portuguese', 'German', 'Turkish', 'Dutch', 'Ukrainian', 'Vietnamese', 'Indonesian', 'Italian',
  'Thai', 'Polish', 'Romanian', 'Greek', 'Czech', 'Finnish', 'Hindi', 'Bulgarian', 'Danish', 'Hebrew',
  'Malay', 'Persian', 'Slovak', 'Swedish', 'Croatian', 'Filipino', 'Hungarian', 'Norwegian', 'Slovenian',
  'Catalan', 'Nynorsk', 'Tamil', 'Afrikaans',
])

/** 灵动模式三态（SPEC §11.1）：off = 绝对闸，preset = 只有 preset 行生效，global = 全局行生效。 */
export const EMOTION_SCOPES = Object.freeze(['off', 'preset', 'global'])

/** 行级角色（SPEC §11.1 / §11.2）：full = 全局行（9 条路由），skill-only = preset 行（只有技能与工具）。 */
export const ROLES = Object.freeze(['full', 'skill-only'])

/** 语气词标签（SPEC §8：19 个，仅 2.8-hd / 2.8-turbo 支持）。清洗时必须原样保留。 */
export const CUE_TAGS = Object.freeze([
  'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale',
  'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes',
])

/** 进入缓存 key 的参数（顺序固定，SPEC §6）。其余字段一律不进 key。 */
export const PARAM_FIELDS = Object.freeze([
  'emotion', 'speed', 'vol', 'pitch', 'format', 'sampleRate', 'bitrate', 'channel', 'languageBoost',
])

/** 缓存 key 之外的参数（改它们不影响已有缓存，SPEC §4）。 */
export const NON_KEY_FIELDS = Object.freeze([
  'apiKey', 'baseUrl', 'cleanup', 'emotionTts', 'previewText', 'role',
  'advance.subtitleEnable', 'advance.aigcWatermark', 'advance.outputFormat',
])

/** 文本上限：MiniMax `text` 必须 < 10000 字符（SPEC §8）。 */
export const TEXT_LIMIT = 10000

/** 音色目录的内存缓存 TTL（SPEC §5 / §8）：24h，且按 `baseUrl` 分键。 */
export const VOICES_TTL_MS = 86400000

const AUDIO_NAME_RE = /^[a-f0-9]{64}\.[A-Za-z0-9_]{1,12}$/
const MIME_BY_EXT = Object.freeze({
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', pcm: 'audio/L16',
  opus: 'audio/ogg', pcmu_raw: 'audio/basic', pcmu_wav: 'audio/wav',
})
const DAY_MS = 86400000
/** pending 条目的默认存活期：v1 不挂灵动模式，这里只保证语义有界。 */
export const PENDING_TTL_MS = 6 * 60 * 60 * 1000
/** 回放账本上限（SPEC §11.5）：只记「哪条消息播过哪份稿子」，超出丢最旧。 */
export const PENDING_DELIVERED_LIMIT = 64

// ─────────────────────────────────────────────────────────────── 小工具

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value) => (typeof value === 'string' ? value : '')
const num = (value, fallback) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const nonNeg = (value) => Math.max(0, Math.trunc(num(value, 0)))
const bool = (value, fallback = false) => (typeof value === 'boolean' ? value : fallback)
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
const clamp = (value, min, max, fallback) => Math.min(max, Math.max(min, num(value, fallback)))
const clone = (value) => (value === undefined ? undefined : structuredClone(value))
const trimSlash = (value) => str(value).replace(/\/+$/, '')

/** 只有这些键会被写进配置（SPEC §4 冻结字段名）。 */
/** 试听文本默认值（设置页「用当前音色试听」）。客户端 `client.js` 有一份逐字相同的副本：
 *  两半不能互相 import（客户端只能 require('react')），改动时要两边同步。 */
export const DEFAULT_PREVIEW_TEXT = '你好，这是一段语音合成测试，听到说明朗读功能已经正常工作了。'

export const CONFIG_DEFAULTS = Object.freeze({
  baseUrl: 'https://api.minimax.cn',
  apiKey: '',
  model: 'speech-2.8-hd',
  voices: Object.freeze([{ id: 'female-shaonv', label: '', isDefault: true }]),
  /** 不入缓存 key（见 NON_KEY_FIELDS）。 */
  previewText: DEFAULT_PREVIEW_TEXT,
  emotion: '',
  speed: 1,
  vol: 1,
  pitch: 0,
  sampleRate: 32000,
  bitrate: 128000,
  format: 'mp3',
  channel: 1,
  languageBoost: 'auto',
  cleanup: Object.freeze({ days: 30, maxItems: 500, maxBytes: 524288000 }),
  advance: Object.freeze({
    textNormalizationMode: '', latexRead: false, pronunciationTone: [], aigcWatermark: false,
    outputFormat: 'hex', forceCbr: false, voiceModify: null, subtitleEnable: false,
  }),
  /** 灵动模式（SPEC §11.1）：非 key 字段，见 NON_KEY_FIELDS。 */
  emotionTts: Object.freeze({ scope: 'off' }),
  /** 行级角色（SPEC §11.1）：非 key 字段；只由插件行的行配置给出，不由设置页写入。 */
  role: 'full',
})

// ─────────────────────────────────────────────────────────────── 文本清洗（SPEC §7）

const CODE_FENCE = /^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm
const INLINE_CODE = /`[^`\n]*`/g
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\n]*\)/g
const ANGLE_URL = /<(?:https?|ftp):\/\/[^>\s]+>/gi
const BARE_URL = /\b(?:https?|ftp):\/\/[^\s<>()[\]{}"']+/gi
const WWW_URL = /\bwww\.[^\s<>()[\]{}"']+/gi
const HTML_TAG = /<(?!\#)[a-zA-Z/][^>\n]{0,80}>/g
/** 路径：按“特异性从高到低”依次抹掉，每轮结果喂给下一轮。 */
const PATH_PATTERNS = Object.freeze([
  /[A-Za-z]:\\[^\s]+/g,
  /~\/[^\s]*/g,
  /\.{1,2}\/[\w.@+-]+(?:\/[\w.@+-]+)*/g,
  /\/(?:[\w.@+-]+\/)+[\w.@+-]*\.[A-Za-z0-9]{1,8}/g,
  /\/(?:[\w.@+-]+\/){2,}[\w.@+-]+/g,
  /\b[\w.@+-]+\/[\w.@+-]+\.[A-Za-z0-9]{1,8}/g,
])
/** emoji / 装饰符 / 箭头 / 制表与几何块 / 竖排标点 / 变更符。 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2500}-\u{257F}\u{2580}-\u{259F}\u{25A0}-\u{25FF}\u{FE30}-\u{FE4F}\u{FE0F}\u{200D}\u{20E3}\u{2122}\u{2139}\u{2049}\u{203C}]/gu
const KAOMOJI_KNOWN = /(?:¯\\_\(ツ\)_\/¯|\(╯°□°\)╯︵\s*┻━┻|┻━┻|ヽ\(`Д´\)ノ|ಠ_ಠ)/gu
const PAREN_GROUP = /[（(][^（）()\n]{1,24}[）)]/g
const PAREN_KEEP = /[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const PINYIN_GROUP = /^(?:[a-z]+[1-5])+$/i
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm
const QUOTE = /^[ \t]{0,3}>[ \t]?/gm
const LIST_ITEM = /^[ \t]{0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/gm
const HRULE = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm
const EMPHASIS = /\*\*|__|~~|\*/g
const TABLE_PIPE = /[ \t]*\|[ \t]*/g
/** 表格对齐行 / 只剩横线冒号的行：拆掉竖线之后就没有可朗读内容了。 */
const SEPARATOR_LINE = /^[ \t]*[-:][-: \t]*$/gm
const INLINE_WS = /[ \t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g
const LINE_WS = / *\n */g
const BLANK_LINES = /\n{3,}/g

/**
 * 把 markdown / 代码 / 链接 / 路径 / emoji 抹成可朗读文本，**保留**语气词标签、停顿标记与行内注音。
 * 纯函数：同样输入永远同样输出；清洗后为空返回 `''`（调用方据此不发起任何请求）。
 */
export function cleanForTts(input) {
  if (typeof input !== 'string' || input === '') return ''
  let text = input

  // 1. 整块代码围栏（含 ```lang 行）与兜底围栏
  text = text.replace(CODE_FENCE, '\n')
  text = text.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n')
  // 2. 行内代码
  text = text.replace(INLINE_CODE, ' ')
  // 3. 链接 / 图片语法 → 只留可读文字；URL 与 www 地址整段丢弃
  text = text.replace(MARKDOWN_LINK, '$1')
  text = text.replace(ANGLE_URL, ' ').replace(BARE_URL, ' ').replace(WWW_URL, ' ')
  // 4. HTML 标签（`<#0.8#>` 这类停顿标记以 `#` 开头，被负向断言保护）
  text = text.replace(HTML_TAG, ' ')
  // 5. 绝对 / 家目录 / 相对 / 盘符路径
  for (const pattern of PATH_PATTERNS) text = text.replace(pattern, ' ')
  // 6. emoji 与常见颜文字，再处理“括号里全是符号”的通用颜文字
  text = text.replace(EMOJI, ' ').replace(KAOMOJI_KNOWN, ' ')
  text = text.replace(PAREN_GROUP, (match) => {
    const inner = match.slice(1, -1)
    if (PINYIN_GROUP.test(inner)) return match
    if (PAREN_KEEP.test(inner)) return match
    return ' '
  })
  // 7. Markdown 装饰符
  text = text.replace(HEADING, '').replace(QUOTE, '').replace(LIST_ITEM, '').replace(HRULE, '')
  text = text.replace(EMPHASIS, '').replace(TABLE_PIPE, ' ').replace(SEPARATOR_LINE, '')
  // 8. 空白归一：行内压成单空格，段落换行保留（MiniMax 用换行分段）
  text = text.replace(INLINE_WS, ' ').replace(LINE_WS, '\n').replace(BLANK_LINES, '\n\n')
  return text.trim()
}

// ─────────────────────────────────────────────────────────────── 缓存 key（SPEC §6）

/** 只取进 key 的字段，字段顺序固定（未给出的字段直接缺席，不补默认值）。 */
export function normalizeParams(params = {}) {
  const out = {}
  if (!isRecord(params)) return out
  for (const field of PARAM_FIELDS) {
    const value = params[field]
    if (value !== undefined && value !== null && value !== '') out[field] = value
  }
  return out
}

/** `sha256(JSON.stringify({ text, params, model, voiceId }))`；`text` 必须是清洗后文本。 */
export function cacheKeyFor({ text, params, model, voiceId } = {}) {
  const payload = {
    text: typeof text === 'string' ? text : str(text),
    params: normalizeParams(params),
    model: str(model),
    voiceId: str(voiceId),
  }
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

/** 音频文件的同源 URL（客户端回放 / `<audio src>` 用）。 */
export function audioUrl(key, ext) {
  return `${ROUTE_PREFIX}/audio/${key}.${str(ext) || 'mp3'}`
}

export function mimeForExt(ext) {
  return MIME_BY_EXT[str(ext)] ?? 'application/octet-stream'
}

// ─────────────────────────────────────────────────────────────── 配置归一化（SPEC §4）

function normalizeVoices(value) {
  const list = Array.isArray(value) ? value : []
  const voices = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const id = str(item.id).trim()
    if (id === '') continue
    voices.push({ id, label: str(item.label), isDefault: item.isDefault === true })
  }
  if (voices.length === 0) return clone(CONFIG_DEFAULTS.voices)
  if (!voices.some((voice) => voice.isDefault)) voices[0].isDefault = true
  return voices
}

/** 缺字段补默认、越界值夹到区间内；永远返回一份新的完整配置。 */
export function normalizeConfig(input = {}) {
  const src = isRecord(input) ? input : {}
  const advance = isRecord(src.advance) ? src.advance : {}
  const cleanup = isRecord(src.cleanup) ? src.cleanup : {}
  const emotionTts = isRecord(src.emotionTts) ? src.emotionTts : {}
  const model = str(src.model).trim()
  return {
    baseUrl: trimSlash(str(src.baseUrl).trim()) || CONFIG_DEFAULTS.baseUrl,
    apiKey: str(src.apiKey),
    model: model === '' ? CONFIG_DEFAULTS.model : model,
    voices: normalizeVoices(src.voices),
    // 空串 / 非字符串回落到默认值；只 trim 首尾，内部换行原样保留（试听文本可以是多行）
    previewText: str(src.previewText).trim() || CONFIG_DEFAULTS.previewText,
    emotion: oneOf(src.emotion, EMOTIONS, CONFIG_DEFAULTS.emotion),
    speed: clamp(src.speed, 0.5, 2, CONFIG_DEFAULTS.speed),
    vol: clamp(src.vol, 0.01, 10, CONFIG_DEFAULTS.vol),
    pitch: clamp(src.pitch, -12, 12, CONFIG_DEFAULTS.pitch),
    sampleRate: oneOf(num(src.sampleRate, NaN), SAMPLE_RATES, CONFIG_DEFAULTS.sampleRate),
    bitrate: oneOf(num(src.bitrate, NaN), BITRATES, CONFIG_DEFAULTS.bitrate),
    format: oneOf(src.format, FORMATS, CONFIG_DEFAULTS.format),
    channel: num(src.channel, 1) === 2 ? 2 : 1,
    languageBoost: Object.prototype.hasOwnProperty.call(src, 'languageBoost') ? str(src.languageBoost).trim() : CONFIG_DEFAULTS.languageBoost,
    cleanup: {
      days: Math.max(0, num(cleanup.days, CONFIG_DEFAULTS.cleanup.days)),
      maxItems: Math.max(0, Math.trunc(num(cleanup.maxItems, CONFIG_DEFAULTS.cleanup.maxItems))),
      maxBytes: Math.max(0, Math.trunc(num(cleanup.maxBytes, CONFIG_DEFAULTS.cleanup.maxBytes))),
    },
    advance: {
      textNormalizationMode: str(advance.textNormalizationMode),
      latexRead: bool(advance.latexRead),
      pronunciationTone: Array.isArray(advance.pronunciationTone)
        ? advance.pronunciationTone.filter((entry) => typeof entry === 'string' && entry !== '')
        : [],
      aigcWatermark: bool(advance.aigcWatermark),
      outputFormat: str(advance.outputFormat) || CONFIG_DEFAULTS.advance.outputFormat,
      forceCbr: bool(advance.forceCbr),
      voiceModify: isRecord(advance.voiceModify) ? clone(advance.voiceModify) : null,
      subtitleEnable: bool(advance.subtitleEnable),
    },
    // SPEC §11.1：scope 缺键 / 非法值一律回落 'off'；role 缺键 / 非法值回落 'full'
    emotionTts: { scope: oneOf(str(emotionTts.scope).trim(), EMOTION_SCOPES, CONFIG_DEFAULTS.emotionTts.scope) },
    role: oneOf(str(src.role).trim(), ROLES, CONFIG_DEFAULTS.role),
  }
}

export function defaultVoiceId(config) {
  const voices = Array.isArray(config?.voices) ? config.voices : []
  const chosen = voices.find((voice) => voice?.isDefault === true) ?? voices[0]
  return str(chosen?.id) || CONFIG_DEFAULTS.voices[0].id
}

/**
 * 把请求级覆盖合并到配置上，得到本次合成**生效**的参数。
 * `params` 只含 PARAM_FIELDS（即进入缓存 key 的那一组），`model` / `voiceId` 单独拎出来。
 */
export function resolveParams(config, patch = {}) {
  const over = isRecord(patch) ? patch : {}
  const pick = (name, normalize) => (over[name] === undefined ? config[name] : normalize(over[name], config[name]))
  const params = {
    emotion: pick('emotion', (value) => oneOf(value, EMOTIONS, config.emotion)),
    speed: pick('speed', (value) => clamp(value, 0.5, 2, config.speed)),
    vol: pick('vol', (value) => clamp(value, 0.01, 10, config.vol)),
    pitch: pick('pitch', (value) => clamp(value, -12, 12, config.pitch)),
    format: pick('format', (value) => oneOf(value, FORMATS, config.format)),
    sampleRate: pick('sampleRate', (value) => oneOf(num(value, NaN), SAMPLE_RATES, config.sampleRate)),
    bitrate: pick('bitrate', (value) => oneOf(num(value, NaN), BITRATES, config.bitrate)),
    channel: pick('channel', (value) => (num(value, 1) === 2 ? 2 : 1)),
    languageBoost: pick('languageBoost', (value) => str(value).trim()),
  }
  return {
    voiceId: str(over.voiceId).trim() || defaultVoiceId(config),
    model: str(over.model).trim() || config.model,
    params,
  }
}

// ─────────────────────────────────────────────────────────────── JSON store（SPEC §3）

/** 原子写：临时文件 + rename；mode 0600；写完再 chmod 一次，保证覆盖旧权限。 */
function writeTextAtomic(target, text, dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${target}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, target)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
    throw error
  }
  try { chmodSync(target, 0o600) } catch { /* 平台不支持时忽略 */ }
}

function writeBinaryAtomic(target, data, dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${target}.tmp`
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, target)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 同上 */ }
    throw error
  }
  try { chmodSync(target, 0o600) } catch { /* 同上 */ }
}

/**
 * 已验证语义的 JSON 文件存储：
 * 写临时文件 + rename 原子替换；首次变更前留一份 `.bak`（后续变更不覆盖）；解析失败自愈；
 * 权限 0600；写入失败退回直写保底。
 */
export function makeJsonStore({ dir, name, fallback }) {
  const file = join(dir, name)
  const backup = `${file}.bak`
  const empty = () => (typeof fallback === 'function' ? fallback() : clone(fallback))
  let memory = null

  const readObject = (target) => {
    try {
      if (!existsSync(target)) return null
      const parsed = JSON.parse(readFileSync(target, 'utf8'))
      return isRecord(parsed) ? parsed : null
    } catch { return null }
  }

  /** 无缓存读：解析失败先看 `.bak` 能不能救，救不回再留证据、最后降级为默认值。 */
  const read = () => {
    const value = readObject(file)
    if (value !== null) return value
    if (!existsSync(file)) return empty()
    const rescued = readObject(backup)
    if (rescued === null) {
      try { if (!existsSync(backup)) copyFileSync(file, backup) } catch { /* 备份失败不阻断自愈 */ }
    }
    return rescued ?? empty()
  }

  const load = () => {
    if (memory === null) memory = read()
    return memory
  }

  const write = (next) => {
    const value = isRecord(next) ? next : empty()
    const text = JSON.stringify(value, null, 2)
    memory = clone(value)
    try {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
      if (current.trim() !== '' && current !== text && !existsSync(backup)) {
        try { copyFileSync(file, backup) } catch { /* best effort */ }
      }
      writeTextAtomic(file, text, dir)
    } catch {
      try { writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 }) } catch { /* best effort */ }
    }
    return clone(memory)
  }

  return { dir, file, backup, read, load, write, empty }
}

// ─────────────────────────────────────────────────────────────── 缓存（SPEC §6）

export function createCache({ dir, now = () => Date.now(), limits = () => ({}) } = {}) {
  const index = makeJsonStore({
    dir, name: 'index.json',
    fallback: () => ({ version: 1, items: {}, hits: 0, totalChars: 0 }),
  })

  const normalizeIndex = (raw) => {
    const items = {}
    for (const [key, value] of Object.entries(raw?.items ?? {})) {
      if (!isRecord(value) || !/^[a-f0-9]{64}$/.test(key)) continue
      const file = str(value.file)
      if (!AUDIO_NAME_RE.test(file) || !file.startsWith(key)) continue
      const createdAt = num(value.createdAt, 0)
      items[key] = {
        file,
        ext: str(value.ext) || file.slice(key.length + 1),
        bytes: nonNeg(value.bytes),
        chars: nonNeg(value.chars),
        model: str(value.model),
        voiceId: str(value.voiceId),
        createdAt,
        lastHitAt: num(value.lastHitAt, createdAt),
        hits: nonNeg(value.hits),
        preview: value.preview === true,
      }
    }
    return { version: 1, items, hits: nonNeg(raw?.hits), totalChars: nonNeg(raw?.totalChars) }
  }

  const readIndex = () => normalizeIndex(index.read())
  const persist = (value) => { index.write(value); return value }

  const limitValues = () => {
    const raw = isRecord(limits()) ? limits() : {}
    return {
      days: Math.max(0, num(raw.days, CONFIG_DEFAULTS.cleanup.days)),
      maxItems: Math.max(0, Math.trunc(num(raw.maxItems, CONFIG_DEFAULTS.cleanup.maxItems))),
      maxBytes: Math.max(0, Math.trunc(num(raw.maxBytes, CONFIG_DEFAULTS.cleanup.maxBytes))),
    }
  }

  const filePath = (item) => join(dir, item.file)

  const readAudio = (item) => {
    try {
      const data = readFileSync(filePath(item))
      return data.length > 0 ? data : null
    } catch { return null }
  }

  const dropItem = (value, key) => {
    const item = value.items[key]
    if (item === undefined) return
    try { rmSync(filePath(item), { force: true }) } catch { /* 文件已不在也算删掉 */ }
    delete value.items[key]
  }

  /** 超 days / maxItems / maxBytes 任一即按 lastHitAt 从旧到新删；preview 优先；三项以 0 表示不限制。 */
  const sweep = () => {
    const value = readIndex()
    const { days, maxItems, maxBytes } = limitValues()
    const cutoff = days > 0 ? now() - days * DAY_MS : null
    let removed = 0

    for (const [key, item] of Object.entries(value.items)) {
      if (cutoff !== null && item.lastHitAt < cutoff) { dropItem(value, key); removed += 1 }
    }

    const rest = Object.entries(value.items).map(([key, item]) => ({ key, item }))
    let count = rest.length
    let bytes = rest.reduce((sum, { item }) => sum + item.bytes, 0)
    if ((maxItems > 0 && count > maxItems) || (maxBytes > 0 && bytes > maxBytes)) {
      const order = rest.sort((a, b) => {
        if (a.item.preview !== b.item.preview) return a.item.preview ? -1 : 1
        return a.item.lastHitAt - b.item.lastHitAt
      })
      for (const { key, item } of order) {
        if ((maxItems <= 0 || count <= maxItems) && (maxBytes <= 0 || bytes <= maxBytes)) break
        dropItem(value, key)
        count -= 1
        bytes -= item.bytes
        removed += 1
      }
    }
    if (removed > 0) persist(value)
    return removed
  }

  const entry = (key) => readIndex().items[str(key)] ?? null

  /** 命中：累加 hits / lastHitAt 并回音频；文件已被外部删掉时顺手清索引条目。 */
  const lookup = (key) => {
    const value = readIndex()
    const item = value.items[str(key)]
    if (item === undefined) return null
    const data = readAudio(item)
    if (data === null) {
      delete value.items[str(key)]
      persist(value)
      return null
    }
    item.hits += 1
    item.lastHitAt = now()
    value.hits += 1
    persist(value)
    return { item: clone(item), data }
  }

  /** 未命中之后的落盘；同 key 已存在时保留原 createdAt/hits，且不重复累计 totalChars。 */
  const put = ({ key, ext, data, chars, model, voiceId, preview = false }) => {
    const id = str(key)
    const extension = str(ext) || 'mp3'
    if (!/^[a-f0-9]{64}$/.test(id) || !Buffer.isBuffer(data) || data.length === 0) return null
    writeBinaryAtomic(join(dir, `${id}.${extension}`), data, dir)
    const value = readIndex()
    const existing = value.items[id]
    const at = now()
    const item = {
      file: `${id}.${extension}`,
      ext: extension,
      bytes: data.length,
      chars: nonNeg(chars),
      model: str(model),
      voiceId: str(voiceId),
      createdAt: existing?.createdAt ?? at,
      lastHitAt: at,
      hits: existing?.hits ?? 0,
      preview: preview === true,
    }
    value.items[id] = item
    if (existing === undefined) value.totalChars += item.chars
    persist(value)
    sweep()
    return clone(item)
  }

  /** `all` 时清空全部（含不在索引里的孤儿文件）；否则只清 preview 条目。 */
  const clear = ({ all = false } = {}) => {
    const value = readIndex()
    let removed = 0
    for (const [key, item] of Object.entries(value.items)) {
      if (all !== true && item.preview !== true) continue
      dropItem(value, key)
      removed += 1
    }
    if (all === true) {
      try {
        for (const name of readdirSync(dir)) {
          if (name === 'index.json' || name === 'index.json.bak' || name.endsWith('.tmp')) continue
          try { rmSync(join(dir, name), { force: true }) } catch { /* best effort */ }
        }
      } catch { /* 目录不存在时无事可做 */ }
    }
    persist(value)
    return removed
  }

  const stats = () => {
    const value = readIndex()
    const items = Object.entries(value.items)
      .map(([key, item]) => ({ key, ...clone(item), url: audioUrl(key, item.ext) }))
      .sort((a, b) => b.lastHitAt - a.lastHitAt)
    return {
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      count: items.length,
      hits: value.hits,
      totalChars: value.totalChars,
      items,
    }
  }

  return { dir, indexFile: index.file, entry, lookup, put, clear, sweep, stats, readAudio, dropItem, readIndex }
}

// ─────────────────────────────────────────────────────────────── pending（SPEC §3 / §9.4）

/** 会话 id → 文件名；拿不到合法 id 时退回单文件 `current.json`（SPEC §9.4 的降级）。 */
export function pendingFileStem(sessionId) {
  const safe = str(sessionId).trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120)
  return safe === '' ? 'current' : safe
}

export function createPending({ dir, now = () => Date.now(), ttlMs = PENDING_TTL_MS } = {}) {
  const stores = new Map()

  const storeFor = (sessionId) => {
    const stem = pendingFileStem(sessionId)
    let store = stores.get(stem)
    if (store === undefined) {
      store = makeJsonStore({
        dir, name: `${stem}.json`,
        fallback: () => ({ version: 1, sessionId: stem, superseded: 0, delivered: {}, items: [] }),
      })
      stores.set(stem, store)
    }
    return store
  }

  const normalizeItem = (item) => {
    if (!isRecord(item)) return null
    const id = str(item.id)
    const text = str(item.text)
    if (id === '' || text === '') return null
    const createdAt = num(item.createdAt, now())
    return {
      id,
      text,
      params: isRecord(item.params) ? clone(item.params) : {},
      model: str(item.model),
      voiceId: str(item.voiceId),
      source: str(item.source) || 'script',
      createdAt,
      expiresAt: num(item.expiresAt, createdAt + ttlMs),
    }
  }

  /** 账本键：非空、限长、不吃原型链上的名字（键来自客户端请求体里的 messageId）。 */
  const deliveredKey = (messageId) => {
    const key = str(messageId).trim()
    if (key === '' || key.length > 120) return ''
    return (key === '__proto__' || key === 'constructor' || key === 'prototype') ? '' : key
  }

  /** 回放账本条目：`messageId → { text, params, createdAt }`（不参与待播队列、不随 TTL 过期）。 */
  const normalizeDelivered = (raw) => {
    const out = {}
    const source = isRecord(raw) ? raw : {}
    for (const rawKey of Object.keys(source)) {
      const key = deliveredKey(rawKey)
      const entry = source[rawKey]
      if (key === '' || !isRecord(entry)) continue
      const text = str(entry.text)
      if (text === '') continue
      out[key] = { text, params: isRecord(entry.params) ? clone(entry.params) : {}, createdAt: num(entry.createdAt, 0) }
    }
    return out
  }

  const trimDelivered = (map) => {
    const keys = Object.keys(map)
    if (keys.length <= PENDING_DELIVERED_LIMIT) return map
    keys.sort((a, b) => map[a].createdAt - map[b].createdAt)
    const kept = {}
    for (const key of keys.slice(keys.length - PENDING_DELIVERED_LIMIT)) kept[key] = map[key]
    return kept
  }

  const normalize = (raw, stem) => {
    const items = (Array.isArray(raw?.items) ? raw.items : []).map(normalizeItem).filter((item) => item !== null)
    items.sort((a, b) => a.createdAt - b.createdAt)
    return {
      version: 1,
      sessionId: str(raw?.sessionId) || stem,
      superseded: nonNeg(raw?.superseded),
      delivered: normalizeDelivered(raw?.delivered),
      items,
    }
  }

  /** 读 + 过期清理（有变化才落盘），所有操作都先过这一关。 */
  const sweep = (sessionId) => {
    const store = storeFor(sessionId)
    const value = normalize(store.read(), pendingFileStem(sessionId))
    const at = now()
    const kept = value.items.filter((item) => item.expiresAt > at)
    if (kept.length !== value.items.length) {
      value.items = kept
      store.write(value)
    }
    return value
  }

  const list = (sessionId) => sweep(sessionId).items.map(clone)

  /** 新条目取代**全部**旧条目（含已被绑定的那条）；被取代的计数留在文件里做审计。 */
  const add = (sessionId, input = {}) => {
    const store = storeFor(sessionId)
    const value = sweep(sessionId)
    const at = now()
    const item = normalizeItem({
      ...input,
      id: str(input.id) || randomUUID(),
      createdAt: num(input.createdAt, at),
      expiresAt: num(input.expiresAt, at + ttlMs),
    })
    if (item === null) return null
    value.superseded += value.items.length
    value.items = [item]
    store.write(value)
    return clone(item)
  }

  /**
   * 认领即消费（SPEC §11.5）：取最早的一条未认领条目，从待播队列里删掉后返回；
   * 同一份稿子不会被队列认领第二次。
   * 带 `messageId` 时多一层**回放账本**：同一条消息再次点播放（含换音色后回来）直接返回
   * 它第一次认领到的那份稿子，不再动队列，也不再回落到可见文本。
   * 文件本身保留（`superseded` 计数继续做审计），不删盘。
   */
  const claim = (sessionId, messageId) => {
    const key = deliveredKey(messageId)
    const store = storeFor(sessionId)
    const value = sweep(sessionId)
    const remembered = key === '' ? undefined : value.delivered[key]
    if (remembered !== undefined) return clone(remembered)
    const [target] = value.items.splice(0, 1)
    if (target === undefined) return null
    if (key !== '') {
      value.delivered[key] = { text: target.text, params: clone(target.params), createdAt: target.createdAt }
      value.delivered = trimDelivered(value.delivered)
    }
    store.write(value)
    return clone(target)
  }

  return { dir, storeFor, sweep, list, add, claim }
}

// ─────────────────────────────────────────────────────────────── MiniMax 调用（SPEC §8）

const CACHE_CONTROL_NONE = 'no-store'

/** t2a_v2 请求体：只放显式给出的字段，`advance` 里的开关按 true 才带。 */
export function buildT2aBody({ text, model, voiceId, params = {}, advance = {} } = {}) {
  const voiceSetting = {
    voice_id: str(voiceId),
    speed: num(params.speed, CONFIG_DEFAULTS.speed),
    vol: num(params.vol, CONFIG_DEFAULTS.vol),
    pitch: num(params.pitch, CONFIG_DEFAULTS.pitch),
  }
  if (str(params.emotion) !== '') voiceSetting.emotion = params.emotion
  if (advance?.latexRead === true) voiceSetting.latex_read = true

  const audioSetting = {
    sample_rate: num(params.sampleRate, CONFIG_DEFAULTS.sampleRate),
    bitrate: num(params.bitrate, CONFIG_DEFAULTS.bitrate),
    format: str(params.format) || CONFIG_DEFAULTS.format,
    channel: num(params.channel, CONFIG_DEFAULTS.channel),
  }
  if (advance?.forceCbr === true) audioSetting.force_cbr = true

  const body = { model: str(model), text: str(text), stream: false, voice_setting: voiceSetting, audio_setting: audioSetting }
  if (str(params.languageBoost) !== '') body.language_boost = params.languageBoost
  if (str(advance?.textNormalizationMode) !== '') body.text_normalization_mode = advance.textNormalizationMode
  const tone = Array.isArray(advance?.pronunciationTone) ? advance.pronunciationTone.filter((t) => typeof t === 'string' && t !== '') : []
  if (tone.length > 0) body.pronunciation_dict = { tone }
  if (isRecord(advance?.voiceModify)) body.voice_modify = clone(advance.voiceModify)
  if (advance?.subtitleEnable === true) body.subtitle_enable = true
  if (str(advance?.outputFormat) !== '') body.output_format = advance.outputFormat
  if (advance?.aigcWatermark === true) body.aigc_watermark = true
  return body
}

/** `POST /v1/get_voice` 响应里装音色的四组容器（SPEC §8）：顺序即投影顺序。 */
const VOICE_GROUPS = Object.freeze(['system_voice', 'voice_cloning', 'voice_generation', 'music_generation'])

/**
 * MiniMax 客户端。`fetch` 由外部注入（测试用 mock 替换）。
 * **只看 `base_resp.status_code`**：HTTP 200 也可能带业务错误，非 0 一律透传 status_code / status_msg。
 */
export function createMiniMax({ fetchImpl = globalThis.fetch, timeoutMs = 120000 } = {}) {
  const post = async (url, apiKey, body) => {
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch-unavailable' }
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${str(apiKey)}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return { ok: false, error: 'network-error', statusMsg: String(error?.message ?? error) }
    }
    const raw = typeof response?.text === 'function' ? await response.text().catch(() => '') : ''
    let payload = null
    try { payload = JSON.parse(raw) } catch { payload = null }
    if (!isRecord(payload)) {
      return { ok: false, error: 'bad-response', statusCode: num(response?.status, undefined), statusMsg: raw.slice(0, 200) }
    }
    const code = payload.base_resp?.status_code
    if (num(code, 0) !== 0) {
      return {
        ok: false,
        error: 'minimax-error',
        statusCode: num(code, undefined),
        statusMsg: str(payload.base_resp?.status_msg),
      }
    }
    return { ok: true, payload }
  }

  const synthesize = async ({ baseUrl, apiKey, text, model, voiceId, params, advance } = {}) => {
    const result = await post(`${trimSlash(baseUrl)}/v1/t2a_v2`, apiKey, buildT2aBody({ text, model, voiceId, params, advance }))
    if (result.ok !== true) return result
    const data = result.payload.data
    const hex = isRecord(data) ? data.audio : undefined
    if (typeof hex !== 'string' || hex === '') return { ok: false, error: 'empty-audio' }
    const usage = result.payload?.extra_info?.usage_characters
    return {
      ok: true,
      audio: Buffer.from(hex, 'hex'),
      chars: num(usage, str(text).length),
      traceId: str(result.payload?.trace_id),
    }
  }

  /**
   * 音色目录（SPEC §8）：四组容器按序投影成 `{ id, name }`，其余字段一律不透传
   * （`description` 是数组、`created_time` 无用途）；空 id 丢弃、同 id 先出现者胜。
   */
  const listVoices = async ({ baseUrl, apiKey } = {}) => {
    const result = await post(`${trimSlash(baseUrl)}/v1/get_voice`, apiKey, { voice_type: 'all' })
    if (result.ok !== true) return result
    const voices = []
    const seen = new Set()
    for (const group of VOICE_GROUPS) {
      const rows = result.payload[group]
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        const id = str(row?.voice_id).trim()
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        voices.push({ id, name: str(row?.voice_name) })
      }
    }
    return { ok: true, voices }
  }

  return { synthesize, listVoices, timeoutMs }
}

// ─────────────────────────────────────────────────────────────── 回环守卫 / 响应构造

/** 只放行本机回环请求（SPEC §5：前缀仅本机回环可访问）。 */
export function isLoopbackRequest({ remoteAddress, headers } = {}) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(str(remoteAddress))) return false
  const header = isRecord(headers) ? headers : {}
  const host = str(header.host)
  if (host === '') return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return false
  if (header['sec-fetch-site'] === 'cross-site') return false
  const origin = header.origin
  if (origin === undefined || origin === '') return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

export function jsonResponse(status, value) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, json: value }
}

const fail = (error, extra = {}) => jsonResponse(200, { ok: false, error, ...extra })

// ─────────────────────────────────────────────────────────────── 路由（SPEC §5）

/** 路径 → 方法 → handler 名。`kind` 直接喂给 `webServer.register`。 */
export const ROUTE_TABLE = Object.freeze([
  { path: `${ROUTE_PREFIX}/synthesize`, kind: 'exact', methods: { POST: 'synthesize' } },
  { path: `${ROUTE_PREFIX}/config`, kind: 'exact', methods: { GET: 'getConfig', POST: 'postConfig' } },
  { path: `${ROUTE_PREFIX}/audio`, kind: 'prefix', methods: { GET: 'getAudio' } },
  { path: `${ROUTE_PREFIX}/cache`, kind: 'exact', methods: { GET: 'getCache' } },
  { path: `${ROUTE_PREFIX}/cache/clear`, kind: 'exact', methods: { POST: 'clearCache' } },
  { path: `${ROUTE_PREFIX}/cache/open`, kind: 'exact', methods: { POST: 'openCacheDir' } },
  { path: `${ROUTE_PREFIX}/pending`, kind: 'exact', methods: { GET: 'listPending' } },
  { path: `${ROUTE_PREFIX}/pending/claim`, kind: 'exact', methods: { POST: 'claimPending' } },
  { path: `${ROUTE_PREFIX}/voices`, kind: 'exact', methods: { POST: 'listVoices' } },
])

/** SPEC §5 的全部 handler；每条都是 `async handler(req) → res`，可脱离 HTTP 单测。 */
export function createRoutes(runtime) {
  const audioPrefix = `${ROUTE_PREFIX}/audio/`

  const synthesize = async (req) => {
    const body = isRecord(req?.body) ? req.body : {}
    const cleaned = cleanForTts(typeof body.text === 'string' ? body.text : '')
    if (cleaned === '') return fail('empty-after-clean', { chars: 0 })
    if (cleaned.length >= TEXT_LIMIT) return fail('text-too-large', { length: cleaned.length, limit: TEXT_LIMIT })

    const config = runtime.config()
    const { voiceId, model, params } = resolveParams(config, body.params)
    const key = cacheKeyFor({ text: cleaned, params, model, voiceId })

    const hit = runtime.cache.lookup(key)
    if (hit !== null) {
      return jsonResponse(200, {
        ok: true,
        url: audioUrl(key, hit.item.ext),
        cached: true,
        chars: hit.item.chars,
        totalChars: runtime.cache.stats().totalChars,
      })
    }

    const apiKey = runtime.apiKey()
    if (apiKey === '') return fail('api-key-missing')
    const result = await runtime.minimax.synthesize({
      baseUrl: config.baseUrl, apiKey, text: cleaned, model, voiceId, params, advance: config.advance,
    })
    if (result.ok !== true) {
      return fail(result.error, {
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        ...(str(result.statusMsg) === '' ? {} : { statusMsg: result.statusMsg }),
      })
    }
    const item = runtime.cache.put({
      key, ext: params.format, data: result.audio, chars: result.chars,
      model, voiceId, preview: body.preview === true,
    })
    return jsonResponse(200, {
      ok: true,
      url: audioUrl(key, item?.ext ?? params.format),
      cached: false,
      chars: result.chars,
      totalChars: runtime.cache.stats().totalChars,
    })
  }

  const getConfig = async () => jsonResponse(200, { ok: true, config: runtime.config() })

  const postConfig = async (req) => {
    const patch = isRecord(req?.body?.patch) ? req.body.patch : null
    if (patch === null) return jsonResponse(400, { ok: false, error: 'patch-required' })
    return jsonResponse(200, { ok: true, config: runtime.saveConfig(patch) })
  }

  /** 音色目录的内存缓存（SPEC §5 / §8）：`{ baseUrl, fetchedAt, voices }`，按 baseUrl 分键。 */
  let voicesMemo = null

  /**
   * 音色目录：只作设置页的「远端可用性」提示，**不参与保存与合成**（查错了算上游的）。
   * 命中 `voicesMemo` 且同一 `baseUrl`、未过 TTL 就返回缓存；`refresh: true` 无条件回源；
   * 回源失败时保留旧缓存（下次不带 refresh 仍可用），但本次响应返回失败体、不返回 stale 数据。
   */
  const listVoices = async (req) => {
    const apiKey = runtime.apiKey()
    if (apiKey === '') return fail('api-key-missing')
    const baseUrl = runtime.config().baseUrl
    const fresh = voicesMemo !== null && voicesMemo.baseUrl === baseUrl
      && runtime.now() - voicesMemo.fetchedAt < VOICES_TTL_MS
    if (fresh && req?.body?.refresh !== true) {
      return jsonResponse(200, {
        ok: true, fetchedAt: voicesMemo.fetchedAt, cached: true, count: voicesMemo.voices.length, voices: voicesMemo.voices,
      })
    }
    const result = await runtime.minimax.listVoices({ baseUrl, apiKey })
    if (result.ok !== true) {
      return fail(result.error, {
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        ...(str(result.statusMsg) === '' ? {} : { statusMsg: result.statusMsg }),
      })
    }
    voicesMemo = { baseUrl, fetchedAt: runtime.now(), voices: result.voices }
    return jsonResponse(200, {
      ok: true, fetchedAt: voicesMemo.fetchedAt, cached: false, count: result.voices.length, voices: result.voices,
    })
  }

  const getAudio = async (req) => {
    const raw = String(req?.path ?? '').slice(audioPrefix.length)
    let file = raw
    if (raw.includes('%')) {
      try { file = decodeURIComponent(raw) } catch { return jsonResponse(404, { ok: false, error: 'not-found' }) }
    }
    // 名字必须是 `<sha256hex>.<ext>`：路径穿越、目录、别的路由都不在这里放行
    if (!AUDIO_NAME_RE.test(file)) return jsonResponse(404, { ok: false, error: 'not-found' })
    const known = runtime.cache.entry(file.slice(0, 64))
    if (known === null || known.file !== file) return jsonResponse(404, { ok: false, error: 'not-found' })
    // 名字核对通过后再走 lookup：回放一次算一次命中，顺带刷新 lastHitAt / 清掉文件已丢的条目
    const hit = runtime.cache.lookup(file.slice(0, 64))
    if (hit === null) return jsonResponse(404, { ok: false, error: 'not-found' })
    const entry = hit.item
    const data = hit.data
    return {
      status: 200,
      headers: {
        'content-type': mimeForExt(entry.ext),
        'content-length': String(data.length),
        'cache-control': 'private, max-age=3600',
        'x-tts-chars': String(entry.chars),
      },
      body: data,
    }
  }

  const getCache = async () => jsonResponse(200, { ok: true, ...runtime.cache.stats() })

  const clearCache = async (req) => {
    const all = req?.body?.all === true
    return jsonResponse(200, { ok: true, removed: runtime.cache.clear({ all }) })
  }

  /**
   * 在系统文件管理器里打开缓存目录。动作走注入实现（`createRuntime({ openDirImpl })`），
   * 抛错或返回 `{ ok: false }` 都收敛成业务错误，不冒泡成 500；缓存目录不存在时先建出来再打开。
   */
  const openCacheDir = async () => {
    const dir = runtime.cache.dir
    try { mkdirSync(dir, { recursive: true }) } catch { /* 建不出来也照样试着打开 */ }
    try {
      const result = await runtime.openDir(dir)
      if (result?.ok === false) return fail('open-failed', { dir })
      return jsonResponse(200, { ok: true, dir })
    } catch {
      return fail('open-failed', { dir })
    }
  }

  const listPending = async (req) => {
    // SPEC §11.1：off 是绝对闸，只读列表也返回空
    if (runtime.config().emotionTts.scope === 'off') return jsonResponse(200, { ok: true, items: [] })
    return jsonResponse(200, { ok: true, items: runtime.pending.list(req?.query?.sessionId) })
  }

  const claimPending = async (req) => {
    if (runtime.config().emotionTts.scope === 'off') return jsonResponse(200, { ok: true, item: null })
    const body = isRecord(req?.body) ? req.body : {}
    // 认领即消费（SPEC §11.5）：命中后条目已从待播队列里删除；body 里没有 sessionId 时走 current.json 降级。
    // 带 messageId 时先查回放账本——同一条消息重复点播放沿用它第一次认领到的那份稿子。
    const item = runtime.pending.claim(body.sessionId, body.messageId)
    // 线上响应只给契约里的三个字段（id / expiresAt / binding 之类留给 GET /pending 调试用）
    return jsonResponse(200, { ok: true, item: item === null ? null : { text: item.text, params: item.params, createdAt: item.createdAt } })
  }

  return { synthesize, getConfig, postConfig, listVoices, getAudio, getCache, clearCache, openCacheDir, listPending, claimPending }
}

/** 把 `{ method, path }` 分派到 handler：未命中 404、方法不符 405。 */
export async function dispatch(routes, req) {
  const path = typeof req?.path === 'string' ? req.path : ''
  const method = str(req?.method).toUpperCase()
  for (const route of ROUTE_TABLE) {
    const matched = route.kind === 'exact' ? path === route.path : path.startsWith(route.path)
    if (!matched) continue
    const handler = routes[route.methods[method]]
    if (typeof handler !== 'function') {
      return jsonResponse(405, { ok: false, error: 'method-not-allowed', allow: Object.keys(route.methods).join(', ') })
    }
    return await handler(req)
  }
  return jsonResponse(404, { ok: false, error: 'not-found' })
}

// ─────────────────────────────────────────────────────────────── 运行时装配

/** `~/.dsh/.env` 里的 KEY=VALUE（api key 的最后一级兜底）。 */
export function readDotenvValue(file, key) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      if (trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* 文件不存在是常态 */ }
  return ''
}

export function defaultStateDir(homeDir = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(homeDir, NS)
}

/**
 * 用平台命令在系统文件管理器里打开目录：darwin `open` / win32 `explorer` / 其它 `xdg-open`。
 * `detached + unref`，只等 spawn 握手（毫秒级）就返回，**不等命令退出**；spawn 抛错与 `error`
 * 事件都让 promise 拒绝，由路由收敛成 `open-failed`。成功之后才到的 `error` 被同一个监听器吃掉，
 * 不会变成 uncaught。
 */
function openDirDefault(dir) {
  const command = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'explorer' : 'xdg-open')
  return new Promise((resolve, reject) => {
    const child = spawn(command, [str(dir)], { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

/**
 * 把 store / 缓存 / pending / MiniMax 客户端 / 打开目录的实现 / 路由全部接起来。
 * index.js 与测试共用这一个入口，所以线上跑的路径就是被测试覆盖的路径。
 */
export function createRuntime({
  dir = defaultStateDir(),
  homeDir = process.env.DSH_HOME || join(homedir(), '.dsh'),
  config = {},
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  openDirImpl = openDirDefault,
} = {}) {
  const base = normalizeConfig(config)
  const configStore = makeJsonStore({ dir, name: 'config.json', fallback: () => ({}) })
  // store 里的空串 apiKey 视为「没设过」丢掉：否则会盖掉 DSH 注入的 key
  // （空 = 回退 DSH 注入值 → MINIMAX_API_KEY → ~/.dsh/.env，见 SPEC §4 apiKey 描述）
  const config0 = () => {
    const loaded = configStore.load()
    const stored = isRecord(loaded) ? { ...loaded } : {}
    if (str(stored.apiKey).trim() === '') delete stored.apiKey
    return normalizeConfig({ ...base, ...stored })
  }
  const cache = createCache({ dir: join(dir, 'cache'), now, limits: () => config0().cleanup })
  const pending = createPending({ dir: join(dir, 'pending'), now })
  const minimax = createMiniMax({ fetchImpl })
  const dotenvFile = join(homeDir, '.env')

  const apiKey = () => {
    const direct = config0().apiKey.trim()
    if (direct !== '') return direct
    const fromEnv = str(process.env.MINIMAX_API_KEY).trim()
    if (fromEnv !== '') return fromEnv
    return readDotenvValue(dotenvFile, 'MINIMAX_API_KEY')
  }

  const saveConfig = (patch = {}) => {
    const clean = {}
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      if (isRecord(patch) && patch[key] !== undefined) clean[key] = patch[key]
    }
    // store 只保存「用户显式设过的键」，默认值由 config0() 的 normalizeConfig 补齐：
    // 落盘整份归一化对象会把未设过的键（尤其 apiKey）写成默认值/空串，从而盖掉 DSH 注入值
    configStore.write({ ...configStore.load(), ...clean })
    return config0()
  }

  const runtime = { dir, homeDir, config: config0, saveConfig, apiKey, cache, pending, minimax, configStore, openDir: openDirImpl, now }
  runtime.routes = createRoutes(runtime)
  runtime.dispatch = (req) => dispatch(runtime.routes, req)
  runtime.audioUrl = audioUrl
  return runtime
}

export { CACHE_CONTROL_NONE }
