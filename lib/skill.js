/**
 * 灵动模式（SPEC §11.3 / §11.4）：技能正文、技能 provider、`emotion_tts` 工具定义。
 *
 * 三条硬约束：
 * - 技能正文只存在于本文件（代码即数据），**不落盘**成 SKILL.md / `<name>.md`
 *   ——否则任何人往自己的 preset 里加一行指向本目录就能绕过「禁用」（SPEC §11.3）；
 * - 工具只登记待播请求，不触网、不合成、不写缓存（SPEC §11.4）；
 * - 本文件零外部 import（只用 `node:` 与同目录的纯 core），provider 与工具都能脱离 cordis 单测。
 */
import {
  CUE_TAGS, EMOTIONS, LANGUAGE_BOOSTS, NS, TEXT_LIMIT, defaultVoiceId, emotionAllowedByModel, emotionsForModel,
} from './core.js'

/** 技能名（SPEC §11.3；与用户 YAML、设置页说明文字里的名字逐字一致）。 */
export const EMOTION_SKILL_NAME = 'emotion-tts'

/** 工具名（SPEC §11.4）。 */
export const EMOTION_TOOL_NAME = 'emotion_tts'

/** 与官方 bundled 技能同档的 rank（@deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK）。 */
export const BUNDLED_SKILL_RANK = 600

/** Agent 能覆盖的六个参数（与客户端 `AGENT_PARAM_KEYS` 逐字一致，SPEC §11.4）。 */
export const AGENT_PARAM_KEYS = Object.freeze(['emotion', 'voiceId', 'speed', 'vol', 'pitch', 'languageBoost'])

const SKILL_DESCRIPTION = '把你已经发给用户的那段正文，按原词句登记成待播的朗读稿（只加朗读标记）：用户点这条消息的播放按钮时才合成、朗读。'
const TOOL_DESCRIPTION = '登记一份待播朗读稿：只登记，不合成、不播放，用户点击该消息的播放按钮时宿主才送去合成。`text` 传你刚发的那段正文，词句不变、只可加朗读标记。'
const TEXT_LIMIT_HINT = `单条上限 ${TEXT_LIMIT} 字符`

const isText = (value) => typeof value === 'string'
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** 参数区间（SPEC §11.4），用于工具 schema、映射收敛与技能正文。 */
export const PARAM_RANGES = Object.freeze({
  speed: Object.freeze({ min: 0.5, max: 2 }),
  vol: Object.freeze({ min: 0.01, max: 10 }),
  pitch: Object.freeze({ min: -12, max: 12 }),
})

/** 可用音色：`{ voiceId, label }[]`，label 为空时只给 id。 */
function voiceList(config) {
  const voices = Array.isArray(config?.voices) ? config.voices : []
  return voices
    .map((voice) => ({ id: isText(voice?.id) ? voice.id.trim() : '', label: isText(voice?.label) ? voice.label.trim() : '' }))
    .filter((voice) => voice.id !== '')
    .map((voice) => (voice.label === '' ? `\`${voice.id}\`` : `\`${voice.id}\`（${voice.label}）`))
}

/**
 * 技能正文（SPEC §11.3）：当前配置拼出模型、可用音色与参数范围。
 * 只在 `get()` 时生成，所以设置页改完配置后下一次加载即是新内容。
 */
