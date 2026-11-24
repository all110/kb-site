/* ============================================================
   YonData 面试知识库 — 交互逻辑
   状态 / 路由 / 侧栏 / 渲染 / 检索 / 编辑 / 主题 / mermaid
   ============================================================ */
(function () {
  "use strict";

  const C = window.KB_CONTENT || { groups: [], docs: {}, stats: {} };
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- 状态 ---------------- */
  const state = {
    slug: null,
    term: "",
    theme: "light",
    editing: false,
    mermaidState: "idle",   // idle | loading | ready | failed
    mermaidLib: null,
    lastMermaid: [],
    scrollHandler: null,
    tocObserver: null,
  };

  /* ---------------- 存储 ---------------- */
  const KBStore = (function () {
    const P = "kb:";
    let ok = true;
    try {
      localStorage.setItem(P + "__probe", "1");
      localStorage.removeItem(P + "__probe");
    } catch (e) { ok = false; }

    return {
      available: () => ok,
      getEdit: (s) => (ok ? localStorage.getItem(P + "edit:" + s) : null),
      setEdit: (s, t) => { if (ok) localStorage.setItem(P + "edit:" + s, t); },
      clearEdit: (s) => { if (ok) localStorage.removeItem(P + "edit:" + s); },
      listEdited: () => {
        if (!ok) return [];
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(P + "edit:")) out.push(k.slice((P + "edit:").length));
        }
        return out;
      },
      getPref: (k, d) => {
        if (!ok) return d;
        try {
          const v = localStorage.getItem(P + k);
          return v === null ? d : JSON.parse(v);
        } catch (e) { return d; }
      },
      setPref: (k, v) => { if (ok) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) {} } },
      clearAll: () => {
        if (!ok) return;
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(P) && k.indexOf(P + "edit:") === 0) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
      },
    };
  })();

  /* ---------------- 图标 ---------------- */
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    message: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 1 1 18-4z"/>',
    code: '<path d="m9 8-4 4 4 4"/><path d="m15 8 4 4-4 4"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5.5-5.5 2 2-5.5z"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/>',
    download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 21h16"/>',
    reset: '<path d="M4 4v6h6"/><path d="M20 20v-6h-6"/><path d="M20 10a8 8 0 0 0-14-4L4 8"/><path d="M4 14a8 8 0 0 0 14 4l2-2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 4v6h6V4"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  };

  const icon = (name, cls) =>
    `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  /* ---------------- 工具 ---------------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const fmtChars = (n) => (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

  function toast(msg) {
    let el = $(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute("data-theme", t);
    KBStore.setPref("theme", t);
    const btn = $("#themeBtn");
    if (btn) btn.innerHTML = icon(t === "dark" ? "sun" : "moon");
  }

  function initTheme() {
    const saved = KBStore.getPref("theme", null);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(saved || (prefersDark ? "dark" : "light"));
  }

  /* ---------------- 清除本地修改（SRS §6.3） ---------------- */
  function clearAllEdits() {
    const edited = KBStore.listEdited();
    if (!edited.length) { toast("没有本地修改"); return; }
    if (!confirm("将清除 " + edited.length + " 篇文档的本地修改，源文件不受影响。继续？")) return;
    KBStore.clearAll();
    toast("已清除全部本地修改");
    state.slug ? openDoc(state.slug) : renderSidebar();
  }

  /* ---------------- 侧边栏 ---------------- */
  function groupOf(slug) {
    return C.groups.find((g) => g.docs.indexOf(slug) >= 0);
  }

  function renderSidebar() {
    const nav = $("#nav");
    const collapsed = new Set(KBStore.getPref("collapse", []) || []);
    const edited = new Set(KBStore.listEdited());
    const activeGroup = state.slug ? groupOf(state.slug) : null;
    const SECTION_LABEL = { intro: "项目介绍", interview: "面试题库", general: "通用技术知识" };

    let html = '<a class="home-link' + (state.slug ? "" : " active") + '" href="#/">' +
      icon("home") + "<span>首页概览</span></a>";

    // 项目 → 三个分区
    for (const proj of C.projects || []) {
      const mine = (C.groups || []).filter((g) => g.project === proj.id);
      if (!mine.length) continue;
      html += '<div class="nav-project">' +
        `<div class="nav-project-head"><span class="np-name">${esc(proj.name)}</span>` +
        `<span class="np-sub">${esc(proj.subtitle || "")}</span></div>`;
      for (const g of mine) {
        const isCollapsed = collapsed.has(g.id);
        const isActive = activeGroup && activeGroup.id === g.id;
        html += `<section class="group${isCollapsed ? " collapsed" : ""}${isActive ? " active" : ""}" data-gid="${g.id}">`;
        html += `<button class="group-head" type="button" data-toggle="${g.id}">` +
          icon("chevron", "chev") +
          `<span class="group-title">${esc(SECTION_LABEL[g.section] || g.title)}</span>` +
          `<span class="group-count">${g.docs.length}</span>` +
          "</button>";
        html += '<ul class="doc-list">';
        for (const sub of g.subgroups || [{ title: "", docs: g.docs }]) {
          if (sub.title) {
            html += `<li class="doc-sub">${esc(sub.title)}<span>${sub.docs.length}</span></li>`;
          }
          for (const slug of sub.docs) {
            const doc = C.docs[slug];
            if (!doc) continue;
            const on = slug === state.slug;
            html += `<li><a class="doc-link${on ? " active" : ""}" href="#/doc/${encodeURIComponent(slug)}" data-slug="${esc(slug)}">` +
              `<span class="doc-name">${esc(doc.title)}</span>` +
              (edited.has(slug) ? '<span class="edit-dot" title="有本地修改"></span>' : "") +
              `<span class="doc-size">${fmtChars(doc.chars)}</span>` +
              "</a></li>";
          }
        }
        html += "</ul></section>";
      }
      html += "</div>";
    }
    nav.innerHTML = html;
  }

  function bindSidebar() {
    $("#nav").addEventListener("click", (e) => {
      const t = e.target.closest("[data-toggle]");
      if (!t) return;
      const gid = t.getAttribute("data-toggle");
      const sec = t.closest(".group");
      const collapsed = new Set(KBStore.getPref("collapse", []) || []);
      if (sec.classList.contains("collapsed")) { collapsed.delete(gid); sec.classList.remove("collapsed"); }
      else { collapsed.add(gid); sec.classList.add("collapsed"); }
      KBStore.setPref("collapse", Array.from(collapsed));
    });
  }

  /* ---------------- 检索 ---------------- */
  function makeSnippet(body, idx, len) {
    const start = Math.max(0, idx - 28);
    const end = Math.min(body.length, idx + len + 56);
    let text = body.slice(start, end).replace(/\s+/g, " ");
    if (start > 0) text = "…" + text;
    if (end < body.length) text += "…";
    const hitStart = (idx - start) + (start > 0 ? 1 : 0);
    return { text, hitStart, hitLen: len };
  }

  function search(term) {
    const q = term.trim().toLowerCase();
    if (!q) return null;
    const out = [];
    for (const slug in C.docs) {
      const doc = C.docs[slug];
      const body = KBStore.getEdit(slug) || doc.body;
      const lower = body.toLowerCase();
      const idx = lower.indexOf(q);
      const titleHit = doc.title.toLowerCase().indexOf(q) >= 0;
      if (idx < 0 && !titleHit) continue;
      let count = 0, p = 0;
      while ((p = lower.indexOf(q, p)) >= 0) { count++; p += q.length; }
      out.push({ slug, title: doc.title, titleHit, count, snippet: idx < 0 ? null : makeSnippet(body, idx, q.length) });
    }
    out.sort((a, b) => (b.titleHit - a.titleHit) || (b.count - a.count));
    return out;
  }

  function renderResults(results, term) {
    const nav = $("#nav");
    if (!results.length) {
      nav.innerHTML = '<div class="no-result">没有找到匹配内容</div>';
      return;
    }
    const q = term.trim();
    let html = '<div class="results">';
    html += `<div class="no-result" style="padding:6px 10px 10px;text-align:left">共 ${results.length} 篇命中</div>`;
    for (const r of results) {
      let snip = "";
      if (r.snippet) {
        const s = r.snippet;
        const before = esc(s.text.slice(0, s.hitStart));
        const hit = esc(s.text.slice(s.hitStart, s.hitStart + s.hitLen));
        const after = esc(s.text.slice(s.hitStart + s.hitLen));
        snip = `<div class="result-snippet">${before}<mark>${hit}</mark>${after}</div>`;
      }
      html += `<a class="result-item" href="#/doc/${encodeURIComponent(r.slug)}">` +
        `<div class="result-title"><span>${esc(r.title)}</span>` +
        (r.count ? `<span class="result-count">${r.count}</span>` : "") +
        "</div>" + snip + "</a>";
    }
    html += "</div>";
    nav.innerHTML = html;
    // 轻量高亮：标题里的命中词也标出来
    if (q) {
      $$(".result-title > span", nav).forEach((el) => {
        const t = el.textContent;
        const i = t.toLowerCase().indexOf(q.toLowerCase());
        if (i >= 0) {
          el.innerHTML = esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" + esc(t.slice(i + q.length));
        }
      });
    }
  }

  function onSearchInput(e) {
    const v = e.target.value;
    state.term = v;
    clearTimeout(onSearchInput._t);
    onSearchInput._t = setTimeout(() => {
      if (!v.trim()) { renderSidebar(); return; }
      renderResults(search(v), v);
    }, 120);
  }

  /* ---------------- 目录 ---------------- */
  function renderTOC(headings) {
    const toc = $("#toc");
    const items = headings.filter((h) => h.level >= 2 && h.level <= 3);
    if (!items.length) {
      toc.innerHTML = '<div class="toc-empty">本篇无小节</div>';
      return;
    }
    let html = '<div class="toc-title">本页目录</div><ul>';
    for (const h of items) {
      html += `<li><a href="#${esc(h.id)}" class="${h.level === 3 ? "lv3" : "lv2"}" data-target="${esc(h.id)}">${esc(h.text)}</a></li>`;
    }
    html += "</ul>";
    toc.innerHTML = html;

    toc.querySelector("ul").addEventListener("click", (e) => {
      const a = e.target.closest("a[data-target]");
      if (!a) return;
      e.preventDefault();
      const el = document.getElementById(a.getAttribute("data-target"));
      if (el) {
        const area = $("#scroll");
        const top = el.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 12;
        area.scrollTo({ top, behavior: "smooth" });
      }
    });
  }

  function setupScrollSpy() {
    if (state.tocObserver) state.tocObserver.disconnect();
    const area = $("#scroll");
    const heads = $$("#content h2[id], #content h3[id]");
    if (!heads.length) return;
    const links = {};
    $$("#toc a[data-target]").forEach((a) => { links[a.getAttribute("data-target")] = a; });
    let current = null;

    const onScroll = () => {
      const areaTop = area.getBoundingClientRect().top;
      let activeId = null;
      for (const h of heads) {
        if (h.getBoundingClientRect().top - areaTop <= 80) activeId = h.id;
        else break;
      }
      if (activeId === current) return;
      current = activeId;
      $$("#toc a").forEach((a) => a.classList.remove("active"));
      if (activeId && links[activeId]) links[activeId].classList.add("active");
    };

    if (state.scrollHandler) area.removeEventListener("scroll", state.scrollHandler);
    state.scrollHandler = onScroll;
    area.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------------- 进度条 ---------------- */
  function setupProgress() {
    const area = $("#scroll");
    const bar = $("#progressBar");
    area.addEventListener("scroll", () => {
      const max = area.scrollHeight - area.clientHeight;
      const p = max > 0 ? (area.scrollTop / max) * 100 : 0;
      bar.style.width = p + "%";
      $("#fab").classList.toggle("show", area.scrollTop > 500);
    }, { passive: true });
  }

  /* ---------------- mermaid ---------------- */
  function ensureMermaid() {
    if (state.mermaidLib) return Promise.resolve(state.mermaidLib);
    if (state.mermaidState === "loading") return state.mermaidReady;
    state.mermaidState = "loading";
    state.mermaidReady = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "assets/mermaid.min.js";
      s.onload = () => {
        try {
          window.mermaid.initialize({
            startOnLoad: false,
            theme: state.theme === "dark" ? "dark" : "default",
            securityLevel: "strict",
            fontFamily: "inherit",
            flowchart: { htmlLabels: false, useMaxWidth: true, curve: "basis" },
          });
          state.mermaidLib = window.mermaid;
          state.mermaidState = "ready";
          resolve(window.mermaid);
        } catch (e) { state.mermaidState = "failed"; reject(e); }
      };
      s.onerror = () => { state.mermaidState = "failed"; reject(new Error("mermaid 加载失败")); };
      document.head.appendChild(s);
    });
    return state.mermaidReady;
  }

  async function renderMermaid(blocks) {
    const nodes = $$("#content .mmd");
    if (!nodes.length) return;
    let lib;
    try {
      lib = await ensureMermaid();
    } catch (e) {
      nodes.forEach((n, i) => {
        n.innerHTML = '<div class="mmd-error"><p>图形库不可用，以下为源码</p>' +
          '<pre class="code" data-lang="mermaid"><code>' + esc(blocks[i] || "") + "</code></pre></div>";
      });
      return;
    }
    for (const node of nodes) {
      const idx = +node.getAttribute("data-idx");
      const src = blocks[idx];
      if (!src) continue;
      try {
        const id = "mmd-" + idx + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
        const res = await lib.render(id, src);
        node.innerHTML = res.svg;
      } catch (e) {
        node.innerHTML = '<div class="mmd-error"><p>此图形渲染失败，以下为源码</p>' +
          '<pre class="code" data-lang="mermaid"><code>' + esc(src) + "</code></pre></div>";
      }
    }
  }

  /* ---------------- 文档渲染 ---------------- */
  function crumbHTML(title) {
    return '<a class="crumb-home" href="#/">首页</a><span class="crumb-sep">/</span>' +
      (title ? "<b>" + esc(title) + "</b>" : "");
  }

  function docText(slug) {
    const doc = C.docs[slug];
    if (!doc) return "";
    return KBStore.getEdit(slug) || doc.body;
  }

  function openDoc(slug, anchor) {
    const doc = C.docs[slug];
    if (!doc) return showNotFound(slug);

    state.slug = slug;
    state.editing = false;

    const edited = !!KBStore.getEdit(slug);
    const text = docText(slug);

    let result;
    try {
      result = window.KBMarkdown.render(text, { slug });
    } catch (e) {
      result = { html: '<pre class="code"><code>' + esc(text) + "</code></pre>", headings: [], mermaid: [] };
      console.error("[kb] 渲染失败", e);
    }

    // 工具栏
    $("#crumb").innerHTML = crumbHTML(doc.title);
    $("#editBtn").disabled = !KBStore.available();
    $("#editBtn").style.display = "";
    $("#resetBtn").style.display = edited ? "" : "none";

    // 提示条
    const banner = $("#editBanner");
    if (edited) {
      banner.style.display = "";
      banner.innerHTML = icon("edit") + '<span class="grow">当前显示的是本地修改版，源文件未被改动。</span>';
      const restore = document.createElement("button");
      restore.className = "btn ghost";
      restore.textContent = "还原";
      restore.onclick = () => doReset(slug);
      banner.appendChild(restore);
    } else {
      banner.style.display = "none";
    }

    // 正文
    $("#content").innerHTML = result.html;
    $("#content").setAttribute("data-slug", slug);

    // 页脚信息
    $("#docMeta").innerHTML =
      `<span>源文件：<code>${esc(doc.source)}</code></span>` +
      `<span>${fmtChars(doc.chars)} 字符</span>` +
      (doc.mermaid ? `<span>${doc.mermaid} 张图</span>` : "");

    renderTOC(result.headings);
    renderSidebar();
    renderPager(slug);

    state.lastMermaid = result.mermaid;
    if (result.mermaid.length) renderMermaid(result.mermaid);

    setupScrollSpy();

    const area = $("#scroll");
    if (anchor) {
      const el = document.getElementById(anchor);
      if (el) {
        requestAnimationFrame(() => {
          const top = el.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 12;
          area.scrollTo({ top, behavior: "smooth" });
        });
        return;
      }
    }
    area.scrollTo({ top: 0 });
  }

  function linearOrder() {
    return C.groups.flatMap((g) => g.docs);
  }

  function renderPager(slug) {
    const order = linearOrder();
    const i = order.indexOf(slug);
    const prev = i > 0 ? C.docs[order[i - 1]] : null;
    const next = i >= 0 && i < order.length - 1 ? C.docs[order[i + 1]] : null;
    const pager = $("#pager");
    if (!prev && !next) { pager.innerHTML = ""; return; }

    let html = "";
    html += prev
      ? `<a class="prev" href="#/doc/${encodeURIComponent(prev.slug)}"><span class="dir">← 上一篇</span><span class="to">${esc(prev.title)}</span></a>`
      : "<span></span>";
    html += next
      ? `<a class="next" href="#/doc/${encodeURIComponent(next.slug)}"><span class="dir">下一篇 →</span><span class="to">${esc(next.title)}</span></a>`
      : "<span></span>";
    pager.innerHTML = html;
  }

  /* ---------------- 首页 ---------------- */
  const SECTION_DESC = {
    intro: "总览、架构、技术文档与学习路线",
    interview: "简历条目、面试问题与追问准备",
    general: "面试官会发散到的通用技术知识",
  };

  const READ_PATH = [
    { slug: "简历-YonData开发", step: "定简历口径", hint: "YonData 先看「标准版 / 精简版」" },
    { slug: "简历-数据引擎经历", step: "补上一段经历", hint: "数据引擎的简历条目与边界" },
    { slug: "简历-在线编程平台", step: "第三段经历", hint: "在线编程项目的简历条目" },
    { slug: "面试-YonData工作总结", step: "搭主故事", hint: "全量工作总结，把项目讲成一条线" },
    { slug: "项目总览-数据引擎", step: "熟悉引擎", hint: "7 个模块、执行链、边界" },
    { slug: "项目总览-在线编程平台", step: "熟悉在线编程", hint: "容器化实验环境怎么做" },
  ];

  function homeDocLink(slug, extra) {
    const d = C.docs && C.docs[slug];
    if (!d) return "";
    return `<a class="hlink" href="#/doc/${encodeURIComponent(slug)}">${esc(d.title)}` +
      (extra ? `<span class="hl-meta">${extra}</span>` : "") + "</a>";
  }

  function showHome() {
    state.slug = null;
    state.editing = false;
    $("#crumb").innerHTML = crumbHTML(null);
    $("#editBtn").style.display = "none";
    $("#resetBtn").style.display = "none";
    $("#editBanner").style.display = "none";
    $("#pager").innerHTML = "";
    $("#docMeta").innerHTML = "";

    const s = C.stats || {};
    const groups = C.groups || [];

    // 一张卡片 = 某项目的某个分区（项目介绍 / 面试题库 / 通用技术知识）
    const topicCard = (g) => {
      const first = g.docs[0];
      const picks = g.docs.slice(0, 5).map((slug) => {
        const d = C.docs[slug];
        return d ? `<a class="hlink" href="#/doc/${encodeURIComponent(slug)}">${esc(d.title)}</a>` : "";
      }).join("");
      return '<div class="topic">' +
        `<div class="topic-head">` +
          `<span class="topic-ic">${icon(g.icon || "file")}</span>` +
          `<span class="topic-name">${esc(g.title)}</span>` +
          `<span class="topic-count">${g.docs.length} 篇</span>` +
        "</div>" +
        `<p class="topic-desc">${esc(SECTION_DESC[g.section] || "")}</p>` +
        `<div class="topic-links">${picks}</div>` +
        (first
          ? `<a class="topic-more" href="#/doc/${encodeURIComponent(first)}">进入${esc(g.title)} →</a>`
          : "") +
        "</div>";
    };

    // 按项目分段：每个项目一条标题带 + 一行三张卡片
    const topics = (C.projects || []).map((p) => {
      const mine = groups.filter((g) => g.project === p.id);
      if (!mine.length) return "";
      const n = mine.reduce((k, g) => k + g.docs.length, 0);
      return `<h3 class="topic-band"><span>${esc(p.name)}</span>` +
        `<span class="topic-band-sub">${esc(p.subtitle || "")}</span>` +
        `<span class="topic-band-n">${n} 篇</span></h3>` +
        '<div class="topic-grid topic-grid-3">' + mine.map(topicCard).join("") + "</div>";
    }).join("");

    const path = READ_PATH.map((p, i) => {
      const d = C.docs && C.docs[p.slug];
      if (!d) return "";
      return '<li><span class="step-no">' + (i + 1) + "</span>" +
        '<span class="step-body">' +
          `<a href="#/doc/${encodeURIComponent(p.slug)}">${esc(d.title)}</a>` +
          `<span class="step-hint">${esc(p.hint)}</span>` +
        "</span></li>";
    }).join("");

    // 全部文档：按项目 + 分区排
    const index = (C.projects || []).map((p) => {
      const cols = groups.filter((g) => g.project === p.id).map((g) => {
        const items = g.docs.map((slug) => {
          const d = C.docs[slug];
          if (!d) return "";
          return `<li>${homeDocLink(slug, fmtChars(d.chars))}</li>`;
        }).join("");
        return '<div class="idx-col">' +
          `<div class="idx-head">${esc(g.title)}<span>${g.docs.length}</span></div>` +
          `<ul class="idx-list">${items}</ul></div>`;
      }).join("");
      return '<div class="idx-project">' +
        `<div class="idx-project-head">${esc(p.name)}<span>${esc(p.subtitle || "")}</span></div>` +
        '<div class="doc-index">' + cols + "</div></div>";
    }).join("");

    $("#content").innerHTML =
      '<div class="hero">' +
        "<h1>求职准备知识库</h1>" +
        '<p class="hero-sub">三个项目的离线工作台：YonData 数据智能、数据引擎、在线编程教学平台。每个项目下分「项目介绍 / 面试题库 / 通用技术知识」，站内检索与 AI 助手都覆盖。</p>' +
        '<div class="hero-actions">' +
          '<button class="btn primary" type="button" data-focus-search>搜索全部文档<span class="kbd">Ctrl K</span></button>' +
        "</div>" +
        '<p class="hero-tip">正文里框选文字或图片后右键，可以让内置 AI 按你的要求改写；托管版在 AI 面板设置里填直连接口，或直接用离线规则。</p>' +
      "</div>" +
      '<div class="stat-grid">' +
        `<div class="stat-card"><div class="stat-num">${s.docCount || 0}</div><div class="stat-label">收录文档</div></div>` +
        `<div class="stat-card"><div class="stat-num">${fmtChars(s.chars || 0)}</div><div class="stat-label">总字数</div></div>` +
        `<div class="stat-card"><div class="stat-num">${s.mermaid || 0}</div><div class="stat-label">流程 / 架构图</div></div>` +
        `<div class="stat-card"><div class="stat-num">${s.codeBlocks || 0}</div><div class="stat-label">代码片段</div></div>` +
      "</div>" +
      '<h2 id="home-topics">按主题进入</h2>' +
      '<div id="home-topic-body">' + topics + "</div>" +
      '<h2 id="home-path">推荐阅读顺序</h2>' +
      '<ol class="read-path">' + path + "</ol>" +
      '<h2 id="home-index">全部文档</h2>' +
      '<div class="doc-index">' + index + "</div>";

    renderTOC([
      { level: 2, id: "home-topics", text: "按主题进入" },
      { level: 2, id: "home-path", text: "推荐阅读顺序" },
      { level: 2, id: "home-index", text: "全部文档" },
    ]);
    renderSidebar();
    setupScrollSpy();

    const focusBtn = $("#content [data-focus-search]");
    if (focusBtn) focusBtn.addEventListener("click", () => { const inp = $("#search"); if (inp) inp.focus(); });

    $("#scroll").scrollTo({ top: 0 });
  }

  function showNotFound(slug) {
    state.slug = null;
    $("#crumb").innerHTML = crumbHTML("未找到");
    $("#editBtn").style.display = "none";
    $("#resetBtn").style.display = "none";
    $("#pager").innerHTML = "";
    $("#content").innerHTML =
      '<div class="empty-state"><div class="emoji">🔍</div>' +
      "<h2>没有这篇文档</h2>" +
      `<p>找不到 <code>${esc(slug)}</code>。可能是链接过期，或内容尚未构建。</p>` +
      '<a class="btn primary" href="#/">返回首页</a></div>';
    $("#toc").innerHTML = "";
    renderSidebar();
  }

  /* ---------------- 编辑 ---------------- */
  function enterEdit() {
    const slug = state.slug;
    if (!slug || state.editing) return;
    if (!KBStore.available()) { toast("当前浏览器禁用本地存储，无法编辑"); return; }

    state.editing = true;
    const text = docText(slug);
    $("#content").innerHTML =
      '<textarea class="editor" id="editor" spellcheck="false"></textarea>' +
      '<p style="margin-top:12px;font-size:13px;color:var(--text-dim)">' +
      "编辑内容只保存在本浏览器，不影响源文件。长期保留请导出后让 AI 写回 docs/yondata/。</p>";
    $("#editor").value = text;

    $("#editBtn").style.display = "none";
    $("#saveBtn").style.display = "";
    $("#cancelBtn").style.display = "";
    $("#exportBtn").style.display = "";
    $("#resetBtn").style.display = "none";
    $("#editor").focus();
  }

  function saveEdit() {
    const slug = state.slug;
    const ta = $("#editor");
    if (!slug || !ta) return;
    try {
      KBStore.setEdit(slug, ta.value);
      toast("已保存到本地");
      exitEditUI();
      openDoc(slug);
    } catch (e) {
      toast("保存失败：本地存储可能已满");
    }
  }

  function exitEditUI() {
    state.editing = false;
    $("#saveBtn").style.display = "none";
    $("#cancelBtn").style.display = "none";
    $("#exportBtn").style.display = "none";
    $("#editBtn").style.display = "";
  }

  function cancelEdit() {
    const slug = state.slug;
    exitEditUI();
    if (slug) openDoc(slug); else showHome();
  }

  function doReset(slug) {
    if (!confirm("将丢弃本地修改，恢复源文档内容？")) return;
    KBStore.clearEdit(slug);
    toast("已还原为源文档");
    openDoc(slug);
  }

  function doExport() {
    const slug = state.slug;
    if (!slug) return;
    const text = state.editing ? ($("#editor") ? $("#editor").value : "") : docText(slug);
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = slug + ".md";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast("已导出 " + slug + ".md");
  }

  /* ---------------- 内容区交互 ---------------- */
  function bindContent() {
    const content = $("#content");
    content.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("[data-copy]");
      if (copyBtn) {
        const pre = copyBtn.closest("pre");
        const code = pre && pre.querySelector("code");
        if (!code) return;
        const text = code.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => { copyBtn.textContent = "已复制"; setTimeout(() => (copyBtn.textContent = "复制"), 1200); },
            () => toast("复制失败，请手动选择")
          );
        } else {
          toast("当前环境不支持自动复制");
        }
        return;
      }

      const broken = e.target.closest("a[data-broken]");
      if (broken) {
        e.preventDefault();
        toast("目标文档不存在：" + broken.getAttribute("href"));
        return;
      }

      // 指向工作区文件系统的相对路径（非站点内文档）
      const local = e.target.closest("a[data-local]");
      if (local) {
        e.preventDefault();
        toast("在文件系统中打开：" + local.getAttribute("href"));
        return;
      }

      // 文档内锚点（非路由）
      const a = e.target.closest('a[href^="#"]');
      if (a && !a.getAttribute("href").startsWith("#/")) {
        const id = a.getAttribute("href").slice(1);
        const el = document.getElementById(id);
        if (el) {
          e.preventDefault();
          const area = $("#scroll");
          const top = el.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 12;
          area.scrollTo({ top, behavior: "smooth" });
        }
      }
    });
  }

  /* ---------------- 路由 ---------------- */
  function route() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw || raw === "/") return showHome();

    const m = raw.match(/^\/doc\/([^#?]+)(?:\?[^#]*)?(?:#(.+))?$/);
    if (!m) return showHome();

    let slug;
    try { slug = decodeURIComponent(m[1]); } catch (e) { slug = m[1]; }

    closeMobileNav();
    if (!C.docs[slug]) return showNotFound(slug);

    // 正在编辑别的文档时切走，丢弃未保存内容
    if (state.editing && state.slug && state.slug !== slug) {
      exitEditUI();
    }

    openDoc(slug, m[2]);
  }

  /* ---------------- 移动端侧栏 ---------------- */
  function openMobileNav() {
    document.body.classList.add("nav-open");
    const bd = $("#navBackdrop");
    if (bd) bd.hidden = false;
  }
  function closeMobileNav() {
    document.body.classList.remove("nav-open");
    const bd = $("#navBackdrop");
    if (bd) bd.hidden = true;
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    initTheme();
    $("#clearBtn").innerHTML = icon("trash");
    $("#clearBtn").addEventListener("click", clearAllEdits);

    $("#nav").innerHTML = "";
    bindSidebar();
    bindContent();
    setupProgress();

    $("#search").addEventListener("input", onSearchInput);
    $("#search").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.target.value = ""; state.term = ""; renderSidebar(); e.target.blur(); }
    });

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#search").focus();
        $("#search").select();
      }
    });

    $("#themeBtn").addEventListener("click", () => {
      applyTheme(state.theme === "dark" ? "light" : "dark");
      if (state.slug && state.lastMermaid && state.lastMermaid.length) {
        // 主题变了，重新渲染图
        if (state.mermaidLib) {
          state.mermaidLib.initialize({
            startOnLoad: false,
            theme: state.theme === "dark" ? "dark" : "default",
            securityLevel: "strict",
            fontFamily: "inherit",
            flowchart: { htmlLabels: false, useMaxWidth: true, curve: "basis" },
          });
        }
        const blocks = state.lastMermaid.slice();
        $$("#content .mmd").forEach((n) => { n.innerHTML = '<div class="mmd-loading">图形加载中…</div>'; });
        renderMermaid(blocks);
      }
    });

    $("#editBtn").addEventListener("click", enterEdit);
    $("#saveBtn").addEventListener("click", saveEdit);
    $("#cancelBtn").addEventListener("click", cancelEdit);
    $("#exportBtn").addEventListener("click", doExport);
    $("#resetBtn").addEventListener("click", () => { if (state.slug) doReset(state.slug); });
    $("#fab").addEventListener("click", () => $("#scroll").scrollTo({ top: 0, behavior: "smooth" }));
    $("#menuBtn").addEventListener("click", () => {
      document.body.classList.contains("nav-open") ? closeMobileNav() : openMobileNav();
    });
    const navClose = $("#navCloseBtn");
    if (navClose) navClose.addEventListener("click", closeMobileNav);
    const navBackdrop = $("#navBackdrop");
    if (navBackdrop) navBackdrop.addEventListener("click", closeMobileNav);
    // 抽屉里选中一篇后自动收起，手机上不用再点一次
    $("#nav").addEventListener("click", (e) => {
      if (e.target.closest("a[href^='#/']")) closeMobileNav();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("nav-open")) closeMobileNav();
    });
    // 转成桌面宽度时清掉抽屉状态，免得回来时残留在打开态
    if (window.matchMedia) {
      const mq = window.matchMedia("(min-width: 861px)");
      const sync = () => { if (mq.matches) closeMobileNav(); };
      mq.addEventListener ? mq.addEventListener("change", sync) : mq.addListener(sync);
    }

    if (!C.docs || !Object.keys(C.docs).length) {
      $("#content").innerHTML =
        '<div class="empty-state"><div class="emoji">⚙️</div><h2>内容尚未生成</h2>' +
        "<p>请在项目根目录运行 <code>python docs/yondata-kb/tools/build_kb.py</code> 生成 content.js。</p></div>";
      return;
    }

    window.addEventListener("hashchange", route);
    route();

    const aiCtx = {
        content: () => $("#content"),
        docText: (slug) => docText(slug),
        getSlug: () => state.slug,
        toast: (m) => toast(m),
        applyText: (slug, next) => {
          try {
            // 改回与源文件完全一致时不留本地副本，免得侧栏一直挂着「有本地修改」
            if (C.docs[slug] && next === C.docs[slug].body) KBStore.clearEdit(slug);
            else KBStore.setEdit(slug, next);
          } catch (e) {
            toast("保存失败：本地存储可能已满");
            return;
          }
          if (state.slug === slug) openDoc(slug);
          else renderSidebar();
          // 提示条由 openDoc 按「当前是否有本地版本」刷新；清掉编辑副本后要主动收起来
          if (C.docs[slug] && docText(slug) === C.docs[slug].body) {
            const banner = $("#editBanner");
            if (banner) banner.style.display = "none";
          }
        },
    };
    if (window.KBAI) window.KBAI.init(aiCtx);
    if (window.KBAgent) window.KBAgent.init(aiCtx);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
