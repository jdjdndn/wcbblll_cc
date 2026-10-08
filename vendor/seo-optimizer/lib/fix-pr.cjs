/*
 * lib/fix-pr.cjs —— 修复 diff 草稿生成（不自动提交，仅供人工审核）
 *
 * 对确定性高的常见问题（missing-title/description/viewport/alt）生成 unified diff，
 * 展示在看板供复制应用。不自动提交、不修改原文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function generateDiff(original, modified, fileName) {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  let diff = `--- a/${fileName}\n+++ b/${fileName}\n`;
  let start = 0;
  while (start < origLines.length && start < modLines.length && origLines[start] === modLines[start]) start++;
  let endOrig = origLines.length - 1, endMod = modLines.length - 1;
  while (endOrig > start && endMod > start && origLines[endOrig] === modLines[endMod]) { endOrig--; endMod--; }
  diff += `@@ -${start + 1},${endOrig - start + 1} +${start + 1},${endMod - start + 1} @@\n`;
  for (let i = start; i <= endOrig; i++) diff += `-${origLines[i] || ''}\n`;
  for (let i = start; i <= endMod; i++) diff += `+${modLines[i] || ''}\n`;
  return diff;
}

function fixTitle(html, title) {
  if (/<title[^>]*>/i.test(html)) return null;
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    <title>${title || '页面标题'}</title>`);
}
function fixDescription(html, desc) {
  if (/<meta[^>]+name=["']description["']/i.test(html)) return null;
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    <meta name="description" content="${desc || '页面描述'}">`);
}
function fixViewport(html) {
  if (/<meta[^>]+name=["']viewport["']/i.test(html)) return null;
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    <meta name="viewport" content="width=device-width, initial-scale=1">`);
}
function fixAlt(html) {
  let changed = false;
  const result = html.replace(/<img\b([^>]*?)>/gi, (match, attrs) => {
    if (/\balt=/i.test(attrs)) return match;
    changed = true;
    return `<img${attrs} alt="">`;
  });
  return changed ? result : null;
}
function fixBlockingScript(html) {
  let changed = false;
  const result = html.replace(/<script\b([^>]*\bsrc=["'][^"']+["'][^>]*)>/gi, (match, attrs) => {
    if (/\b(defer|async)\b/i.test(attrs) || /type=["']application\/ld\+json["']/i.test(attrs)) return match;
    changed = true;
    return `<script${attrs} defer>`;
  });
  return changed ? result : null;
}
function fixImageLazyLoad(html) {
  let changed = false;
  const result = html.replace(/<img\b([^>]*?)>/gi, (match, attrs) => {
    if (/\bloading=/i.test(attrs)) return match;
    changed = true;
    return `<img${attrs} loading="lazy">`;
  });
  return changed ? result : null;
}
function fixBadViewport(html) {
  const m = html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i);
  if (!m) return null;
  const correct = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  return html.replace(m[0], correct);
}
function fixMissingOg(html) {
  if (/<meta[^>]+property=["']og:title["']/i.test(html)) return null;
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '页面标题';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  const og = `<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:type" content="website">`;
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    ${og}`);
}
function fixTwitterCard(html) {
  if (/<meta[^>]+name=["']twitter:card["']/i.test(html)) return null;
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '页面标题';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  const tc = `<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${desc}">`;
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    ${tc}`);
}
function fixCanonical(html, correctUrl) {
  const m = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  if (!m) return null;
  const url = correctUrl || '';
  if (!url) return null;
  return html.replace(m[0], `<link rel="canonical" href="${url}">`);
}
function fixHeading(html) {
  const headings = [...html.matchAll(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi)];
  if (headings.length < 2) return null;
  let changed = false;
  let result = html;
  let prevLevel = 0;
  for (const h of headings) {
    const level = parseInt(h[1], 10);
    if (prevLevel > 0 && level > prevLevel + 1) {
      const newLevel = prevLevel + 1;
      const oldTag = `<h${level}${h[2]}>${h[3]}</h${level}>`;
      const newTag = `<h${newLevel}${h[2]}>${h[3]}</h${newLevel}>`;
      result = result.replace(oldTag, newTag);
      changed = true;
    }
    prevLevel = level;
  }
  return changed ? result : null;
}
function fixJsonLd(html) {
  let changed = false;
  const result = html.replace(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (match, content) => {
    try { JSON.parse(content); return match; } catch (e) {}
    let fixed = content.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":').replace(/'/g, '"');
    try { JSON.parse(fixed); changed = true; return match.replace(content, fixed); } catch (e2) { return match; }
  });
  return changed ? result : null;
}
function fixFavicon(html) {
  if (/<link[^>]+rel=["'](?:icon|shortcut icon)["']/i.test(html)) return null;
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    <link rel="icon" href="/favicon.ico">`);
}
function fixNoscript(html) {
  if (/<noscript\b/i.test(html)) return null;
  if (!/<script\b/i.test(html)) return null;
  return html.replace(/<body([^>]*)>/i, `<body$1>\n  <noscript><p>本页面需要 JavaScript，请启用后查看。</p></noscript>`);
}
function fixSkipLink(html) {
  if (/<a\b[^>]*href=["']#(?:main|content)["']/i.test(html.slice(0, 2000))) return null;
  if (!/<main\b/i.test(html) && !/id=["'](?:main|content)["']/i.test(html)) return null;
  return html.replace(/<body([^>]*)>/i, `<body$1>\n  <a href="#main" class="skip-link">跳到主内容</a>`);
}
function fixImageDimensions(html) {
  let changed = false;
  const result = html.replace(/<img\b([^>]*?)>/gi, (match, attrs) => {
    if (/\bwidth\s*=/.test(attrs) && /\bheight\s*=/.test(attrs)) return match;
    changed = true;
    let fixed = attrs;
    if (!/\bwidth\s*=/.test(fixed)) fixed += ' width="100"';
    if (!/\bheight\s*=/.test(fixed)) fixed += ' height="100"';
    return `<img${fixed}>`;
  });
  return changed ? result : null;
}
function fixMixedContent(html) {
  if (!/https?:\/\//i.test(html)) return null;
  let changed = false;
  const result = html.replace(/\b(src|href)=["'](http:\/\/(?!localhost|127\.0\.0\.1)[^"']+)["']/gi, (m, attr, url) => {
    changed = true;
    return `${attr}="https://${url.slice(7)}`;
  });
  return changed ? result : null;
}
function fixExternalRel(html) {
  let changed = false;
  const result = html.replace(/<a\b([^>]*?)>/gi, (match, attrs) => {
    const href = (attrs.match(/href=["']([^"']+)["']/i) || [])[1] || '';
    if (!/^https?:\/\//i.test(href)) return match;
    if (/\brel\s*=/i.test(attrs)) {
      const rel = (attrs.match(/rel=["']([^"']*)["']/i) || [])[1] || '';
      if (rel.toLowerCase().includes('noopener') && rel.toLowerCase().includes('noreferrer')) return match;
      changed = true;
      const newRel = [...new Set([...rel.split(/\s+/), 'noopener', 'noreferrer'].filter(Boolean))].join(' ');
      return match.replace(/rel=["']([^"']*)["']/i, `rel="${newRel}"`);
    }
    changed = true;
    return `<a${attrs} rel="noopener noreferrer">`;
  });
  return changed ? result : null;
}
function fixFormLabel(html) {
  let changed = false;
  const labels = new Set([...html.matchAll(/<label\b[^>]*for=["']([^"']+)["']/gi)].map((m) => m[1]));
  let idx = 0;
  const result = html.replace(/<input\b([^>]*?)>/gi, (match, attrs) => {
    if (/type=["'](?:hidden|submit|button|reset)["']/i.test(attrs)) return match;
    const id = (attrs.match(/id=["']([^"']+)["']/i) || [])[1];
    if (id && labels.has(id)) return match;
    if (/\baria-label\s*=/.test(attrs) || /\baria-labelledby\s*=/.test(attrs)) return match;
    changed = true;
    const newId = id || `auto-input-${++idx}`;
    const label = `<label for="${newId}" class="sr-only">输入</label>`;
    const fixedAttrs = id ? attrs : attrs + ` id="${newId}"`;
    return label + `<input${fixedAttrs}>`;
  });
  return changed ? result : null;
}
function fixTableHeader(html) {
  let changed = false;
  const result = html.replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi, (match, open, inner) => {
    if (/<thead\b/i.test(inner) || /<th\b/i.test(inner)) return match;
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[0]);
    if (!rows.length) return match;
    changed = true;
    const firstRow = rows[0].replace(/<td\b/g, '<th').replace(/<\/td>/g, '</th>');
    return `<table${open}><thead>${firstRow}</thead>${rows.slice(1).join('')}</table>`;
  });
  return changed ? result : null;
}
function fixFontDisplay(html) {
  let changed = false;
  const result = html.replace(/@font-face\s*\{([^}]*)\}/gi, (match, body) => {
    if (/font-display\s*:/i.test(body)) return match;
    changed = true;
    return match.replace(/\}/, `\n  font-display: swap;\n}`);
  });
  return changed ? result : null;
}
function fixManifest(html) {
  if (/<link[^>]+rel=["']manifest["']/i.test(html)) return null;
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    <link rel="manifest" href="/manifest.json">`);
}
function fixVideoSubtitle(html) {
  let changed = false;
  const result = html.replace(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi, (match, attrs, inner) => {
    if (/<track\b/i.test(inner)) return match;
    changed = true;
    return `<video${attrs}>${inner}<track kind="captions" src="subtitle.vtt" srclang="zh"></video>`;
  });
  return changed ? result : null;
}
function fixMetaRefresh(html) {
  if (!/<meta[^>]+http-equiv=["']refresh["']/i.test(html)) return null;
  return html.replace(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/gi, '');
}
function fixSingleH1(html) {
  const h1s = [...html.matchAll(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi)];
  if (h1s.length <= 1) return null;
  let changed = false;
  let result = html;
  for (let i = 1; i < h1s.length; i++) {
    const attrs = h1s[i][1] || '';
    const content = h1s[i][2] || '';
    const oldTag = `<h1${attrs}>${content}</h1>`;
    const newTag = `<h2${attrs}>${content}</h2>`;
    result = result.replace(oldTag, newTag);
    changed = true;
  }
  return changed ? result : null;
}
function fixDescriptiveLink(html) {
  const BAD = /^(点击这里|点击查看|更多|查看更多|详情|click here|read more|more|here|详情请点击)$/i;
  let changed = false;
  const result = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!text || !BAD.test(text)) return match;
    const href = (attrs.match(/href=["']([^"']+)["']/i) || [])[1] || '';
    const desc = href ? href.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/[-_]/g, ' ').replace(/\.\w+$/, '').trim() : '';
    const newText = desc || '查看详情';
    changed = true;
    return `<a${attrs}>${newText}</a>`;
  });
  return changed ? result : null;
}
function fixCrawlableAnchors(html) {
  let changed = false;
  const result = html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    const href = (attrs.match(/href=["']([^"']*)["']/i) || [])[1];
    if (href === undefined) return match;
    if (/javascript:/i.test(href) || href.trim() === '') {
      changed = true;
      return match.replace(/href=["']([^"']*)["']/i, 'href="#"');
    }
    return match;
  });
  return changed ? result : null;
}
function fixEmptyHeading(html) {
  let changed = false;
  const result = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, level, attrs, content) => {
    if (content.replace(/<[^>]+>/g, '').trim() !== '') return match;
    changed = true;
    return `<h${level}${attrs}>标题</h${level}>`;
  });
  return changed ? result : null;
}
function fixButtonName(html) {
  let changed = false;
  const result = html.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, (match, attrs, content) => {
    const text = content.replace(/<[^>]+>/g, '').trim();
    if (text) return match;
    if (/\baria-label\s*=/.test(attrs) || /\btitle\s*=/.test(attrs)) return match;
    changed = true;
    return `<button${attrs} aria-label="按钮">${content}</button>`;
  });
  return changed ? result : null;
}
function fixTapTarget(html) {
  let changed = false;
  const result = html.replace(/<(a|button|input|select|textarea)\b([^>]*)>/gi, (match, tag, attrs) => {
    const w = parseInt((attrs.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || '0', 10);
    const h = parseInt((attrs.match(/\bheight\s*=\s*["']?(\d+)/i) || [])[1] || '0', 10);
    const styleW = parseInt((attrs.match(/min-width\s*:\s*(\d+)/i) || [])[1] || '0', 10);
    const styleH = parseInt((attrs.match(/min-height\s*:\s*(\d+)/i) || [])[1] || '0', 10);
    const effW = Math.max(w, styleW), effH = Math.max(h, styleH);
    if (effW >= 48 && effH >= 48) return match;
    if (effW === 0 && effH === 0) return match;
    changed = true;
    const style = 'min-width:48px;min-height:48px';
    if (/\bstyle\s*=/.test(attrs)) {
      return match.replace(/style=["']([^"']*)["']/i, (m, s) => `style="${s};${style}"`);
    }
    return `<${tag}${attrs} style="${style}">`;
  });
  return changed ? result : null;
}
function fixViewportScalable(html) {
  let changed = false;
  const result = html.replace(/<meta[^>]+name=["']viewport["'][^>]*>/i, (match) => {
    if (!/user-scalable\s*=\s*["']?no/i.test(match) && !/maximum-scale\s*=\s*["']?1(\D|$)/i.test(match)) return match;
    changed = true;
    let fixed = match.replace(/,\s*user-scalable\s*=\s*["']?no["']?/gi, '').replace(/user-scalable\s*=\s*["']?no["']?\s*,?\s*/gi, '');
    fixed = fixed.replace(/,\s*maximum-scale\s*=\s*["']?1\.?0?["']?/gi, '').replace(/maximum-scale\s*=\s*["']?1\.?0?["']?\s*,?\s*/gi, '');
    return fixed;
  });
  return changed ? result : null;
}
function fixValidLang(html) {
  const m = html.match(/<html\b([^>]*\blang=["']([^"']+)["'][^>]*)>/i);
  if (!m) return null;
  const lang = m[2];
  const VALID = new Set(['en','zh','ja','ko','fr','de','es','ru','ar','pt','it','nl','pl','tr','vi','th','id','ms','hi','bn','fa','he','cs','sv','da','no','fi','el','uk','ro','hu']);
  if (VALID.has(lang.toLowerCase().split('-')[0])) return null;
  return html.replace(m[0], m[0].replace(/lang=["']([^"']+)["']/i, 'lang="en"'));
}
function fixTableCaption(html) {
  let changed = false;
  const result = html.replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi, (match, attrs, inner) => {
    if (/<caption\b/i.test(inner)) return match;
    changed = true;
    return `<table${attrs}><caption>表格</caption>${inner}</table>`;
  });
  return changed ? result : null;
}
function fixTabindex(html) {
  let changed = false;
  const result = html.replace(/\btabindex=["']?(\d+)["']?/gi, (match, val) => {
    const n = parseInt(val, 10);
    if (n <= 0) return match;
    changed = true;
    return 'tabindex="0"';
  });
  return changed ? result : null;
}

