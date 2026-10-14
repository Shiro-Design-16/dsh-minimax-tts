/**
 * 灵动模式（SPEC §11.3 / §11.4 / §11.7）：
 * - 配置归一化：emotionTts 三态与行级 role 的缺键/非法值口径；
 * - 技能 provider：candidate 冻结形状 + 正文按当前配置生成；
 * - `emotion_tts` 工具：参数收敛、会话 id 取用、写盘与同会话覆盖；
 * - 接线闸门：role × scope 四种组合下「路由 / 技能 / 工具」各自的注册面，
 *   以及「role 只认行配置」这条防线。
 *
 * 接线闸门用真实 cordis Context + 假服务（webServer / skills / tools）；
 * 真实包（SkillRegistry / ToolRuntime）的接受度由探针另行取证，见回报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CUE_TAGS, EMOTIONS, EMOTION_SCOPES, LANGUAGE_BOOSTS, NS, NON_KEY_FIELDS, ROLES, ROUTE_TABLE, TEXT_LIMIT,
  createPending, defaultVoiceId, emotionAllowedByModel, emotionsForModel, normalizeConfig,
} from '../lib/core.js'
import {
  AGENT_PARAM_KEYS, BUNDLED_SKILL_RANK, EMOTION_SKILL_NAME, EMOTION_TOOL_NAME, PARAM_RANGES,
  buildEmotionToolDefinition, buildSkillCandidate, buildSkillContent, createSkillProvider,
  pickAgentParams, registerEmotionSkill, registerEmotionTool, sessionIdOf, stageEmotionRequest,
} from '../lib/skill.js'
import { Config, apply as applyPlugin, inject as pluginInject, name as pluginName } from '../index.js'

/** cordis 只在装了宿主依赖的机器上可解析；缺了就跳过接线闸门，单元部分照跑。 */
let Context = null
try { ({ Context } = await import('@deepseek-ai/cordis')) } catch { Context = null }

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function tempDir() { return mkdtempSync(join(tmpdir(), 'mtts-emotion-')) }

