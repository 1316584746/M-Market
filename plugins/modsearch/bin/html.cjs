"use strict";
/**
 * 本地抓取用的 HTML → 文本 / 链接。移植自 liustack/modsearch（MIT）的 providers/http/htmlExtract.ts。
 * 不用 LLM、不开浏览器。用扫描而不是正则去掉标记（嵌套量词的正则在畸形的 2 MB 页面上会卡死），
 * 实体解码要安全，只取绝对链接。
 */
const MAX_LINKS = 20;

/** 只转 ASCII 大小写：Unicode 的 toLowerCase 可能改变长度（İ 会变两个字符），下标会错位 */
const asciiLower = s => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));

/** 下一个真正的 `<tag`，不是属性值里的文字 */
function findTagStart(haystack, tag, from) {
  const open = `<${tag}`;
  let i = from;
  let inTag = false;
  let quote = "";
  while (i < haystack.length) {
    const ch = haystack[i];
    if (quote) {
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (inTag) {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") inTag = false;
      i++;
      continue;
    }
    if (ch === "<") {
      if (haystack.startsWith(open, i)) {
        const b = haystack[i + open.length];
        if (b === undefined || /[\s/>]/.test(b)) return i;
      }
      inTag = true;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/** 去掉 `<tag>...</tag>`，用扫描实现 */
function stripElement(html, tag) {
  const close = `</${tag}>`;
  const haystack = asciiLower(html);
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = findTagStart(haystack, tag, cursor);
    if (start === -1) return out + html.slice(cursor);
    out += `${html.slice(cursor, start)} `;
    const end = haystack.indexOf(close, start);
    if (end === -1) return out;
    cursor = end + close.length;
  }
}

function stripComments(html) {
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = html.indexOf("<!--", cursor);
    if (start === -1) return out + html.slice(cursor);
    out += `${html.slice(cursor, start)} `;
    const end = html.indexOf("-->", start + 4);
    if (end === -1) return out;
    cursor = end + 3;
  }
}

const safeFromCodePoint = cp => {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return null;
  if (cp >= 0xd800 && cp <= 0xdfff) return null;
  return String.fromCodePoint(cp);
};

function decodeHtmlEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return safeFromCodePoint(Number.parseInt(lower.slice(2), 16)) ?? full;
    if (lower.startsWith("#")) return safeFromCodePoint(Number.parseInt(lower.slice(1), 10)) ?? full;
    return named[lower] ?? full;
  });
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  return normalizeWhitespace(decodeHtmlEntities(m[1])) || null;
}

function extractVisibleTextFromHtml(html) {
  const title = extractTitle(html);
  let s = html;
  for (const tag of ["head", "script", "style", "noscript", "template"]) s = stripElement(s, tag);
  s = stripComments(s);
  const withBreaks = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|td|th|ul)>/gi, "\n");
  const text = normalizeWhitespace(decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " ")));
  return { title, text };
}

/** 页面里的绝对外链，去重，按文档顺序 */
function extractLinks(html, baseUrl) {
  const links = [];
  // 文档自己的 <base href> 决定相对链接指向哪，而不是我们落到的 URL
  const baseTag = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html);
  let base = baseUrl;
  if (baseTag) {
    try {
      base = new URL(decodeHtmlEntities(baseTag[1] ?? baseTag[2] ?? baseTag[3] ?? ""), baseUrl).toString();
    } catch {
      /* 保持响应 URL */
    }
  }
  const seen = new Set();
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchor.exec(html)) !== null && links.length < MAX_LINKS) {
    const href = decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "");
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs) || seen.has(abs)) continue;
    const text = normalizeWhitespace(decodeHtmlEntities((m[4] ?? "").replace(/<[^>]+>/g, " "))).trim().slice(0, 100);
    if (!text) continue;
    seen.add(abs);
    links.push({ text, url: abs });
  }
  return links;
}

module.exports = { extractVisibleTextFromHtml, extractLinks, normalizeWhitespace };