// fixHtmlDoctype：在 HTML 开头添加 <!DOCTYPE html>
function fixHtmlDoctype(html) {
  if (/^<!doctype\s+html>/i.test(html.trim())) return null;
  return '<!DOCTYPE html>\n' + html;
}

// fixIframeSandbox：给无 sandbox 的 iframe 添加 sandbox 属性
function fixIframeSandbox(html) {
  let changed = false;
  const result = html.replace(/<iframe\b([^>]*)>/gi, (match, attrs) => {
    if (/\bsandbox\s*=/.test(attrs)) return match;
    changed = true;
    return '<iframe' + attrs + ' sandbox="allow-scripts allow-same-origin">';
  });
  return changed ? result : null;
}

// fixViewportScale：给 viewport meta 添加 initial-scale=1
function fixViewportScale(html) {
  let changed = false;
  const result = html.replace(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["']/gi, (match, content) => {
    if (/initial-scale\s*=/.test(content)) return match;
    changed = true;
    return match.replace(content, 'initial-scale=1, ' + content);
  });
  return changed ? result : null;
}

// fixTitleLength：截断/补全 title 到 10-60 字符
function fixTitleLength(html, title) {
  let t = (title || '').trim();
  if (t.length >= 10 && t.length <= 60) return null;
  if (t.length > 60) t = t.slice(0, 57) + '...';
  else if (t.length < 10) t = t.padEnd(10, ' -');
  let changed = false;
  const result = html.replace(/<title>([\s\S]*?)<\/title>/i, () => { changed = true; return '<title>' + t + '</title>'; });
  return changed ? result : null;
}

