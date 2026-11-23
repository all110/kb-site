/* YonData 面试知识库 — 内置 AI 助手（对话 + 工具 + 会话历史）
 *
 * 与 ai.js 的分工：
 *   ai.js    —— 「改写」：框选 → 右键 → 单次改写 → 覆盖/复制
 *   agent.js —— 「对话」：多轮、会用工具查知识库和源码、可在运行中停止
 *
 * 后端是 tools/kb_agent.py（py 版的最小 harness，参照 pi.dev 的 agent loop）：
 *   POST /api/agent/chat      → {runId, sessionId}
 *   GET  /api/agent/stream    → SSE 事件流（thinking / text / tool_call / tool_result / approval / done / error）
 * 会话落在 .runtime/agent/sessions/*.jsonl，历史跨刷新保留。
 */
(function () {
  "use strict";

  const CFG_KEY = "kb:ai:cfg";
  const esc = (window.KBMarkdown && window.KBMarkdown.escapeHtml) ||
    ((s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

  const $ = (id) => document.getElementById(id);

  let ctx = null;          // 与 ai.js 共用 App 注入的上下文
  const S = {
    sessionId: null,
    runId: null,
    source: null,          // EventSource
    streaming: false,
    tab: "chat",
    histOpen: false,
    ctxText: "",           // 当前页选中的上下文（随消息一起发）
    entries: [],           // 当前会话的渲染模型
    pendingApproval: null,
  };

  const TABS = { chat: "aiChatPane", rewrite: "aiRewritePane", hist: "aiHistPane" };

  /* ============================================================
     服务地址
     ============================================================ */
  function loadCfg() {
    try {
      const raw = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
      return raw || {};
    } catch (e) { return {}; }
  }

  function serverBase() {
    const c = loadCfg();
    return String(c.proxyUrl || "http://127.0.0.1:8766/rewrite").replace(/\/rewrite\/?$/, "");
  }

  /* ============================================================
     面板与 Tab
     ============================================================ */
  function openPanel(tab) {
    const p = $("aiPanel");
    if (!p) return;
    p.setAttribute("aria-hidden", "false");
    p.classList.add("open");
    document.body.classList.add("ai-open");
    if (tab) setTab(tab);
    placeFab();
    if (tab === "chat") setTimeout(() => { const i = $("aiInput"); if (i) i.focus(); }, 50);
  }

  function closePanel() {
    const p = $("aiPanel");
    if (!p) return;
    p.setAttribute("aria-hidden", "true");
    p.classList.remove("open");
    document.body.classList.remove("ai-open");
    placeFab();
  }

  function isOpen() {
    const p = $("aiPanel");
    return !!(p && p.classList.contains("open"));
  }

  function setTab(name) {
    S.tab = name;
    S.histOpen = name === "hist";
    Object.keys(TABS).forEach((k) => {
      const el = $(TABS[k]);
      if (el) el.hidden = k !== name;
    });
    document.querySelectorAll("#aiTabs .ai-tab").forEach((b) => {
      const on = b.getAttribute("data-tab") === name;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    $("aiTabs").hidden = name === "hist";
    $("aiHistBtn").setAttribute("aria-pressed", String(name === "hist"));
    if (name === "chat") $("aiTitle").textContent = "AI 助手";
    if (name === "rewrite") $("aiTitle").textContent = "改写助手";
    if (name === "hist") {
      $("aiTitle").textContent = "对话历史";
      loadHistory();
    }
    if (name === "chat") {
      const log = $("aiChatLog");
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  /* ============================================================
     渲染
     ============================================================ */
  const TOOL_LABEL = {
    kb_list_docs: "列文档",
    kb_search: "搜索知识库",
    kb_outline: "看目录结构",
    kb_read: "读文档",
    repo_search: "搜索源码",
    repo_read: "读源码",
    draft_write: "写草稿",
    doc_edit: "修改源文档",
    kb_build: "重建站点",
  };

  function toolSummary(name, args) {
    if (!args) return "";
    if (name === "kb_search") return "「" + (args.query || "") + "」";
    if (name === "repo_search") return "`" + (args.pattern || "") + "`";
    if (name === "kb_read") return String(args.slug || "") + (args.start_line ? " · 第 " + args.start_line + " 行起" : "");
    if (name === "kb_outline") return String(args.slug || "");
    if (name === "repo_read") return String(args.path || "");
    if (name === "draft_write") return String(args.name || "");
    if (name === "doc_edit") return String(args.slug || "");
    return "";
  }

  function md(text) {
    try {
      return window.KBMarkdown.render(text || "", { noSrc: true }).html;
    } catch (e) {
      return "<p>" + esc(text) + "</p>";
    }
  }

  function el(html) {
    const d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }

  function bubbleUser(text, context) {
    const node = el(
      '<div class="ai-msg user">' +
        '<div class="ai-msg-body">' + md(text) + "</div>" +
        (context ? '<div class="ai-msg-ctx">附带上下文 ' + context.length + " 字</div>" : "") +
      "</div>"
    );
    $("aiChatLog").appendChild(node);
    return node;
  }

  function bubbleAssistant() {
    const node = el(
      '<div class="ai-msg bot">' +
        '<div class="ai-msg-head"><span class="ai-msg-mark">AI</span><span class="ai-msg-time"></span></div>' +
        '<div class="ai-think" hidden><div class="ai-think-head">思考中…</div><div class="ai-think-body"></div></div>' +
        '<div class="ai-tools"></div>' +
        '<div class="ai-msg-body"></div>' +
      "</div>"
    );
    $("aiChatLog").appendChild(node);
    return node;
  }

  function addToolCard(bubble, name, args, callId) {
    const box = bubble.querySelector(".ai-tools");
    const id = "tc" + Math.random().toString(36).slice(2, 8);
    const card = el(
      '<div class="ai-tool" id="' + id + '"' + (callId ? ' data-call="' + esc(callId) + '"' : "") + '>' +
        '<div class="ai-tool-head">' +
          '<span class="ai-tool-ico">⚙</span>' +
          '<span class="ai-tool-name">' + esc(TOOL_LABEL[name] || name) + "</span>" +
          '<span class="ai-tool-sum">' + esc(toolSummary(name, args)) + "</span>" +
          '<span class="ai-tool-state">运行中…</span>' +
        "</div>" +
        '<div class="ai-tool-body" hidden></div>' +
      "</div>"
    );
    box.appendChild(card);
    return card;
  }

  function settleCard(card, ok, result) {
    if (!card) return;
    card.classList.add(ok ? "ok" : "err");
    card.querySelector(".ai-tool-state").textContent = ok ? "完成" : "失败";
    const tb = card.querySelector(".ai-tool-body");
    tb.textContent = result || "";
    tb.hidden = true;
    const head = card.querySelector(".ai-tool-head");
    head.style.cursor = "pointer";
    head.addEventListener("click", () => { tb.hidden = !tb.hidden; });
  }

  function scrollLog() {
    const log = $("aiChatLog");
    if (log) log.scrollTop = log.scrollHeight;
  }

  /* ============================================================
     会话
     ============================================================ */
  async function ensureSession() {
    if (S.sessionId) return S.sessionId;
    const r = await fetch(serverBase() + "/api/agent/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新对话" }),
    });
    if (!r.ok) throw new Error("建会话失败：HTTP " + r.status);
    const d = await r.json();
    S.sessionId = d.session.id;
    try { localStorage.setItem("kb:agent:last", S.sessionId); } catch (e) {}
    return S.sessionId;
  }

  async function loadHistory() {
    const list = $("aiHistList");
    list.innerHTML = '<div class="ai-hist-empty">读取中…</div>';
    try {
      const r = await fetch(serverBase() + "/api/agent/sessions");
      const d = await r.json();
      const items = d.sessions || [];
      if (!items.length) {
        list.innerHTML = '<div class="ai-hist-empty">还没有对话记录。</div>';
        return;
      }
      list.innerHTML = items.map((s) => (
        '<div class="ai-hist-item' + (s.id === S.sessionId ? " on" : "") + '" data-id="' + esc(s.id) + '">' +
          '<div class="ai-hist-main">' +
            '<div class="ai-hist-title">' + esc(s.title || "新对话") + "</div>" +
            '<div class="ai-hist-time">' + esc((s.updatedAt || "").replace("T", " ")) + "</div>" +
          "</div>" +
          '<button class="ai-hist-del" type="button" data-del="' + esc(s.id) + '" title="删除">✕</button>' +
        "</div>"
      )).join("");
    } catch (e) {
      list.innerHTML = '<div class="ai-hist-empty">读取失败：' + esc(e.message) + "（服务没起？）</div>";
    }
  }

  async function openSession(sid) {
    try {
      const r = await fetch(serverBase() + "/api/agent/session?id=" + encodeURIComponent(sid));
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      S.sessionId = sid;
      try { localStorage.setItem("kb:agent:last", sid); } catch (e) {}
      renderEntries(d.entries || []);
      setTab("chat");
    } catch (e) {
      ctx.toast("打开会话失败：" + e.message);
    }
  }

  function renderEntries(entries) {
    const log = $("aiChatLog");
    log.innerHTML = "";
    let bubble = null;
    let cards = {};        // callId → 卡片
    let lastCard = null;
    entries.forEach((e) => {
      if (e.type === "user") {
        bubbleUser(e.text || "", e.context || "");
        bubble = null;
        cards = {};
        lastCard = null;
      } else if (e.type === "assistant") {
        bubble = bubbleAssistant();
        if (e.thinking) {
          const th = bubble.querySelector(".ai-think");
          th.hidden = false;
          th.querySelector(".ai-think-head").textContent = "思考过程";
          th.querySelector(".ai-think-body").textContent = e.thinking;
        }
        if (e.content) bubble.querySelector(".ai-msg-body").innerHTML = md(e.content);
        (e.toolCalls || []).forEach((c) => {
          const card = addToolCard(bubble, c.name, c.args, c.id);
          cards[c.id] = card;
          lastCard = card;
        });
      } else if (e.type === "tool") {
        const scope = bubble || $("aiChatLog").lastElementChild;
        if (!scope) return;
        const target = cards[e.callId] || lastCard || addToolCard(scope, e.name, e.args, e.callId);
        settleCard(target, e.ok, e.result);
        lastCard = null;
      }
    });
    if (!entries.length) {
      log.innerHTML = '<div class="ai-chat-empty"><p class="ace-title">新对话</p><p>问点什么，或者让它去查资料。</p></div>';
    }
    scrollLog();
  }

  async function newSession() {
    S.sessionId = null;
    try { localStorage.removeItem("kb:agent:last"); } catch (e) {}
    $("aiChatLog").innerHTML =
      '<div class="ai-chat-empty"><p class="ace-title">新对话</p><p>问点什么，或者让它去查资料。</p></div>';
    setTab("chat");
    // 不预先建会话：等第一条消息再建，避免历史里堆空会话
    S.sessionId = null;
  }

  /* ============================================================
     发送
     ============================================================ */
  function autoGrow() {
    const ta = $("aiInput");
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
  }

  function setBusy(on) {
    S.streaming = on;
    $("aiStop").hidden = !on;
    $("aiSendChat").disabled = on;
    $("aiRunState").textContent = on ? "运行中" : "";
    $("aiRunState").className = "ai-run-state" + (on ? " on" : "");
  }

  async function send() {
    if (window.KB_STATIC) {
      const bubble0 = bubbleAssistant();
      const think0 = bubble0.querySelector(".ai-think");
      if (think0) think0.remove();
      bubble0.querySelector(".ai-msg-body").innerHTML =
        '<p class="ai-note">托管版没有后端服务，AI 助手（工具调用、对话历史）不可用。'
        + '想用大模型请切到「改写」页：在设置里填直连接口，或用离线规则。</p>';
      scrollLog();
      return;
    }
    const ta = $("aiInput");
    const text = (ta.value || "").trim();
    if (!text || S.streaming) return;
    ta.value = "";
    autoGrow();

    const empty = $("aiChatLog").querySelector(".ai-chat-empty");
    if (empty) empty.remove();
    bubbleUser(text, S.ctxText);
    scrollLog();

    const bubble = bubbleAssistant();
    setBusy(true);
    S.pendingApproval = null;

    try {
      const sid = await ensureSession();
      const r = await fetch(serverBase() + "/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, text: text, context: S.ctxText || "" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || ("HTTP " + r.status));
      S.runId = d.runId;
      streamRun(bubble, d.runId, 0);
    } catch (e) {
      bubble.querySelector(".ai-msg-body").innerHTML =
        '<p class="ai-err">' + esc(e.message || String(e)) + "</p>";
      setBusy(false);
    }
  }

  function streamRun(bubble, runId, from) {
    if (S.source) { try { S.source.close(); } catch (e) {} }
    const es = new EventSource(serverBase() + "/api/agent/stream?run=" + encodeURIComponent(runId) + "&from=" + from);
    S.source = es;

    let body = "";
    let lastCard = null;
    const bodyEl = bubble.querySelector(".ai-msg-body");
    const thinkEl = bubble.querySelector(".ai-think");
    const thinkBody = bubble.querySelector(".ai-think-body");
    let paintQueued = false;
    const paint = () => {
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(() => {
        paintQueued = false;
        bodyEl.innerHTML = md(body);
        scrollLog();
      });
    };

    es.onmessage = (ev) => {
      let e;
      try { e = JSON.parse(ev.data); } catch (err) { return; }
      if (e.type === "thinking") {
        thinkEl.hidden = false;
        thinkBody.textContent += e.text || "";
        thinkBody.scrollTop = thinkBody.scrollHeight;
        scrollLog();
      } else if (e.type === "text") {
        body += e.text || "";
        paint();
      } else if (e.type === "tool_call") {
        lastCard = addToolCard(bubble, e.name, e.args, e.callId);
        scrollLog();
      } else if (e.type === "tool_result") {
        settleCard(lastCard, e.ok, e.result);
        lastCard = null;
        scrollLog();
      } else if (e.type === "approval") {
        showApproval(bubble, e);
      } else if (e.type === "note") {
        body += "\n\n> " + e.text;
        paint();
      } else if (e.type === "done") {
        if (e.content) body = e.content;
        bodyEl.innerHTML = md(body);
        thinkEl.hidden = true;
        finish();
      } else if (e.type === "aborted") {
        bodyEl.innerHTML = md(body) + '<p class="ai-note">已停止。</p>';
        thinkEl.hidden = true;
        finish();
      } else if (e.type === "error") {
        bodyEl.innerHTML = md(body) + '<p class="ai-err">' + esc(e.message || "出错了") + "</p>";
        thinkEl.hidden = true;
        finish();
      } else if (e.type === "end") {
        finish();
      }
    };

    es.onerror = () => {
      // EventSource 在流正常结束时会自己重连；这里只在真的断开时收尾
      if (!S.streaming) return;
      bodyEl.innerHTML = md(body) + '<p class="ai-err">连接中断，可以重发一次。</p>';
      finish();
    };

    function finish() {
      if (!S.streaming) { if (es) es.close(); return; }
      S.streaming = false;
      try { es.close(); } catch (e) {}
      if (S.source === es) S.source = null;
      setBusy(false);
      S.runId = null;
      scrollLog();
      if (S.histOpen) loadHistory();
    }
  }

  function showApproval(bubble, e) {
    const body = bubble.querySelector(".ai-msg-body");
    const card = el(
      '<div class="ai-approval">' +
        '<div class="ai-approval-head">需要你确认：' + esc(TOOL_LABEL[e.name] || e.name) + "</div>" +
        '<pre class="ai-approval-diff">' + esc(e.preview || "") + "</pre>" +
        '<div class="ai-approval-actions">' +
          '<button class="btn primary sm" data-allow="1" type="button">允许</button>' +
          '<button class="btn sm" data-allow="0" type="button">拒绝</button>' +
        "</div>" +
      "</div>"
    );
    body.appendChild(card);
    scrollLog();
    card.querySelectorAll("[data-allow]").forEach((b) => {
      b.addEventListener("click", async () => {
        const allow = b.getAttribute("data-allow") === "1";
        card.querySelector(".ai-approval-actions").innerHTML = allow ? "已允许" : "已拒绝";
        try {
          await fetch(serverBase() + "/api/agent/approve", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: S.runId, callId: e.callId, allow: allow }),
          });
        } catch (err) { /* 流里会报错 */ }
      });
    });
  }

  async function stop() {
    if (!S.runId) return;
    try {
      await fetch(serverBase() + "/api/agent/abort", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: S.runId }),
      });
    } catch (e) {
      ctx.toast("停止失败：" + e.message);
    }
  }

  /* ============================================================
     选区上下文
     ============================================================ */
  function captureSelection() {
    if (!window.KBAI || !window.KBAI.selectionContext) return;
    const got = window.KBAI.selectionContext();
    if (!got) { if (S.ctxText) { S.ctxText = ""; updateCtxBar(); } return; }
    const t = got.text || "";
    S.ctxText = t.length > 4000 ? t.slice(0, 4000) + "…" : t;
    updateCtxBar();
  }

  function updateCtxBar() {
    const bar = $("aiChatCtx");
    if (!bar) return;
    if (!S.ctxText) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    bar.innerHTML = '<span class="ctx-label">上下文</span><span class="ctx-text">' +
      esc(S.ctxText.slice(0, 120)) + (S.ctxText.length > 120 ? "…" : "") +
      '</span><button class="ai-link" type="button" id="aiCtxRewrite">用改写处理</button>' +
      '<button class="ai-link" type="button" id="aiCtxClear">移除</button>';
    $("aiCtxClear").onclick = () => { S.ctxText = ""; updateCtxBar(); };
    $("aiCtxRewrite").onclick = () => {
      if (window.KBAI && window.KBAI.rewriteSelection()) setTab("rewrite");
    };
  }

  /* ============================================================
     浮起按钮（手动唤起面板）
     ============================================================ */
  function placeFab() {
    const b = $("aiOpen");
    if (!b) return;
    b.classList.toggle("hidden", isOpen());
  }

  /* ============================================================
     初始化
     ============================================================ */
  function bind() {
    $("aiOpen").addEventListener("click", () => openPanel("chat"));
    $("aiClose").addEventListener("click", closePanel);
    $("aiHistBtn").addEventListener("click", () => {
      if (window.KB_STATIC) return;
      setTab(S.histOpen ? "chat" : "hist");
    });
    document.querySelectorAll("#aiTabs .ai-tab").forEach((b) => {
      b.addEventListener("click", () => setTab(b.getAttribute("data-tab")));
    });

    $("aiHistNew").addEventListener("click", newSession);
    $("aiHistList").addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        const sid = del.getAttribute("data-del");
        if (!confirm("删除这个对话？")) return;
        try {
          await fetch(serverBase() + "/api/agent/session/delete", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: sid }),
          });
          if (sid === S.sessionId) newSession();
          loadHistory();
        } catch (err) { ctx.toast("删除失败：" + err.message); }
        return;
      }
      const item = e.target.closest(".ai-hist-item");
      if (item) openSession(item.getAttribute("data-id"));
    });

    $("aiSendChat").addEventListener("click", send);
    $("aiStop").addEventListener("click", stop);
    $("aiInput").addEventListener("input", autoGrow);
    $("aiInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    const log = $("aiChatLog");
    log.addEventListener("click", (e) => {
      const chip = e.target.closest(".ace-chip");
      if (!chip) return;
      $("aiInput").value = chip.getAttribute("data-ask") || "";
      autoGrow();
      send();
    });

    document.addEventListener("selectionchange", () => {
      if (isOpen() && S.tab === "chat") captureSelection();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!isOpen()) return;
        if (S.histOpen) { setTab("chat"); e.stopPropagation(); }
        else closePanel();
      }
    });

    // 恢复上次会话（托管版没有服务端会话）
    if (window.KB_STATIC) {
      if ($("aiHistBtn")) $("aiHistBtn").style.display = "none";
      placeFab(); window.addEventListener("resize", placeFab); return;
    }
    let last = null;
    try { last = localStorage.getItem("kb:agent:last"); } catch (e) {}
    if (last) {
      fetch(serverBase() + "/api/agent/session?id=" + encodeURIComponent(last))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          S.sessionId = last;
          if (d.entries && d.entries.length) renderEntries(d.entries);
        })
        .catch(() => {});
    }

    placeFab();
    window.addEventListener("resize", placeFab);
  }

  function init(context) {
    ctx = context;
    if (!$("aiPanel") || !$("aiChatLog")) return;
    bind();
  }

  window.KBAgent = {
    init,
    open: (tab) => openPanel(tab || "chat"),
    close: closePanel,
    isOpen,
    setContext: (t) => { S.ctxText = String(t || "").slice(0, 4000); updateCtxBar(); },
  };
})();