export function buildSkillContent(config) {
  const model = isText(config?.model) && config.model !== '' ? config.model : '(未设置)'
  const voiceId = defaultVoiceId(config)
  const voices = voiceList(config)
  const allowedEmotions = emotionsForModel(model)
  const blockedEmotions = EMOTIONS.filter((emotion) => !allowedEmotions.includes(emotion))
  const lines = [
    `# ${EMOTION_SKILL_NAME} · 灵动朗读稿`,
    '',
    '**你发给用户的那段正文就是稿子**：正文照常写、保持干净（一个朗读标记都不要有）；发言结束后再调用',
    '`emotion_tts`，把**同一段话**登记成待播请求——只允许加朗读标记，词句不动。',
    '**不要决定什么时候播放**——调用工具只是登记，最终由用户点那条消息的播放按钮触发。',
    '',
    '## 正文与稿子',
    '',
    '- 正文：你平时怎么写给用户就怎么写，但**不要写朗读标记**——`(laughs)`、`<#0.3#>`、`(chu3)(li3)` 这些只出现在 `text` 里。',
    '- `text`：就是那段正文，**词句与正文逐句相同**（不增删信息、不改意思、不换措辞）；允许的改动只有两种：插入朗读标记，或把数字/单位/缩写写成念法（例如「2026 年」而不是「2026Y」，不确定的缩写写成全称）。',
    '- `text` 里不要 Markdown（`**粗体**`、`#` 标题、链接语法、代码块）：正文里可以有，但念不出来。',
    '- 顺手把正文写成能念的句子有额外好处：没有登记稿子时，播放按钮念的就是这条消息的可见正文（兜底），所以表格、长清单这类念不了的内容越少越好。',
    '- 例外：正文里确实有念不了的内容（代码块、表格、链接、长清单）时，`text` 只收能念的那些句子，并在回执里说明略过了什么；这一轮不想念，也可以不登记。',
    '- 一段稿子就是一口气能念完的一到几段话；口播节奏靠标点和停顿，不靠换行。',
    `- ${TEXT_LIMIT_HINT}。超过 3000 字符建议先精简：长稿合成慢、出错重试也贵。`,
    '',
    '## 语气与停顿',
    '',
    `- 19 个英文半角语气标签，写进 \`text\` 里需要喘气/笑的地方：${CUE_TAGS.map((tag) => `\`(${tag})\``).join('、')}。`,
    '  标签只在 MiniMax `speech-2.8-hd` / `speech-2.8-turbo` 上有意义，别的模型会当成正文念出来。',
    '- 停顿写成 `<#0.3#>`（秒，可带小数），插在需要喘口气的位置，不要连着放两个。',
    '- 多音字注音写成 `(chu3)(li3)` 这种括号形式，紧跟在该字所在词后面。',
    '',
    '## 参数怎么给',
    '',
    '`emotion_tts({ text, emotion?, voiceId?, speed?, vol?, pitch?, languageBoost? })`：',
    '',
    `- \`emotion\`：${allowedEmotions.map((item) => `\`${item}\``).join('、')}；省略则用设置页的情绪。${blockedEmotions.length > 0 ? `当前模型 \`${model}\` 不支持 ${blockedEmotions.map((item) => `\`${item}\``).join('、')}（上游会报 2013），别给。` : ''}`,
    `- \`voiceId\`：可用音色 ${voices.length > 0 ? voices.join('、') : `\`${voiceId}\``}；省略则用设置页的默认音色。`,
    `- \`speed\`：${PARAM_RANGES.speed.min}–${PARAM_RANGES.speed.max}；省略则用设置页的语速。`,
    `- \`vol\`：${PARAM_RANGES.vol.min}–${PARAM_RANGES.vol.max}；省略则用设置页的音量。`,
    `- \`pitch\`：${PARAM_RANGES.pitch.min}–${PARAM_RANGES.pitch.max}；省略则用设置页的音调。`,
    '- `languageBoost`：MiniMax 的 `language_boost`（语言增强）；省略则用设置页的值。常用值：`auto`（自动识别）、`Chinese`、`Chinese,Yue`（粤语，粤语音色必须给）、`English`、`Japanese`、`Korean`；完整枚举见工具 schema。`speech-01` / `02` 不支持 `Persian` / `Filipino` / `Tamil`。',
    '',
    '只给需要偏离设置页的参数，其余省略。不在允许值/区间里的值会被工具拒绝。',
    '',
    '## 当前配置',
    '',
    `- 模型：\`${model}\`（由插件配置决定，工具参数里改不了）`,
    `- 默认音色：\`${voiceId}\``,
    '',
    '## 边界',
    '',
    '- 一轮最多登记一次；**同一会话里后登记的会覆盖尚未播出的前一份**，所以同一轮别登记多份。',
    '- 登记的是你**本来就要发的那段话**：不要为了朗读改写措辞，也不要长篇补写。',
    '- 不触网、不合成、不写缓存：这些都由宿主与客户端完成。',
    '',
    '## 例子',
    '',
    '用户看到的正文（干净、没有标记）：',
    '',
    '```text',
    '今晚的雨停在十一点。你把窗打开一条缝，风就进来了。别急着关窗，让它多待一会儿。',
    '```',
    '',
    '发言结束后登记（词句没变，只多了一个语气标签）：',
    '',
    '```text',
    'emotion_tts({',
    '  text: "今晚的雨停在十一点。你把窗打开一条缝，风就进来了。(sighs)别急着关窗，让它多待一会儿。",',
    '  emotion: "calm",',
    '  speed: 0.95,',
    '})',
    '```',
  ]
  return lines.join('\n')
}

