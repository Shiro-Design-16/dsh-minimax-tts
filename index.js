/**
 * dsh-minimax-tts · 宿主半边接线层
 *
 * 这一层只做四件事：`Config` schema（SPEC §4）、把 `lib/core.js` 的纯 handler 接到
 * `webServer.register` 上、用 `ctx.effect(...)` 管清理、以及 `$DSH_HOME` 状态目录的落点。
 * 所有可单测的逻辑都在 `lib/core.js` 里（那一半零外部 import）。
 *
 * 路由前缀 `/dsh-minimax-tts`，仅本机回环可访问（回环判定见 core 的 `isLoopbackRequest`）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_PREVIEW_TEXT, NS, ROUTE_PREFIX, ROUTE_TABLE, createRuntime, defaultStateDir,
  isLoopbackRequest, jsonResponse,
} from './lib/core.js'
import { EMOTION_SKILL_NAME, EMOTION_TOOL_NAME, registerEmotionSkill, registerEmotionTool } from './lib/skill.js'

export const name = NS

/** 冻结（SPEC §2）：宿主半边只依赖 webServer。 */
export const inject = ['webServer']

/** 配置 schema（SPEC §4）：字段名与默认值逐条对齐冻结契约。 */
export const Config = z.object({
  baseUrl: z.string().default('https://api.minimax.cn').description('MiniMax 接入点（api.minimax.cn / api.minimaxi.com / api.minimax.io）'),
  apiKey: z.string().default('').description('留空则回退到 MINIMAX_API_KEY 环境变量与 ~/.dsh/.env'),
  model: z.string().default('speech-2.8-hd').description('speech-2.8-hd / speech-2.8-turbo / 2.6 / 02 / 01 系列'),
  voices: z.array(z.object({
    id: z.string().description('MiniMax voice_id'),
    label: z.string().default(''),
    isDefault: z.boolean().default(false),
  })).default([{ id: 'female-shaonv', label: '', isDefault: true }]).description('音色列表；isDefault 的那条是默认音色'),
  previewText: z.string().default(DEFAULT_PREVIEW_TEXT)
    .description('试听用的默认文本（客户端持久化）；空串回落默认值，不进缓存 key'),
  emotion: z.string().default('').description('空 = 不传，由模型按文本自选'),
  speed: z.number().min(0.5).max(2).default(1),
  vol: z.number().min(0.01).max(10).default(1),
  pitch: z.number().min(-12).max(12).step(1).default(0),
  sampleRate: z.number().default(32000).description('8000 / 16000 / 22050 / 24000 / 32000 / 44100'),
  bitrate: z.number().default(128000).description('32000 / 64000 / 128000 / 256000（仅 mp3）'),
  format: z.string().default('mp3').description('mp3 / pcm / flac / wav / pcmu_raw / pcmu_wav / opus'),
  channel: z.number().min(1).max(2).step(1).default(1),
  languageBoost: z.string().default('auto'),
  cleanup: z.object({
    days: z.number().min(0).default(30).description('按最后命中时间计龄'),
    maxItems: z.number().min(0).default(500),
    maxBytes: z.number().min(0).default(524288000),
  }).collapse(true).default({ days: 30, maxItems: 500, maxBytes: 524288000 }).description('缓存淘汰：任一超限即按 lastHitAt 从旧到新删，preview 优先'),
  advance: z.object({
    textNormalizationMode: z.string().default(''),
    latexRead: z.boolean().default(false),
    pronunciationTone: z.array(z.string()).default([]).description('发音词典，形如 "处理/(chu3)(li3)"'),
    aigcWatermark: z.boolean().default(false),
    outputFormat: z.string().default('hex'),
    forceCbr: z.boolean().default(false),
    voiceModify: z.union([z.const(null), z.object({
      pitch: z.number().default(0),
      intensity: z.number().default(0),
      timbre: z.number().default(0),
      sound_effects: z.string().default(''),
    })]).default(null).description('v1 不使用；保留字段以免设置页把它吃掉'),
    subtitleEnable: z.boolean().default(false),
  }).collapse(true).description('装完只调一次；除 subtitleEnable / aigcWatermark / outputFormat 外都进缓存 key')
    .default({
      textNormalizationMode: '', latexRead: false, pronunciationTone: [], aigcWatermark: false,
      outputFormat: 'hex', forceCbr: false, voiceModify: null, subtitleEnable: false,
    }),
  emotionTts: z.object({
    scope: z.union([z.const('off'), z.const('preset'), z.const('global')]).default('off')
      .description('灵动模式（SPEC §11.1）：off = 关闭；preset = 只有 preset 行注册技能与工具；global = 全局行注册'),
  }).collapse(true).default({ scope: 'off' }),
  role: z.union([z.const('full'), z.const('skill-only')]).default('full')
    .description('行级角色（SPEC §11.1）：full = 全局行（9 条路由）；skill-only = preset 行（不注册路由）'),
})

/** node `IncomingMessage` → 冻结形态 `req` 里的 body。 */
async function readJsonBody(stream) {
  if (stream.method === 'GET' || stream.method === 'HEAD') return { ok: true, value: undefined }
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: true, value: undefined }
  try { return { ok: true, value: JSON.parse(text) } } catch { return { ok: false, value: undefined } }
}