// fixDescriptionLength：截断/补全 description 到 50-160 字符
function fixDescriptionLength(html, desc) {
  let d = (desc || '').trim();
  if (d.length >= 50 && d.length <= 160) return null;
  if (d.length > 160) d = d.slice(0, 157) + '...';
  else if (d.length < 50) return null;
  let changed = false;
  const result = html.replace(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i, (match, oldContent) => {
    if (oldContent.trim().length < 50) { changed = true; return match.replace(oldContent, d); }
    return match;
  });
  return changed ? result : null;
}

// fixDuplicateId：给重复的 id 追加后缀去重
function fixDuplicateId(html) {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
  const counts = {};
  for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  const dups = Object.keys(counts).filter((id) => counts[id] > 1);
  if (!dups.length) return null;
  let result = html;
  const seen = {};
  for (const dup of dups) {
    result = result.replace(new RegExp('\\bid=["\']' + dup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']', 'gi'), () => {
      seen[dup] = (seen[dup] || 0) + 1;
      if (seen[dup] === 1) return 'id="' + dup + '"';
      return 'id="' + dup + '-' + seen[dup] + '"';
    });
  }
  return result;
}

// fixAriaHiddenFocus：给 aria-hidden 元素添加 tabindex=-1
function fixAriaHiddenFocus(html) {
  let changed = false;
  const result = html.replace(/(<\w+\b[^>]*\baria-hidden=["']true["'][^>]*>)/gi, (match, tag) => {
    if (/\btabindex\s*=/.test(tag)) return match;
    changed = true;
    return tag.replace(/>$/, ' tabindex="-1">');
  });
  return changed ? result : null;
}

// fixAutocompleteValid：修复无效的 autocomplete 属性
function fixAutocompleteValid(html) {
  const validValues = ['on', 'off', 'name', 'email', 'username', 'current-password', 'new-password', 'tel', 'street-address', 'postal-code', 'address-line1', 'address-line2', 'bday', 'cc-number', 'cc-exp', 'cc-csc'];
  let changed = false;
  const result = html.replace(/\bautocomplete=["']([^"']+)["']/gi, (match, val) => {
    if (validValues.includes(val.toLowerCase())) return match;
    changed = true;
    return 'autocomplete="off"';
  });
  return changed ? result : null;
}

// fixNoDocumentWrite：将 document.write() 改为 textContent
function fixNoDocumentWrite(html) {
  let changed = false;
  const result = html.replace(/document\s*\.\s*write\s*\(([^)]*)\)/gi, (match, arg) => {
    changed = true;
    const content = arg.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    return 'document.body.textContent = ' + JSON.stringify(content);
  });
  return changed ? result : null;
}

