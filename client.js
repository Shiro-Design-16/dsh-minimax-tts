/**
 * dsh-minimax-tts — 客户端半边。
 *
 * 浏览器侧只做三件事：
 *   1. `conversation.chat.assistant-actions`  消息旁的「播放 / 停止」切换按钮
 *   2. （已移除）输入区不再放任何按钮：自动朗读开关只在设置里
 *   3. `plugins.bundle.config` / `plugins.row.config`  设置页（设置 → 插件 → 本插件）
 *
 * 契约见 docs/SPEC.md（冻结、只读）。本文件恪守其中 §9 的硬约束：
 *   - 只 require 宿主注入的 `react`，不 require 任何 DeepSeek Harness 客户端包；
 *   - 样式一次性注入 `document.head` 的 `<style data-mtts>`，绝不碰到 body；
 *   - 圆角一律走 `var(--dsw-radius-*)` token，无字面值；
 *   - 文本清洗 / 缓存 key / 计费判定全在宿主半边，客户端只传原文；
 *   - 音频只接同源 URL 交给 `new Audio()`，不做 fetch→blob。
 *
 * v1.1 灵动模式（SPEC §11.5 / §11.6）：
 *   - 点播放先 `POST /pending/claim { sessionId }`：命中 → 用 Agent 登记的稿子合成（agent 参数覆盖设置页同名参数）；
 *     未命中 → 该条消息的可见文本 + 设置页参数；
 *   - `resolveUtterance(messageId) → { text, params, source: 'visible' }` 只解「可见文本」这条兜底路径；
 *   - 对话区不再有任何灵动模式元素；三态开关（禁用 / 白名单 / 全局）只在设置页。
 *
 * 会话 id：`conversation.input.*` / `conversation.chat.*` 这类 session 作用域的插槽，
 * 条目 props 由「会话标准套件 + 全局席位 + owner props + inject 面」合成，其中确实带
 * `sessionId`。证据：`@linxin666/dsh-client-ui-git-graph/lib/client.js:1241` 在
 * `conversation.input.selector.context` 的组件里写 `const sessionId = props.sessionId;`。
 * 但该字段可能是 `undefined`（同一插槽里的同侪会显式判空），因此这里一律按
 * 「拿得到就带、拿不到就不带」处理（SPEC §9 第 4 条的降级分支同时保留）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-minimax-tts',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 注册条目 id：插槽去重键，也是 `slots.register` 的 id。 */
    const NS = 'minimax-tts';
    /** 宿主半边 HTTP 路由前缀（SPEC §5，冻结）。 */
    const API = '/dsh-minimax-tts';
    /** 本插件自己的 locale 命名空间。 */
    const LOCALE_NS = 'plugin.minimax-tts';
    /** 注入样式元素的标记：`<style data-mtts>`。 */
    const STYLE_MARKER = 'data-mtts';
    /** 引导用户去官方音色试听页挑音色。 */
    const VOICE_GUIDE = 'https://www.minimax.cn/audio';
    /** 试听用的默认文本（配置项 `previewText` 的缺省值；宿主半边持有同一句）。 */
    const DEFAULT_PREVIEW_TEXT = '你好，这是一段语音合成测试，听到说明朗读功能已经正常工作了。';
    /** 设置搬进「设置 → 插件」：keyed slot 的 key（SPEC §9）。 */
    const PLUGIN_PACKAGE = '@local/dsh-minimax-tts';
    const PLUGIN_ROW_ID = 'dsh-minimax-tts';
    const BUNDLE_KEY = PLUGIN_PACKAGE;
    const ROW_KEY = PLUGIN_PACKAGE + '#' + PLUGIN_ROW_ID;

    /** 宿主支持的模型（SPEC §8）。 */
    const MODELS = [
      'speech-2.8-hd', 'speech-2.8-turbo',
      'speech-2.6-hd', 'speech-2.6-turbo',
      'speech-02-hd', 'speech-02-turbo',
      'speech-01-hd', 'speech-01-turbo',
    ];
    /** 情绪枚举；空串 = 不传，由模型按文本自选（SPEC §8）。 */
    const EMOTIONS = ['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'];
    const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100];
    const BITRATES = [32000, 64000, 128000, 256000];
    const FORMATS = ['mp3', 'pcm', 'flac', 'wav', 'pcmu_raw', 'pcmu_wav', 'opus'];
    /* language_boost 的官方枚举（40 种语言 + auto）；'' = 不传该字段（官方默认 null＝不增强）。 */
    const LANGUAGE_BOOSTS = ['', 'auto', 'Chinese', 'Chinese,Yue', 'English', 'Japanese', 'Korean',
      'Arabic', 'Russian', 'Spanish', 'French', 'Portuguese', 'German', 'Turkish', 'Dutch', 'Ukrainian',
      'Vietnamese', 'Indonesian', 'Italian', 'Thai', 'Polish', 'Romanian', 'Greek', 'Czech', 'Finnish',
      'Hindi', 'Bulgarian', 'Danish', 'Hebrew', 'Malay', 'Persian', 'Slovak', 'Swedish', 'Croatian',
      'Filipino', 'Hungarian', 'Norwegian', 'Slovenian', 'Catalan', 'Nynorsk', 'Tamil', 'Afrikaans'];
    const LANGUAGE_BOOST_LABELS = {
      '': '不增强（不传该字段）', auto: 'auto（自动识别）', Chinese: 'Chinese（中文）',
      'Chinese,Yue': 'Chinese,Yue（粤语）', English: 'English（英文）', Japanese: 'Japanese（日语）', Korean: 'Korean（韩语）',
    };

    /** 宿主没给 useChat 时的占位选择器：不调用任何 React hook，调用形式与真 hook 一致。 */
    const NO_STORE_HOOK = function noStoreHook() { return undefined; };

    /* ------------------------------------------------------------------ *
     * 样式：SPEC §9 的按钮规格逐字照抄，其余类名一律 `mtts-` 前缀。
     * 只有 `border-radius` 使用 token，没有任何字面圆角值。
     * ------------------------------------------------------------------ */
    const CSS = [
      /* ---- SPEC §9 冻结的按钮规格（照抄，未加一字） ---- */
      '.mtts-actions{display:inline-flex;align-items:center;gap:8px;height:28px;}',
      '.mtts-btn{width:28px;height:28px;padding:6px;box-sizing:border-box;',
      'display:inline-flex;align-items:center;justify-content:center;',
      'border:none;background:transparent;cursor:pointer;',
      'border-radius:var(--dsw-radius-sm);',
      'color:var(--dsw-alias-label-tertiary);',
      'transition:background-color 80ms ease;}',
      '.mtts-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}',
      '.mtts-btn[data-unavailable="true"]{opacity:.4;cursor:default;}',
      '.mtts-btn svg{width:15px;height:15px;display:block;}',
      /* 用户给定的播放/停止图标是 16×16 网格，按原尺寸渲染（优先级高于 .mtts-btn svg）。 */
      '.mtts-btn .mtts-icon16{width:16px;height:16px;}',

      /* ---- 与同一行的宿主原生动作按钮逐项对齐 ----
       * 邻居是 dsh-client-ui-chat 内联的 MessageIconActions.module.css：
       *   .ppByMG_actions{height:calc(28px + var(--dsh-content-font-delta,0px)); ...}
       *   .ppByMG_action{width:calc(28px + var(--dsh-content-font-delta,0px)); height:同左; ...}
       *   .ppByMG_action[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary); background:0 0}
       * 尺寸跟随内容字号增量（未设置时增量＝0px，即 28px）；不可用时 hover 既不给底色也不换文字色。 */
      '.mtts-actions{height:calc(28px + var(--dsh-content-font-delta,0px));}',
      '.mtts-btn{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));}',
      '.mtts-btn[data-unavailable="true"]:hover{background:0 0;color:var(--dsw-alias-label-tertiary);}',

      /* ---- 设置页 ---- */
      '.mtts-page{display:flex;flex-direction:column;gap:14px;min-width:0;max-width:100%;font-size:13px;}',
      '.mtts-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
      'padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0;}',
      '.mtts-card>h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.mtts-summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.mtts-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.mtts-label{min-width:86px;color:var(--dsw-alias-label-secondary);}',
      '.mtts-input-box{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'padding:6px 10px;font-size:13px;min-width:150px;}',
      '.mtts-textarea{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'padding:6px 10px;font-size:13px;width:100%;box-sizing:border-box;min-height:56px;resize:vertical;}',
      '.mtts-hint{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary);}',
      '.mtts-hint a{color:var(--dsw-alias-label-secondary);}',
      '.mtts-voice{display:flex;gap:8px;align-items:center;padding:3px 0;flex-wrap:wrap;}',
      '.mtts-voice-id{font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:12px;',
      'color:var(--dsw-alias-label-primary);}',
      '.mtts-tag{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.mtts-status{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.mtts-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary);}',
      '.mtts-status[data-tone="ok"]{color:var(--dsw-alias-label-primary);}',
      '.mtts-btn-text{border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);',
      'padding:4px 10px;cursor:pointer;font-size:12px;}',
      '.mtts-btn-text:disabled{opacity:.5;cursor:default;}',

      /* ---- 音色目录标记：纯提示，不参与任何可用性判断 ---- */
      '.mtts-catalog{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.mtts-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.mtts-card-head>h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
    ].join('');

    /* ------------------------------------------------------------------ *
     * 纯函数小工具
     * ------------------------------------------------------------------ */

    /** 从 chat store 快照里取出目标 assistant 节点。 */
    function selectNode(nodes, messageId) {
      if (!Array.isArray(nodes)) return null;
      for (const node of nodes) {
        if (node && node.kind === 'assistant' && node.messageId === messageId) return node;
      }
      return null;
    }

    /** 节点文本块拼成原文；清洗由宿主侧负责，这里只做拼接。 */
    function visibleText(node) {
      if (!node || !Array.isArray(node.blocks)) return '';
      const out = [];
      for (const block of node.blocks) {
        if (block && block.kind === 'text' && typeof block.text === 'string' && block.text) out.push(block.text);
      }
      return out.join('\n').trim();
    }

    /** 生效音色：显式指定 > 列表里标了 isDefault 的 > 列表第一个。 */
    function defaultVoiceId(cfg) {
      const list = cfg && Array.isArray(cfg.voices) ? cfg.voices : [];
      for (const v of list) {
        if (v && v.isDefault && v.id) return v.id;
      }
      for (const v of list) {
        if (v && v.id) return v.id;
      }
      return '';
    }

    /**
     * 把本地配置投影成 `/synthesize` 的 `params`（SPEC §5）。
     * 字段顺序固定，因为宿主用它算缓存 key（SPEC §6）。
     */
    function paramsFromConfig(cfg, voiceId) {
      const c = cfg || {};
      const out = {};
      const voice = voiceId || defaultVoiceId(c);
      if (voice) out.voiceId = voice;
      if (c.model) out.model = c.model;
      if (c.emotion) out.emotion = c.emotion;
      if (typeof c.speed === 'number') out.speed = c.speed;
      if (typeof c.vol === 'number') out.vol = c.vol;
      if (typeof c.pitch === 'number') out.pitch = c.pitch;
      if (c.format) out.format = c.format;
      if (c.sampleRate) out.sampleRate = c.sampleRate;
      if (c.bitrate) out.bitrate = c.bitrate;
      if (c.channel) out.channel = c.channel;
      if (typeof c.languageBoost === 'string') out.languageBoost = c.languageBoost;
      return out;
    }

    /** Agent 登记的朗读稿能覆盖的参数（SPEC §11.4 工具参数 = 这六项）。 */
    const AGENT_PARAM_KEYS = ['emotion', 'voiceId', 'speed', 'vol', 'pitch', 'languageBoost'];

    /**
     * 把 Agent 稿子的参数叠加到设置页参数上：同名覆盖，其余保持设置页的值。
     * 只认 §11.4 的六个键，且类型不符时忽略（避免脏值混进 params / 缓存 key）。
     */
    function applyAgentParams(base, extra) {
      const out = Object.assign({}, base);
      if (!extra || typeof extra !== 'object') return out;
      for (const key of AGENT_PARAM_KEYS) {
        const v = extra[key];
        if (typeof v === 'string') { if (v !== '') out[key] = v; continue; }
        if (typeof v === 'number' && isFinite(v)) out[key] = v;
      }
      return out;
    }

    /** 三态取值（SPEC §11.1）：非法值一律回落 `off`。 */
    const EMOTION_SCOPES = ['off', 'preset', 'global'];

    /** 灵动模式三态的显示名（禁用 / 白名单 / 全局）。 */
    const EMOTION_SCOPE_LABELS = { off: '禁用', preset: '白名单', global: '全局' };

    /** 归一化 `emotionTts.scope`：缺键 / 非法值 → `'off'`。 */
    function normalizeEmotionScope(scope) {
      return EMOTION_SCOPES.indexOf(scope) >= 0 ? scope : 'off';
    }

    /** 把 `/synthesize` 的失败响应翻成人能读的错误。 */
    function synthError(body, httpStatus) {
      const parts = [];
      if (body && body.error) parts.push(String(body.error));
      if (body && body.statusCode !== undefined && body.statusCode !== null) parts.push('code ' + body.statusCode);
      if (body && body.statusMsg) parts.push(String(body.statusMsg));
      if (!parts.length) parts.push('HTTP ' + httpStatus);
      const err = new Error(parts.join(' · '));
      err.code = (body && body.error) || 'synth-failed';
      err.statusCode = body && body.statusCode;
      err.statusMsg = body && body.statusMsg;
      return err;
    }

    function jsonPost(url, payload, method) {
      return fetch(url, {
        method: method || 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    function fmtBytes(n) {
      let v = typeof n === 'number' && isFinite(n) && n > 0 ? n : 0;
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i];
    }

    /* ------------------------------------------------------------------ *
     * 图标：手写矢量，仅描边、currentColor，尺寸由 CSS 定成 15×15。
     * ------------------------------------------------------------------ */
    /** 用户提供的播放 / 停止图标：16×16 网格、1px 描边，描边色跟随主题（currentColor）。 */
    function PlaybackIcon(props) {
      const isStop = props.name === 'stop';
      const paths = isStop
        ? ['M4.5 4.5h7v7h-7z']
        : ['M2 6.81818V9.18182', 'M4.4 3.86364V12.1364', 'M6.8 1.5V14.5', 'M9.2 5.04545V10.9545', 'M11.6 2.68182V13.3182', 'M14 6.22727V9.77273'];
      return h('svg', {
        viewBox: '0 0 16 16',
        className: 'mtts-icon16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1,
        strokeLinecap: isStop ? 'butt' : 'round',
        'aria-hidden': 'true',
      }, paths.map((d, i) => h('path', { key: i, d: d })));
    }

    /* ------------------------------------------------------------------ *
     * 单例播放器
     *
     * - 音频只走同源 URL：`new Audio(j.url)`，不做 fetch→blob。
     * - `stop()` 真的 pause + 复位状态，并让在途请求作废（seq 代际）。
     * - 因为是单例，重复点同一条消息 = 先 stop 再 play，所以能重播。
     * ------------------------------------------------------------------ */
    function createPlayer() {
      let audio = null;
      let playing = false;
      let key = '';
      let lastChars = 0;
      let generation = 0;
      const subs = new Set();

      const notify = () => {
        for (const fn of [...subs]) {
          try { fn(); } catch (_) { /* 订阅者自身异常不能影响别人 */ }
        }
      };

      const clear = () => {
        if (audio) {
          try { audio.onended = null; } catch (_) {}
          try { audio.onerror = null; } catch (_) {}
          try { audio.pause(); } catch (_) {}
          audio = null;
        }
        playing = false;
        key = '';
      };

      return {
        get playing() { return playing; },
        get key() { return key; },
        get lastChars() { return lastChars; },
        playingFor(k) { return playing && key === k; },
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

        /** 停止当前播放并复位。在途的 play() 会因此作废。 */
        stop() {
          generation += 1;
          const had = playing || key !== '';
          clear();
          if (had) notify();
        },

        /**
         * 合成并播放一段文本。
         * @param {string} text 原文（清洗由宿主做）
         * @param {object} params `/synthesize` 的 params
         * @param {string} k 播放键（用 messageId，重复点同一条即重播）
         * @param {{preview?: boolean}} [opts] preview=true 时宿主把缓存条目标记为试听
         */
        async play(text, params, k, opts) {
          const raw = String(text == null ? '' : text).trim();
          if (!raw) {
            const empty = new Error('这条消息没有可朗读的文本');
            empty.code = 'empty-text';
            throw empty;
          }
          this.stop();
          const my = generation;

          const payload = { text: raw, params: params || {} };
          if (opts && opts.preview) payload.preview = true;

          const res = await jsonPost(API + '/synthesize', payload);
          const body = await res.json().catch(() => null);
          if (my !== generation) return { cancelled: true };
          if (!res.ok || !body || body.ok !== true) throw synthError(body, res.status);
          if (typeof body.url !== 'string' || !body.url) {
            throw synthError({ error: 'synthesize 未返回音频 URL' }, res.status);
          }

          const el = new Audio(body.url);
          audio = el;
          key = String(k);
          playing = true;
          lastChars = typeof body.chars === 'number' ? body.chars : 0;
          notify();

          const settle = () => {
            if (audio !== el) return;
            clear();
            notify();
          };
          el.onended = settle;
          el.onerror = settle;

          try {
            await el.play();
          } catch (err) {
            settle();
            throw err;
          }
          return {
            ok: true,
            url: body.url,
            cached: body.cached === true,
            chars: lastChars,
            totalChars: typeof body.totalChars === 'number' ? body.totalChars : undefined,
          };
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 配置 store：`/config` 的本地镜像 + 订阅，供三个席位共享。
     * 注意 SPEC §5：POST /config 是**浅合并**，所以子对象（voices / emotionTts /
     * cleanup / advance）必须整体回传，不能只发一个字段。
     * ------------------------------------------------------------------ */
    function createConfigStore() {
      let cfg = null;
      const subs = new Set();
      const notify = () => {
        for (const fn of [...subs]) {
          try { fn(); } catch (_) {}
        }
      };
      return {
        get() { return cfg; },
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
        /** 启动时静默拉一次；失败不抛，界面退化成「加载中」。 */
        async load() {
          try {
            const res = await fetch(API + '/config');
            const body = await res.json();
            if (body && body.ok === true && body.config) { cfg = body.config; notify(); }
          } catch (_) { /* 宿主还没起来，允许 */ }
          return cfg;
        },
        async patch(patch) {
          const res = await jsonPost(API + '/config', { patch: patch });
          const body = await res.json().catch(() => null);
          if (!body || body.ok !== true) {
            const err = new Error((body && body.error) || ('保存失败（HTTP ' + res.status + '）'));
            err.code = 'config-failed';
            throw err;
          }
          if (body.config) { cfg = body.config; notify(); }
          return cfg;
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 待播链路（SPEC §11.5）：Agent 用 `emotion_tts` 工具把朗读稿登记到宿主，
     * 客户端在**点播放时**认领（认领即消费，不会重复提交同一份稿子）。
     *
     * `refresh()` / `find()` 只读 `GET /pending` 列表，保留给调试与冒烟；
     * 真正决定播什么的是 `claim()`。
     * ------------------------------------------------------------------ */
    function createPendingSource() {
      let items = [];
      return {
        get items() { return items; },
        /** GET /pending?sessionId= —— 拿不到 sessionId 就不带（SPEC §9 第 4 条降级）。 */
        async refresh(sessionId) {
          const query = sessionId === undefined || sessionId === null || sessionId === ''
            ? ''
            : '?sessionId=' + encodeURIComponent(String(sessionId));
          try {
            const res = await fetch(API + '/pending' + query);
            const body = await res.json();
            items = body && body.ok === true && Array.isArray(body.items) ? body.items : [];
          } catch (_) {
            items = [];
          }
          return items;
        },
        /**
         * POST /pending/claim —— 认领该会话最早的未认领朗读稿。
         * 宿主返回 `{ ok:true, item:{ text, params, createdAt } | null }`；任何异常一律当「没命中」。
         * 带 `messageId` 时命中宿主的回放账本：同一条消息第二次问，拿回的还是它第一次认领的那份稿子。
         */
        async claim(payload) {
          try {
            const res = await jsonPost(API + '/pending/claim', payload || {});
            const body = await res.json();
            if (!body || body.ok !== true) return null;
            const claimed = body.item || null;
            if (claimed) items = items.filter((it) => it !== claimed);
            return claimed;
          } catch (_) {
            return null;
          }
        },
      };
    }

    /** 会话 id 降级：拿不到就不带该字段（宿主按单文件 `pending/current.json` 处理）。 */
    function sessionPayload(sessionId) {
      return (sessionId === undefined || sessionId === null || sessionId === '')
        ? {}
        : { sessionId: sessionId };
    }

    /* ------------------------------------------------------------------ *
     * `resolveUtterance(messageId) → { text, params, source }`（SPEC §9 冻结形状）。
     *
     * v1.1 里它只解「可见文本」这条**兜底**路径：脚本分支需要先 POST 认领，
     * 队列仍是一次性消费（一份稿子只被认领一次），但同一条消息的重复播放由宿主的
     * 回放账本兜住，所以由 `resolveForPlay()` 承担（SPEC §11.5 的点击顺序）。
     * 可见文本由各席位在渲染时登记进 `visibleTexts`，
     * 使 API 能脱离 React 组件独立调用。
     * ------------------------------------------------------------------ */
    function createUtteranceSource(deps) {
      return {
        /**
         * @param {string} messageId
         * @param {string} [visibleText] 调用方手上已有的新鲜可见文本；省略时回落到登记表
         *   （席位在 effect 里登记，首帧还是空的，所以组件内一定要把 text 传进来）。
         * @returns {{text: string, params: object, source: 'visible'}}
         */
        resolveUtterance(messageId, visibleText) {
          const cfg = deps.getConfig();
          return {
            text: typeof visibleText === 'string' ? visibleText : deps.readVisible(messageId),
            params: paramsFromConfig(cfg, null),
            source: 'visible',
          };
        },
        /**
         * 播放按钮的解析顺序（SPEC §11.5）：① 先认领 Agent 登记的朗读稿；② 未命中／稿子为空 → 可见文本。
         * @returns {Promise<{text: string, params: object, source: 'script'|'visible'}>}
         */
        async resolveForPlay(messageId, visibleText, sessionId) {
          const cfg = deps.getConfig();
          // messageId 一并交给宿主：同一条消息重复点播放（含换音色后回来）由宿主的回放账本命中
          // 同一份稿子，参数仍按当前设置页重新合成（SPEC §11.5）。
          const claimed = await deps.pending.claim({ ...sessionPayload(sessionId), messageId: messageId });
          if (claimed && typeof claimed.text === 'string' && claimed.text.trim()) {
            return {
              text: claimed.text.trim(),
              params: applyAgentParams(paramsFromConfig(cfg, null), claimed.params),
              source: 'script',
            };
          }
          return {
            text: typeof visibleText === 'string' ? visibleText : deps.readVisible(messageId),
            params: paramsFromConfig(cfg, null),
            source: 'visible',
          };
        },
        /** 把一条消息的可见文本登记进来。 */
        noteVisible(messageId, text) { deps.noteVisible(messageId, text); },
        /** 把一条消息的可见文本注销。 */
        forgetVisible(messageId) { deps.forgetVisible(messageId); },
      };
    }

    /* ------------------------------------------------------------------ *
     * 席位 1：每条 assistant 消息旁的按钮组
     * ------------------------------------------------------------------ */
    function Actions(props) {
      const messageId = props.messageId;
      const useChat = props.useChat;
      const sessionId = props.sessionId;
      const player = props.mttsPlayer;
      const configStore = props.mttsConfig;
      const source = props.mttsSource;

      const [, bump] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [errLine, setErrLine] = React.useState('');
      const alive = React.useRef(true);

      React.useEffect(() => () => { alive.current = false; }, []);
      React.useEffect(
        () => player.subscribe(() => { if (alive.current) bump((n) => n + 1); }),
        [player],
      );
      React.useEffect(
        () => configStore.subscribe(() => { if (alive.current) bump((n) => n + 1); }),
        [configStore],
      );

      // 席位是 session scope，useChat 由 session standard kit 注入；宿主没给时退化成空选择器，
      // 这样下面两行的调用形式恒定（同一个组件实例内分支不会翻转，hook 顺序稳定）。
      const useStore = typeof useChat === 'function' ? useChat : NO_STORE_HOOK;
      const text = useStore((s) => visibleText(selectNode(s && s.legacy && s.legacy.nodes, messageId)));

      // 把可见文本登记给 resolveUtterance，让它能脱离本组件被调用（脚本分支的兜底也读它）。
      React.useEffect(() => {
        if (messageId === undefined || messageId === null) return undefined;
        source.noteVisible(messageId, text);
        return () => source.forgetVisible(messageId);
      }, [source, messageId, text]);

      if (messageId === undefined || messageId === null) return null;

      // 必须把这一帧读到的 text 传进去：登记表是在 effect 里写的，首帧还是空的。
      const utterance = source.resolveUtterance(messageId, text);
      const playKey = String(messageId);
      const hasText = utterance.text.length > 0;
      const playing = player.playingFor(playKey);

      const onRead = () => {
        if (busy || !hasText) return;
        setErrLine('');
        setBusy(true);
        // SPEC §11.5：先认领 Agent 登记的朗读稿（认领即消费），未命中才回退可见文本 + 设置页参数。
        source.resolveForPlay(messageId, text, sessionId)
          .then((utterance2) => player.play(utterance2.text, utterance2.params, playKey))
          .then(() => {
            if (!alive.current) return;
            setBusy(false);
          })
          .catch((err) => {
            if (!alive.current) return;
            setBusy(false);
            if (err && err.code === 'empty-text') return;
            if (err && err.name === 'AbortError') return;
            setErrLine((err && err.message) || '朗读失败');
          });
      };

      const charNote = player.lastChars > 0 ? '（上次发声 ' + player.lastChars + ' 字符）' : '';
      const idleTitle = (busy ? '合成中…' : '朗读这条回复') + charNote;
      const btnTitle = errLine ? '朗读失败：' + errLine : (playing ? '停止朗读' : idleTitle);

      // 一颗按钮两种状态：未播放＝播放图标，播放中＝停止图标，播完自动变回播放。
      // SPEC §11.6：对话区不再有任何灵动模式元素，这里就是唯一那颗按钮。
      return h('span', { className: 'mtts-actions' },
        h('button', {
          type: 'button',
          className: 'mtts-btn',
          'data-unavailable': hasText && !busy ? undefined : 'true',
          'aria-pressed': playing ? 'true' : undefined,
          disabled: (!hasText && !playing) || busy,
          title: btnTitle,
          'aria-label': playing ? '停止朗读' : '朗读这条回复',
          onClick: playing
            ? () => { setErrLine(''); player.stop(); }
            : onRead,
        }, h(PlaybackIcon, { name: playing ? 'stop' : 'play' })),
      );
    }


    /* ------------------------------------------------------------------ *
     * 设置页：注册进「设置 → 插件」里本插件自己的页面（keyed slot）
     * ------------------------------------------------------------------ */
    function SettingsCard(props) {
      const player = props.mttsPlayer;
      const configStore = props.mttsConfig;

      const [, bump] = React.useState(0);
      const [status, setStatus] = React.useState(null); // { text, tone }
      const [busy, setBusy] = React.useState(false);
      const [cache, setCache] = React.useState(null);
      const [cacheDir, setCacheDir] = React.useState('');
      const [keyInput, setKeyInput] = React.useState('');
      const [voiceInput, setVoiceInput] = React.useState('');
      const [confirmClear, setConfirmClear] = React.useState(false);
      // 账号音色目录：{ status, fetchedAt, names: Map<id,name>, error }。只用来画标记。
      const [catalog, setCatalog] = React.useState({ status: 'idle', fetchedAt: 0, names: null, error: '' });
      const alive = React.useRef(true);

      React.useEffect(() => () => { alive.current = false; }, []);
      React.useEffect(
        () => configStore.subscribe(() => { if (alive.current) bump((n) => n + 1); }),
        [configStore],
      );

      const say = (text, tone) => setStatus({ text: text, tone: tone || 'idle' });

      const loadCache = React.useCallback(() => {
        fetch(API + '/cache')
          .then((r) => r.json())
          .then((body) => { if (alive.current && body && body.ok === true) setCache(body); })
          .catch(() => {});
      }, []);

      /** 取账号音色目录。失败时保留上一轮 names，只把状态降级为 error。 */
      const loadCatalog = React.useCallback((refresh) => {
        setCatalog((prev) => Object.assign({}, prev, { status: 'loading' }));
        return jsonPost(API + '/voices', refresh ? { refresh: true } : {})
          .then((r) => r.json())
          .then((body) => {
            if (!alive.current) return null;
            if (body && body.ok === true && Array.isArray(body.voices)) {
              const names = new Map();
              for (const v of body.voices) {
                if (v && typeof v.id === 'string') names.set(v.id, typeof v.name === 'string' ? v.name : '');
              }
              setCatalog({
                status: 'ok',
                fetchedAt: typeof body.fetchedAt === 'number' ? body.fetchedAt : Date.now(),
                names: names,
                error: '',
              });
              return body;
            }
            const code = (body && body.error) || 'bad-response';
            setCatalog((prev) => Object.assign({}, prev, {
              status: 'error',
              error: body && body.statusCode ? code + '（HTTP ' + body.statusCode + '）' : code,
            }));
            return body;
          })
          .catch(() => {
            if (alive.current) setCatalog((prev) => Object.assign({}, prev, { status: 'error', error: 'network-error' }));
            return null;
          });
      }, []);

      /** 目录标记：中性措辞，永不参与可用性判断，也永不禁用任何按钮。 */
      const catalogMark = (id) => {
        const known = catalog.names && catalog.names.size > 0;
        const inside = known ? catalog.names.has(id) : false;
        if (catalog.status === 'ok' || (catalog.status === 'error' && known)) {
          return inside
            ? { text: '目录内', title: '账号目录：' + (catalog.names.get(id) || id) }
            : { text: '目录外', title: '不在当前账号的音色目录里；目录只作提示，不阻止使用' };
        }
        if (catalog.status === 'loading') return { text: '检查中…', title: undefined };
        if (catalog.status === 'error') return { text: '检验失败', title: catalog.error || 'network-error' };
        return null;
      };

      const catalogHint = catalog.status === 'loading' ? '检查中…'
        : catalog.status === 'error' ? '检验失败：' + (catalog.error || 'network-error')
          : catalog.fetchedAt ? '上次检查：' + new Date(catalog.fetchedAt).toLocaleString()
            : '尚未检查';

      React.useEffect(() => {
        configStore.load().then(() => { if (alive.current) bump((n) => n + 1); }).catch(() => {});
        loadCache();
        loadCatalog(false);
      }, [configStore, loadCache, loadCatalog]);

      const cfg = configStore.get();
      if (!cfg) return h('div', { className: 'mtts-page' }, h('div', { className: 'mtts-hint' }, '加载中…'));

      const voices = Array.isArray(cfg.voices) ? cfg.voices : [];
      const advance = cfg.advance || {};
      const cleanup = cfg.cleanup || {};
      const emotionScope = normalizeEmotionScope(cfg.emotionTts && cfg.emotionTts.scope);

      const save = (patch) => {
        say('保存中…', 'idle');
        setBusy(true);
        configStore.patch(patch)
          .then(() => {
            if (!alive.current) return;
            say('已保存', 'ok');
            loadCache();
          })
          .catch((err) => { if (alive.current) say((err && err.message) || '保存失败', 'error'); })
          .finally(() => { if (alive.current) setBusy(false); });
      };

      /** 子对象整体回传（浅合并）。 */
      const saveVoiceList = (list) => save({ voices: list });

      const setDefaultVoice = (id) => {
        saveVoiceList(voices.map((v) => ({ id: v.id, label: v.label || '', isDefault: v.id === id })));
      };

      const addVoice = () => {
        const id = voiceInput.trim();
        if (!id) return;
        if (voices.some((v) => v && v.id === id)) { say('「' + id + '」已经在列表里了', 'error'); return; }
        const next = voices.map((v) => ({ id: v.id, label: v.label || '', isDefault: v.isDefault === true }));
        next.push({ id: id, label: '', isDefault: next.length === 0 });
        saveVoiceList(next);
        setVoiceInput('');
      };

      const removeVoice = (id) => {
        const next = voices.filter((v) => v && v.id !== id)
          .map((v) => ({ id: v.id, label: v.label || '', isDefault: v.isDefault === true }));
        if (!next.length) { say('至少要保留一个音色', 'error'); return; }
        if (!next.some((v) => v.isDefault)) next[0].isDefault = true;
        saveVoiceList(next);
      };


      const previewText = (typeof cfg.previewText === 'string' && cfg.previewText.trim() !== '')
        ? cfg.previewText
        : DEFAULT_PREVIEW_TEXT;

      const preview = () => {
        const text = previewText.trim();
        if (!text) { say('试听文本为空', 'error'); return; }
        say('合成中…', 'idle');
        setBusy(true);
        // preview: true —— 试听条目与正式条目同池，但淘汰时优先删除（SPEC §6）。
        player.play(text, paramsFromConfig(cfg, null), '@preview', { preview: true })
          .then((r) => {
            if (!alive.current) return;
            if (r && r.cancelled) return;
            say('试听中…' + (r && r.cached ? '（缓存命中）' : '') + (r && r.chars ? '，本次 ' + r.chars + ' 字符' : ''), 'ok');
            loadCache();
          })
          .catch((err) => { if (alive.current) say((err && err.message) || '试听失败', 'error'); })
          .finally(() => { if (alive.current) setBusy(false); });
      };

      const openCacheDir = () => {
        setBusy(true);
        jsonPost(API + '/cache/open', {})
          .then((r) => r.json())
          .then((body) => {
            if (!alive.current) return;
            setCacheDir((body && body.dir) || '');
            if (body && body.ok === true) say('已打开缓存目录', 'ok');
            else say('打开缓存目录失败，下方是它的绝对路径', 'error');
          })
          .catch(() => { if (alive.current) say('打开缓存目录失败', 'error'); })
          .finally(() => { if (alive.current) setBusy(false); });
      };

      const clearCache = () => {
        if (!confirmClear) { setConfirmClear(true); say('再点一次确认清空全部音频缓存', 'error'); return; }
        setConfirmClear(false);
        setBusy(true);
        jsonPost(API + '/cache/clear', { all: true })
          .then((r) => r.json())
          .then((body) => {
            if (!alive.current) return;
            if (body && body.ok === true) say('已清空 ' + (body.removed || 0) + ' 个缓存文件', 'ok');
            else say('清空失败', 'error');
            loadCache();
          })
          .catch(() => { if (alive.current) say('清空失败', 'error'); })
          .finally(() => { if (alive.current) setBusy(false); });
      };

      const input = { className: 'mtts-input-box' };
      const btn = { className: 'mtts-btn-text', disabled: busy };

      const selectRow = (label, value, options, onPick, render) => h('div', { className: 'mtts-row' },
        h('span', { className: 'mtts-label' }, label),
        h('select', Object.assign({}, input, { value: value, onChange: (e) => onPick(e.target.value) }),
          options.map((opt) => h('option', { key: String(opt), value: String(opt) }, render ? render(opt) : String(opt)))),
      );

      const numRow = (label, value, attrs, onCommit) => h('div', { className: 'mtts-row' },
        h('span', { className: 'mtts-label' }, label),
        h('input', Object.assign({ type: 'number', defaultValue: value === undefined ? '' : value }, input, attrs, {
          onBlur: (e) => {
            const raw = e.target.value.trim();
            if (raw === '') return;
            const num = Number(raw);
            if (!isFinite(num)) { say('「' + label + '」不是合法数字', 'error'); return; }
            onCommit(num);
          },
        })),
      );

      const textRow = (label, value, placeholder, onCommit, attrs) => h('div', { className: 'mtts-row' },
        h('span', { className: 'mtts-label' }, label),
        h('input', Object.assign({ defaultValue: value || '', placeholder: placeholder }, input, attrs, {
          onBlur: (e) => {
            const next = e.target.value.trim();
            if (next === (value || '')) return;
            onCommit(next);
          },
          onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur(); },
        })),
      );

      const cards = [];

      /* ---- 服务 ---- */
      cards.push(h('div', { className: 'mtts-card', key: 'service' },
        h('h3', null, '服务'),
        textRow('API 地址', cfg.baseUrl, 'https://api.minimax.cn', (v) => save({ baseUrl: v })),
        h('div', { className: 'mtts-row' },
          h('span', { className: 'mtts-label' }, 'API Key'),
          h('input', Object.assign({ type: 'password', value: keyInput, placeholder: cfg.apiKey ? '已配置（留空=不改）' : '粘贴 MiniMax API Key' },
            input, { onChange: (e) => setKeyInput(e.target.value) })),
          h('button', Object.assign({ type: 'button' }, btn, {
            onClick: () => {
              if (!keyInput.trim()) { say('先粘贴 Key', 'error'); return; }
              save({ apiKey: keyInput.trim() });
              setKeyInput('');
            },
          }), '保存 Key'),
        ),
        h('div', { className: 'mtts-hint' },
          'Key 也可以放环境变量 MINIMAX_API_KEY 或 ~/.dsh/.env，宿主会按 config → 环境变量 → .env 的顺序兜底。'),
        selectRow('模型', cfg.model || MODELS[0], MODELS, (v) => save({ model: v })),
      ));

      /* ---- 音色 ---- */
      const voiceRows = voices.map((v) => {
        const mark = catalogMark(v.id);
        return h('div', { className: 'mtts-voice', key: v.id },
          h('input', {
            type: 'radio',
            name: 'mtts-default-voice',
            checked: v.isDefault === true,
            disabled: busy,
            onChange: () => setDefaultVoice(v.id),
          }),
          h('span', { className: 'mtts-voice-id' }, v.id),
          mark ? h('span', { className: 'mtts-catalog', title: mark.title }, mark.text) : null,
          h('span', { className: 'mtts-tag' }, v.isDefault ? '当前使用' : ''),
          h('button', Object.assign({ type: 'button' }, btn, { onClick: () => removeVoice(v.id) }), '移除'),
        );
      });

      cards.push(h('div', { className: 'mtts-card', key: 'voices' },
        h('div', { className: 'mtts-card-head' },
          h('h3', null, '音色'),
          h('span', { className: 'mtts-hint' }, catalogHint),
        ),
        voices.length ? voiceRows : h('div', { className: 'mtts-hint' }, '列表为空，先加一个 voice_id。'),
        h('div', { className: 'mtts-row' },
          h('span', { className: 'mtts-label' }, '加入音色'),
          h('input', Object.assign({
            value: voiceInput,
            placeholder: '如 female-shaonv / qiaopi_mengmei',
          }, input, {
            onChange: (e) => setVoiceInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addVoice(); } },
          })),
          h('span', { className: 'mtts-actions' },
            h('button', Object.assign({ type: 'button' }, btn, { onClick: addVoice }), '加入列表'),
            h('button', Object.assign({ type: 'button' }, btn, {
              disabled: busy || catalog.status === 'loading',
              onClick: () => loadCatalog(true),
            }), '刷新音色目录'),
          ),
        ),
        h('div', { className: 'mtts-hint' },
          '目录只作提示：目录外的音色（例如产品站音色）照样可以合成，加入 / 移除 / 设为默认都不受它影响；',
          '合成是否可用以真实朗读为准。',
          h('br'),
          '想挑新音色，去官方试听页听过再复制 voice_id 回来：',
          h('a', { href: VOICE_GUIDE, target: '_blank', rel: 'noreferrer noopener' }, VOICE_GUIDE),
        ),
      ));

      /* ---- 发声参数 ---- */
      cards.push(h('div', { className: 'mtts-card', key: 'voiceparams' },
        h('h3', null, '发声'),
        selectRow('情绪', cfg.emotion || '', EMOTIONS, (v) => save({ emotion: v }), (v) => (v === '' ? '自动（由模型判断）' : v)),
        numRow('语速', cfg.speed, { step: '0.1', min: '0.5', max: '2' }, (v) => save({ speed: v })),
        numRow('音量', cfg.vol, { step: '0.1', min: '0.1', max: '10' }, (v) => save({ vol: v })),
        numRow('音调', cfg.pitch, { step: '1', min: '-12', max: '12' }, (v) => save({ pitch: v })),
        selectRow('采样率', String(cfg.sampleRate || 32000), SAMPLE_RATES, (v) => save({ sampleRate: Number(v) })),
        selectRow('码率', String(cfg.bitrate || 128000), BITRATES, (v) => save({ bitrate: Number(v) })),
        selectRow('格式', cfg.format || 'mp3', FORMATS, (v) => save({ format: v })),
        selectRow('声道', String(cfg.channel || 1), [1, 2], (v) => save({ channel: Number(v) })),
        selectRow('语言增强', cfg.languageBoost === undefined ? 'auto' : cfg.languageBoost,
          LANGUAGE_BOOSTS.includes(cfg.languageBoost) || cfg.languageBoost === undefined ? LANGUAGE_BOOSTS : LANGUAGE_BOOSTS.concat([cfg.languageBoost]),
          (v) => save({ languageBoost: v }), (v) => LANGUAGE_BOOST_LABELS[v] || v),
        h('div', { className: 'mtts-hint' }, '语言增强＝MiniMax 的 language_boost：auto 让模型自动识别语言；选「不增强」＝请求里不带该字段（官方默认 null）。粤语音色必须选 Chinese,Yue；speech-01 / 02 不支持 Persian / Filipino / Tamil。'),
        h('div', { className: 'mtts-hint' }, '情绪里的 whisper 在 speech-2.8 系列上会被上游拒绝（2013），请换用别的情绪；fluent 不受模型限制。'),
      ));

      /* ---- 试听 ---- */
      cards.push(h('div', { className: 'mtts-card', key: 'preview' },
        h('h3', null, '试听'),
        // 试听文本存进配置（`previewText`），重开设置页不会重置；`key` 绑定当前值，
        // 这样点「恢复默认」后输入框会立刻回显默认文本。
        h('textarea', {
          key: previewText,
          className: 'mtts-textarea',
          defaultValue: previewText,
          onBlur: (e) => {
            const next = e.target.value;
            if (next !== previewText) save({ previewText: next });
          },
        }),
        h('div', { className: 'mtts-row' },
          h('button', Object.assign({ type: 'button' }, btn, { onClick: preview }), busy ? '…' : '用当前音色试听'),
          h('button', Object.assign({ type: 'button' }, btn, { onClick: () => player.stop() }), '停止'),
          h('button', Object.assign({ type: 'button' }, btn, { onClick: () => save({ previewText: DEFAULT_PREVIEW_TEXT }) }), '恢复默认'),
          h('span', { className: 'mtts-hint' }, '试听文本会保存下来；试听结果也入缓存，但淘汰时优先删除。'),
        ),
      ));

      /* ---- 缓存与计费 ---- */
      const cacheInfo = cache || {};
      cards.push(h('div', { className: 'mtts-card', key: 'cache' },
        h('h3', null, '缓存与计费'),
        h('div', { className: 'mtts-row' },
          h('span', { className: 'mtts-label' }, '占用'),
          h('span', null, fmtBytes(cacheInfo.bytes)),
          h('span', { className: 'mtts-tag' }, (cacheInfo.count || 0) + ' 个文件'),
          h('span', { className: 'mtts-tag' }, '命中 ' + (cacheInfo.hits || 0) + ' 次'),
        ),
        h('div', { className: 'mtts-row' },
          h('span', { className: 'mtts-label' }, '累计字符'),
          h('span', null, String(cacheInfo.totalChars || 0) + ' 字符'),
          h('span', { className: 'mtts-hint' }, '按 MiniMax 返回的 usage_characters 累计，即计费口径。'),
        ),
        h('div', { className: 'mtts-row' },
          h('button', Object.assign({ type: 'button' }, btn, { onClick: clearCache }),
            confirmClear ? '再点一次确认清空' : '清空缓存'),
          h('button', Object.assign({ type: 'button' }, btn, { onClick: loadCache }), '刷新'),
          h('button', Object.assign({ type: 'button' }, btn, { onClick: openCacheDir }), '打开缓存目录'),
        ),
        h('div', { className: 'mtts-hint' }, '想导出某段语音，点「打开缓存目录」后在目录里取对应音频文件即可；插件只负责把目录打开。'),
        cacheDir ? h('div', { className: 'mtts-hint' }, '缓存目录：', h('span', { className: 'mtts-voice-id' }, cacheDir)) : null,
        h('div', { className: 'mtts-hint' }, '自动淘汰：超过 ' + (cleanup.days || 30) + ' 天 / '
          + (cleanup.maxItems || 500) + ' 个 / ' + fmtBytes(cleanup.maxBytes || 524288000) + ' 任一即按最近命中时间由旧到新删除。'),
      ));

      /* ---- 灵动模式（三态：禁用 / 白名单 / 全局） ---- */
      cards.push(h('div', { className: 'mtts-card', key: 'emotion' },
        h('h3', null, '灵动模式'),
        selectRow('模式', emotionScope, EMOTION_SCOPES,
          (v) => save({ emotionTts: { scope: normalizeEmotionScope(v) } }),
          (v) => EMOTION_SCOPE_LABELS[v] || EMOTION_SCOPE_LABELS.off),
        h('div', { className: 'mtts-hint' }, '禁用＝技能一行都不注册；白名单＝只有写进 preset 的那一行注册；全局＝所有模式的会话都能调用。'),
        h('div', { className: 'mtts-hint' }, '说明：Agent 通过 emotion-tts 技能把一份更适合朗读的稿子登记到待播队列，点消息旁的播放按钮时优先播这份稿子；没有登记稿时仍照原文朗读。'),
        h('div', { className: 'mtts-hint' }, '开启后 Agent 可能多消耗一些 token。'),
      ));

      /* ---- 高级（默认折叠） ---- */
      cards.push(h('details', { className: 'mtts-card', key: 'advance' },
        h('summary', { className: 'mtts-summary' }, '高级（装完通常不用动）'),
        selectRow('文本规范化', advance.textNormalizationMode || '', ['', 'basic', 'advanced'], (v) => save({ advance: Object.assign({}, advance, { textNormalizationMode: v }) }), (v) => (v === '' ? '默认' : v)),
        h('div', { className: 'mtts-row' },
          h('label', { className: 'mtts-row' },
            h('input', {
              type: 'checkbox',
              checked: advance.latexRead === true,
              disabled: busy,
              onChange: (e) => save({ advance: Object.assign({}, advance, { latexRead: e.target.checked }) }),
            }),
            h('span', null, '朗读数学公式（latex_read）'),
          ),
        ),
        textRow('发音词典', Array.isArray(advance.pronunciationTone) ? advance.pronunciationTone.join(' ') : '', '处理/(chu3)(li3) 危险/dangerous', (v) => save({
          advance: Object.assign({}, advance, { pronunciationTone: v ? v.split(/\s+/) : [] }),
        })),
        h('div', { className: 'mtts-row' },
          h('label', { className: 'mtts-row' },
            h('input', {
              type: 'checkbox',
              checked: advance.aigcWatermark === true,
              disabled: busy,
              onChange: (e) => save({ advance: Object.assign({}, advance, { aigcWatermark: e.target.checked }) }),
            }),
            h('span', null, '加水印'),
          ),
          h('label', { className: 'mtts-row' },
            h('input', {
              type: 'checkbox',
              checked: advance.forceCbr === true,
              disabled: busy,
              onChange: (e) => save({ advance: Object.assign({}, advance, { forceCbr: e.target.checked }) }),
            }),
            h('span', null, '强制 CBR'),
          ),
          h('label', { className: 'mtts-row' },
            h('input', {
              type: 'checkbox',
              checked: advance.subtitleEnable === true,
              disabled: busy,
              onChange: (e) => save({ advance: Object.assign({}, advance, { subtitleEnable: e.target.checked }) }),
            }),
            h('span', null, '返回字幕'),
          ),
        ),
        numRow('保留天数', cleanup.days, { min: '1' }, (v) => save({ cleanup: Object.assign({}, cleanup, { days: v }) })),
        numRow('最多文件数', cleanup.maxItems, { min: '1' }, (v) => save({ cleanup: Object.assign({}, cleanup, { maxItems: v }) })),
        textRow('最大占用（字节）', cleanup.maxBytes, '524288000', (v) => {
          const num = Number(v);
          if (!isFinite(num) || num <= 0) { say('最大占用需要是正整数', 'error'); return; }
          save({ cleanup: Object.assign({}, cleanup, { maxBytes: num }) });
        }),
        h('div', { className: 'mtts-hint' }, 'outputFormat / voiceModify 属于 v1 不做的范围，这里不提供开关。'),
      ));

      return h('div', { className: 'mtts-page' },
        h('div', { className: 'mtts-hint' },
          '每条 assistant 回复旁的按钮组与输入区开关都使用这里的配置；文本清洗、缓存与计费判定都在宿主半边完成。'),
        cards,
        h('div', { className: 'mtts-status', 'data-tone': status ? status.tone : undefined },
          status ? status.text : ''),
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */
    return {
      // 故意留空：声明一个没人满足的依赖会让本条目停在 pending，而渲染层的启动审计
      // 把任何未激活条目都当致命错误。所以服务一律惰性取（见 apply 的注入回调形式）。
      inject: [],

      apply(ctx) {
        // 回调形式：这会起一个嵌套插件，由它自己去等 `slots` / `locale`，
        // 而不是把本条目挂住或拖垮。
        ctx.inject(['slots', 'locale'], (scoped) => {
          scoped.effect(
            () => scoped.locale.register(LOCALE_NS, {
              zh: { nav: 'MiniMax 朗读' },
              en: { nav: 'MiniMax TTS' },
            }),
            'dsh-minimax-tts: dictionaries',
          );
          let t = (key) => key;
          try { t = scoped.locale.bind(LOCALE_NS); } catch (_) {}

          // 样式一次性注入 document.head 的 <style data-mtts>；绝不挂到 body。
          scoped.effect(() => {
            const style = document.createElement('style');
            style.setAttribute(STYLE_MARKER, '');
            style.textContent = CSS;
            document.head.appendChild(style);
            return () => style.remove();
          }, 'dsh-minimax-tts: client styles');

          const player = createPlayer();
          const configStore = createConfigStore();
          const pendingSource = createPendingSource();

          // 可见文本登记表：让 resolveUtterance(messageId) 能脱离 React 组件被调用。
          const visibleTexts = new Map();
          configStore.load().catch(() => {});

          const utteranceSource = createUtteranceSource({
            getConfig: () => configStore.get(),
            pending: pendingSource,
            readVisible: (messageId) => visibleTexts.get(String(messageId)) || '',
            noteVisible: (messageId, text) => { visibleTexts.set(String(messageId), text || ''); },
            forgetVisible: (messageId) => { visibleTexts.delete(String(messageId)); },
          });

          // ---- 席位 1：消息旁按钮组 ----
          const actionsFace = () => ({
            mttsPlayer: player,
            mttsConfig: configStore,
            mttsSource: utteranceSource,
            mttsPending: pendingSource,
          });
          scoped.slots.inject('conversation.chat.assistant-actions', () => scoped.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: NS,
            order: 25,
            locale: LOCALE_NS,
            inject: actionsFace,
          }, Actions));

          // ---- 席位 2：设置页（设置 → 插件 → 本插件）----
          // 不再占用「设置 → 通用」的导航项，改为注册进插件页的 keyed slot：
          // 组合包页用包名，行页用 `<包名>#<行 id>`（对照 dsh-image-gen 的两种注册）。
          const settingsFace = () => ({ mttsPlayer: player, mttsConfig: configStore });
          scoped.slots.inject('plugins.bundle.config', () => scoped.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE_KEY,
            locale: LOCALE_NS,
            inject: settingsFace,
          }, SettingsCard));
          scoped.slots.inject('plugins.row.config', () => scoped.slots.register({
            name: 'plugins.row.config',
            key: ROW_KEY,
            locale: LOCALE_NS,
            inject: settingsFace,
          }, SettingsCard));
        });
      },
    };
  },
});
