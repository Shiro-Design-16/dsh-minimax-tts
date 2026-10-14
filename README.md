# dsh-minimax-tts

把对话流里的 assistant 消息朗读出来 —— 只适配 MiniMax（海螺）TTS 的 DSH 插件。

两半边纯 ESM JavaScript，无 TS、无构建步骤。本文件属于**宿主半边**（`index.js` / `lib/**` / 路由与缓存）；
`client.js`（消息上的朗读按钮）由客户端半边交付。

- v1 = **手动模式**可用（点一下读一条 + 设置页可调参数）。
- v1.1 = **灵动模式**宿主半边落地：`emotionTts` 三态 + 行级 `role`，Agent 侧多出技能 `emotion-tts` 与工具
  `emotion_tts`，交出的朗读稿进 `pending/<session>.json`，播放按钮**认领即消费 + 回放账本**（见下「灵动模式」）。
- 不做：声音克隆、声音设计、双音色 `timbre_weights`、变声 `voice_modify`、音乐与音效、流式合成、
  字幕落盘、边生成边朗读。

## 安装

profile 是 `$DSH_HOME/profiles/<name>`。三种等价做法：

- 「插件」页里添加本仓库目录（会写成 `link:` 依赖）；
- 或直接编辑 profile 的 `package.json`，把 `"@local/dsh-minimax-tts": "link:<本仓库绝对路径>"` 加进 `dependencies`；
- 再把它加进 **bundle 清单**（`dsh plugin add` 只写依赖，**`dsh.profile.bundles` 才是挂载清单**），
  然后在 profile 目录跑一次包管理安装，最后重启 DSH。

```json
{
  "dependencies": {
    "@local/dsh-minimax-tts": "link:<本仓库绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-minimax-tts"]
    }
  }
}
```

bundle 补丁层（`cordis.patch.yml`）只插入宿主半边一行；客户端半边由 `package.json` 的 `dsh.client` 声明，
不需要另开一行。`@deepseek-ai/schemastery` 与 `@deepseek-ai/cordis` 由宿主运行时提供，**故意不声明成依赖**。

## 配置

装完在 DSH 的**「设置 → 插件」**里找到本插件改字段（keyed 插件设置页，不占通用设置入口；
`Config` 的字段名与默认值见下），也可以 `POST /dsh-minimax-tts/config`
用 `{ patch }` 浅合并（`voices` 是整体替换）。落盘在 `$DSH_HOME/dsh-minimax-tts/config.json`（`0600`，原子写；
首次变更前留一份 `config.json.bak`；文件损坏时优先回退 `.bak`，没有 `.bak` 就降级默认值并把损坏原文留作
`.bak` 证据）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://api.minimax.cn` | 也可 `api.minimaxi.com` / `api.minimax.io` |
| `apiKey` | `''` | 兜底顺序：`config.apiKey` → 环境变量 `MINIMAX_API_KEY` → `~/.dsh/.env` |
| `model` | `speech-2.8-hd` | `speech-2.8-hd` / `speech-2.8-turbo` / 2.6 / 02 / 01 系列 |
| `voices` | `[{ id: 'female-shaonv', label: '', isDefault: true }]` | `isDefault` 那条是默认音色 |
| `previewText` | `你好，这是一段语音合成测试，听到说明朗读功能已经正常工作了。` | 设置页「试听」的默认文本（客户端可持久化）；空串回落默认值，**不进缓存 key** |
| `emotion` | `''` | 空 = 不传，由模型按文本自选；`whisper` 在 `speech-2.8` 系列不可用（上游 2013），`fluent` 不受限 |
| `speed` / `vol` / `pitch` | `1` / `1` / `0` | 区间 `[0.5, 2]` / `(0, 10]` / `[-12, 12]` |
| `sampleRate` | `32000` | `8000/16000/22050/24000/32000/44100`（不在集合里回退默认） |
| `bitrate` | `128000` | `32000/64000/128000/256000`（仅 mp3） |
| `format` | `mp3` | `mp3/pcm/flac/wav/pcmu_raw/pcmu_wav/opus` |
| `channel` | `1` | `1` 或 `2` |
| `languageBoost` | `auto` | MiniMax `language_boost`，设置页为**下拉选框**（40 种语言 + `auto` + 「不增强」）。`auto`＝模型自动识别语言；**选「不增强」＝请求里不带该字段**（官方默认 `null`＝不增强）；粤语音色必须 `Chinese,Yue`；`speech-01`/`02` 不支持 `Persian`/`Filipino`/`Tamil` |
| `cleanup` | `{ days: 30, maxItems: 500, maxBytes: 524288000 }` | 三项**任一超限**即淘汰；**填 0 = 该项不限制** |
| `advance` | 全 `false` / `''` / `[]`，`outputFormat: 'hex'` | 装完只调一次，设置页默认折叠；v1 只会用到 `pronunciationTone` / `latexRead` 等文本侧开关 |
| `emotionTts` | `{ scope: 'off' }` | 灵动模式三态：`off` 两处都不注册 / `preset` 只有 preset 行注册 / `global` 全局行注册；非法值回落 `off` |
| `role` | `full` | **行级**角色（写在那一行的 `config` 里）：`full` 挂 9 条路由，`skill-only` 只挂技能与工具、不挂路由 |