/** 技能 candidate（SPEC §11.3 冻结形状；正文在 `get()` 里给）。 */
export function buildSkillCandidate(config) {
  const voiceId = defaultVoiceId(config)
  return {
    name: EMOTION_SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: false },
    provider: NS,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'opaque', description: `由 ${NS} 插件内置供给，无磁盘路径` },
    locator: { kind: 'inline', voiceId },
  }
}

/**
 * 技能 provider（SPEC §11.3）。`list` / `get` 的形状照官方 `@deepseek-ai/dsh-skill` 的
 * `SkillRegistry` 契约：`list(options) → Promise<candidate[]>`，
 * `get(candidate, options) → Promise<{ ...candidate, summary, content }>`。
 * `summary` 给列表/工具面用（= `description`），`content` 是正文（SPEC §11.3）。
 *
 * **两者必须是 thenable**：dsh-skill 用 `waitWithAbort(provider.list(...))` / `waitWithAbort(provider.get(...))`
 * 等待，内部直接 `.then`（`@deepseek-ai/dsh-skill/lib/index.js:350`、`:256`，waitWithAbort 见 `:537`）。
 * 返回裸数组/裸对象时 Agent 一调 skill 就报 `promise.then is not a function`；官方 `dsh-skill-office`
 * 同样是 `Promise.resolve(...)` + `async get()`。
 */
export function createSkillProvider(getConfig) {
  const readConfig = () => (typeof getConfig === 'function' ? getConfig() : {})
  return {
    name: NS,
    list: () => Promise.resolve([buildSkillCandidate(readConfig())]),
    get: async (candidate) => {
      if (candidate?.name !== EMOTION_SKILL_NAME) return undefined
      return { ...candidate, summary: candidate.description, content: buildSkillContent(readConfig()) }
    },
  }
}

/** 把 provider 挂到真实的 `ctx.skills` 上，返回 cordis 的 disposer。 */
export function registerEmotionSkill(skills, getConfig) {
  return skills.registerProvider(() => createSkillProvider(getConfig))
}

/**
 * 收敛工具参数：只取 §11.4 的六个键，空串/non-finite 视为没给。
 * 越界**拒绝**而不是夹值——Agent 看不到夹值反馈，静默改成别的语速比报错更糟。
 */
export function pickAgentParams(input, model) {
  const src = typeof input === 'object' && input !== null ? input : {}
  const params = {}
  for (const key of AGENT_PARAM_KEYS) {
    const value = src[key]
    if (key === 'emotion') {
      const emotion = isText(value) ? value.trim() : ''
      if (emotion === '') continue
      if (!EMOTIONS.includes(emotion)) throw new Error(`emotion "${emotion}" 不在允许值里：${EMOTIONS.join(' / ')}`)
      if (!emotionAllowedByModel(model, emotion)) {
        throw new Error(`emotion "${emotion}" 在当前模型 ${model} 上不可用（上游会报 2013）；可用：${emotionsForModel(model).join(' / ')}`)
      }
      params.emotion = emotion
      continue
    }
    if (key === 'languageBoost') {
      const boost = isText(value) ? value.trim() : ''
      if (boost === '') continue
      if (!LANGUAGE_BOOSTS.includes(boost)) {
        throw new Error(`languageBoost "${boost}" 不在允许值里：${LANGUAGE_BOOSTS.filter((item) => item !== '').join(' / ')}`)
      }
      params.languageBoost = boost
      continue
    }
    if (key === 'voiceId') {
      const voiceId = isText(value) ? value.trim() : ''
      if (voiceId !== '') params.voiceId = voiceId
      continue
    }
    if (value === undefined || value === null) continue
    if (!isFiniteNumber(value)) throw new Error(`${key} 必须是数字（收到 ${JSON.stringify(value)}）`)
    const range = PARAM_RANGES[key]
    if (value < range.min || value > range.max) throw new Error(`${key} 必须在 ${range.min}–${range.max} 之间（收到 ${value}）`)
    params[key] = value
  }
  return params
}