// fixNoMutationEvents：将 Mutation Events 改为 MutationObserver
function fixNoMutationEvents(html) {
  const meMap = { onDOMSubtreeModified: 'childList: true', onDOMNodeInserted: 'childList: true', onDOMNodeRemoved: 'childList: true', onDOMAttrModified: 'attributes: true', onDOMCharacterDataModified: 'characterData: true' };
  let changed = false;
  let result = html;
  for (const [evt, obs] of Object.entries(meMap)) {
    result = result.replace(new RegExp('\\b' + evt + '\\s*=\\s*["\']([^"\']*)["\']', 'gi'), (match, handler) => {
      changed = true;
      return 'data-mutation-observer="' + handler + '" data-observer-options="' + obs + '"';
    });
  }
  return changed ? result : null;
}

// fixPasswordPaste：移除密码 input 的 onpaste="return false"
function fixPasswordPaste(html) {
  let changed = false;
  const result = html.replace(/(<input\b[^>]*\btype=["']password["'][^>]*)\bonpaste=["']\s*return\s+false["']/gi, (match, before) => {
    changed = true;
    return before;
  });
  return changed ? result : null;
}

// fixNoEmptyTable：移除空 table
function fixNoEmptyTable(html) {
  let changed = false;
  const result = html.replace(/<table\b[^>]*>\s*<\/table>/gi, () => { changed = true; return ''; });
  return changed ? result : null;
}

// fixNoOldFlexbox：将 display:box 改为 display:flex
function fixNoOldFlexbox(html) {
  let changed = false;
  const result = html.replace(/display\s*:\s*box/gi, (match) => { changed = true; return 'display:flex'; });
  return changed ? result : null;
}

// fixImageRedundantAlt：将重复 alt 改为空（装饰性图片）
function fixImageRedundantAlt(html) {
  let changed = false;
  const result = html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (match, inner) => {
    const imgMatch = inner.match(/<img\b([^>]*\balt=["']([^"']*)["'][^>]*)>/i);
    if (!imgMatch) return match;
    const alt = (imgMatch[2] || '').trim();
    if (!alt) return match;
    const linkText = inner.replace(/<[^>]+>/g, '').trim();
    if (linkText && (alt === linkText || linkText.includes(alt) || alt.includes(linkText))) {
      changed = true;
      const newImg = imgMatch[1].replace(/\balt=["']([^"']*)["']/i, 'alt=""');
      return match.replace(imgMatch[0], '<img' + newImg + '>');
    }
    return match;
  });
  return changed ? result : null;
}