**音色怎么挑**：内置默认音色 `female-shaonv` 一个，够用就直接用；想换或想加，就去官方试听页
<https://www.minimax.cn/audio> 听过、复制 `voice_id`，手填进 `voices` 列表（设置页或 `POST /config` 整体替换），
`isDefault: true` 的那条就是默认音色。设置页会拿账号音色目录给每条音色标一个**中性的「目录内 / 目录外」**，
但**目录只作提示，绝不阻止**加入、移除、设为默认或合成：官方试听页能听、能真实合成的音色，`POST /v1/get_voice`
未必返回（例如 `Japanese_energetic_anime_girl_vv1`），查错了算上游的，合成是否可用以真实朗读为准。

## 使用

客户端半边只做两件事：每条 assistant 消息上的**朗读按钮**，和「设置 → 插件」里的**参数页**。

- 朗读按钮是**一颗按钮**：未播放时是播放图标，播放中变成停止图标（点它即停），图标与尺寸照抄宿主
  native `MessageIconActions`（28×28、`--dsw-radius-sm`、hover 只换底色不改圆角）；同一时刻只播一条，
  播新的会自动停掉上一条。
- 设置页包括音色 / 模型 / 情绪 / 语速 / 音量 / 音高 / 格式 / 采样率 / 码率 / 声道 / 语言增强下拉 /
  高级参数折叠区，以及**试听**：试听文本会持久化（重开设置页不重置），旁边有「恢复默认」；
  「打开缓存目录」按钮直接调系统文件管理器打开缓存目录。音色行标出「目录内 / 目录外」（中性提示、不拦截任何操作），
  卡片标题行显示「上次检查：<时间>」（失败时为「检验失败：<错误码>」并保留上一轮标记），
  「刷新音色目录」按钮在下面输入行、紧挨「加入列表」（同一不换行按钮组，不会被拆到两行）（见上文「音色怎么挑」）。

走本半边下面这些路由。宿主半边也能独立验证：

```sh
curl -s -X POST http://127.0.0.1:3080/dsh-minimax-tts/synthesize \
  -H 'content-type: application/json' \
  -d '{"text":"你好，这是一次试听。","preview":true}'
# => {"ok":true,"url":"/dsh-minimax-tts/audio/<sha256>.mp3","cached":false,"chars":9,"totalChars":9}
```

把返回的 `url` 拼在 DSH 的 origin 后面就能播；命中缓存时 `cached: true` 且**不发起任何上游请求**。
`preview: true` 的条目（试听）与正式条目同池，但淘汰时**优先删 preview**。

| 方法 | 路径 | 请求 → 响应 |
| --- | --- | --- |
| POST | `/dsh-minimax-tts/synthesize` | `{ text, params?: { voiceId, model, emotion, speed, vol, pitch, format, sampleRate, bitrate, channel, languageBoost }, preview? }` → `{ ok, url, cached, chars, totalChars }` |
| GET | `/dsh-minimax-tts/config` | → `{ ok, config }` |
| POST | `/dsh-minimax-tts/config` | `{ patch }` → `{ ok, config }` |
| GET | `/dsh-minimax-tts/audio/<hash>.<ext>` | → 音频二进制 + `content-type`（`x-tts-chars` 是这条音频的字数） |
| GET | `/dsh-minimax-tts/cache` | → `{ ok, bytes, count, hits, totalChars, items }` |
| POST | `/dsh-minimax-tts/cache/clear` | `{ all?: true }` → `{ ok, removed }` |
| POST | `/dsh-minimax-tts/cache/open` | → `{ ok: true, dir }`（在系统文件管理器里打开缓存目录）；打不开时 `{ ok: false, error: 'open-failed', dir }` |
| GET | `/dsh-minimax-tts/pending` | `?sessionId=` → `{ ok, items }`（只读；`emotionTts.scope='off'` 时恒为 `[]`） |
| POST | `/dsh-minimax-tts/pending/claim` | `{ sessionId, messageId? }` → `{ ok, item: { text, params, createdAt } \| null }`；先查**回放账本**（同一条消息重复问拿回同一份稿子），未命中才取走并删除队首条目；`GET /pending/claim` → 405 |