/** 冻结形态 `res` → node `ServerResponse`。 */
function writeResponse(res, out) {
  const headers = { ...(out?.headers ?? {}) }
  let payload = Buffer.alloc(0)
  if (out?.json !== undefined) {
    payload = Buffer.from(JSON.stringify(out.json), 'utf8')
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json; charset=utf-8'
  } else if (Buffer.isBuffer(out?.body)) {
    payload = out.body
  } else if (typeof out?.body === 'string') {
    payload = Buffer.from(out.body, 'utf8')
  }
  if (headers['content-length'] === undefined) headers['content-length'] = String(payload.length)
  res.writeHead(out?.status ?? 200, headers)
  res.end(payload)
}

export function apply(ctx, config) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const runtime = createRuntime({ dir: defaultStateDir(home), homeDir: home, config })
  // 行级角色只认**行配置**（SPEC §11.2）：full = 全局行，skill-only = preset 行。
  // 两行共享同一个状态目录，若从合并后的配置里读 role，preset 行写进 config.json 的值
  // 会让全局行也少注册 9 条路由——设置页没有 role 开关，但这条防线不该靠「客户端不会发」。
  const role = config?.role === 'skill-only' ? 'skill-only' : 'full'
  // 三态闸（SPEC §11.1）：off 两处都不注册；preset 只有 preset 行注册；global 只有全局行注册。
  const scope = runtime.config().emotionTts.scope
  const exposeEmotion = role === 'skill-only' ? scope === 'preset' : scope === 'global'
  let mounted = false

  const mountRoutes = () => {
    if (mounted) return
    const web = ctx.get('webServer')
    if (web === undefined || web === null) return
    mounted = true

    for (const route of ROUTE_TABLE) {
      ctx.effect(() => {
        const disposer = web.register({
          kind: route.kind,
          path: route.path,
          handler: async (req, res) => {
            try {
              if (!isLoopbackRequest({ remoteAddress: req.socket?.remoteAddress, headers: req.headers ?? {} })) {
                writeResponse(res, jsonResponse(403, { ok: false, error: 'loopback-only' }))
                return
              }
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              const parsed = await readJsonBody(req)
              if (parsed.ok !== true) {
                writeResponse(res, jsonResponse(400, { ok: false, error: 'bad-json' }))
                return
              }
              const out = await runtime.dispatch({
                method: req.method ?? 'GET',
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                body: parsed.value,
              })
              writeResponse(res, out)
            } catch (error) {
              ctx.logger?.warn?.(`[${NS}] ${route.path} failed: ${error?.message ?? error}`)
              writeResponse(res, jsonResponse(500, { ok: false, error: 'internal-error' }))
            }
          },
        })
        return () => { if (typeof disposer === 'function') disposer() }
      }, `${NS}: ${route.path} route`)
    }

    ctx.logger?.info?.(`[${NS}] routes mounted on ${ROUTE_PREFIX} -> ${runtime.dir}`)
  }

  /**
   * 灵动模式的两件贡献（SPEC §11.2）：技能 provider + `emotion_tts` 工具。
   * 从 preset 作用域注册进的是该 preset 的层（只有被这个 preset 挂载的会话看得见），
   * 从全局行注册进的是全局层（所有模式可见）——这正是 `scope` 两态的区别。
   *
   * `ctx.inject(['skills','tools'], cb)` 是 cordis 的「等服务就绪再跑」形状：这两个服务
   * 可能晚于本插件出现，也可能整个不存在（老宿主没有 skills / tools 服务），所以既不能
   * 同步 `ctx.get`，也不能把它们写进本插件的静态 `inject`——那会让 9 条路由一起空等。
   */
  const contributeEmotion = (scoped) => {
    scoped.effect(() => registerEmotionSkill(scoped.skills, () => runtime.config()),
      `${NS}: ${EMOTION_SKILL_NAME} skill provider`)
    scoped.effect(() => registerEmotionTool(scoped.tools, { pending: runtime.pending, config: () => runtime.config() }),
      `${NS}: ${EMOTION_TOOL_NAME} tool`)
    scoped.logger?.info?.(`[${NS}] 灵动模式已挂载（role=${role}）：${EMOTION_SKILL_NAME} + ${EMOTION_TOOL_NAME}`)
  }

  /** 全局行的 9 条路由：`inject` 已保证 webServer 存在，这里只兜「服务真的缺失」这一种情况。 */
  const whenReady = (service, mount) => {
    if (ctx.get(service) !== undefined) mount()
    else ctx.on('internal/service', (ready) => { if (ready === service) mount() })
  }

  if (role === 'skill-only') {
    // preset 行：不注册任何路由（SPEC §11.2）
    ctx.logger?.info?.(`[${NS}] skill-only 行：不注册路由（灵动模式${exposeEmotion ? '已启用' : `未启用：scope=${scope}`}）`)
  } else {
    whenReady('webServer', mountRoutes)
  }

  if (exposeEmotion) ctx.inject(['skills', 'tools'], contributeEmotion)
  else if (role === 'full') ctx.logger?.info?.(`[${NS}] 灵动模式未启用（scope=${scope}）：技能与工具都不注册`)
}