const FIXERS = {
  'missing-title': fixTitle,
  'missing-description': fixDescription,
  'missing-viewport': fixViewport,
  'missing-alt': fixAlt,
  'blocking-script': fixBlockingScript,
  'image-lazy-load': fixImageLazyLoad,
  'bad-viewport': fixBadViewport,
  'missing-og': fixMissingOg,
  'twitter-card': fixTwitterCard,
  'canonical-mismatch': fixCanonical,
  'heading-skip': fixHeading,
  'jsonld-invalid': fixJsonLd,
  'missing-favicon': fixFavicon,
  'missing-noscript': fixNoscript,
  'missing-skip-link': fixSkipLink,
  'missing-dimensions': fixImageDimensions,
  'mixed-content': fixMixedContent,
  'external-rel': fixExternalRel,
  'missing-form-label': fixFormLabel,
  'missing-table-header': fixTableHeader,
  'missing-font-display': fixFontDisplay,
  'missing-manifest': fixManifest,
  'video-no-subtitle': fixVideoSubtitle,
  'meta-refresh-present': fixMetaRefresh,
  'h1-not-single': fixSingleH1,
  'link-text-bad': fixDescriptiveLink,
  'anchor-not-crawlable': fixCrawlableAnchors,
  'heading-empty': fixEmptyHeading,
  'button-no-name': fixButtonName,
  'tap-target-small': fixTapTarget,
  'viewport-no-scale': fixViewportScalable,
  'lang-invalid': fixValidLang,
  'table-no-caption': fixTableCaption,
  'tabindex-invalid': fixTabindex,
  'missing-doctype': fixHtmlDoctype,
  'iframe-no-sandbox': fixIframeSandbox,
  'viewport-missing-scale': fixViewportScale,
  'title-length': fixTitleLength,
  'description-length': fixDescriptionLength,
  'duplicate-id': fixDuplicateId,
  'aria-hidden-focus': fixAriaHiddenFocus,
  'autocomplete-invalid': fixAutocompleteValid,
  'document-write': fixNoDocumentWrite,
  'mutation-events': fixNoMutationEvents,
  'password-no-paste': fixPasswordPaste,
  'empty-table': fixNoEmptyTable,
  'old-flexbox': fixNoOldFlexbox,
  'image-redundant-alt': fixImageRedundantAlt,
};