路由**只放行本机回环**请求（远程地址 + `Host`/`Origin` 同源校验），其余一律 `403 loopback-only`。

错误判定只看 MiniMax 的 `base_resp.status_code` —— HTTP 200 也可能是业务错误：非 0 时把
`status_code` / `status_msg` 透传成 `{ ok: false, error: 'minimax-error', statusCode, statusMsg }`；
另外还有 `api-key-missing`、`empty-after-clean`、`text-too-large`、`empty-audio`。

## 灵动模式（Agent 侧）

「灵动模式」让 Agent 把**这轮发给你的那段正文**登记成朗读稿：正文保持干净，`text` 用同一段话、只加朗读标记（词句不变）；念不念、什么时候念，仍由人点播放按钮决定。

- `emotionTts.scope` 三态：`off`（默认）宿主两处都不注册，Agent 完全看不见这个能力；`preset`（白名单）只有
  `role: skill-only` 的 preset 行注册技能 `emotion-tts` 与工具 `emotion_tts`；`global` 时全局行注册同一对
  技能/工具（所有会话可见）。
- 两类行靠 `role` 分工：全局行（`cordis.patch.yml` 插入的那行，默认 `role: full`）照旧挂 9 条路由；
  `role: skill-only` 的行**不挂任何路由**，只出技能与工具 —— 两行共享同一份状态目录，路由不会重复注册。
- 想开白名单：给自己 agent preset 的行列表加一行（与现有行同级），再把 `emotionTts.scope` 设成 `preset`：

  ```yaml
  - id: dsh-minimax-tts-skill
    name: '@local/dsh-minimax-tts'
    config: { role: skill-only }
  ```

  行里的插件按 profile 的 `node_modules/@local/dsh-minimax-tts` 符号链解析（装好这个插件后就有）。
- 技能正文由插件代码供给（`lib/skill.js`），**不落盘 SKILL.md / `<name>.md`**：指一个目录也绕不过 `scope` 闸门。
  正文按当前配置拼出模型、可用音色与参数区间（emotion / voiceId / speed / vol / pitch / languageBoost）。
- 正文口径：**可见正文不写朗读标记**（`(laughs)`、`<#0.3#>`、`(chu3)(li3)` 只出现在 `text` 里）；`text` 与正文**词句逐句相同**，
  只允许加标记或把数字/单位/缩写写成念法；正文里念不了的内容（代码块/表格/长清单）可只收能念的句子并在回执里说明。
  想让 Agent 每轮都登记，在人格（系统提示）里加一句即可，例如「发言结束后，用 `emotion-tts` 把这段正文按原词句登记为待播」——
  技能正文已按这个口径写，不加也不会误用；不登记也不算错（播放按钮念可见正文）。
- 工具只登记、不合成：`text`（必填，≤10000 字符）+ `emotion` / `voiceId` / `speed`(0.5–2) / `vol`(0.01–10) /
  `pitch`(-12–12) / `languageBoost`（枚举＝设置页下拉里除「不增强」外的 41 项，粤语音色必须 `Chinese,Yue`），
  稿子原子写进 `pending/<session>.json`，同 session 后写覆盖前一条；取不到会话 id 时降级写
  `pending/current.json`。工具不触网、不算缓存。越界值或不认识的枚举值会被工具**直接拒绝**（不夹值），
  省略某个参数＝用设置页的值。
- 播放按钮点击时先 `POST /pending/claim {sessionId, messageId}`：命中就用稿子自己的 `text` + `params` 合成（Agent 给的
  参数按同名覆盖设置页参数），未命中才退回「消息可见文本 + 设置页参数」。
- 队列仍是一次性消费（同一份稿子不会被两条消息各播一次），但**同一条消息会被记进回放账本**：换音色、改参数后回来
  再点播放，用的还是 Agent 那份稿子，只是按当前设置页重新合成（缓存 key 含参数，换音色必然重新生成）。

## 文本清洗

朗读的是**清洗后**的文本（纯函数在宿主半边，客户端不重复实现）：去掉代码块与行内代码、URL、文件路径、
emoji、表格分隔行等噪声；保留 `(sighs)`、`<#0.8#>（停顿/语速标记）`、`(chu3)(li3)`（拼音标注）这类朗读指令。
清洗后为空就直接返回 `empty-after-clean`，不请求上游也不落缓存。

## 状态目录与缓存