/** 真 pending store + 临时目录，供工具层断言落盘内容。 */
function pendingHarness() {
  const dir = tempDir()
  const pending = createPending({ dir: join(dir, 'pending'), now: () => 1_700_000_000_000 })
  return {
    dir,
    pending,
    file: (name) => join(dir, 'pending', `${name}.json`),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// ───────────────────────────────────────────────────────────── 配置归一化（§11.1 / §11.7）

test('normalizeConfig：emotionTts 缺键/非法值一律回落 off，合法三态透传', () => {
  assert.deepEqual(normalizeConfig({}).emotionTts, { scope: 'off' })
  for (const bad of [null, 'global', [], { scope: 'sometimes' }, { scope: '' }, { scope: 1 }]) {
    assert.deepEqual(normalizeConfig({ emotionTts: bad }).emotionTts, { scope: 'off' }, `emotionTts=${JSON.stringify(bad)} 应回落 off`)
  }
  assert.deepEqual(EMOTION_SCOPES, ['off', 'preset', 'global'])
  for (const scope of EMOTION_SCOPES) {
    assert.deepEqual(normalizeConfig({ emotionTts: { scope } }).emotionTts, { scope })
  }
})

test('normalizeConfig：role 缺键/非法值回落 full，skill-only 透传', () => {
  assert.deepEqual(ROLES, ['full', 'skill-only'])
  assert.equal(normalizeConfig({}).role, 'full')
  for (const bad of ['', 'FULL', 'skill_only', 'skillOnly', 1]) {
    assert.equal(normalizeConfig({ role: bad }).role, 'full', `role=${JSON.stringify(bad)} 应回落 full`)
  }
  assert.equal(normalizeConfig({ role: 'skill-only' }).role, 'skill-only')
})

test('normalizeConfig：emotionTts 与 role 都在非 key 清单里，旧的 autoMode 已退出', () => {
  for (const field of ['emotionTts', 'role']) assert.ok(NON_KEY_FIELDS.includes(field), `${field} 必须在 NON_KEY_FIELDS 里`)
  assert.equal(NON_KEY_FIELDS.includes('autoMode'), false)
  assert.equal('autoMode' in normalizeConfig({}), false)
  assert.equal(JSON.stringify(normalizeConfig({})).includes('scriptSkill'), false)
})

// ───────────────────────────────────────────────────────────── 技能 provider（§11.3）

test('buildSkillCandidate：冻结形状逐字段（SPEC §11.3）', () => {
  const candidate = buildSkillCandidate(normalizeConfig({}))
  assert.deepEqual(candidate, {
    name: 'emotion-tts',
    description: candidate.description,
    invocation: { modelInvocable: true, userInvocable: false },
    provider: NS,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'opaque', description: candidate.resourceBase.description },
    locator: { kind: 'inline', voiceId: defaultVoiceId(normalizeConfig({})) },
  })
  assert.equal(typeof candidate.description, 'string')
  assert.ok(candidate.description.length > 0)
  assert.equal(BUNDLED_SKILL_RANK, 600)
  // 正文不在 candidate 上——它只在 get() 时生成，且这里不碰任何磁盘路径
  assert.equal('content' in candidate, false)
  assert.equal('path' in candidate, false)
  assert.equal(candidate.resourceBase.kind, 'opaque')
})

test('buildSkillContent：写清场景、19 个标签、停顿与注音、参数区间与上限', () => {
  const config = normalizeConfig({
    model: 'speech-2.8-hd',
    voices: [{ id: 'female-shaonv', label: '少女音', isDefault: true }, { id: 'male-qn-qingse', label: '', isDefault: false }],
  })
  const content = buildSkillContent(config)
  // 身份与边界：正文就是稿子、词句不变、只加标记、不决定何时播
  assert.match(content, /你发给用户的那段正文就是稿子/)
  assert.match(content, /词句与正文逐句相同/)
  assert.match(content, /不要写朗读标记/)
  assert.match(content, /不要决定什么时候播放/)
  assert.match(content, /播放按钮/)
  // 例子必须同时给出「干净的正文」与「只加了一个标记的同一句话」
  assert.ok(content.includes('风就进来了。别急着关窗'))
  assert.ok(content.includes('风就进来了。(sighs)别急着关窗'))
  // 19 个标签一个不少，且都是英文半角括号写法
  for (const tag of CUE_TAGS) assert.ok(content.includes(`(${tag})`), `正文缺少标签 (${tag})`)
  assert.equal(CUE_TAGS.length, 19)
  // 停顿与注音写法
  assert.ok(content.includes('<#0.3#>'))
  assert.ok(content.includes('(chu3)(li3)'))
  // 参数与区间
  for (const key of AGENT_PARAM_KEYS) assert.ok(content.includes(`\`${key}\``), `正文缺少参数 ${key}`)
  for (const [key, range] of Object.entries(PARAM_RANGES)) {
    assert.ok(content.includes(`${range.min}–${range.max}`), `正文缺少 ${key} 的区间`)
  }
  for (const emotion of emotionsForModel('speech-2.8-hd')) assert.ok(content.includes(`\`${emotion}\``), `正文缺少情绪 ${emotion}`)
  // 2.8 上被上游拒绝的 whisper（实测 2013）：不列进可用值，但要说清为什么
  assert.ok(content.includes('不支持 `whisper`'))
  // 当前配置拼进去的模型与音色（含 label），且没有 Markdown 之外的东西被写进正文
  assert.ok(content.includes('`speech-2.8-hd`'))
  assert.ok(content.includes('`female-shaonv`（少女音）'))
  assert.ok(content.includes('`male-qn-qingse`'))
  assert.ok(content.includes(String(TEXT_LIMIT)))
  assert.ok(content.includes('3000'))
  // 正文里不出现任何磁盘路径（硬约束：不落盘、不被别人指向）
  assert.equal(/\.md\b|\/Users\/|SKILL\.md/.test(content), false)
})

test('buildSkillContent：模型/音色没配时给可得信息，不产出 undefined', () => {
  const normalized = buildSkillContent(normalizeConfig({ model: '', voices: [] }))
  assert.equal(normalized.includes('undefined'), false)
  assert.ok(normalized.includes('`speech-2.8-hd`'))
  assert.ok(normalized.includes(`\`${defaultVoiceId(normalizeConfig({}))}\``))
  // 真拿到空模型（防御分支）时给「(未设置)」而不是 undefined
  const blank = buildSkillContent({ voices: [] })
  assert.equal(blank.includes('undefined'), false)
  assert.ok(blank.includes('(未设置)'))
})

test('createSkillProvider：list/get 必须返回 thenable（dsh-skill 用 waitWithAbort 等待），内容随配置变化', async () => {
  let config = normalizeConfig({ model: 'speech-2.8-hd' })
  const provider = createSkillProvider(() => config)
  assert.equal(provider.name, NS)

  const listed = provider.list()
  assert.equal(typeof listed.then, 'function', 'list() 必须返回 thenable：裸数组会让宿主报 promise.then is not a function')
  const candidates = await listed
  assert.equal(Array.isArray(candidates), true)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, EMOTION_SKILL_NAME)

  const got = provider.get(candidates[0])
  assert.equal(typeof got.then, 'function', 'get() 必须返回 thenable')
  const first = await got
  assert.equal(first.name, EMOTION_SKILL_NAME)
  assert.equal(typeof first.content, 'string')
  assert.ok(first.content.includes('speech-2.8-hd'))
  assert.equal(first.description, candidates[0].description)

  config = normalizeConfig({ model: 'speech-2.6-hd' })
  assert.ok((await provider.get(candidates[0])).content.includes('speech-2.6-hd'), 'get() 应按当前配置重新生成正文')
  assert.equal(await provider.get({ name: 'other-skill' }), undefined)
  assert.equal(await provider.get(undefined), undefined)
})

