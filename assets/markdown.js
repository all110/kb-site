/* YonData 面试知识库 - Markdown 渲染器
 * 只支持本项目实际使用的语法；不支持的结构一律转义为文本。
 *
 * 偏移标注：每个块级元素带 data-src="起,止"，指向源 Markdown 的字符区间。
 * 这是内置 AI 改写能「框选 → 精确替换」的基础，改动时不要省掉。
 */
(function () {
  "use strict";

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  const KEYWORDS = {
    java: new Set(("abstract assert boolean break byte case catch char class const continue default do double else enum " +
      "extends final finally float for goto if implements import instanceof int interface long native new package private " +
      "protected public return short static strictfp super switch synchronized this throw throws transient try void " +
      "volatile while var record yield true false null").split(" ")),
    bash: new Set(("cd ls grep find cat echo mkdir rm cp mv git mvn java python pip npm node curl sed awk head tail " +
      "export source set if then else fi for do done while").split(" ")),
  };

  // ---------- 行内 ----------
  function inline(text, opts) {
    let s = escapeHtml(text);
    const codes = [];
    // 1) 保护行内代码
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    // 2) 图片（先于链接，否则 ![alt](url) 会被链接规则截胡）
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) =>
      `<img class="inline-img" src="${src}" alt="${alt}" loading="lazy">`);
    // 3) 加粗
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 4) 链接
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const r = resolveLink(href, opts);
      const attrs = r.external ? ' target="_blank" rel="noopener"' : "";
      const cls = r.broken ? ' class="broken"' : r.local ? ' class="local-plane"' : "";
      const flag = r.broken ? ' data-broken="1"' : r.local ? ' data-local="1"' : "";
      return `<a href="${escapeHtml(r.href)}"${attrs}${cls}${flag}>${label}</a>`;
    });
    // 5) 还原代码
    s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => "<code>" + codes[+i] + "</code>");
    return s;
  }

  function resolveLink(href, opts) {
    const raw = href.trim();
    if (/^javascript:/i.test(raw)) return { href: "#", external: false, broken: false, blocked: true };
    if (/^(https?:)?\/\//i.test(raw)) return { href: raw, external: true };
    if (/^mailto:/i.test(raw)) return { href: raw, external: true };
    if (raw.startsWith("#")) return { href: raw, external: false };
    const m = raw.match(/^([^#?]+)\.md(#.*)?$/);
    // 站内文档按 slug 路由：同目录的 `xxx.md` 与跨目录的 `../proj/xxx.md`
    // 都取文件名部分去 content.js 里找（slug 全站唯一，构建时已校验不重名）。
    if (m) {
      const base = m[1].split("/").pop();
      let slug;
      try { slug = decodeURIComponent(base); } catch { slug = base; }
      const exists = !!(window.KB_CONTENT && window.KB_CONTENT.docs[slug]);
      if (exists) {
        return { href: "#/doc/" + encodeURIComponent(slug) + (m[2] || ""), external: false };
      }
      // 同目录但没有对应文档 → 断链；跨目录 → 不在知识库里，按本地文件处理
      if (m[1].indexOf("/") < 0) return { href: raw, external: false, broken: true };
      return { href: raw, external: false, local: true };
    }
    // 非 .md 的相对路径（如 ../yondata-kb/site/index.html）：站内无法路由，
    // 标成 local，点击时提示在文件系统里打开，而不是跳去 404。
    return { href: raw, external: false, local: true };
  }

  // ---------- 代码高亮（极简） ----------
  function highlight(escaped, lang) {
    if (lang === "json") {
      return escaped
        .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
        .replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="tok-str">$2</span>')
        .replace(/\b(true|false|null)\b/g, '<span class="tok-kw">$1</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
    }
    if (lang === "java" || lang === "bash" || lang === "js" || lang === "javascript") {
      let out = escaped;
      // 字符串
      out = out.replace(/(&quot;[^&]*?&quot;)/g, '<span class="tok-str">$1</span>');
      // 注释（在已包裹的 span 之外，用简化规则）
      out = out.replace(/(^|[\s;{}()])(\/\/[^<\n]*)/g, '$1<span class="tok-cmt">$2</span>');
      // 关键字
      const kw = KEYWORDS[lang === "bash" ? "bash" : "java"];
      out = out.replace(/\b([A-Za-z_$][\w$]*)\b/g, (m, w) =>
        kw.has(w) ? '<span class="tok-kw">' + w + "</span>" : m);
      return out;
    }
    return escaped;
  }

  function renderCode(code, lang, srcRange) {
    const body = highlight(escapeHtml(code), lang);
    return `<pre class="code" ${srcRange ? `data-src="${srcRange}"` : ""} data-lang="${escapeHtml(lang || "text")}">` +
      `<button class="copy" data-copy type="button" aria-label="复制代码">复制</button>` +
      `<code>${body}</code></pre>`;
  }

  // ---------- 表格 ----------
  // 返回每个单元格的可见文本及其在「行内」的起止位置，用来给 <td> 标 data-src。
  function splitRow(line) {
    const cells = [];
    let cur = "";
    let start = 0;
    let inCode = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "`") { inCode = !inCode; cur += ch; continue; }
      if (ch === "|" && !inCode) { cells.push({ raw: cur, start }); cur = ""; start = i + 1; continue; }
      cur += ch;
    }
    cells.push({ raw: cur, start });
    if (cells.length && !cells[0].raw.trim()) cells.shift();
    if (cells.length && !cells[cells.length - 1].raw.trim()) cells.pop();
    return cells.map((c) => {
      const lead = c.raw.length - c.raw.replace(/^\s+/, "").length;
      const text = c.raw.trim();
      return { text, start: c.start + lead, end: c.start + lead + text.length };
    });
  }

  const isNum = (s) => /^[\d.,%\s]+$/.test(s.replace(/[`*]/g, "")) && /\d/.test(s);

  function renderTable(rows, opts, lineIdx, lineStart) {
    if (rows.length < 2) return "<p>" + escapeHtml(rows.join(" ")) + "</p>";
    const head = splitRow(rows[0]);
    const cellAttr = (rowNo, k) => {
      if (opts.noSrc) return "";
      const c = splitRow(rows[rowNo])[k];
      if (!c) return "";
      const base = lineStart[lineIdx[rowNo]];
      return ` data-src="${base + c.start},${base + c.end}"`;
    };
    const th = head.map((c, k) => `<th${cellAttr(0, k)}>${inline(c.text, opts)}</th>`).join("");
    const tb = rows.slice(2).map((_, n) => {
      const r = splitRow(rows[n + 2]);
      const tds = head.map((_, k) => {
        const v = r[k] ? r[k].text : "";
        return `<td${isNum(v) ? ' class="num"' : ""}${cellAttr(n + 2, k)}>${inline(v, opts)}</td>`;
      }).join("");
      return `<tr${opts.noSrc ? "" : ` data-src="${lineStart[lineIdx[n + 2]]},${lineStart[lineIdx[n + 2]] + rows[n + 2].length}"`}>${tds}</tr>`;
    }).join("");
    const wrapSrc = opts.noSrc ? "" :
      ` data-src="${lineStart[lineIdx[0]]},${lineStart[lineIdx[rows.length - 1]] + rows[rows.length - 1].length}"`;
    return `<div class="table-wrap"${wrapSrc}><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
  }

  // ---------- 列表 ----------
  function renderList(lines, start, opts, lineStart) {
    const first = lines[start];
    const ordered = /^\s*\d+\.\s+/.test(first);
    const items = [];
    let i = start;
    const indent = (lines[start].match(/^\s*/) || [""])[0].length;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
      if (!m || (line.match(/^\s*/) || [""])[0].length !== indent) break;
      const itemLine = i;
      let content = m[2];
      let task = null;
      const tm = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (tm) { task = tm[1].toLowerCase() === "x"; content = tm[2]; }
      i++;
      // 合并续行（缩进更深的非列表行）
      while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
             (lines[i].match(/^\s*/) || [""])[0].length > indent) {
        content += " " + lines[i].trim();
        i++;
      }
      items.push({ content, task, from: itemLine, to: i - 1 });
    }
    const tag = ordered ? "ol" : "ul";
    const html = items.map((it) => {
      const attr = opts.noSrc ? "" :
        ` data-src="${lineStart[it.from]},${lineStart[it.to] + lines[it.to].length}"`;
      if (it.task === null) return `<li${attr}>${inline(it.content, opts)}</li>`;
      return `<li class="task"${attr}><input type="checkbox" disabled${it.task ? " checked" : ""}>` +
             `<span>${inline(it.content, opts)}</span></li>`;
    }).join("");
    return { html: `<${tag}>${html}</${tag}>`, next: i };
  }

  // ---------- 锚点 ----------
  function slugify(text, used) {
    let base = text
      .replace(/`|\*\*|\[|\]|\(|\)/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\w一-龥-]/g, "");
    if (!base) base = "sec";
    let id = base, n = 2;
    while (used.has(id)) { id = base + "-" + n++; }
    used.add(id);
    return id;
  }

  const isBlockStart = (line) =>
    /^```/.test(line) || /^#{1,6}\s/.test(line) || /^\s*\|/.test(line) ||
    /^\s*>\s?/.test(line) || /^\s*([-*]|\d+\.)\s+/.test(line) || /^\s*(---|\*\*\*)\s*$/.test(line) ||
    /^!\[[^\]]*\]\([^)\s]+\)\s*$/.test(line);

  // ---------- 主函数 ----------
  function render(md, opts) {
    opts = opts || {};
    const base = opts.base || 0;
    const noSrc = !!opts.noSrc;
    const lines = String(md).replace(/\r\n?/g, "\n").split("\n");

    // 每行在整篇源文中的起始字符偏移
    const lineStart = [];
    let p = base;
    for (const l of lines) { lineStart.push(p); p += l.length + 1; }

    const out = [];
    const headings = [];
    const mermaidBlocks = [];
    const used = new Set();
    let i = 0;

    const srcOf = (from, to) => noSrc ? "" :
      ` data-src="${lineStart[from]},${lineStart[to] + lines[to].length}"`;

    while (i < lines.length) {
      const line = lines[i];

      if (/^```/.test(line)) {
        const lang = line.slice(3).trim().toLowerCase();
        const fenceFrom = i;
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        const fenceTo = Math.min(i, lines.length - 1);
        i++;
        if (lang === "mermaid") {
          mermaidBlocks.push(buf.join("\n"));
          out.push(`<div class="mmd" data-idx="${mermaidBlocks.length - 1}"${srcOf(fenceFrom, fenceTo)}>` +
            `<div class="mmd-loading">图形加载中…</div></div>`);
        } else {
          out.push(renderCode(buf.join("\n"), lang, noSrc ? "" : `${lineStart[fenceFrom]},${lineStart[fenceTo] + lines[fenceTo].length}`));
        }
        continue;
      }

      // 独占一行的图片 → figure
      const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
      if (img) {
        out.push(`<figure class="img"${srcOf(i, i)}>` +
          `<img src="${escapeHtml(img[2])}" alt="${escapeHtml(img[1])}" loading="lazy">` +
          (img[1] ? `<figcaption>${inline(img[1], opts)}</figcaption>` : "") +
          `</figure>`);
        i++;
        continue;
      }

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        const rawText = h[2].trim();
        const id = slugify(rawText, used);
        headings.push({ level, id, text: rawText.replace(/`/g, "") });
        out.push(`<h${level} id="${id}"${srcOf(i, i)}>${inline(rawText, opts)}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*\|/.test(line)) {
        const rows = [];
        const idx = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); idx.push(i); i++; }
        out.push(renderTable(rows, opts, idx, lineStart));
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const from = i;
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        // 引用内部不标 data-src：整段作为一个块，避免行内偏移错位
        const inner = render(buf.join("\n"), Object.assign({}, opts, { noSrc: true })).html;
        out.push(`<blockquote${srcOf(from, i - 1)}>${inner}</blockquote>`);
        continue;
      }

      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const r = renderList(lines, i, opts, lineStart);
        out.push(r.html);
        i = r.next;
        continue;
      }

      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (!line.trim()) { i++; continue; }

      const from = i;
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
      if (buf.length) out.push(`<p${srcOf(from, i - 1)}>${inline(buf.join(" "), opts)}</p>`);
    }

    return { html: out.join("\n"), headings, mermaid: mermaidBlocks };
  }

  /* ============================================================
     可见文本 → 源偏移的映射
     渲染后的 DOM 文本去掉了 **、`、[t](u) 这些标记，要把它还原成
     源 Markdown 的字符位置，才能把「选中的一句话」精确替换回去。
     ============================================================ */
  const SEPARATOR_ROW = /^\s*\|?[\s:|-]+\|?\s*$/;

  function visibleMap(src) {
    let text = "";
    const map = [];
    const push = (ch, at) => { text += ch; map.push(at); };
    let i = 0;
    let atLineStart = true;

    while (i < src.length) {
      if (atLineStart) {
        atLineStart = false;
        // 跳过块级前缀：缩进、引用符、列表符、标题符
        const m = src.slice(i).match(/^(?:[ \t]*(?:>\s?)*[ \t]*(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+)?)/);
        if (m && m[0].length) i += m[0].length;
        if (i >= src.length) break;
      }
      const ch = src[i];

      if (ch === "\n") {
        // 表格分隔行整行丢弃
        const lineEnd = src.indexOf("\n", i);
        const lineTxt = src.slice(i + 1, lineEnd < 0 ? src.length : lineEnd);
        if (SEPARATOR_ROW.test(lineTxt) && lineTxt.indexOf("|") >= 0) { i = lineEnd < 0 ? src.length : lineEnd + 1; continue; }
        push(" ", i);
        i++;
        atLineStart = true;
        continue;
      }

      if (ch === "\\" && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!|>]/.test(src[i + 1])) {
        push(src[i + 1], i + 1);
        i += 2;
        continue;
      }

      // 图片：只取 alt 参与可见文本
      if (ch === "!" && src[i + 1] === "[") {
        const close = src.indexOf("](", i + 2);
        const altEnd = close < 0 ? src.indexOf("]", i + 2) : close;
        if (altEnd > 0) {
          for (let k = i + 2; k < altEnd; k++) push(src[k], k);
          const paren = src.indexOf(")", altEnd);
          i = paren < 0 ? altEnd + 1 : paren + 1;
          continue;
        }
      }

      // 链接：标签可见，目标不可见
      if (ch === "[") {
        const close = src.indexOf("](", i + 1);
        if (close > 0) {
          for (let k = i + 1; k < close; k++) push(src[k], k);
          const paren = src.indexOf(")", close);
          i = paren < 0 ? close + 1 : paren + 1;
          continue;
        }
      }

      // 行内代码的反引号不可见
      if (ch === "`") { i++; continue; }
      // 加粗标记不可见
      if (ch === "*" && src[i + 1] === "*") { i += 2; continue; }
      // 表格竖线不可见，用空格占位以便与 DOM 文本对齐
      if (ch === "|") { push(" ", i); i++; continue; }

      push(ch, i);
      i++;
    }
    return { text, map };
  }

  window.KBMarkdown = { render, escapeHtml, resolveLink, visibleMap };
})();