function generateFixDraft(filePath, templateId, args) {
  const fixer = FIXERS[templateId];
  if (!fixer) return { ok: false, note: `不支持自动修复: ${templateId}` };
  if (!fs.existsSync(filePath)) return { ok: false, note: `文件不存在: ${filePath}` };
  const original = fs.readFileSync(filePath, 'utf8');
  const modified = fixer(original, ...(args || []));
  if (modified === null || modified === undefined) return { ok: false, note: '无需修改（已存在或无法修复）' };
  const diff = generateDiff(original, modified, path.basename(filePath));
  return { ok: true, diff, filePath };
}

// applyFix：实际修改文件并写回（generateFixDraft 只生成 diff 不写文件）
function applyFix(filePath, templateId, args) {
  const fixer = FIXERS[templateId];
  if (!fixer) return { ok: false, note: `不支持自动修复: ${templateId}` };
  if (!fs.existsSync(filePath)) return { ok: false, note: `文件不存在: ${filePath}` };
  const original = fs.readFileSync(filePath, 'utf8');
  const modified = fixer(original, ...(args || []));
  if (modified === null || modified === undefined) return { ok: false, note: '无需修改（已存在或无法修复）' };
  fs.writeFileSync(filePath, modified, 'utf8');
  return { ok: true, filePath, diff: generateDiff(original, modified, path.basename(filePath)) };
}

module.exports = { generateFixDraft, applyFix, generateDiff, FIXERS };