test('registerEmotionSkill / registerEmotionTool：把 provider 与定义交给宿主服务，返回 disposer', () => {
  const seen = { providers: [], tools: [] }
  const skills = { registerProvider: (create) => { seen.providers.push(create()); return () => {} } }
  const tools = { register: (definition) => { seen.tools.push(definition); return () => {} } }
  const config = normalizeConfig({})

  const disposeSkill = registerEmotionSkill(skills, () => config)
  const disposeTool = registerEmotionTool(tools, { pending: createPending({ dir: tempDir(), now: () => 0 }), config: () => config })
  assert.equal(typeof disposeSkill, 'function')
  assert.equal(typeof disposeTool, 'function')
  assert.equal(seen.providers.length, 1)
  assert.equal(seen.providers[0].name, NS)
  assert.equal(seen.tools[0].name, EMOTION_TOOL_NAME)
})

// ───────────────────────────────────────────────────────────── emotion_tts 工具（§11.4）

test('sessionIdOf：优先 header.id（客户端同源），逐级回退，拿不到给 undefined', () => {
  assert.equal(sessionIdOf({ agent: { session: { header: { id: 's1' }, id: 'nope' } } }), 's1')
  assert.equal(sessionIdOf({ agent: { session: { id: 's2' } } }), 's2')
  assert.equal(sessionIdOf({ agent: { session: { header: { sessionId: 's3' } } } }), 's3')
  assert.equal(sessionIdOf({ agent: { session: { header: { id: '   ' } } } }), undefined)
  assert.equal(sessionIdOf({ agent: {} }), undefined)
  assert.equal(sessionIdOf({}), undefined)
  assert.equal(sessionIdOf(undefined), undefined)
})

test('pickAgentParams：只取六个键，空值视为没给，越界与非法值直接报错', () => {
  assert.deepEqual(pickAgentParams({}), {})
  assert.deepEqual(pickAgentParams(undefined), {})
  assert.deepEqual(pickAgentParams({ emotion: '  ', voiceId: '', speed: undefined, vol: null, languageBoost: '' }), {})
  assert.deepEqual(pickAgentParams({ languageBoost: ' auto ' }), { languageBoost: 'auto' })
  assert.deepEqual(
    pickAgentParams({
      text: '不该被收进来', emotion: 'calm', voiceId: 'female-shaonv', speed: 0.95, vol: 10, pitch: -12, languageBoost: 'Chinese,Yue',
    }),
    { emotion: 'calm', voiceId: 'female-shaonv', speed: 0.95, vol: 10, pitch: -12, languageBoost: 'Chinese,Yue' },
  )
  assert.throws(() => pickAgentParams({ emotion: 'joyful' }), /不在允许值里/)
  assert.throws(() => pickAgentParams({ languageBoost: 'Cantonese' }), /不在允许值里/)
  assert.throws(() => pickAgentParams({ speed: 3 }), /必须在 0.5–2 之间/)
  assert.throws(() => pickAgentParams({ vol: 0 }), /必须在 0.01–10 之间/)
  assert.throws(() => pickAgentParams({ pitch: 13 }), /必须在 -12–12 之间/)
  assert.throws(() => pickAgentParams({ speed: '1.5' }), /必须是数字/)
})

