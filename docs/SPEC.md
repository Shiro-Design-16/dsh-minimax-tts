# dsh-minimax-tts 规格与接口契约（冻结版）

> 本文件是插件的实现契约与实测记录（冻结版）。源码与测试里引用的 `§` 编号都指向本文件，改动请同步。
> 版本：v1 = 手动模式可用；v1.1 = 灵动模式（2026-10-14 实装，契约见 §11）。
> 命名：用户可见名为「灵动模式」「灵动朗读技能」，技能英文名 `emotion-tts`；内部键为 `emotionTts.scope`（`off` / `preset` / `global`）与行级 `role`，见 §11。

## 0. 定位

DSH 插件，只适配 MiniMax 的 TTS：把对话流里的 assistant 消息朗读出来。
- 插件目录：本仓库根目录
- 两半边纯 ESM JavaScript，**无 TS、无构建步骤**
- 挂载：profile（`$DSH_HOME/profiles/<name>`）的 `package.json` 的 `dependencies` 里加 `"dsh-minimax-tts": "link:<本仓库绝对路径>"`，并在 `dsh.profile.bundles` 里加一条。

**v1 不做**：声音克隆、声音设计、双音色 `timbre_weights`、变声 `voice_modify`、音乐与音效、流式合成、字幕落盘、边生成边朗读。

## 1. 文件构成

| 路径 | 内容 |
|---|---|
| `README.md` | 安装、配置、路由与使用说明（公开文档） |
| `docs/SPEC.md` | 本文件：实现契约与实测记录 |
| `package.json`、`cordis.patch.yml`、`index.js`、`lib/**`、`test/**` | 宿主半边（路由、合成、缓存、技能与工具） |
| `client.js` | 客户端半边（消息上的朗读按钮与设置页） |

## 2. package.json 契约（冻结）

```json
{
  "name": "dsh-minimax-tts",
  "version": "0.1.0",
  "private": true,
  "description": "MiniMax TTS：朗读对话流里的 assistant 消息（手动模式；灵动模式为 v1.1 预留框架）",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots"
      ]
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" },
  "engines": { "node": "^22.19.0 || >=24" }
}
```

`inject` 只列客户端真正用到的两个宿主包（`slots` / `locale`）；`dsh-api-remotes` 与 `dsh-client-ui-settings`
在 2026-10-14「设置页搬进插件页」后已不再被 `client.js` 使用，故移出清单（`client.js` 只 `require('react')`，
HTTP 一律用 `fetch` 打本机回环路由）。`slots.inject(name, cb)` 的惰性形式让客户端不依赖加载顺序。

`cordis.patch.yml`（冻结）：

```yaml
# dsh-minimax-tts bundle patch: insert the host row into the composition.
- insert:
    - id: dsh-minimax-tts
      name: 'dsh-minimax-tts'   # 必须逐字等于 package.json 的 name
```

> 沿革（2026-10-15）：本插件最初以 `@local/dsh-minimax-tts` 的名字挂载。它的目录变成 git 仓库
> （有了远端）之后，插件管理器按目录名把它重挂成不带 scope 的 `dsh-minimax-tts` —— profile 的
> `dependencies` 键、`dsh.profile.bundles`、`node_modules/dsh-minimax-tts` 符号链都改成了新名，
> 而 `package.json` 与 bundle 行还停在旧名上，两边对不上：bundle 行靠 `name` 解析客户端模块，
> 名字不一致会让 roster 找不到该行、整个插件挂载失败（实测：profile 起不来）。现已把包名、
> bundle 行名、客户端注册 id 与设置项 key 统一为 `dsh-minimax-tts`。

宿主半边导出（冻结）：

```js
export const name = 'dsh-minimax-tts'
export const inject = ['webServer']
export const Config = z.object({ /* §4 */ })
export function apply(ctx, config) { /* 只在此处注册副作用，全部走 ctx.effect(...) */ }
```

`z` 来自 `@deepseek-ai/schemastery`（宿主半边运行在 profile 的 node_modules 解析环境下，由宿主运行时提供，**故意不声明成依赖**）。

## 3. 状态目录（`$DSH_HOME` = `~/.dsh`）

```
~/.dsh/dsh-minimax-tts/
  config.json          配置（本插件唯一的配置真相源；0600）
  config.json.bak      首次变更前的快照
  cache/index.json     缓存索引（原子写 + .bak 自愈）
  cache/<hash>.<ext>   音频文件
  pending/<sessionId>.json   灵动模式待提交请求（v1 落缝，默认不挂载）
  voices.json          用户音色列表（含默认标记）——若并入 config.json 则不要此文件
```

