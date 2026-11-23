/* YonData 面试知识库 — 内置 AI 改写
 *
 * 能力：框选正文 / 图片 / 代码 → 右键输入要求 → 右侧面板给出改写 → 覆盖或复制。
 *
 * 三条通道：
 *   1) 本地服务（tools/kb_server.py，推荐）：模型在 /models.html 里配置和切换，
 *      密钥只存在本机服务端，浏览器拿不到。
 *   2) 直连 OpenAI 兼容接口：没有本地服务时兜底，Key 存本机 localStorage。
 *   3) 离线规则：不联网，只做「精炼 / 口语化 / 规范标点」三类确定性改写。
 *      面板上的模式徽章会明确写出来是哪一种，不会把规则改写说成大模型。
 */
(function () {
  "use strict";

  const CFG_KEY = "kb:ai:cfg";
  const esc = (window.KBMarkdown && window.KBMarkdown.escapeHtml) ||
    ((s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

  let ctx = null;         // { docText, applyText, toast, getSlug, content }
  const state = {
    cfg: null,
    mode: "offline",      // offline | proxy | direct
    server: null,         // 本地服务状态：{ active, activeId, modelCount }
    target: null,         // { slug, srcStart, srcEnd, text, kind, blockText }
    result: "",
    busy: false,
    aborter: null,
    diff: true,
    undo: null,           // { slug, text }
    ask: "",
    preset: null,
  };

  /* ============================================================
     配置
     ============================================================ */
  const DEFAULT_CFG = {
    mode: "offline",                                // 托管版默认离线；auto | proxy | direct | offline
    proxyUrl: "",
    baseUrl: "",
    model: "",
    key: "",
  };

  function loadCfg() {
    try {
      const raw = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
      return Object.assign({}, DEFAULT_CFG, raw || {});
    } catch (e) { return Object.assign({}, DEFAULT_CFG); }
  }

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(state.cfg)); } catch (e) {}
    applyModeBadge();
  }

  function serverBase() {
    return String(state.cfg.proxyUrl || DEFAULT_CFG.proxyUrl).replace(/\/rewrite\/?$/, "");
  }

  /** 读本地服务的模型列表与当前模型；服务不在就返回 null。 */
  async function fetchServer() {
    try {
      const p = fetch(serverBase() + "/api/models", { cache: "no-store" });
      const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]);
      if (!r || !r.ok) return null;
      const s = await r.json();
      if (!s || !Array.isArray(s.models)) return null;
      const active = s.models.find((m) => m.id === s.activeId) || s.models[0] || null;
      state.server = {
        models: s.models,
        activeId: s.activeId,
        active,
        configured: !!(active && active.model && active.baseUrl),
        modelCount: s.models.length,
      };
      return state.server;
    } catch (e) {
      state.server = null;
      return null;
    }
  }

  /** 在站点里直接切换当前模型。 */
  async function switchServerModel(id) {
    try {
      const res = await fetch(serverBase() + "/api/models/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      await fetchServer();
      applyModeBadge();
      renderModelSelect();
      ctx.toast("已切换到 " + ((state.server && state.server.active && state.server.active.name) || "新模型"));
    } catch (e) {
      ctx.toast("切换模型失败：" + (e.message || e));
    }
  }

  async function detectMode() {
    const c = state.cfg;
    if (c.mode !== "direct") { state.server = null; return "offline"; }
    if (c.mode === "direct") { state.server = null; return c.key && c.baseUrl ? "direct" : "offline"; }
    // auto / proxy：探测本地服务是否在线
    const s = await fetchServer();
    if (s) return "proxy";
    if (c.mode === "proxy") return "offline";
    if (c.key && c.baseUrl) return "direct";
    return "offline";
  }

  function applyModeBadge() {
    const el = document.getElementById("aiMode");
    if (!el) return;
    let text = { offline: "本地规则", proxy: "本地模型", direct: "直连接口" }[state.mode] || "本地规则";
    if (state.mode === "proxy") {
      const a = state.server && state.server.active;
      if (a) text = "本地模型 · " + (a.name || a.model || "");
      else if (state.server && !state.server.configured) text = "本地模型 · 未配置";
      el.title = a && a.model ? "当前模型：" + a.model : "托管版没有本地模型服务";
    } else if (state.mode === "offline") {
      el.title = "离线规则：只做精炼 / 口语 / 标点三类改写";
    } else {
      el.title = "浏览器直连接口";
    }
    el.textContent = text;
    el.className = "ai-mode " + state.mode;
  }

  /* ============================================================
     选区 → 源偏移
     ============================================================ */
  const isSkipped = (n) =>
    n.nodeType === 1 &&
    (n.tagName === "SCRIPT" || n.tagName === "STYLE" ||
     (n.classList && (n.classList.contains("copy") || n.classList.contains("mmd-loading"))));

  function nodeLen(n) {
    if (n.nodeType === 3) return n.nodeValue.length;
    if (n.nodeType !== 1) return 0;
    if (n.tagName === "IMG") return (n.getAttribute("alt") || "").length;
    if (isSkipped(n)) return 0;
    let s = 0;
    for (const c of n.childNodes) s += nodeLen(c);
    return s;
  }

  // 选区端点 → 该端点在 root 可见文本中的字符下标
  function offsetIn(root, node, offset) {
    let acc = 0, done = false;
    const walk = (n) => {
      if (done) return;
      if (n === node) {
        if (n.nodeType === 3) { acc += offset; done = true; return; }
        for (let i = 0; i < offset && i < n.childNodes.length; i++) acc += nodeLen(n.childNodes[i]);
        done = true;
        return;
      }
      if (n.nodeType === 3 || n.tagName === "IMG") { acc += nodeLen(n); return; }
      if (isSkipped(n)) return;
      for (const c of n.childNodes) { walk(c); if (done) return; }
    };
    walk(root);
    return acc;
  }

  function blockOf(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    const content = ctx.content();
    while (el && el !== content) {
      if (el.hasAttribute && el.hasAttribute("data-src")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function srcSlice(block) {
    const raw = block.getAttribute("data-src") || "";
    const [a, b] = raw.split(",").map(Number);
    if (!isFinite(a) || !isFinite(b)) return null;
    return { base: a, src: ctx.docText(ctx.getSlug()).slice(a, b) };
  }

  // 单个块内：可见偏移 → 源偏移
  function visToSrc(block, visStart, visEnd) {
    const s = srcSlice(block);
    if (!s) return null;
    const { text, map } = window.KBMarkdown.visibleMap(s.src);
    const n = text.length;
    if (!n) return null;
    let a = Math.max(0, Math.min(n - 1, visStart));
    let b = Math.max(a + 1, Math.min(n, visEnd));
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b <= a) return null;
    const start = s.base + map[a];
    const end = s.base + map[b - 1] + 1;
    return {
      start, end,
      visText: text.slice(a, b),
      // 写回用的是源 Markdown 片段（含 **、` 等标记），不是可见文本
      srcText: ctx.docText(ctx.getSlug()).slice(start, end),
    };
  }

  function captureText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const content = ctx.content();
    if (!content.contains(range.commonAncestorContainer)) return null;

    const startBlock = blockOf(range.startContainer);
    if (!startBlock) return null;

    // 代码块：直接按源码字符对齐，不走 visibleMap
    if (startBlock.matches("pre.code")) {
      const codeEl = startBlock.querySelector("code");
      if (!codeEl || !codeEl.contains(range.startContainer)) return null;
      const s = srcSlice(startBlock);
      if (!s) return null;
      const firstNl = s.src.indexOf("\n");
      if (firstNl < 0) return null;
      const bodyBase = s.base + firstNl + 1;
      const a = offsetIn(codeEl, range.startContainer, range.startOffset);
      const b = offsetIn(codeEl, range.endContainer, range.endOffset);
      if (b <= a) return null;
      const text = codeEl.textContent.slice(a, b);
      return {
        slug: ctx.getSlug(), kind: "code", srcStart: bodyBase + a, srcEnd: bodyBase + b,
        text, visText: text, srcText: text, blockText: codeEl.textContent,
      };
    }

    const endBlock = blockOf(range.endContainer) || startBlock;
    if (endBlock === startBlock) {
      const vs = offsetIn(startBlock, range.startContainer, range.startOffset);
      const ve = offsetIn(startBlock, range.endContainer, range.endOffset);
      const m = visToSrc(startBlock, Math.min(vs, ve), Math.max(vs, ve));
      if (!m) return null;
      return {
        slug: ctx.getSlug(), kind: "text",
        srcStart: m.start, srcEnd: m.end,
        text: m.visText, visText: m.visText, srcText: m.srcText,
        blockText: visibleSource(startBlock),
      };
    }

    // 跨块：起点块的开头到终点块的结尾，中间整块纳入
    const s = srcSlice(startBlock), e = srcSlice(endBlock);
    if (!s || !e) return null;
    const vs = offsetIn(startBlock, range.startContainer, range.startOffset);
    const ve = offsetIn(endBlock, range.endContainer, range.endOffset);
    const a = visToSrc(startBlock, vs, vs + 1) || { start: s.base };
    const b = visToSrc(endBlock, Math.max(0, ve - 1), ve) || { end: e.base + e.src.length };
    if (b.end <= a.start) return null;
    const text = ctx.docText(ctx.getSlug()).slice(a.start, b.end);
    return {
      slug: ctx.getSlug(), kind: "text",
      srcStart: a.start, srcEnd: b.end,
      text, visText: text, srcText: text,
      blockText: text,
    };
  }

  function visibleSource(block) {
    const s = srcSlice(block);
    return s ? s.src : "";
  }

  function captureImage(img) {
    const block = img.closest("[data-src]");
    if (!block) return null;
    const s = srcSlice(block);
    if (!s) return null;
    const srcUrl = img.getAttribute("src") || "";
    const alt = img.getAttribute("alt") || "";
    let a = s.base, b = s.base + s.src.length;

    // 改写目标是 alt（图注）：只替换 `![alt](url)` 里的 alt 部分，图本身不动
    if (block.matches("figure.img")) {
      const idx = s.src.indexOf("](");
      if (idx > 1 && s.src[0] === "!") { a = s.base + 2; b = a + alt.length; }
    } else {
      const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
      let m;
      while ((m = re.exec(s.src))) {
        if (m[2] === srcUrl) { a = s.base + m.index + 2; b = a + m[1].length; break; }
      }
    }

    return {
      slug: ctx.getSlug(), kind: "image",
      srcStart: a, srcEnd: b,
      text: alt, visText: alt, srcText: alt,
      blockText: s.src,
      imgSrc: srcUrl,
    };
  }

  /* ============================================================
     离线规则改写（确定性，不联网）
     ============================================================ */
  const FILLERS = /(其实|实际上|基本上|可以说|换句话说|简单来说|众所周知|大家都知道|值得注意的是|需要注意的是|在这种情况下)/g;

  const OFFLINE = {
    tight(t) {
      let s = t.replace(FILLERS, "");
      s = s.replace(/[，,]\s*[，,]/g, "，").replace(/。\s*。/g, "。");
      s = s.replace(/的的/g, "的").replace(/了了/g, "了");
      s = s.replace(/([。！？])\s+/g, "$1");
      return s.trim();
    },
    spoken(t) {
      const map = [
        [/因此/g, "所以"], [/然而/g, "但是"], [/此外/g, "另外"], [/例如/g, "比如"],
        [/由于/g, "因为"], [/此时/g, "这时候"], [/目前/g, "现在"], [/以便/g, "好让"],
        [/若(?![干])/g, "如果"], [/以及/g, "和"], [/即(?![使|便])/g, "就是"],
        [/具有/g, "有"], [/进行/g, ""], [/予以/g, "给"],
      ];
      let s = t;
      for (const [re, to] of map) s = s.replace(re, to);
      s = s.replace(/；/g, "。");
      return s.trim();
    },
    fix(t) {
      let s = t.replace(/[ \t]+/g, " ");
      s = s.replace(/([一-龥])\s+(?=[一-龥])/g, "$1");
      s = s.replace(/\s+([，。！？；：、])/g, "$1");
      s = s.replace(/([一-龥]),(?=[一-龥])/g, "$1，");
      s = s.replace(/([一-龥])\.(?=\s|$)/g, "$1。");
      s = s.replace(/\.{3,}/g, "……");
      s = s.replace(/[。]{2,}/g, "。").replace(/，{2,}/g, "，");
      return s.trim();
    },
  };

  const PRESETS = [
    { id: "tight", label: "更精炼", offline: true,
      ask: "把这段压缩约三成，删掉铺垫和重复，事实、数字、类名一个都不能丢。" },
    { id: "spoken", label: "更口语", offline: true,
      ask: "改成能直接说出口的口语，短句为主，去掉书面连接词。" },
    { id: "fix", label: "修正标点", offline: true,
      ask: "只修正语病、标点和中英文混排，不改原意、不改结构。" },
    { id: "interview", label: "面试口播",
      ask: "改写成面试口播：先给结论，再补一句机制，最后一句代码依据，总共不超过四句。" },
    { id: "detail", label: "补机制细节",
      ask: "在不新增事实的前提下把话说实：把抽象结论落到具体机制、类名或数据上。" },
  ];

  const IMAGE_PRESETS = [
    { id: "alt", label: "生成图注", ask: "为这张图写一句不超过 30 字的中文图注，说明它画的是什么结构。" },
    { id: "explain", label: "解释这张图", ask: "按「这张图在讲什么 → 关键节点 → 面试时怎么用」三段解释，不要编造图中没有的信息。" },
  ];

  function offlineRewrite(text, askOrId, target) {
    const id = askOrId;
    if (target && target.kind === "image") {
      // 离线模式看不到图，只能从文件名给出保守图注；不做任何推测性描述
      const file = (target.imgSrc || "").split("/").pop() || "";
      const stem = file.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
      return stem || text || "";
    }
    if (id === "tight") return OFFLINE.tight(text);
    if (id === "spoken") return OFFLINE.spoken(text);
    if (id === "fix") return OFFLINE.fix(text);
    return null;
  }

  function pickOfflinePreset(ask) {
    const a = String(ask || "");
    if (/精炼|精简|压缩|短一点|短些|简洁/.test(a)) return "tight";
    if (/口语|口播|说出口|自然/.test(a)) return "spoken";
    if (/病句|标点|格式|错别字|排版/.test(a)) return "fix";
    return null;
  }

  /* ============================================================
     模型通道
     ============================================================ */
  const SYSTEM_PROMPT = [
    "你是一名中文技术写作助手，服务于一个「数据引擎 / 数据智能」方向的求职知识库。",
    "用户会给你一段从笔记里选中的片段，以及他希望怎么改。你只输出改写后的那一段。",
    "",
    "硬性规则：",
    "1. 只输出改写后的片段本身。不要解释，不要前后缀，不要用 ``` 包住整段（除非片段本身是代码）。",
    "2. 保持原文的 Markdown 风格：加粗、行内代码 `x`、列表、表格结构该保留就保留。",
    "3. 不新增原文无法推断的事实、数字、类名、接口名、性能数据。需要举例时只能用原文已有信息。",
    "4. 保持简体中文；原文有英文技术词就保留英文。",
    "5. 长度遵循用户要求；没有要求时，改写后与原文长度接近。",
    "6. 片段是代码时，保持代码语义与可编译性，只做可读性调整。",
    "7. 片段是图片时，你看不到图，只能依据文件名与上下文写图注；信息不足就在结果末尾另起一行写「需补充：…」，不要编造。",
  ].join("\n");

  function buildUserMessage(t) {
    const doc = window.KB_CONTENT && window.KB_CONTENT.docs[t.slug];
    const kindName = { text: "正文", code: "代码", image: "图片" }[t.kind] || "正文";
    const lines = [
      "【文档】" + (doc ? doc.title : t.slug),
      "【片段类型】" + kindName,
    ];
    if (t.kind === "image") lines.push("【图片文件】" + (t.imgSrc || "").split("/").pop());
    lines.push("【用户要求】" + (state.ask || "让表达更清楚"));
    lines.push("【原文】", "<<<", t.srcText || t.text || "（无文字说明）", ">>>");
    return lines.join("\n");
  }

  async function callModel(t) {
    const c = state.cfg;
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(t) },
    ];
    const ctrl = new AbortController();
    state.aborter = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 90000);

    try {
      let url, headers, body;
      if (state.mode === "proxy") {
        url = serverBase() + "/api/rewrite";
        headers = { "Content-Type": "application/json" };
        body = { messages };
      } else {
        url = (c.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
        headers = { "Content-Type": "application/json", Authorization: "Bearer " + c.key };
        body = { model: c.model || "gpt-4o-mini", messages, temperature: 0.3 };
      }
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) {}
      if (!res.ok) {
        const msg = (data && (data.error && (data.error.message || data.error) || data.message)) || raw.slice(0, 200);
        throw new Error("接口返回 " + res.status + "：" + msg);
      }
      const content =
        (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
        (data && data.content) || (data && data.text) || "";
      if (!content.trim()) throw new Error("模型返回为空");
      return String(content);
    } finally {
      clearTimeout(timer);
      state.aborter = null;
    }
  }

  function stripFence(s) {
    const m = String(s).match(/^\s*```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
    return m ? m[1] : String(s);
  }

  /* ============================================================
     差异比较（token 级 LCS，带规模上限）
     ============================================================ */
  function tokenize(s) {
    return String(s).match(/[一-龥]|[A-Za-z0-9_]+|\s+|[^\s]/g) || [];
  }

  function lcsMark(a, b) {
    const n = a.length, m = b.length, LIMIT = 1600;
    if (n > LIMIT || m > LIMIT) return null;
    const dp = new Uint16Array((n + 1) * (m + 1));
    const w = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const keepA = new Uint8Array(n), keepB = new Uint8Array(m);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { keepA[i++] = 1; keepB[j++] = 1; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
    return { keepA, keepB };
  }

  function renderDiff(a, b) {
    const A = tokenize(a), B = tokenize(b);
    const marks = lcsMark(A, B);
    const paint = (tokens, keep, cls) => {
      let out = "", buf = "", inMark = false;
      const flush = () => {
        if (!buf) return;
        out += inMark ? `<${cls}>${esc(buf)}</${cls}>` : esc(buf);
        buf = "";
      };
      for (let i = 0; i < tokens.length; i++) {
        const changed = keep ? !keep[i] : false;
        if (changed !== inMark) { flush(); inMark = changed; }
        buf += tokens[i];
      }
      flush();
      return out;
    };
    if (!marks) return { a: esc(a), b: esc(b) };
    return { a: paint(A, marks.keepA, "del"), b: paint(B, marks.keepB, "ins") };
  }

  /* ============================================================
     UI：浮层输入卡
     ============================================================ */
  function $(id) { return document.getElementById(id); }

  function openCard(anchor) {
    const card = $("aiCard");
    const t = state.target;
    if (!card || !t) return;
    const chips = t.kind === "image" ? IMAGE_PRESETS : PRESETS;
    $("aiChips").innerHTML = chips.map((p) =>
      `<button class="ai-chip" type="button" data-preset="${p.id}"${p.offline ? "" : ' data-online="1"'}>${esc(p.label)}</button>`
    ).join("");
    state.preset = null;
    $("aiAsk").value = "";
    $("aiCardSel").textContent =
      t.kind === "image" ? "已选 1 张图片" :
      t.kind === "code" ? `已选代码 ${(t.visText || t.text || "").length} 字` :
      `已选 ${(t.visText || t.text || "").length} 字`;
    $("aiHint").textContent = state.mode === "offline" ? "离线规则模式" : "回车发送";
    card.hidden = false;
    // 定位：优先放光标右侧，超界则翻转
    const pad = 12;
    const rect = anchor || { left: window.innerWidth / 2, top: 120, right: window.innerWidth / 2, bottom: 120 };
    card.style.visibility = "hidden";
    card.style.left = "0px";
    card.style.top = "0px";
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let left = rect.left + pad;
    let top = rect.top + pad;
    if (left + cw > window.innerWidth - pad) left = Math.max(pad, rect.right - cw);
    if (top + ch > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - ch - pad);
    card.style.left = left + "px";
    card.style.top = top + "px";
    card.style.visibility = "";
    card.querySelectorAll(".ai-chip").forEach((b) => b.classList.remove("on"));
    setTimeout(() => $("aiAsk").focus(), 0);
  }

  function closeCard() {
    const card = $("aiCard");
    if (card) card.hidden = true;
  }

  /* ============================================================
     UI：右侧面板
     ============================================================ */
  function openPanel() {
    // 面板与 Tab 归 agent.js 管，这里只负责「切到改写页」
    if (window.KBAgent) { window.KBAgent.open("rewrite"); return; }
    const p = $("aiPanel");
    if (!p) return;
    p.setAttribute("aria-hidden", "false");
    p.classList.add("open");
    document.body.classList.add("ai-open");
  }

  function closePanel() {
    if (window.KBAgent) { window.KBAgent.close(); return; }
    const p = $("aiPanel");
    if (!p) return;
    p.setAttribute("aria-hidden", "true");
    p.classList.remove("open");
    document.body.classList.remove("ai-open");
  }

  function panelSetSource(t) {
    $("aiSrcMeta").textContent = t ? `　${(t.visText || t.text || "").length} 字` : "";
    const box = $("aiSource");
    if (!t) { box.innerHTML = '<p class="ai-empty">框选正文、代码或图片后右键，写下你的要求。</p>'; return; }
    const shown = t.visText || t.text || "（无文字说明）";
    const r = window.KBMarkdown.render(t.kind === "text" ? shown : (t.text || "（无文字说明）"), { noSrc: true });
    box.innerHTML = r.html;
  }

  function panelSetLoading(ask) {
    $("aiResMeta").textContent = "";
    $("aiResult").innerHTML =
      `<div class="ai-loading"><span class="spin"></span><span>正在改写…</span>` +
      `<button class="ai-link" id="aiStop" type="button">停止</button></div>` +
      `<p class="ai-askline">要求：${esc(ask || "让表达更清楚")}</p>`;
    const stop = $("aiStop");
    if (stop) stop.onclick = () => { if (state.aborter) state.aborter.abort(); };
  }

  function panelSetError(msg) {
    state.busy = false;
    $("aiResMeta").textContent = "";
    $("aiResult").innerHTML = `<div class="ai-error"><b>没能完成改写</b><p>${esc(msg)}</p>` +
      (state.mode === "direct"
        ? '<p class="ai-tip">浏览器直连第三方接口常被 CORS 拦截。更稳的做法是启动本地代理：<code>python docs/yondata-kb/tools/ai_proxy.py</code>，然后在设置里选「本地代理」。</p>'
        : "") +
      `<button class="btn ghost" id="aiRetry2" type="button">重试</button></div>`;
    const r = $("aiRetry2");
    if (r) r.onclick = runRewrite;
  }

  function panelSetResult(text) {
    state.busy = false;
    state.result = stripFence(text).trim();
    const r = window.KBMarkdown.render(state.result, { noSrc: true });
    $("aiResMeta").textContent = `　${state.result.length} 字`;
    $("aiResult").innerHTML = r.html;
    if (state.diff && state.target) {
      const d = renderDiff(state.target.text, state.result);
      $("aiResult").innerHTML =
        `<div class="ai-diff"><div class="ai-diff-label">原文</div><p>${d.a}</p>` +
        `<div class="ai-diff-label">改写</div><p>${d.b}</p></div>` +
        `<details class="ai-plain"><summary>只看结果</summary>${r.html}</details>`;
    }
    $("aiReplace").disabled = false;
    $("aiCopy").disabled = false;
  }

  function setBusy(on) {
    state.busy = on;
    $("aiReplace").disabled = on || !state.result;
    $("aiCopy").disabled = on || !state.result;
    $("aiRetry").disabled = on;
    const send = $("aiSend");
    if (send) send.disabled = on;
  }

  /* ============================================================
     主流程
     ============================================================ */
  async function runRewrite() {
    const t = state.target;
    if (!t || state.busy) return;
    openPanel();
    closeCard();
    panelSetSource(t);
    setBusy(true);
    state.result = "";
    panelSetLoading(state.ask);

    try {
      if (state.mode === "offline") {
        const id = state.preset || pickOfflinePreset(state.ask);
        const out = offlineRewrite(t.srcText || t.text, id, t);
        if (out === null) {
          panelSetError(t.kind === "image"
            ? "离线规则看不到图片，只能按文件名回填图注。要真正读懂图，请配置模型接口：点右上角 ⚙。"
            : "离线规则模式只能做「更精炼 / 更口语 / 修正标点」这三类。自由改写需要配置模型接口：点右上角 ⚙，启动本地代理或填写 API。");
          return;
        }
        await new Promise((r) => setTimeout(r, 260));
        panelSetResult(out);
        return;
      }
      const out = await callModel(t);
      panelSetResult(out);
    } catch (e) {
      if (e && e.name === "AbortError") panelSetError("已停止。");
      else panelSetError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  function doReplace() {
    const t = state.target;
    if (!t || !state.result) return;
    const cur = ctx.docText(t.slug);
    const expect = t.srcText != null ? t.srcText : t.text;
    const now = cur.slice(t.srcStart, t.srcEnd);
    if (now !== expect) {
      ctx.toast("文档已变化，请重新框选");
      return;
    }
    state.undo = { slug: t.slug, text: cur };
    const next = cur.slice(0, t.srcStart) + state.result + cur.slice(t.srcEnd);
    if (next === cur) {
      ctx.toast("改写结果和原文一致，没有改动");
      return;
    }
    ctx.applyText(t.slug, next);
    ctx.toast("已覆盖到本地版本");
    showUndo();
  }

  function showUndo() {
    const bar = $("aiUndo");
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = '<span>已覆盖到本地版本（源文件未改）</span><button class="ai-link" id="aiUndoBtn" type="button">撤销</button>';
    $("aiUndoBtn").onclick = () => {
      if (!state.undo) return;
      ctx.applyText(state.undo.slug, state.undo.text);
      state.undo = null;
      bar.hidden = true;
      ctx.toast("已撤销");
    };
  }

  async function doCopy() {
    if (!state.result) return;
    try {
      await navigator.clipboard.writeText(state.result);
      ctx.toast("已复制改写结果");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = state.result;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); ctx.toast("已复制改写结果"); }
      catch (e2) { ctx.toast("复制失败，请手动选择"); }
      ta.remove();
    }
  }

  /* ============================================================
     设置面板
     ============================================================ */
  function renderCfg() {
    const c = state.cfg;
    $("cfgMode").value = c.mode === "offline" || c.mode === "direct" ? c.mode : "offline";
    $("cfgBase").value = c.baseUrl || "";
    $("cfgModel").value = c.model || "";
    $("cfgKey").value = c.key || "";
    syncCfgRows();
    renderModelSelect();
  }

  /** 把本地服务里配置的模型列进下拉框，选谁就切换谁。 */
  function renderModelSelect() {
    const sel = $("cfgModelSel");
    if (!sel) return;
    const s = state.server;
    if (!s) {
      sel.innerHTML = '<option value="">（本地服务未连接）</option>';
      sel.disabled = true;
      return;
    }
    if (!s.models || !s.models.length) {
      sel.innerHTML = '<option value="">（还没有配置模型）</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = s.models.map((m) => {
      const label = (m.name || m.model) + (m.model && m.model !== m.name ? "（" + m.model + "）" : "");
      return `<option value="${esc(m.id)}"${m.id === s.activeId ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
  }

  function syncCfgRows() {
    const m = $("cfgMode").value;
    $("rowDirect").hidden = m !== "direct";
    $("rowDirectModel").hidden = m !== "direct";
    $("rowDirectKey").hidden = m !== "direct";
  }

  async function applyCfg() {
    state.cfg = {
      mode: $("cfgMode").value,
      proxyUrl: "",
      baseUrl: $("cfgBase").value.trim(),
      model: $("cfgModel").value.trim(),
      key: $("cfgKey").value.trim(),
    };
    saveCfg();
    state.mode = await detectMode();
    applyModeBadge();
    renderModelSelect();
    $("aiCfg").hidden = true;
    if (state.mode === "offline") {
      ctx.toast("已保存，当前为离线规则模式");
    } else {
      ctx.toast("已保存，直连接口可用");
    }
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bind() {
    const content = ctx.content();

    content.addEventListener("contextmenu", (e) => {
      if (e.target.closest("#aiCard, #aiPanel")) return;
      const img = e.target.closest("#content img");
      const t = img ? captureImage(img) : captureText();
      if (!t) return;
      e.preventDefault();
      state.target = t;
      openCard({ left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY });
    });

    // 触屏 / 无右键：选中后浮出一个小按钮
    document.addEventListener("selectionchange", placeFab);

    // 滚动后选区位置失效，直接收起按钮
    const scroller = $("scroll");
    if (scroller) scroller.addEventListener("scroll", () => {
      const btn = $("aiFab");
      if (btn) btn.hidden = true;
    }, { passive: true });

    $("aiFab").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openCard({ left: r.left, top: r.bottom, right: r.right, bottom: r.bottom });
    });

    $("aiCardClose").addEventListener("click", closeCard);
    $("aiChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-preset]");
      if (!b) return;
      const id = b.getAttribute("data-preset");
      const list = state.target && state.target.kind === "image" ? IMAGE_PRESETS : PRESETS;
      const p = list.find((x) => x.id === id);
      state.preset = id;
      state.ask = p ? p.ask : "";
      $("aiAsk").value = state.ask;
      $("aiChips").querySelectorAll(".ai-chip").forEach((x) => x.classList.toggle("on", x === b));
      if (state.mode === "offline" && p && !p.offline) {
        $("aiHint").textContent = "该选项需要模型接口";
      }
    });

    $("aiAsk").addEventListener("input", () => {
      state.ask = $("aiAsk").value.trim();
      if (state.ask) state.preset = null;
    });

    $("aiAsk").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
        e.preventDefault();
        if (state.ask || state.preset) runRewrite();
        else $("aiAsk").focus();
      }
    });

    $("aiSend").addEventListener("click", () => {
      // 没写要求时给一个默认目标，不要点了没反应
      if (!state.ask && !state.preset) {
        state.ask = state.target && state.target.kind === "image"
          ? "为这张图写一句不超过 30 字的图注。"
          : "让这段表达更清楚、更紧凑，保留全部事实。";
        $("aiAsk").value = state.ask;
      }
      runRewrite();
    });

    $("aiClose").addEventListener("click", closePanel);
    $("aiReplace").addEventListener("click", doReplace);
    $("aiCopy").addEventListener("click", doCopy);
    $("aiRetry").addEventListener("click", () => runRewrite());
    $("aiDiff").addEventListener("click", (e) => {
      state.diff = !state.diff;
      e.currentTarget.setAttribute("aria-pressed", String(state.diff));
      if (state.result) panelSetResult(state.result);
    });

    $("aiCfgBtn").addEventListener("click", async () => {
      const box = $("aiCfg");
      box.hidden = !box.hidden;
      if (!box.hidden) {
        await fetchServer();
        state.mode = await detectMode();
        applyModeBadge();
        renderCfg();
        $("cfgMode").focus();
      }
    });
    $("cfgMode").addEventListener("change", syncCfgRows);
    $("cfgSave").addEventListener("click", applyCfg);
    $("cfgCancel").addEventListener("click", () => { $("aiCfg").hidden = true; });
    const sel = $("cfgModelSel");
    if (sel) sel.addEventListener("change", () => { if (sel.value) switchServerModel(sel.value); });
    // 配置页在新标签打开；切回本页时重新探测，免得改了模型还显示旧的
    window.addEventListener("focus", async () => {
      if (!$("aiCfg") || $("aiCfg").hidden || state.cfg.mode !== "direct") return;
      const before = state.server && state.server.activeId;
      await fetchServer();
      state.mode = await detectMode();
      applyModeBadge();
      if (!state.server || state.server.activeId !== before) renderModelSelect();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // 只管改写浮层；面板的 Esc 由 agent.js 统一处理
        if (!$("aiCard").hidden) { closeCard(); e.stopPropagation(); }
      }
    });

    // 点空白关掉浮层；点浮出按钮不算「点空白」
    document.addEventListener("mousedown", (e) => {
      const card = $("aiCard");
      if (!card || card.hidden) return;
      const t = e.target;
      const onFab = !!(t && t.closest && t.closest("#aiFab"));
      if (!card.contains(t) && !onFab) closeCard();
    });

    window.addEventListener("resize", closeCard);
  }

  /* ============================================================
     触屏 / 无右键：选中后浮出的小按钮
     ============================================================ */
  function placeFab() {
    const btn = $("aiFab");
    if (!btn) return;
    const sel = window.getSelection();
    const contentNow = ctx.content();
    if (!sel || sel.isCollapsed || !sel.rangeCount ||
        !contentNow.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      btn.hidden = true;
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { btn.hidden = true; return; }
    // 选区滚出视口时不浮按钮（窗口最小化时 innerHeight 为 0，跳过判断）
    if (window.innerHeight > 0 && (r.bottom < 8 || r.top > window.innerHeight - 8)) { btn.hidden = true; return; }
    const t = captureText();
    if (!t) { btn.hidden = true; return; }
    state.target = t;
    btn.hidden = false;
    btn.style.left = Math.min(window.innerWidth - 88, Math.max(8, r.left + r.width / 2 - 30)) + "px";
    btn.style.top = Math.max(8, r.top - 40) + "px";
  }

  /* ============================================================
     初始化
     ============================================================ */
  async function init(context) {
    ctx = context;
    if (!$("aiPanel") || !$("aiCard")) return;
    state.cfg = loadCfg();
    state.mode = await detectMode();
    applyModeBadge();
    bind();
    panelSetSource(null);
    setBusy(false);
  }

  window.KBAI = {
    init, closePanel, openPanel, placeFab: () => placeFab(),
    /** 把当前正文选区交给对话用：返回 { text, target } 或 null */
    selectionContext: () => {
      const t = captureText();
      if (!t) return null;
      state.target = t;
      return { text: t.srcText || t.text || "", target: t };
    },
    /** 从对话面板点「改写这段」：直接按选区发起一次改写 */
    rewriteSelection: () => {
      const t = state.target || captureText();
      if (!t) return false;
      state.target = t;
      closeCard();
      runRewrite();
      return true;
    },
  };
})();