```
$DSH_HOME/dsh-minimax-tts/
├── config.json          0600，原子写；首次变更前的快照 config.json.bak
├── cache/
│   ├── index.json       { version, items: { <key>: { file, ext, bytes, chars, model, voiceId, createdAt, lastHitAt, hits, preview } }, hits, totalChars }
│   └── <sha256>.<ext>   音频本体
└── pending/<session>.json   灵动模式的待播稿（每 session 至多一条，被认领后删除）
```

- 缓存 key = `sha256(JSON.stringify({ text, params, model, voiceId }))`（`text` 是清洗后的文本）。
  **不入 key** 的字段：`apiKey`、`baseUrl`、`cleanup`、`emotionTts`、`role`、`previewText`、
  `advance.subtitleEnable`、`advance.aigcWatermark`、`advance.outputFormat` —— 改这些不会让已有缓存失效。
- 回放一次算一次命中：`hits` / `lastHitAt` 会刷新，所以常播的条目不会被按天淘汰掉。
- 淘汰：`days` / `maxItems` / `maxBytes` 任一超限即按 `lastHitAt` 从旧到新删，直到全部满足，删条目同时删音频文件。
- 清理缓存：`POST /dsh-minimax-tts/cache/clear` 默认只清 `preview`（试听）条目，`{"all":true}` 连索引外的孤儿
  文件一起清；也可以直接删 `$DSH_HOME/dsh-minimax-tts/cache/` 整个目录，索引会自愈。
- 打开缓存目录：`POST /dsh-minimax-tts/cache/open` 调系统命令（darwin `open` / win32 `explorer` / 其它 `xdg-open`）
  在文件管理器里打开 `$DSH_HOME/dsh-minimax-tts/cache/`；`detached + unref` 打开、不等命令退出，目录不存在时
  先建出来再打开。打不开回 `{ ok: false, error: 'open-failed', dir }`（HTTP 200，不报 500）。

## 自检（离线）

```sh
cd <本仓库目录>
node --test                  # 自动发现 test/*.test.js：99 条
node --test test/*.test.js   # 等价写法
```

> Node v24 上 `node --test <目录>` 会把目录当脚本执行并报
> `Cannot find module '.../test'`（`code: 'MODULE_NOT_FOUND'`），所以这里用上面两种等价形式之一；
> 测试只 import `lib/core.js` 与 node 内建，不安装、不联网、不碰真实 `~/.dsh`（状态目录一律是临时目录）。
>
> 清洗语料在 `test/corpus/`：`filtered/` 与 `dropped/` 下的每一份片段都会被断言「清洗后为空」，
> 往里丢文件即自动纳入（详见 `test/corpus/README.md`）。

接线层（`index.js`）的语法与挂载自检：

```sh
node --check index.js   # 语法
node --check lib/core.js
node --check lib/skill.js
```

## 已知限制

- 灵动模式**不会自动朗读**：Agent 调 `emotion_tts` 只是把稿子登记进 `pending/`，什么时候念仍由人点播放按钮决定；
  `scope` 关着时技能与工具压根不注册，不存在「偷偷念」。
- 音频只落在本机状态目录，不回传上游 URL（上游返回的是 hex 音频，本插件落盘后自己分发）。
- `bitrate` 只对 mp3 有意义；`content-type` 按扩展名分发：`mp3→audio/mpeg`、`wav/pcmu_wav→audio/wav`、
  `flac→audio/flac`、`pcm→audio/L16`、`pcmu_raw→audio/basic`、`opus→audio/ogg`，其余 `application/octet-stream`。
- 音色标记**只作提示**：设置页用 `POST /dsh-minimax-tts/voices`（宿主转官方 `POST /v1/get_voice`，24h 缓存）
  给每条音色标「目录内 / 目录外」，标记不参与任何拦截；内置默认音色 + 手填 `voice_id` + 官方试听页
  <https://www.minimax.cn/audio> 仍是全部音色来源。

## 待解决的问题

- **无法按用户意愿限制 Agent 使用某个情绪（例如 `fluent` / `whisper`）** —— 2026-10-15 记录，修复已暂停。
  - 现状：设置页的 `emotion` 是**默认值**（「省略时用哪个」），不是「允许集合」；宿主只做**模型级**硬校验
    （`whisper` 在 `speech-2.8` 系列被本地拒绝、错误里列出可用值）。想表达「我不想让 Agent 用这两个情绪」
    时没有任何配置项，而工具 schema 与技能正文里的枚举只是提示——**Agent 不保证遵守**，实测仍会出现被排除的值。
  - 待定方向：加一个「Agent 可用情绪」配置（默认＝全部，可收窄），在宿主 `pickAgentParams` 里硬校验，
    并同步收窄工具 schema 与技能正文。因为模型对 schema 的遵守不可靠，闸门必须落在宿主侧。

## 许可证

MIT（见 `LICENSE`）。