/**
 * 登记待播请求（SPEC §11.4）：写 `pending/<sid>.json`（sid 先净化，拿不到则 `current.json`），
 * 同会话已有未认领条目时后写覆盖（由 pending store 的 add 语义保证），返回条目本身。
 */
export function stageEmotionRequest(pending, input = {}) {
  const text = isText(input.text) ? input.text.trim() : ''
  if (text === '') throw new Error('text 不能为空')
  if (text.length > TEXT_LIMIT) throw new Error(`text 超出上限 ${TEXT_LIMIT} 字符（收到 ${text.length}）`)
  const config = typeof input.config === 'function' ? input.config() : input.config
  const params = pickAgentParams(input.params, config?.model)
  const item = pending.add(input.sessionId, { text, params, source: 'agent' })
  if (item === null) throw new Error('待播条目登记失败')
  return item
}

/**
 * 调用者会话 id。`session.header.id` 是权威身份：宿主 API 层就是用它做会话寻址的
 * （`dsh-api-session-controller` 的 `observation.header.id !== sessionId` 判定），
 * 客户端的 `props.sessionId` 与它同源——认领时两边必须落在同一份 `pending/<id>.json`。
 * 拿不到就返回 undefined，由 `pendingFileStem` 降级到 `current.json`（SPEC §11.4）。
 */
export function sessionIdOf(exec) {
  const session = exec?.agent?.session
  for (const value of [session?.header?.id, session?.id, session?.header?.sessionId]) {
    if (isText(value) && value.trim() !== '') return value
  }
  return undefined
}

/**
 * `emotion_tts` 工具的**裸定义**（SPEC §11.4）。`ctx.tools.register` 只要求
 * `output: { schema, render }` + 合法 JSON Schema 的 `parameters`，裸对象即可注册；
 * 这里不依赖 `defineTool`（宿主半边解析不到 `@deepseek-ai/dsh-tools`，见回报）。
 */
export function buildEmotionToolDefinition({ pending, config }) {
  const readConfig = () => (typeof config === 'function' ? config() : config)
  const model = readConfig()?.model
  return {
    name: EMOTION_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: `要念的内容，纯文本，不要 Markdown；${TEXT_LIMIT_HINT}` },
        emotion: { type: 'string', enum: [...emotionsForModel(model)], description: '情绪；省略则用设置页的值' },
        voiceId: { type: 'string', description: 'MiniMax voice_id；省略则用设置页的默认音色' },
        speed: { type: 'number', description: `语速 ${PARAM_RANGES.speed.min}–${PARAM_RANGES.speed.max}` },
        vol: { type: 'number', description: `音量 ${PARAM_RANGES.vol.min}–${PARAM_RANGES.vol.max}` },
        pitch: { type: 'number', description: `音调 ${PARAM_RANGES.pitch.min}–${PARAM_RANGES.pitch.max}` },
        languageBoost: {
          type: 'string',
          enum: LANGUAGE_BOOSTS.filter((item) => item !== ''),
          description: 'MiniMax language_boost（语言增强）；省略则用设置页的值。粤语音色必须给 Chinese,Yue',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          registered: { type: 'boolean', const: true },
          chars: { type: 'number' },
          params: { type: 'object', properties: {}, additionalProperties: true, description: '收敛后的参数（只含显式给出的键）' },
          duplicates: { type: 'boolean', description: '是否覆盖了同会话里尚未播出的上一份稿子' },
        },
        required: ['registered', 'chars', 'params', 'duplicates'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.duplicates === true
          ? `已登记待播朗读稿（${value.chars} 字符，覆盖了同会话里尚未播出的上一份）。用户点这条消息的播放按钮时朗读。`
          : `已登记待播朗读稿（${value.chars} 字符）。用户点这条消息的播放按钮时朗读。`,
      }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const before = pending.list(sessionId).length
      const item = stageEmotionRequest(pending, { text: args?.text, params: args, sessionId, config: readConfig() })
      return { registered: true, chars: item.text.length, params: item.params, duplicates: before > 0 }
    },
    presentCall(args) {
      const text = isText(args?.text) ? args.text.trim() : ''
      return {
        card: 'generic',
        title: '登记待播朗读稿',
        kind: 'execute',
        rawInput: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      }
    },
  }
}

/** 把工具挂到真实的 `ctx.tools` 上，返回 cordis 的 disposer。 */
export function registerEmotionTool(tools, options) {
  return tools.register(buildEmotionToolDefinition(options))
}