`makeStore()` 采用已验证语义：写临时文件 + `rename` 原子替换；首次变更前留一份 `.bak`；解析失败自愈为默认值；文件权限 0600。

## 4. 配置 Schema（冻结字段名与默认值）

```js
config = {
  baseUrl: 'https://api.minimax.cn',   // 可改为 api.minimaxi.com / api.minimax.io
  apiKey: '',
  model: 'speech-2.8-hd',
  voices: [ { id: 'female-shaonv', label: '', isDefault: true } ],
  previewText: '你好，这是一段语音合成测试，听到说明朗读功能已经正常工作了。',   // 试听文本；空串回落默认值，与客户端常量逐字相同
  emotion: '',                          // '' = 不传，由模型按文本自选
  speed: 1,                             // [0.5, 2]
  vol: 1,                               // (0, 10]
  pitch: 0,                             // [-12, 12]
  sampleRate: 32000, bitrate: 128000, format: 'mp3', channel: 1,
  languageBoost: 'auto',
  cleanup: { days: 30, maxItems: 500, maxBytes: 524288000 },
  advance: {                            // 装完只调一次，设置页默认折叠
    textNormalizationMode: '', latexRead: false, pronunciationTone: [], aigcWatermark: false,
    outputFormat: 'hex', forceCbr: false, voiceModify: null, subtitleEnable: false
  },
  emotionTts: { scope: 'off' },   // v1.1 三态 off|preset|global；行级字段 role（'full'|'skill-only'）见 §11.2
}
```

API key 兜底顺序：`config.apiKey` → 环境变量 `MINIMAX_API_KEY` → `~/.dsh/.env` → （可选）扫同目录约定文件。
**不入缓存 key 的字段**（改了不影响已有缓存）：`apiKey`、`baseUrl`、`cleanup`、`emotionTts`、`role`、`previewText`、`advance.subtitleEnable`、`advance.aigcWatermark`、`advance.outputFormat`。

## 5. HTTP 路由契约（冻结路径）

前缀固定 `/dsh-minimax-tts`，仅本机回环可访问。