test('stageEmotionRequest：空文本与超限分别报错（超限带上限），正常写条目标 source=agent', () => {
  const h = pendingHarness()
  try {
    assert.throws(() => stageEmotionRequest(h.pending, { text: '   ' }), /text 不能为空/)
    assert.throws(() => stageEmotionRequest(h.pending, { text: 'a'.repeat(TEXT_LIMIT + 1) }), new RegExp(String(TEXT_LIMIT)))
    const item = stageEmotionRequest(h.pending, { text: '  念这段  ', params: { speed: 0.9 }, sessionId: 's1' })
    assert.equal(item.text, '念这段')
    assert.deepEqual(item.params, { speed: 0.9 })
    assert.equal(item.source, 'agent')
  } finally { h.done() }
})

test('stageEmotionRequest：Agent 给的 languageBoost 进待播条目（§11.4）', () => {
  const h = pendingHarness()
  try {
    const item = stageEmotionRequest(h.pending, { text: '念这个', params: { languageBoost: 'Chinese,Yue' }, sessionId: 's1' })
    assert.deepEqual(item.params, { languageBoost: 'Chinese,Yue' })
  } finally { h.done() }
})

test('客户端 AGENT_PARAM_KEYS 与宿主逐字一致（SPEC §11.4）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const match = src.match(/const AGENT_PARAM_KEYS = \[([^\]]*)\]/)
  assert.ok(match, 'client.js 里找不到 AGENT_PARAM_KEYS')
  const clientKeys = match[1].split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter((item) => item !== '')
  assert.deepEqual(clientKeys, [...AGENT_PARAM_KEYS])
})

test('模型级情绪闸门：whisper 在 2.8 系列不可用、fluent 不限（2026-10-15 实测）', () => {
  assert.equal(emotionAllowedByModel('speech-2.8-hd', 'whisper'), false)
  assert.equal(emotionAllowedByModel('speech-2.8-turbo', 'whisper'), false)
  assert.equal(emotionAllowedByModel('speech-2.6-hd', 'whisper'), true)
  assert.equal(emotionAllowedByModel('speech-02-hd', 'whisper'), true)
  assert.equal(emotionAllowedByModel('', 'whisper'), true, '模型未知时不拦，交给上游')
  for (const model of ['speech-2.8-hd', 'speech-2.6-turbo', 'speech-02-hd']) assert.equal(emotionAllowedByModel(model, 'fluent'), true)
  assert.deepEqual(EMOTIONS.filter((item) => !emotionsForModel('speech-2.8-hd').includes(item)), ['whisper'])

  const h = pendingHarness()
  try {
    const enumOf = (model) => buildEmotionToolDefinition({ pending: h.pending, config: () => normalizeConfig({ model }) }).parameters.properties.emotion.enum
    assert.equal(enumOf('speech-2.8-hd').includes('whisper'), false)
    assert.equal(enumOf('speech-2.6-hd').includes('whisper'), true)
  } finally {
    h.done()
  }

  assert.throws(() => pickAgentParams({ emotion: 'whisper' }, 'speech-2.8-hd'), /不可用/)
  assert.deepEqual(pickAgentParams({ emotion: 'whisper' }, 'speech-2.6-hd'), { emotion: 'whisper' })
  assert.deepEqual(pickAgentParams({ emotion: 'fluent' }, 'speech-2.8-hd'), { emotion: 'fluent' })
  assert.deepEqual(pickAgentParams({ emotion: 'whisper' }), { emotion: 'whisper' }, '不传模型＝不拦')
})

test('buildEmotionToolDefinition：schema 与 output.render 形状（§11.4）', () => {
  const h = pendingHarness()
  try {
    const definition = buildEmotionToolDefinition({ pending: h.pending, config: () => normalizeConfig({}) })
    assert.equal(definition.name, EMOTION_TOOL_NAME)
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.deepEqual(definition.parameters.required, ['text'])
    assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['emotion', 'languageBoost', 'pitch', 'speed', 'text', 'voiceId', 'vol'])
    assert.deepEqual(definition.parameters.properties.emotion.enum, [...emotionsForModel(normalizeConfig({}).model)])
    assert.deepEqual(definition.parameters.properties.languageBoost.enum, LANGUAGE_BOOSTS.filter((item) => item !== ''))
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.required.includes('registered'), true)
    assert.equal(definition.output.schema.properties.registered.const, true)

    const [block] = definition.output.render({}, { registered: true, chars: 8, params: {}, duplicates: false })
    assert.equal(block.type, 'text')
    assert.match(block.text, /8 字符/)
    assert.match(block.text, /播放按钮/)
    // 回执不泄露内部路径
    assert.equal(/pending|\.json|\/Users\//.test(block.text), false)
    assert.match(definition.output.render({}, { registered: true, chars: 8, params: {}, duplicates: true })[0].text, /覆盖/)

    const card = definition.presentCall({ text: 'x'.repeat(200) })
    assert.equal(card.card, 'generic')
    assert.equal(card.kind, 'execute')
    assert.equal(card.rawInput.length < 200, true)
  } finally { h.done() }
})