**实现形态（冻结）**：每条路由是一个可直接单测的纯函数
`async function handler(req) → res`，其中 `req = { method, path, query, body }`、`res = { status, headers?, json?, body? }`（`body` 为 Buffer 时表示二进制）。另有一个薄适配层把 `webServer.register({ kind: 'exact', path, handler })` 接到这些函数上。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/dsh-minimax-tts/synthesize` | `{ text, params: { voiceId?, model?, emotion?, speed?, vol?, pitch?, format?, sampleRate?, bitrate?, channel?, languageBoost? }, preview?: true }` | `{ ok: true, url, cached: bool, chars: number, totalChars: number }` 或 `{ ok: false, error, statusCode?, statusMsg? }` |
| GET | `/dsh-minimax-tts/config` | — | `{ ok: true, config }` |
| POST | `/dsh-minimax-tts/config` | `{ patch }` | `{ ok: true, config }`（浅合并；`voices` 整体替换） |
| GET | `/dsh-minimax-tts/audio/<hash>.<ext>` | — | 音频二进制 + `content-type` |
| GET | `/dsh-minimax-tts/cache` | — | `{ ok: true, bytes, count, hits, totalChars, items: [...] }` |
| POST | `/dsh-minimax-tts/cache/clear` | `{ all?: true }` | `{ ok: true, removed: n }` |
| POST | `/dsh-minimax-tts/cache/open` | — | `{ ok: true, dir }`；打不开时 `{ ok: false, error: 'open-failed', dir }`（HTTP 200 + 业务 error）。用平台命令在文件管理器里打开缓存目录：darwin `open` / win32 `explorer` / 其它 `xdg-open`，`detached + unref`（不等命令退出）；打开动作经 `createRuntime({ openDirImpl })` 注入，测试用假实现替换 |
| GET | `/dsh-minimax-tts/pending` | `?sessionId=` | `{ ok: true, items: [...] }`（只读调试用；`emotionTts.scope === 'off'` 时恒返回空） |
| POST | `/dsh-minimax-tts/pending/claim` | `{ sessionId? }`（无 sessionId → 降级 `pending/current.json`） | `{ ok: true, item: { text, params, createdAt } \| null }`；认领即消费（第二次返回 `null`）；`scope='off'` 时 `item: null`；`GET` → 405 |
| POST | `/dsh-minimax-tts/voices` | `{}` 或 `{ refresh: true }` | `{ ok: true, fetchedAt, cached, count, voices: [{ id, name }] }`；失败 `{ ok: false, error: 'api-key-missing' \| 'fetch-unavailable' \| 'network-error' \| 'bad-response' \| 'minimax-error', statusCode?, statusMsg? }`（HTTP 200 + 业务 error，永不 500）。查询域与合成同一个 `baseUrl`（`POST {baseUrl}/v1/get_voice`，body `{ voice_type: 'all' }`，复用合成用的 `post()`）；缓存 24h、按 `baseUrl` 分键，`refresh: true` 强制回源；回源失败保留旧缓存但本次响应不回 stale 数据；`apiKey` 为空时不发请求。投影规则见 §8 |

> **音色目录只作提示**：设置页用 `POST /dsh-minimax-tts/voices`（§5）的结果中性标注「目录内 / 目录外」（请求失败时标记降级为「检验失败」且保留上一轮结果），该标记**不参与保存与合成**——不阻止、不阻断、不提示失败；
> 查询端点 `POST {baseUrl}/v1/get_voice` 未必返回官方试听页 <https://www.minimax.cn/audio> 可见、可真实合成的音色（如 `Japanese_energetic_anime_girl_vv1`），**查错了算上游的**（用户决策 2026-10-14）。
> 音色来源＝内置默认音色 + 用户手填 `voice_id` 加入 `voices` 列表 + 官方试听页试听后复制。

**计费与错误语义（关键）**：MiniMax 用 HTTP 200 携带业务错误，**判定只看 `base_resp.status_code === 0`**；非 0 时把 `status_code` 与 `status_msg` 透传到 `error`/`statusCode`/`statusMsg`。

## 6. 缓存契约（冻结）

- `key = sha256(JSON.stringify({ text, params, model, voiceId }))`（`params` 为生效参数合并后的对象，字段顺序固定；`text` 为**清洗后**文本）。
- 文件：`cache/<key>.<ext>`；索引 `cache/index.json` = `{ version: 1, items: { [key]: { file, ext, bytes, chars, model, voiceId, createdAt, lastHitAt, hits, preview } } }`。
- 命中即回 `url`、`cached: true`，并累加 `hits`/`lastHitAt`；未命中才请求 MiniMax，成功落盘并写索引（原子写 + `.bak`）。
- 淘汰：`days` / `maxItems` / `maxBytes` 任一超限 → 按 `lastHitAt` 从旧到新删，直到全部满足。删除同时清索引条目。
- `preview: true` 的条目（试听）与正式条目同池，但淘汰时**优先删 preview**。
- 计量：`chars` 取 MiniMax `extra_info.usage_characters`；设置页展示单次与累计（`totalChars` 存在 index 顶层）。

## 7. 文本清洗契约（冻结在宿主半边，纯函数）

签名：`export function cleanForTts(text) → string`，与 `cacheKeyFor()`、缓存淘汰、pending 状态迁移、**全部路由 handler** 一起放在 **`lib/core.js`**。

**`lib/core.js` 零外部 import**：不 import `@deepseek-ai/*`（`node --test` 在工作区解析不到 profile 的 node_modules），只用 node 内建。`index.js` 只做接线：`Config` schema、`apply`、`webServer.register` 适配、`ctx.effect` 清理。这样纯逻辑可以脱离 DSH 环境直接单测。

规则：
1. 去代码围栏/行内代码、URL、绝对与相对路径、颜文字与 emoji、Markdown 装饰符（`**`、`#`、`>`、表格竖线、链接语法）；
2. **强保留**：语气词标签（`(laughs)`、`(sighs)`、`(chuckle)`… 共 19 个，仅 2.8-hd/turbo 支持）、停顿标记 `<#0.8#>`（0.01–99.99 秒、两位小数、不连续）、行内注音 `(chu3)(li3)` 这类半角括号注音；
3. 压缩连续空白，保留段落换行（MiniMax 用换行分段）；
4. 清洗后为空 → 返回空串，`/synthesize` 直接 `{ ok: false, error: 'empty-after-clean' }`，不产生任何请求。

## 8. MiniMax API（写代码时的权威事实）

**端点**：`POST {baseUrl}/v1/t2a_v2`；错误响应体形如 `{"base_resp":{"status_code":1004,"status_msg":"login fail: ..."}}`。

**请求体**
```
{ model, text, stream: false,
  voice_setting: { voice_id, speed, vol, pitch, emotion, latex_read? },
  audio_setting: { sample_rate, bitrate, format, channel, force_cbr? },
  language_boost?, text_normalization_mode?, pronunciation_dict?{tone:[]},
  voice_modify?{pitch,intensity,timbre,sound_effects}, subtitle_enable?, output_format?, aigc_watermark? }
```
- `model` ∈ `speech-2.8-hd | speech-2.8-turbo | speech-2.6-hd | speech-2.6-turbo | speech-02-hd | speech-02-turbo | speech-01-hd | speech-01-turbo`
- `text` 必须 < 10000 字符；> 3000 官方建议流式（v1 不做流式，超限给明确错误）
- `language_boost` ∈ 官方 41 项（40 种语言 + `auto`），默认 `null`＝不增强；`auto`＝模型自动识别；粤语音色必须 `Chinese,Yue`；`speech-01`/`02` 不支持 `Persian`/`Filipino`/`Tamil`。**本插件语义**：设置页为下拉选框，取值 `auto`（默认）/ 40 种语言 / `''`＝不传该字段（官方默认 `null`）；配置里 `''` 不回落为 `auto`
- `emotion` ∈ `happy|sad|angry|fearful|disgusted|surprised|calm|fluent|whisper`；默认由模型自选；**`whisper` 在 `speech-2.8` 系列不可用**（2026-10-15 实测 2.8-hd / 2.8-turbo：`status_code 2013`「invalid params, speech 2.8 don't support whisper」）；`fluent` 在 2.8 / 2.6 / 02 上实测均 `status_code 0`（官方文档「fluent / whisper 仅 2.6 系列」对 `fluent` 是错的）
- `speed` [0.5,2]（默认 1）、`vol` (0,10]（默认 1）、`pitch` [-12,12]（默认 0）
- `sample_rate` ∈ {8000,16000,22050,24000,32000,44100}；`bitrate` ∈ {32000,64000,128000,256000}（仅 mp3）；`format` ∈ {mp3,pcm,flac,wav,pcmu_raw,pcmu_wav,opus}；`channel` 1|2
- 文本内标记：停顿 `<#x#>`（x 0.01–99.99，最多两位小数，必须夹在可朗读片段之间、不能连续）；语气词 19 个：`laughs chuckle coughs clear-throat groans breath pant inhale exhale gasps sniffs sighs snorts burps lip-smacking humming hissing emm sneezes`；行内注音用半角括号。
- `text_normalization`（旧，voice_setting 内）**已废弃**，用顶层 `text_normalization_mode`。

**响应**：`{ base_resp:{status_code,status_msg}, data:{ audio: "<hex>", subtitle_file? }, extra_info:{ audio_length, usage_characters, ... }, trace_id }`。
`data` 可能为 `null`；`data.audio` 为 hex 编码音频，落盘时 `Buffer.from(hex, 'hex')`。

**音色枚举**（本插件用于设置页的「远端可用性」标记，**只作提示**、绝不阻止保存或合成，见 §5）：`POST {baseUrl}/v1/get_voice`，body `{ voice_type: 'all' }`（可选 `system|voice_cloning|voice_generation|all`）→ 账号下全部 `voice_id`（含克隆/设计/音乐产出人声）。返回体巨大。
**投影（冻结）**：顶层四组 `system_voice` / `voice_cloning` / `voice_generation` / `music_generation` 按此顺序遍历，entry 取 `voice_id` → `id`、`voice_name` → `name`（缺失给空串）；`id` 去空白后为空则丢弃，同 id 去重（先出现者胜）；除 `id`/`name` 外**不透传任何字段**（`description` 是数组）。`voice_slots` 与 `base_resp` 忽略。
**缓存（冻结）**：宿主内存缓存，TTL 24h、按 `baseUrl` 分键（域名改了重新取）；`refresh: true` 无条件回源；回源失败保留旧缓存（下次不带 refresh 仍可用旧数据），但本次响应返回失败体。
用户挑音色仍以官方试听页（https://www.minimax.cn/audio）为准：试听后把 `voice_id` 手填进设置页。

**上游文档**：MiniMax 官方「同步语音合成（T2A HTTP）」与「Get Voice（音色管理）」接口文档；与本插件相关的字段与实测结论已汇总进 §8，日常只需读本文件。

## 9. 客户端半边契约（冻结）

**加载形态**：浏览器 ESM，`window.__ModuleLoader__.load({ id, factory })`，`factory` 接收 `require`；插槽用法遵循 DSH 客户端插件的通用骨架。

**挂载点**（已核实存在）
- `conversation.chat.assistant-actions`（scope `session`，宿主传入 `{ messageId, sessionId? }`）→ 朗读按钮（单按钮播放/停止切换）
- `plugins.bundle.config` + `plugins.row.config`（keyed root scope，`entryKey` = 包名 `dsh-minimax-tts`，宿主传入 `{ view: 'page' }`）→ 插件设置页
- ~~`conversation.input.left`~~（v1 已撤：自动朗读开关只留设置页里的一个）
- ~~`settings.section`~~（v1 已撤：设置搬到「设置 → 插件」，不占通用设置入口）

**禁止**：`require` 任何 `@deepseek-ai/*` Harness 客户端包（官方 `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35` 明文禁止，插件必须自己复刻宿主控件样式）；`document.body.appendChild`；写死圆角/颜色字面值；`border-radius` 只准用 `var(--dsw-radius-sm)` 等 token。

**按钮规格（照抄 native `MessageIconActions`，一个字都别自己发明）**
```css
.mtts-actions { display:inline-flex; align-items:center; gap:8px; height:28px; }
.mtts-btn { width:28px; height:28px; padding:6px; box-sizing:border-box;
  display:inline-flex; align-items:center; justify-content:center;
  border:none; background:transparent; cursor:pointer;
  border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-tertiary);
  transition:background-color 80ms ease; }
.mtts-btn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-secondary); }
.mtts-btn[data-unavailable="true"] { opacity:.4; cursor:default; }
.mtts-btn svg { width:15px; height:15px; display:block; }
```
样式注入方式：一次性把上面这段 CSS 插进 `document.head` 的 `<style data-mtts>`（**不是 body**），类名固定 `mtts-` 前缀。圆角 token 值：`--dsw-radius-xs 4 / sm 8 / md 12 / lg 16 / xl 20 / panel 28`；**hover 绝不改圆角**。

**本轮（2026-10-14）用户驱动的六项变更（已实现）**
1. 设置入口从 `settings.section` 搬到「设置 → 插件」（`plugins.bundle.config` + `plugins.row.config`），类名与样式不变；
2. `previewText` 入配置（宿主 `lib/core.js:91` 的 `DEFAULT_PREVIEW_TEXT`），设置页「试听文本」持久化、重开设置页不重置，并有「恢复默认」按钮；
3. 设置页新增「打开缓存目录」按钮 → `POST /cache/open`（宿主侧 `lib/core.js:898-912`）；
4. 恢复「刷新音色可用性」链路（客户端调 `/voices`、设置页中性标注「目录内 / 目录外」、请求失败时为「检验失败」并保留上一轮结果），但**降级为提示**：目录只作参考，绝不阻止保存或合成（`GET /voices` 仍 405）；
5. 撤掉 `conversation.input.left` 里的「停止全部」与自动朗读开关，按钮组只剩 flowItem 那一颗；
6. flowItem 由「两个按钮」改成「单按钮播放/停止切换」，图标换成用户给定的 16×16 SVG（播放 6 条路径、停止 1 条路径 `M4.5 4.5h7v7h-7z`，`stroke=currentColor`、`stroke-width=1`、cap `round`/`butt`）；
7. 同日追加（用户第二批指令）：**播放图标几何换成用户第二版**——六条横杠 `M2 6.81818V9.18182`、`M4.4 3.86364V12.1364`、`M6.8 1.5V14.5`、`M9.2 5.04545V10.9545`、`M11.6 2.68182V13.3182`、`M14 6.22727V9.77273`（仍是 16×16 网格、`stroke-width=1`、`currentColor`、round cap；停止态不变）；**音色卡片布局**：「加入列表」与「刷新音色目录」同处一个 `mtts-actions` 不换行按钮组（`client.js` 音色行），「上次检查：<时间>」/「检验失败：<code>」小字移到卡片标题行 `.mtts-card-head` 里，不再跟在按钮后面（否则窄面板换行会把两颗按钮拆到两行）。

**播放文本来源（v1）**：`useChat(s => s.legacy.nodes)` → 取 `node.kind === 'assistant' && node.messageId === messageId` 的 `node.blocks` 拼文本；`node.turn/step/seq/time` 用于判断是否最新消息。文本清洗由宿主侧完成，客户端**只传原文**。

**v1 必须留下的「缝」**
1. 播放器 API：`resolveUtterance(messageId) → { text, params, source: 'script' | 'visible' }`，v1 恒为 `'visible'`；
2. ~~按钮组里预留「灵动朗读」按钮位~~（2026-10-14 撤销，见 §11.6：对话区不再有任何灵动模式元素）；
3. 请求 `/pending` 与 `/pending/claim` 的调用封装（v1 返回空列表 → 走 `visible` 分支）；
4. 会话 id 来源：若客户端上下文里拿不到 sessionId（**这是阶段 E 要确认的点**），降级为不传 sessionId，宿主按单文件 `pending/current.json` 处理。

## 10. 测试与验收（宿主半边）

`node --test`（在插件目录下执行，只 import `lib/core.js` 与 node 内建）必须全绿，至少覆盖：
- store：首次写入不产生 `.bak`、首次变更后产生、后续变更不覆盖 `.bak`、无残留 `.tmp`、损坏文件自愈；
- `cleanForTts`：去代码块/URL/路径/emoji；保留 `(sighs)`、`<#0.8#>`、`(chu3)(li3)`；清洗后为空；
- `cacheKeyFor`：同参数同 key、改 text/params/model/voiceId 任一即变、改 apiKey/baseUrl/cleanup 不变；
- 缓存淘汰：超 days / maxItems / maxBytes 任一即删，preview 优先；
- pending：认领最早的 unclaimed、已有绑定时新条目 supersede 旧条目、过期条目清理；
- 路由：`POST /synthesize` 在 mock fetch 返回 `{base_resp:{status_code:1004,status_msg:'login fail...'}}` 时返回 `ok:false` 且携带 `statusCode/statusMsg`；命中缓存时**不发起 fetch**；
- 路由：`POST /cache/open` 用注入的 `openDirImpl` 断言「只调一次、参数是缓存目录绝对路径」；抛错或返回 `{ ok: false }` 时收敛为 `{ ok: false, error: 'open-failed', dir }`（HTTP 200）；
- 路由：`POST /voices` 投影（四组按序、空 id 丢弃、同 id 先出现者胜、其余字段不透传）；缓存（两次调用 fetch 只被调一次、`refresh:true` 后再调）；`apiKey === ''` → `{ ok: false, error: 'api-key-missing' }` 且不发请求；上游 `base_resp.status_code !== 0` → `{ ok: false, error: 'minimax-error', statusCode }` 且不污染已有缓存；`GET /voices` → 405；
- `normalizeConfig`：`previewText` 默认值与客户端常量逐字相同、空串回落默认值、多行原样保留（只 trim 首尾），且不进缓存 key。

客户端半边无自动化测试，用「静态自检 + 应用内验证清单」作为证据（无 `document.body`、无 `@deepseek-ai/` require、圆角全 token、类名 `mtts-` 前缀、slot 名与 `inject` 列表正确）。

## 11. v1.1 灵动模式（冻结契约；2026-10-14 用户拍板）

### 11.1 配置（替换 `autoMode`）
- 删除 `autoMode{enabled,autoRead,scriptSkill}`；新增 `emotionTts: { scope: 'off' | 'preset' | 'global' }`，默认 `{ scope: 'off' }`。非法值一律回落 `'off'`；缺键 → `'off'`。
- 新增行级字段 `role: 'full' | 'skill-only'`，默认 `'full'`；`role` 必须进 `NON_KEY_FIELDS`（不进缓存 key）。
- 三态语义：`off` = 两处都不注册（绝对闸）；`preset` = 只有被 preset 挂载的那一行注册；`global` = 全局行注册（所有模式可见）。

### 11.2 两行职责（同一个包，两种角色）
- **全局行**（profile bundle，现状不动）：`role='full'` → 注册 9 条路由；**仅当** `emotionTts.scope === 'global'` 时额外注册技能 provider + 工具。
- **preset 行**（用户写进 daily preset 的插件列表）：`config: { role: 'skill-only' }` → 不注册任何路由；**仅当** `emotionTts.scope === 'preset'` 时注册技能 provider + 工具。
- 交给用户的 YAML（daily preset 的 plugins 列表里，与现有行同级）：
  ```yaml
  - id: dsh-minimax-tts-skill
    name: 'dsh-minimax-tts'
    config:
      role: skill-only
  ```
- **实现待实测项**（实现者必须在证据里回报结论，不得靠猜）：
  1. preset 行能否解析 `dsh-minimax-tts`（走 profile 的 `node_modules/dsh-minimax-tts` 符号链）；
  2. `ctx.tools.register` 接受裸对象定义还是必须 `defineTool`（优先 `import('@deepseek-ai/dsh-tools')` 取 `defineTool`，解析失败退化为裸对象，以真实注册成功为准）；
  3. 技能 provider 的注册形状（照官方 `@deepseek-ai/dsh-skill-office`：`inject=['skills']` + `ctx.skills.registerProvider(() => provider)`；若 `inject` 多值冲突则改用 `ctx.inject([...], cb)`）。

- **实测结论（2026-10-14，host-v11 带回真实包证据、我复核）**：
  1. preset 行**能**解析 `dsh-minimax-tts`：`~/.dsh/profiles/desktop/node_modules/dsh-minimax-tts` 是符号链 → 插件目录，profile `package.json:11` 有 `link:` 依赖且 `dsh.profile.bundles` 含它（其余 profile 无此链 → 白名单行只在被链的 profile 生效）。
  2. `ctx.tools.register` **接受裸对象定义**：官方只校验 `output.render` 是函数、`output.schema` 合法、`name !== 'run_code'`；`defineTool` 只是 terse → JSON Schema 的糖。实现因此不依赖 `@deepseek-ai/dsh-tools`（宿主半边解析不到它）。
  3. provider 注册走 `ctx.inject(['skills','tools'], cb)` + `skills.registerProvider(() => provider)`；候选与定义已过真实 `SkillRegistry` 的 `validateCandidate` / `validateDefinition`（candidate 需带 `summary`）。

### 11.3 技能 `emotion-tts`（宿主侧 provider，正文在代码里）
- **硬约束**：正文不得以裸 `SKILL.md` / `<name>.md` 落盘（否则任何人往自己 preset 加一行指向该目录就能绕过「禁用」）；正文存插件代码（`lib/skill.js`），只经本插件 provider 供给。
- candidate 形状：`{ name:'emotion-tts', description, invocation:{ modelInvocable:true, userInvocable:false }, provider:'dsh-minimax-tts', source:'bundled', rank: BUNDLED_SKILL_RANK, resourceBase:{ kind:'opaque', description }, locator }`；`get()` 返回 `{ summary, content }`，content 用当前配置拼出模型、可用音色与参数范围。
- **`list()` / `get()` 必须是 thenable**（`Promise.resolve([...])` / `async get()`）：dsh-skill 用 `waitWithAbort(provider.list(...))`、`waitWithAbort(provider.get(...))` 等待，内部直接 `.then`（`@deepseek-ai/dsh-skill/lib/index.js:350`、`:256`，waitWithAbort 定义 `:537`）。返回裸数组/裸对象 ⇒ Agent 一调 `skill` 就报 `promise.then is not a function`（2026-10-14 实测踩过，已修 + 两条回归断言）。
- 正文必须写清：**可见正文保持干净（不写任何朗读标记）**，`text` 传同一段话、**词句与正文逐句相同**（不增删信息、不改意思、不换措辞），只允许加朗读标记或把数字/单位/缩写写成念法；正文里念不了的内容（代码块/表格/链接/长清单）可只收能念的句子并在回执说明略过了什么，或干脆不登记；可用 19 个英文半角标签（`(laughs)` 等）、停顿 `<#0.3#>`、注音 `(chu3)(li3)`；参数给法（emotion / voiceId / speed / vol / pitch / languageBoost）；**不得决定何时播放**（调用工具只是登记请求）；单条 ≤10000 字符，超 3000 建议精简。
- 推荐（非强制）人格式声明：「发言结束后用 `emotion-tts` 把这段正文按原词句登记为待播」——技能正文不依赖它也能正确使用；不登记不算错（播放按钮退回可见正文）。

### 11.4 工具 `emotion_tts`（登记朗读请求）
- 参数：`text`（必填，≤10000 字符）、`emotion`、`voiceId`、`speed`(0.5–2)、`vol`(0.01–10)、`pitch`(-12–12)、`languageBoost`（枚举 = 客户端 `LANGUAGE_BOOSTS` 里除空串外的 41 项，即设置页下拉的可选值；粤语音色必须给 `Chinese,Yue`）。
- 模型级收敛（§8 实测）：`emotion` 的 schema 枚举与技能正文都按**当前配置的模型**生成——`speech-2.8` 系列下 `whisper` 不出现在可用值里；宿主 `pickAgentParams` 另做硬闸（`emotion "whisper" 在当前模型 … 上不可用`，错误里列出可用值）。`fluent` 不受任何模型限制。
- **已知缺口**（2026-10-15，修复暂停）：没有「只允许 Agent 用哪些情绪」的开关——设置页的 `emotion` 是默认值而非允许集合，Agent 是否遵守 schema/正文里的枚举不受控。见 README「待解决的问题」。
- 参数收敛顺序：Agent 给的值 → 覆盖设置页同名项（客户端 `applyAgentParams`）；交给宿主 `/synthesize` 的 `params` 是并集，`params` 键集合固定为 11 项（进缓存 key）。宿主侧 `pickAgentParams` 的校验口径与其它参数一致：**越界/不在枚举里直接报错、不夹值**；空串与缺省等价（回落设置页）。
- Agent 侧的枚举闸门在宿主工具里（客户端只做类型过滤）：手工改 `pending/*.json` 塞进非枚举值不受这两道闸保护，与设置页允许自定义值同一口径。
- 行为：取调用者会话 id（`exec.agent` 里找，实测为准；拿不到 → 降级写 `pending/current.json`）；把 `{ text, params, createdAt, sessionId? }` 原子写入 `pending/<sid>.json`（sid 先做文件名净化），同 session 已有未认领条目时**后写覆盖**。返回一句话回执，不泄露内部路径。
- 禁止：触网、合成、写缓存。文本空或超限 → 报错（超限附上限）。

### 11.5 待播链路（客户端）
- 播放按钮点击顺序：① `POST /pending/claim { sessionId, messageId }` —— 宿主先拿 `messageId` 查**回放账本**（命中就直接返回那条消息第一次认领到的稿子，不动队列）；未命中才从待播队列取最早的未认领条目并**删除**它，同时把这份稿子记进账本。拿到 item → 用 item 的 text + params 合成（agent 参数覆盖设置页同名参数）；② 未命中 → 现状（该条消息可见文本 + 设置页参数）。
- 回放账本：落在 `pending/<sid>.json` 的 `delivered: { messageId: { text, params, createdAt } }`，**不随 TTL 过期、也不被后登记的稿子取代**（队列的 `add` 只替换 `items`），上限 64 条、超出丢最旧。语义是「这条消息播过哪份稿子」——换音色/改参数后回来再点播放，用的仍是那份稿子、但参数取当前设置页，因此会按新参数重新合成（缓存 key 含参数，换音色必然重新合成）。
- `GET /pending` 保留为只读列表（调试/冒烟），只列尚未认领的队列条目；`GET /pending/claim` → 405。队列本身仍是一次性消费：同一份稿子不会被两条不同消息各播一次。

### 11.6 客户端 UI 口径（撤销 SPEC §9 缝 #2）
- 删「灵动朗读」占位按钮、`ICON_PATHS.script`、相关 CSS 与 `autoEnabled` 注入。
- 设置页 `autoMode` 卡片换成「灵动模式」三态选择器（禁用 / 白名单 / 全局）+ 一行小字「开启后 Agent 可能多消耗一些 token」；删「启用灵动模式」勾选、「自动朗读」下拉、「允许调用技能」勾选。说明文字里出现一次英文名 `emotion-tts`（与 YAML 里的技能名一致）。

### 11.7 测试与验收增量
- 宿主 `node --test` 新增：emotionTts 归一化（缺键/非法→`off`、合法值透传）；`role` 不进缓存 key；pending 认领原子性（第二次认领 `null`）、同 session 覆盖、关闭态 `/pending/claim` 返回 `{ ok:true, item:null }`、`GET /pending/claim` → 405；**回放账本**（带 `messageId` 重复认领返回同一份稿子且不消费队列、后登记的稿子不抹账本、不带 `messageId` 行为不变、上限 64 丢最旧）；staging 工具用注入的 fake ctx 断言写文件内容与覆盖行为；Agent 参数收敛（只取六个键、越界与非法枚举报错、空串回落）；宿主与客户端 `AGENT_PARAM_KEYS` 逐字一致的源码级守卫。
- 客户端冒烟新增：三态选择器渲染与保存、占位按钮与 script 图标已删、播放先 claim 再回退（claim 体带 `sessionId` + `messageId`）、claim 命中时用 item 文本与参数（含 `languageBoost` 覆盖设置页的 `auto`、空串不覆盖）、换音色后重播同一条消息仍是 Agent 的稿子且参数取当前设置页。
- 应用内验证（交接给用户）：daily 会话里 `skill` 工具列出 `emotion-tts`；mixed 会话不列出；点播放按钮优先播出 Agent 登记的稿子。