test('emotion_tts.execute：写 pending/<sid>.json（含 text/params/source），同会话后写覆盖', async () => {
  const h = pendingHarness()
  try {
    const definition = buildEmotionToolDefinition({ pending: h.pending, config: () => normalizeConfig({}) })
    const exec = { agent: { session: { header: { id: 'sess-1' } } } }

    const first = await definition.execute({ text: ' 第一份稿子 ', speed: 0.9 }, exec)
    assert.deepEqual(first, { registered: true, chars: '第一份稿子'.length, params: { speed: 0.9 }, duplicates: false })
    const file = JSON.parse(readFileSync(h.file('sess-1'), 'utf8'))
    assert.equal(file.items.length, 1)
    assert.equal(file.items[0].text, '第一份稿子')
    assert.deepEqual(file.items[0].params, { speed: 0.9 })
    assert.equal(file.items[0].source, 'agent')
    assert.equal(file.sessionId, 'sess-1')

    const second = await definition.execute({ text: '第二份', emotion: 'calm' }, exec)
    assert.equal(second.duplicates, true, '同一会话里已有未播条目 → 覆盖')
    const after = JSON.parse(readFileSync(h.file('sess-1'), 'utf8'))
    assert.equal(after.items.length, 1, '同会话后写覆盖，不留两条待播')
    assert.equal(after.items[0].text, '第二份')
    assert.equal(after.superseded, 1)
    assert.deepEqual(h.pending.list('sess-1').map((item) => item.text), ['第二份'])
  } finally { h.done() }
})

test('emotion_tts.execute：拿不到会话 id 时降级 current.json，且不触碰别的文件', async () => {
  const h = pendingHarness()
  try {
    const definition = buildEmotionToolDefinition({ pending: h.pending, config: () => normalizeConfig({}) })
    const result = await definition.execute({ text: '降级稿' }, {})
    assert.equal(result.registered, true)
    assert.equal(existsSync(h.file('current')), true)
    assert.equal(JSON.parse(readFileSync(h.file('current'), 'utf8')).items[0].text, '降级稿')
    // 会话 id 带路径片段时被净化，不会跑出 pending 目录
    await definition.execute({ text: '带路径的会话' }, { agent: { session: { header: { id: '../../etc/passwd' } } } })
    assert.equal(JSON.parse(readFileSync(h.file('__.._etc_passwd'), 'utf8')).items[0].text, '带路径的会话')
  } finally { h.done() }
})

test('emotion_tts.execute：参数越界与空文本都抛错，且不落盘', async () => {
  const h = pendingHarness()
  try {
    const definition = buildEmotionToolDefinition({ pending: h.pending, config: () => normalizeConfig({}) })
    const exec = { agent: { session: { header: { id: 's1' } } } }
    await assert.rejects(() => definition.execute({ text: '  ' }, exec), /text 不能为空/)
    await assert.rejects(() => definition.execute({ text: 'a'.repeat(TEXT_LIMIT + 1) }, exec), new RegExp(String(TEXT_LIMIT)))
    await assert.rejects(() => definition.execute({ text: 'ok', speed: 5 }, exec), /必须在 0.5–2 之间/)
    assert.equal(existsSync(h.file('s1')), false)
  } finally { h.done() }
})

// ───────────────────────────────────────────────────────────── 接线闸门（§11.2 / §11.7）

/** 真 cordis Context + 假服务：记下 webServer.register / skills.registerProvider / tools.register 的调用。 */
function wiring({ rowConfig, envHome }) {
  const calls = { routes: [], providers: [], tools: [] }
  const ctx = new Context()
  ctx.provide('webServer', { register: (route) => { calls.routes.push(route); return () => {} } })
  ctx.provide('skills', { registerProvider: (create) => { calls.providers.push(create()); return () => {} } })
  ctx.provide('tools', { register: (definition) => { calls.tools.push(definition); return () => {} } })

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = envHome
  ctx.plugin({ name: pluginName, inject: pluginInject, Config, apply: applyPlugin }, rowConfig)
  return {
    ctx,
    calls,
    async done() {
      await ctx.stop?.()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

test('接线：role=full + scope=global → 9 条路由 + 技能 + 工具', { skip: Context === null }, async () => {
  const dir = tempDir()
  const { calls, done } = wiring({ rowConfig: { emotionTts: { scope: 'global' } }, envHome: dir })
  try {
    await tick()
    assert.deepEqual(calls.routes.map((route) => route.path), ROUTE_TABLE.map((route) => route.path))
    assert.equal(calls.routes.length, 9)
    assert.equal(calls.providers.length, 1)
    assert.equal(calls.providers[0].name, NS)
    assert.equal(calls.tools.length, 1)
    assert.equal(calls.tools[0].name, EMOTION_TOOL_NAME)
    // 交接给宿主的 handler 是函数（挂载面正确，细节由 routes.test.js 覆盖）
    assert.equal(typeof calls.routes[0].handler, 'function')
  } finally { await done(); rmSync(dir, { recursive: true, force: true }) }
})

test('接线：role=skill-only 只认 scope=preset —— 不挂路由，其余组合一律不注册', { skip: Context === null }, async () => {
  const cases = [
    { scope: 'preset', routes: 0, providers: 1, tools: 1 },
    { scope: 'global', routes: 0, providers: 0, tools: 0 },
    { scope: 'off', routes: 0, providers: 0, tools: 0 },
  ]
  for (const item of cases) {
    const dir = tempDir()
    const { calls, done } = wiring({ rowConfig: { role: 'skill-only', emotionTts: { scope: item.scope } }, envHome: dir })
    try {
      await tick()
      assert.equal(calls.routes.length, item.routes, `scope=${item.scope} 时不该挂路由`)
      assert.equal(calls.providers.length, item.providers, `scope=${item.scope} 的技能注册面`)
      assert.equal(calls.tools.length, item.tools, `scope=${item.scope} 的工具注册面`)
    } finally { await done(); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('接线：全局行只在 scope=global 时挂技能与工具，scope=off 是绝对闸', { skip: Context === null }, async () => {
  for (const item of [{ scope: 'off', providers: 0 }, { scope: 'preset', providers: 0 }, { scope: 'global', providers: 1 }]) {
    const dir = tempDir()
    const { calls, done } = wiring({ rowConfig: { emotionTts: { scope: item.scope } }, envHome: dir })
    try {
      await tick()
      assert.equal(calls.routes.length, 9, '全局行的 9 条路由与 scope 无关')
      assert.equal(calls.providers.length, item.providers, `scope=${item.scope} 的技能注册面`)
      assert.equal(calls.tools.length, item.providers, `scope=${item.scope} 的工具注册面`)
    } finally { await done(); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('接线：role 只认行配置——config.json 里的 role 不影响全局行', { skip: Context === null }, async () => {
  const home = tempDir()
  // 两行共享同一个状态目录：伪造 preset 行留下的 role=skill-only
  mkdirSync(join(home, 'dsh-minimax-tts'), { recursive: true })
  writeFileSync(join(home, 'dsh-minimax-tts', 'config.json'), JSON.stringify({ role: 'skill-only', emotionTts: { scope: 'global' } }))
  const { calls, done } = wiring({ rowConfig: { emotionTts: { scope: 'global' } }, envHome: home })
  try {
    await tick()
    assert.equal(calls.routes.length, 9, '行配置 role=full 时，store 里的 role 不该把 9 条路由吃掉')
    assert.equal(calls.providers.length, 1)
  } finally { await done(); rmSync(home, { recursive: true, force: true }) }
})

test('接线：工具定义穿过假 ctx 后能真的写进该状态目录（端到端）', { skip: Context === null }, async () => {
  const home = tempDir()
  const { calls, done } = wiring({ rowConfig: { emotionTts: { scope: 'global' } }, envHome: home })
  try {
    await tick()
    const definition = calls.tools[0]
    const result = await definition.execute({ text: '端到端稿子', voiceId: 'female-shaonv' }, { agent: { session: { header: { id: 's7' } } } })
    assert.equal(result.registered, true)
    const file = JSON.parse(readFileSync(join(home, 'dsh-minimax-tts', 'pending', 's7.json'), 'utf8'))
    assert.equal(file.items[0].text, '端到端稿子')
    assert.deepEqual(file.items[0].params, { voiceId: 'female-shaonv' })
    // 技能正文也从同一个 runtime 配置生成（list/get 是 thenable，按宿主 waitWithAbort 的用法 await）
    const provider = calls.providers[0]
    const candidates = await provider.list()
    assert.ok((await provider.get(candidates[0])).content.includes('speech-2.8-hd'))
  } finally { await done(); rmSync(home, { recursive: true, force: true }) }
})
