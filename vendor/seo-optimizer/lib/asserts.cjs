/*
 * lib/asserts.cjs —— SEO 断言纯函数库（无文件系统/网络依赖，输入文本输出结果）
 *
 * 设计：与 rebuild-all.cjs 本地校验同一套规则（同源），但把"文本判定"抽成纯函数，
 *       供两条路径复用：
 *         1) 本地 CLI：rebuild-all.cjs --verify-only / --daily（读本地产物文件）
 *         2) 云端 Worker：seo-optimizer 巡检（fetch 线上页面后跑同一断言，持久巡检）
 *       由此保证"本地校验"与"线上巡检"判定口径一致（零漂移）。
 *
 * 每个断言返回 { ok: boolean, detail: string }。
 */
'use strict';

function countOcc(text, pat) {
  if (!text) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(pat, i)) !== -1) { n++; i += pat.length; }
  return n;
}

// HTML 属性提取与标签查找（模块级，供多个断言复用）
function attrMeta(tag, name) { const m = tag.match(new RegExp(name + '=["\']([^"\']*)["\']', 'i')); return m ? m[1].trim() : ''; }
function findTag(html, re) { const m = html.match(re); return m ? m[0] : ''; }

// contains：文本含 pattern 至少 min 次
function checkContains(text, pattern, min) {
  const n = countOcc(text || '', pattern);
  const ok = n >= (min || 1);
  return { ok, detail: `命中 ${n}/${min || 1}` };
}

// not-contains：文本不得含 pattern
function checkNotContains(text, pattern) {
  const n = countOcc(text || '', pattern);
  return n === 0
    ? { ok: true, detail: '未命中' }
    : { ok: false, detail: `异常命中 ${n} 次` };
}

// data-vs-html：数据源条目数 == HTML 渲染节点数（SEO 内容可见性）
// 输入 dataJson（已 parse 的对象）与 html 文本
function checkDataVsHtml(dataJson, html, dataPath, htmlPattern) {
  try {
    const data = dataJson || {};
    const arr = dataPath ? (data[dataPath] || []) : data;
    if (!Array.isArray(arr)) throw new Error('dataPath 指向的不是数组');
    const expect = arr.length;
    const actual = countOcc(html || '', htmlPattern || 'class="link-card"');
    return {
      ok: actual === expect,
      detail: `数据 ${expect} 条 / HTML 渲染 ${actual} 处${actual === expect ? '' : '（不一致：漏渲染或重复渲染）'}`,
    };
  } catch (e) {
    return { ok: false, detail: '数据源解析失败: ' + e.message };
  }
}

// sitemap：XML 合法性 + 域名匹配 + loc→页面可达（files 由调用方提供：本地=文件系统，线上=fetch 结果集）
// 输入 xml 文本、domain、locReachable(loc) => boolean、pageLocations(页面 URL 列表，可空)
function checkSitemap(xml, domain, locReachable, pageLocations) {
  const locs = [...(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter(Boolean);
  const d = (domain || '').replace(/\/+$/, '');
  const wrongHost = [], missing = [], notInSitemap = [];
  if (!locs.length) return { ok: false, detail: 'sitemap 无 <loc>（XML 无效或为空）' };
  const locSet = new Set(locs);
  for (const l of locs) {
    if (d && !l.startsWith(d)) { wrongHost.push(l); continue; }
    if (!locReachable(l)) missing.push(l);
  }
  for (const l of (pageLocations || [])) {
    if (!locSet.has(l)) notInSitemap.push(l);
  }
  const ok = !wrongHost.length && !missing.length && !notInSitemap.length;
  return {
    ok,
    detail: `loc ${locs.length} 个`
      + (wrongHost.length ? `；域名不符 ${wrongHost.length}（${wrongHost.slice(0, 3).join(', ')}）` : '')
      + (missing.length ? `；loc不可达 ${missing.length}（${missing.slice(0, 3).join(', ')}）` : '')
      + (notInSitemap.length ? `；页面未收录 ${notInSitemap.length}（${notInSitemap.slice(0, 3).join(', ')}）` : ''),
  };
}

// page-quality：逐页断言 title/description/canonical/OG/JSON-LD
// pages: [{url, html}]；opts: {canonical, og[], jsonld, titleMax, descMin}
function checkPageQuality(pages, opts) {
  const o = opts || {};
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const t = findTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = t ? t.replace(/<\/?title[^>]*>/gi, '').trim() : '';
    const dmeta = findTag(html, /<meta[^>]+name=["']description["'][^>]*>/i) || findTag(html, /<meta[^>]+content=["'][^"']*["'][^>]*name=["']description["'][^>]*>/i);
    const desc = dmeta ? attrMeta(dmeta, 'content') : '';
    const cano = attrMeta(findTag(html, /<link[^>]+rel=["']canonical["'][^>]*>/i), 'href');
    const bad = [];
    if (!title) bad.push('缺title');
    else if (o.titleMax && title.length > o.titleMax) bad.push(`title超长(${title.length}>${o.titleMax})`);
    if (!desc) bad.push('缺description');
    else if (o.descMin && desc.length < o.descMin) bad.push(`description过短(${desc.length}<${o.descMin})`);
    if (o.canonical && (!cano || !cano.startsWith(o.canonical))) bad.push(`canonical不符(${cano || '无'})`);
    for (const g of (o.og || [])) {
      const ogtag = findTag(html, new RegExp('<meta[^>]+property=["\']' + g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i'));
      if (!ogtag || !attrMeta(ogtag, 'content')) bad.push(`缺${g}`);
    }
    if (o.jsonld) {
      const lds = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      const okLd = lds.some((m) => { try { JSON.parse(m[1]); return true; } catch (e) { return false; } });
      if (!okLd) bad.push('缺合法JSON-LD');
    }
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return {
    ok: !issues.length,
    detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过'),
  };
}

// link-health：站内链接/图片无死链 + alt 齐全（本地文件系统版：resolve(u) 返回 true 表示可达）
// pages: [{name, html}]；resolve(relativePath) => boolean
function checkLinkHealth(pages, resolve) {
  const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?|javascript:|mailto:|data:)/i.test(u);
  const broken = [], noAlt = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const pageBase = pg.base || '';
    const reHref = /<(?:a|link)\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = reHref.exec(html)) !== null) {
      const u = m[1].trim();
      if (!u || isExternal(u)) continue;
      if (!resolve(pageBase + u)) broken.push(`${pg.name}: ${u}`);
    }
    const reImg = /<img\b[^>]*>/gi;
    while ((m = reImg.exec(html)) !== null) {
      const tag = m[0];
      const altM = tag.match(/\balt=["']([^"']*)["']/i);
      if (!altM || altM[1].trim() === '') noAlt.push(pg.name);
      const srcM = tag.match(/\bsrc=["']([^"']+)["']/i);
      if (srcM) {
        const u = srcM[1].trim();
        if (u && !isExternal(u) && !resolve(pageBase + u)) broken.push(`${pg.name} → ${u}`);
      }
    }
  }
  const ok = !broken.length && !noAlt.length;
  return {
    ok,
    detail: `页面 ${pages.length} 个`
      + (broken.length ? `；死链 ${broken.length}（${broken.slice(0, 3).join('; ')}${broken.length > 3 ? '…' : ''}）` : '')
      + (noAlt.length ? `；缺alt ${noAlt.length}（${noAlt.slice(0, 3).join('; ')}…）` : '')
      + (!broken.length && !noAlt.length ? '，链接与图片均正常' : ''),
  };
}

// count-files：目录下匹配文件数 >= min（本地文件系统版；云端用 sitemap 覆盖率替代）
function checkCountFiles(fileNames, ext, min) {
  const n = (fileNames || []).filter((f) => f.endsWith(ext)).length;
  return { ok: n >= (min || 1), detail: `${n} 个文件` };
}

// mobile-friendly：viewport meta 存在且值合理（移动端适配，Google 移动优先索引）
// pages: [{url, html}]
function checkMobileFriendly(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const vp = findTag(html, /<meta[^>]+name=["']viewport["'][^>]*>/i);
    const content = vp ? attrMeta(vp, 'content') : '';
    const bad = [];
    if (!vp) bad.push('缺viewport');
    else if (!content.includes('width=device-width') && !content.includes('initial-scale')) bad.push('viewport不合理');
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return {
    ok: !issues.length,
    detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过'),
  };
}

// security-headers：HTTP 响应头安全检查（CSP/HSTS/X-Content-Type-Options 等）
// headers: { 'content-security-policy': '...', ... }；required: ['content-security-policy', ...]
function checkSecurityHeaders(headers, required) {
  const h = headers || {};
  const reqs = required || ['content-security-policy', 'strict-transport-security', 'x-content-type-options'];
  const present = new Set(Object.keys(h).map((k) => k.toLowerCase()));
  const missing = reqs.filter((k) => !present.has(k.toLowerCase()));
  return {
    ok: !missing.length,
    detail: missing.length ? `缺失 ${missing.length} 个安全头（${missing.join(', ')}）` : `全部 ${reqs.length} 个安全头齐全`,
  };
}

// hreflang：多语言站 link rel=alternate hreflang 检查（国际 SEO）
// pages: [{url, html}]
function checkHreflang(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const alts = [...html.matchAll(/<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["'][^>]*>/gi)];
    const bad = [];
    if (!alts.length) bad.push('缺hreflang');
    else if (!alts.some((m) => m[1] === 'x-default')) bad.push('缺x-default');
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return {
    ok: !issues.length,
    detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过'),
  };
}

// structured-data：JSON-LD 深度校验（@type 合法 + required 属性齐全）
// pages: [{url, html}]
const JSONLD_REQUIRED = {
  Article: ['headline', 'datePublished', 'author', 'image'],
  NewsArticle: ['headline', 'datePublished', 'author', 'image'],
  BlogPosting: ['headline', 'datePublished', 'author', 'image'],
  BreadcrumbList: ['itemListElement'],
  Organization: ['name', 'url', 'logo'],
  WebSite: ['name', 'url'],
  Product: ['name', 'image', 'offers'],
};
function checkStructuredData(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const lds = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    const bad = [];
    if (!lds.length) { bad.push('缺JSON-LD'); }
    else {
      for (const m of lds) {
        try {
          const obj = JSON.parse(m[1]);
          const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']].filter(Boolean);
          for (const t of types) {
            const reqs = JSONLD_REQUIRED[t];
            if (reqs) {
              const missing = reqs.filter((r) => !obj[r]);
              if (missing.length) bad.push(`${t}缺${missing.join('/')}`);
            }
          }
        } catch (e) { bad.push('JSON-LD解析失败'); }
      }
    }
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return {
    ok: !issues.length,
    detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过'),
  };
}

// core-web-vitals：检查影响 LCP/CLS 的已知因素（图片 width/height + 阻塞 script）
// pages: [{url, html}]
function checkCoreWebVitals(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const bad = [];
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
    for (const m of imgs) {
      if (!m[0].match(/\bwidth=["']\d+["']/i) || !m[0].match(/\bheight=["']\d+["']/i)) {
        bad.push('图片缺width/height(CLS)');
        break;
      }
    }
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi)].map((m) => m[0]);
    const blocking = scripts.filter((t) => !t.includes('defer') && !t.includes('async') && !t.includes('type="application/ld+json"'));
    if (blocking.length > 1) bad.push(`${blocking.length}个阻塞script`);
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return {
    ok: !issues.length,
    detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过'),
  };
}

// ========== GEO 断言（生成式引擎优化） ==========

// ai-crawlable：robots.txt 允许 AI 爬虫（GPTBot/CCBot/PerplexityBot/Google-Extended/ClaudeBot）
function checkAiCrawlable(robotsTxt) {
  const bots = ['GPTBot', 'CCBot', 'PerplexityBot', 'Google-Extended', 'ClaudeBot'];
  const text = robotsTxt || '';
  const blocked = [];
  for (const bot of bots) {
    const re = new RegExp('User-agent:\\s*' + bot + '[\\s\\S]*?Disallow:\\s*/\\s', 'i');
    if (re.test(text + '\n')) blocked.push(bot);
  }
  return {
    ok: !blocked.length,
    detail: blocked.length ? `禁止 AI 爬虫 ${blocked.length} 个（${blocked.join(', ')}）` : `AI 爬虫可抓取（检查 ${bots.length} 个）`,
  };
}

// faq-content：FAQ/QA 结构化内容（JSON-LD FAQPage 或 HTML details/Q&A 模式）
function checkFaqContent(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const bad = [];
    const lds = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    const hasFaqJsonld = lds.some((m) => { try { const o = JSON.parse(m[1]); return o['@type'] === 'FAQPage' || (Array.isArray(o['@type']) && o['@type'].includes('FAQPage')); } catch (e) { return false; } });
    const hasDetails = /<details\b/i.test(html);
    const hasQaPattern = /<h[23][^>]*>[^<]*[?？]/i.test(html);
    if (!hasFaqJsonld && !hasDetails && !hasQaPattern) bad.push('缺FAQ/QA内容');
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// semantic-html：语义化 HTML 标签（article/nav/section/main/header/footer/aside）
function checkSemanticHtml(pages) {
  const tags = ['article', 'nav', 'section', 'main', 'header', 'footer'];
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const missing = tags.filter((t) => !new RegExp('<' + t + '\\b', 'i').test(html));
    if (missing.length) issues.push(`${pg.url || pg.name || '?'}: 缺${missing.join('/')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// content-structure：heading 层次正确（H1 唯一 + H2-H6 不跳级）
function checkContentStructure(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const bad = [];
    const h1s = [...html.matchAll(/<h1\b[^>]*>/gi)];
    if (h1s.length === 0) bad.push('缺H1');
    else if (h1s.length > 1) bad.push(`H1不唯一(${h1s.length}个)`);
    const headings = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => parseInt(m[1], 10));
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) { bad.push(`heading跳级(H${headings[i - 1]}→H${headings[i]})`); break; }
    }
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// ai-citations：引用/来源标记（blockquote/cite/外链）
function checkAiCitations(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const bad = [];
    const hasBlockquote = /<blockquote\b/i.test(html);
    const hasCite = /<cite\b/i.test(html);
    const hasExternalLink = /<a\b[^>]*href=["']https?:\/\//i.test(html);
    if (!hasBlockquote && !hasCite && !hasExternalLink) bad.push('缺引用/来源');
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// ========== SEO 增强断言 ==========

// twitter-card：Twitter Card 标签完整
function checkTwitterCard(pages) {
  const required = ['twitter:card', 'twitter:title', 'twitter:description'];
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const missing = required.filter((t) => !findTag(html, new RegExp('<meta[^>]+name=["\']' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i')));
    if (missing.length) issues.push(`${pg.url || pg.name || '?'}: 缺${missing.join('/')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// open-graph-enhanced：增强 OG 标签（og:type/og:site_name/og:locale）
function checkOpenGraphEnhanced(pages) {
  const enhanced = ['og:type', 'og:site_name', 'og:locale'];
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const missing = enhanced.filter((t) => !findTag(html, new RegExp('<meta[^>]+property=["\']' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i')));
    if (missing.length) issues.push(`${pg.url || pg.name || '?'}: 缺${missing.join('/')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// anchor-text-quality：内链锚文本质量（非"点击这里"等泛化文本）
function checkAnchorTextQuality(pages) {
  const badTexts = ['点击这里', '了解更多', '查看更多', '这里', '更多', '详情', '点击', 'link', 'here', 'more', 'click', 'click here', 'read more', '查看详情', '点击查看'];
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const anchors = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[1].trim().toLowerCase()).filter((t) => t && t.length < 20);
    const bad = anchors.filter((text) => badTexts.includes(text));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: 泛化锚文本${bad.length}个`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// image-lazy-load：图片 loading="lazy"
function checkImageLazyLoad(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const nonLazy = imgs.filter((t) => !t.match(/\bloading=["']lazy["']/i));
    if (nonLazy.length > 2) issues.push(`${pg.url || pg.name || '?'}: ${nonLazy.length}个图片缺loading=lazy`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// ========== 更多断言维度 ==========

// accessibility：aria 标签检查（按钮/链接/input 有无障碍标签）
function checkAccessibility(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const bad = [];
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
    for (const m of buttons) { if (!/aria-label=/i.test(m[1]) && !m[2].trim()) { bad.push('按钮缺aria-label/文本'); break; } }
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    for (const m of links) { if (!m[2].trim() && !/aria-label=/i.test(m[1])) { bad.push('链接缺文本/aria-label'); break; } }
    const inputs = [...html.matchAll(/<input\b([^>]*)>/gi)];
    for (const m of inputs) { if (!/aria-label=|id=/i.test(m[1])) { bad.push('input缺label'); break; } }
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// internal-links：内链结构分析（内链数量 + 锚文本多样性）
function checkInternalLinks(pages, opts) {
  const minLinks = (opts || {}).minLinks || 3;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const internal = links.filter((m) => !m[1].startsWith('http') && !m[1].startsWith('#') && !m[1].startsWith('mailto'));
    const bad = [];
    if (internal.length < minLinks) bad.push(`内链${internal.length}个(期望>=${minLinks})`);
    const anchors = internal.map((m) => m[2].trim().toLowerCase()).filter(Boolean);
    const unique = new Set(anchors);
    if (anchors.length > 3 && unique.size < anchors.length / 2) bad.push('锚文本重复率高');
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join('、')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// crawl-depth：页面深度/抓取可达性（sitemap URL 从首页可达）
function checkCrawlDepth(sitemapUrls, homepageLinks) {
  const issues = [];
  const reachable = new Set(homepageLinks || []);
  for (const url of (sitemapUrls || [])) {
    if (!reachable.has(url)) issues.push(url);
  }
  return { ok: !issues.length, detail: issues.length ? `${issues.length} 个URL首页不可达（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : `全部 ${sitemapUrls.length} 个URL可达` };
}

// duplicate-content：重复内容检测（title/description/H1 重复）
function checkDuplicateContent(pages) {
  const issues = [];
  const titles = {}, descs = {}, h1s = {};
  for (const pg of pages) {
    const html = pg.html || '';
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
    const h1 = (html.match(/<h1[^>]*>([^<]*)<\/h1>/i) || [])[1] || '';
    if (title) { titles[title] = (titles[title] || []).concat(pg.url || pg.name || '?'); }
    if (desc) { descs[desc] = (descs[desc] || []).concat(pg.url || pg.name || '?'); }
    if (h1) { h1s[h1] = (h1s[h1] || []).concat(pg.url || pg.name || '?'); }
  }
  for (const [t, urls] of Object.entries(titles)) if (urls.length > 1) issues.push(`title重复: ${urls.join('/')}`);
  for (const [d, urls] of Object.entries(descs)) if (urls.length > 1) issues.push(`description重复: ${urls.join('/')}`);
  for (const [h, urls] of Object.entries(h1s)) if (urls.length > 1) issues.push(`H1重复: ${urls.join('/')}`);
  return { ok: !issues.length, detail: issues.length ? `${issues.length} 处重复（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : `页面 ${pages.length} 个，无重复内容` };
}

// html-lang：检查 <html lang="zh"> 属性
function checkHtmlLang(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const m = html.match(/<html\b([^>]*)>/i);
    if (!m || !/lang=["']([^"']+)["']/i.test(m[1] || '')) issues.push(`${pg.url || pg.name || '?'}: 缺lang属性`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// breadcrumb：面包屑导航（JSON-LD BreadcrumbList 或 HTML breadcrumb 结构）
function checkBreadcrumb(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasJsonld = /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?BreadcrumbList[\s\S]*?<\/script>/i.test(html);
    const hasNav = /<nav[^>]*breadcrumb|class=["'][^"']*breadcrumb/i.test(html);
    if (!hasJsonld && !hasNav) issues.push(`${pg.url || pg.name || '?'}: 缺面包屑`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// content-freshness：内容更新日期（article:modified_time 或 JSON-LD dateModified）
function checkContentFreshness(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasModified = /<meta[^>]+property=["']article:modified_time["']/i.test(html) || /"dateModified"\s*:/.test(html);
    const hasPublished = /<meta[^>]+property=["']article:published_time["']/i.test(html) || /"datePublished"\s*:/.test(html);
    if (!hasPublished && !hasModified) issues.push(`${pg.url || pg.name || '?'}: 缺日期标记`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// robots-meta：检查无意外 noindex/nofollow
function checkRobotsMeta(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const m = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);
    if (m && /noindex/i.test(m[1])) issues.push(`${pg.url || pg.name || '?'}: noindex`);
    if (m && /nofollow/i.test(m[1])) issues.push(`${pg.url || pg.name || '?'}: nofollow`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// content-length：页面内容长度合理（太薄内容 SEO 差）
function checkContentLength(pages, opts) {
  const minLen = (opts || {}).minLen || 300;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length < minLen) issues.push(`${pg.url || pg.name || '?'}: 内容${text.length}字(期望>=${minLen})`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// pagination：分页 rel=prev/next
function checkPagination(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasPrev = /<link[^>]+rel=["']prev["']/i.test(html);
    const hasNext = /<link[^>]+rel=["']next["']/i.test(html);
    if (!hasPrev && !hasNext) issues.push(`${pg.url || pg.name || '?'}: 缺分页标记`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// iframe-sandbox：iframe 有 sandbox 属性（安全）
function checkIframeSandbox(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const iframes = [...html.matchAll(/<iframe\b([^>]*)>/gi)].map((m) => m[1] || '');
    const bad = iframes.filter((attrs) => !/\bsandbox\b/i.test(attrs));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个iframe缺sandbox`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// preload-hints：Link rel=preload/preconnect（性能优化提示）
function checkPreloadHints(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasPreload = /<link[^>]+rel=["']preload["']/i.test(html);
    const hasPreconnect = /<link[^>]+rel=["']preconnect["']/i.test(html);
    if (!hasPreload && !hasPreconnect) issues.push(`${pg.url || pg.name || '?'}: 缺preload/preconnect`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// image-format：图片用 webp/avif 现代格式
function checkImageFormat(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const srcs = [...html.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]);
    const legacy = srcs.filter((s) => /\.(png|jpg|jpeg|gif|bmp)(\?|$)/i.test(s));
    if (legacy.length > 2) issues.push(`${pg.url || pg.name || '?'}: ${legacy.length}个传统格式图片`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// html-doctype：<!DOCTYPE html> 声明
function checkHtmlDoctype(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    if (!/<!DOCTYPE\s+html>/i.test(html)) issues.push(`${pg.url || pg.name || '?'}: 缺DOCTYPE`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// meta-viewport-scale：viewport initial-scale 配置
function checkViewportScale(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const vp = findTag(html, /<meta[^>]+name=["']viewport["'][^>]*>/i);
    const content = vp ? attrMeta(vp, 'content') : '';
    if (!vp) { issues.push(`${pg.url || pg.name || '?'}: 缺viewport`); continue; }
    if (!/initial-scale=/i.test(content)) issues.push(`${pg.url || pg.name || '?'}: 缺initial-scale`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// title-length：<title> 长度 10-60 字符（SEO 最佳实践）
function checkTitleLength(pages, opts) {
  const o = opts || {};
  const min = o.min || 10, max = o.max || 60;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const title = findTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const text = title.replace(/<[^>]+>/g, '').trim();
    if (!text) { issues.push(`${pg.url || pg.name || '?'}: 缺title`); continue; }
    if (text.length < min || text.length > max) issues.push(`${pg.url || pg.name || '?'}: ${text.length}字`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// description-length：meta description 长度 50-160 字符
function checkDescriptionLength(pages, opts) {
  const o = opts || {};
  const min = o.min || 50, max = o.max || 160;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const desc = attrMeta(findTag(html, /<meta[^>]+name=["']description["'][^>]*>/i), 'content');
    if (!desc) { issues.push(`${pg.url || pg.name || '?'}: 缺description`); continue; }
    if (desc.length < min || desc.length > max) issues.push(`${pg.url || pg.name || '?'}: ${desc.length}字`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// image-dimensions：img 有 width/height 防 CLS
function checkImageDimensions(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const bad = imgs.filter((t) => !/\bwidth\s*=/.test(t) || !/\bheight\s*=/.test(t));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个img缺width/height`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// mixed-content：HTTPS 页面无 http:// 资源
function checkMixedContent(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const url = pg.url || '';
    if (!/^https:\/\//i.test(url)) continue;
    const httpSrcs = [...html.matchAll(/\b(?:src|href)=["'](http:\/\/[^"']+)["']/gi)].map((m) => m[1]);
    const bad = httpSrcs.filter((s) => !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(s));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个http资源`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// external-link-rel：外链 rel="noopener noreferrer" 安全
function checkExternalLinkRel(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const pageUrl = pg.url || '';
    const pageHost = (pageUrl.match(/^https?:\/\/([^/]+)/i) || [])[1] || '';
    const links = [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
    const ext = links.filter((t) => {
      const href = attrMeta(t, 'href');
      const host = (href.match(/^https?:\/\/([^/]+)/i) || [])[1] || '';
      return host && host !== pageHost;
    });
    const bad = ext.filter((t) => {
      const rel = attrMeta(t, 'rel').toLowerCase();
      return !rel.includes('noopener') || !rel.includes('noreferrer');
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个外链缺rel`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// favicon：favicon 存在
function checkFavicon(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasIcon = /<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["']/i.test(html);
    if (!hasIcon) issues.push(`${pg.url || pg.name || '?'}: 缺favicon`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// noscript-fallback：<noscript> 降级内容
function checkNoscriptFallback(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasScript = /<script\b/i.test(html);
    const hasNoscript = /<noscript\b/i.test(html);
    if (hasScript && !hasNoscript) issues.push(`${pg.url || pg.name || '?'}: 缺noscript降级`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// skip-link：跳到主内容链接（可访问性）
function checkSkipLink(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasMain = /<main\b/i.test(html) || /id=["'](?:main|content)["']/i.test(html);
    if (!hasMain) continue;
    const first = html.slice(0, 2000);
    const hasSkip = /<a\b[^>]*href=["']#(?:main|content)["']/i.test(first);
    if (!hasSkip) issues.push(`${pg.url || pg.name || '?'}: 缺skip-link`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// form-label：表单 input 有关联 label（可访问性）
function checkFormLabel(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const inputs = [...html.matchAll(/<input\b([^>]*)>/gi)].map((m) => ({ tag: m[0], attrs: m[1] || '' }));
    const labels = [...html.matchAll(/<label\b[^>]*for=["']([^"']+)["']/gi)].map((m) => m[1]);
    const labelledIds = new Set(labels);
    const bad = inputs.filter((inp) => {
      if (/type=["'](?:hidden|submit|button|reset)["']/i.test(inp.attrs)) return false;
      const id = (inp.attrs.match(/id=["']([^"']+)["']/i) || [])[1];
      if (id && labelledIds.has(id)) return false;
      if (/<label\b[^>]*>/i.test(html) && inp.attrs.includes('id')) return false;
      return !/\baria-label\s*=/.test(inp.attrs) && !/\baria-labelledby\s*=/.test(inp.attrs);
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个input缺label`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// table-header：表格有 thead/th（可访问性）
function checkTableHeader(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1] || '');
    const bad = tables.filter((inner) => !/<thead\b/i.test(inner) && !/<th\b/i.test(inner));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个table缺thead/th`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// landmark-regions：语义地标区域 header/nav/main/footer（可访问性）
function checkLandmarkRegions(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasNav = /<nav\b/i.test(html);
    const hasMain = /<main\b/i.test(html);
    const hasHeader = /<header\b/i.test(html);
    const hasFooter = /<footer\b/i.test(html);
    const missing = [];
    if (!hasNav) missing.push('nav');
    if (!hasMain) missing.push('main');
    if (!hasHeader) missing.push('header');
    if (!hasFooter) missing.push('footer');
    if (missing.length) issues.push(`${pg.url || pg.name || '?'}: 缺${missing.join('/')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// aria-roles-valid：ARIA role 值有效（可访问性）
function checkAriaRolesValid(pages) {
  const VALID_ROLES = new Set(['alert','alertdialog','application','article','banner','complementary','contentinfo','definition','dialog','directory','document','feed','figure','form','grid','gridcell','group','heading','img','link','list','listbox','listitem','log','main','marquee','math','menu','menubar','menuitem','menuitemcheckbox','menuitemradio','navigation','none','note','option','presentation','progressbar','radio','radiogroup','region','row','rowgroup','rowheader','scrollbar','search','searchbox','separator','slider','spinbutton','status','switch','tab','table','tablist','tabpanel','term','textbox','timer','toolbar','tooltip','tree','treegrid','treeitem']);
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const roles = [...html.matchAll(/role=["']([^"']+)["']/gi)].map((m) => m[1].trim());
    const bad = roles.filter((r) => r && !VALID_ROLES.has(r));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个无效role`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// font-display：@font-face 有 font-display: swap（性能）
function checkFontDisplay(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const fontFaces = [...html.matchAll(/@font-face\s*\{([^}]*)\}/gi)].map((m) => m[1] || '');
    const bad = fontFaces.filter((body) => !/font-display\s*:\s*swap/i.test(body));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个@font-face缺font-display:swap`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// print-stylesheet：有打印样式 media="print"（可访问性/打印）
function checkPrintStylesheet(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasPrint = /<link[^>]+media=["']print["']/i.test(html) || /@media\s+print/i.test(html);
    if (!hasPrint) issues.push(`${pg.url || pg.name || '?'}: 缺打印样式`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// manifest-json：PWA manifest.json 引用
function checkManifestJson(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hasManifest = /<link[^>]+rel=["']manifest["']/i.test(html);
    if (!hasManifest) issues.push(`${pg.url || pg.name || '?'}: 缺manifest`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// url-canonicalization：URL 规范化一致性（小写/尾斜杠）
function checkUrlCanonicalization(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]).filter((h) => /^https?:\/\//i.test(h));
    const upper = hrefs.filter((h) => h !== h.toLowerCase());
    if (upper.length) issues.push(`${pg.url || pg.name || '?'}: ${upper.length}个URL含大写`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// heading-count：每页 H2 数量 >=1（内容结构质量）
function checkHeadingCount(pages, opts) {
  const min = (opts || {}).min || 1;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const h2 = (html.match(/<h2\b/gi) || []).length;
    if (h2 < min) issues.push(`${pg.url || pg.name || '?'}: ${h2}个H2`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// word-count：正文词数 >= 阈值（内容质量）
function checkWordCount(pages, opts) {
  const min = (opts || {}).min || 300;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < min) issues.push(`${pg.url || pg.name || '?'}: ${words}词`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// link-text-descriptive：链接文本非"点击这里/更多/click here/read more"（可访问性+SEO）
function checkLinkTextDescriptive(pages) {
  const BAD = /^(点击这里|点击查看|更多|查看更多|详情|link|click here|read more|more|here|详情请点击)$/i;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const links = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    const bad = links.filter((t) => t && BAD.test(t));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个非描述性链接`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// image-alt-quality：alt 非空且非纯文件名（可访问性）
function checkImageAltQuality(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const bad = imgs.filter((t) => {
      const alt = (t.match(/alt=["']([^"']*)["']/i) || [])[1];
      if (alt === undefined) return false;
      if (alt.trim() === '') return false;
      if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(alt.trim())) return true;
      if (alt.trim().length < 2) return true;
      return false;
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个低质量alt`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// video-subtitle：video 有 track 字幕（可访问性）
function checkVideoSubtitle(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const videos = [...html.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)].map((m) => m[1] || '');
    const bad = videos.filter((inner) => !/<track\b/i.test(inner));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个video缺track`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// single-h1：每页只有一个 H1（SEO）
function checkSingleH1(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const h1 = (html.match(/<h1\b/gi) || []).length;
    if (h1 !== 1) issues.push(`${pg.url || pg.name || '?'}: ${h1}个H1`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// meta-refresh：无 meta refresh 跳转（SEO）
function checkMetaRefresh(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    if (/<meta[^>]+http-equiv=["']refresh["']/i.test(html)) issues.push(`${pg.url || pg.name || '?'}: 有meta-refresh`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// inline-script：内联 script 数量 <= 阈值（CSP 友好/性能）
function checkInlineScript(pages, opts) {
  const max = (opts || {}).max || 2;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => {
      const attrs = m[1] || '';
      const body = (m[2] || '').trim();
      return !/\bsrc\s*=/.test(attrs) && body.length > 0 && !/type=["']application\/ld\+json["']/i.test(attrs);
    });
    if (inline.length > max) issues.push(`${pg.url || pg.name || '?'}: ${inline.length}个内联script`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// cache-headers：静态资源有 Cache-Control（线上，响应头）
function checkCacheHeaders(headers) {
  const h = headers || {};
  const cc = (h['cache-control'] || h['Cache-Control'] || '').toLowerCase();
  if (!cc) return { ok: false, detail: '缺 Cache-Control' };
  if (/no-cache|no-store/.test(cc)) return { ok: false, detail: `Cache-Control: ${cc}（禁止缓存）` };
  return { ok: true, detail: `Cache-Control: ${cc}` };
}

// csp-present：CSP 头存在（线上，响应头）
function checkCspPresent(headers) {
  const h = headers || {};
  const csp = h['content-security-policy'] || h['Content-Security-Policy'] || '';
  if (!csp) return { ok: false, detail: '缺 Content-Security-Policy' };
  return { ok: true, detail: `CSP: ${csp.slice(0, 60)}${csp.length > 60 ? '…' : ''}` };
}

// x-frame-options：X-Frame-Options 防点击劫持（线上，响应头）
function checkXFrameOptions(headers) {
  const h = headers || {};
  const xfo = (h['x-frame-options'] || h['X-Frame-Options'] || '').toLowerCase();
  if (!xfo) return { ok: false, detail: '缺 X-Frame-Options' };
  if (!/^(deny|sameorigin|allow-from)/.test(xfo)) return { ok: false, detail: `X-Frame-Options: ${xfo}（无效值）` };
  return { ok: true, detail: `X-Frame-Options: ${xfo}` };
}

// referrer-policy：Referrer-Policy 头（线上，响应头）
function checkReferrerPolicy(headers) {
  const h = headers || {};
  const rp = (h['referrer-policy'] || h['Referrer-Policy'] || '').toLowerCase();
  if (!rp) return { ok: false, detail: '缺 Referrer-Policy' };
  const valid = ['no-referrer','no-referrer-when-downgrade','same-origin','origin','strict-origin','origin-when-cross-origin','strict-origin-when-cross-origin','unsafe-url'];
  if (!valid.includes(rp)) return { ok: false, detail: `Referrer-Policy: ${rp}（无效值）` };
  return { ok: true, detail: `Referrer-Policy: ${rp}` };
}

// tap-target-size：触摸目标尺寸 >=48px（Lighthouse A11y，移动端）
function checkTapTargetSize(pages, opts) {
  const min = (opts || {}).min || 48;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const targets = [...html.matchAll(/<(?:a|button|input|select|textarea)\b([^>]*)>/gi)].map((m) => m[1] || '');
    const bad = targets.filter((attrs) => {
      const w = parseInt((attrs.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || '0', 10);
      const h = parseInt((attrs.match(/\bheight\s*=\s*["']?(\d+)/i) || [])[1] || '0', 10);
      const styleW = parseInt((attrs.match(/min-width\s*:\s*(\d+)/i) || [])[1] || '0', 10);
      const styleH = parseInt((attrs.match(/min-height\s*:\s*(\d+)/i) || [])[1] || '0', 10);
      const effectiveW = Math.max(w, styleW);
      const effectiveH = Math.max(h, styleH);
      if (effectiveW > 0 && effectiveW < min) return true;
      if (effectiveH > 0 && effectiveH < min) return true;
      return false;
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个小触摸目标`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// font-size：字号 >=12px（Lighthouse SEO，可读性）
function checkFontSize(pages, opts) {
  const min = (opts || {}).min || 12;
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const sizes = [...html.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*(px|pt|rem|em)?/gi)].map((m) => {
      const val = parseFloat(m[1]);
      const unit = (m[2] || 'px').toLowerCase();
      if (unit === 'pt') return val * 1.333;
      if (unit === 'rem' || unit === 'em') return val * 16;
      return val;
    });
    const bad = sizes.filter((s) => s > 0 && s < min);
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个小字号`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// crawlable-anchors：锚点可抓取（Lighthouse SEO，非 javascript:void(0)）
function checkCrawlableAnchors(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const anchors = [...html.matchAll(/<a\b([^>]*)>/gi)].map((m) => m[1] || '');
    const bad = anchors.filter((attrs) => {
      const href = (attrs.match(/href=["']([^"']*)["']/i) || [])[1];
      if (href === undefined) return false;
      if (/javascript:/i.test(href)) return true;
      if (href.trim() === '') return true;
      return false;
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个不可抓取锚点`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// duplicate-id：重复 id（axe-core，HTML 规范+可访问性）
function checkDuplicateId(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
    const seen = {};
    const dups = ids.filter((id) => { seen[id] = (seen[id] || 0) + 1; return seen[id] === 2; });
    if (dups.length) issues.push(`${pg.url || pg.name || '?'}: ${dups.length}个重复id`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// button-name：按钮有可访问名称（axe-core）
function checkButtonName(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const btns = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((m) => ({ attrs: m[1] || '', content: m[2] || '' }));
    const bad = btns.filter((b) => {
      const text = b.content.replace(/<[^>]+>/g, '').trim();
      if (text) return false;
      if (/\baria-label\s*=/.test(b.attrs)) return false;
      if (/\baria-labelledby\s*=/.test(b.attrs)) return false;
      if (/\btitle\s*=/.test(b.attrs)) return false;
      return true;
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个按钮无名`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// empty-heading：heading 非空（axe-core）
function checkEmptyHeading(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const headings = [...html.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)].map((m) => m[3] || '');
    const bad = headings.filter((c) => c.replace(/<[^>]+>/g, '').trim() === '');
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个空heading`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// link-name：链接有可访问名称（axe-core）
function checkLinkName(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ attrs: m[1] || '', content: m[2] || '' }));
    const bad = links.filter((l) => {
      const text = l.content.replace(/<[^>]+>/g, '').trim();
      if (text) return false;
      if (/\baria-label\s*=/.test(l.attrs)) return false;
      if (/\baria-labelledby\s*=/.test(l.attrs)) return false;
      if (/<img\b[^>]*alt=["'][^"']+["']/i.test(l.content)) return false;
      return true;
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个链接无名`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// https-only：页面使用 HTTPS（Lighthouse best-practice）
function checkHttpsOnly(pages) {
  const issues = [];
  for (const pg of pages) {
    const url = pg.url || '';
    if (!url) continue;
    if (!/^https:\/\//i.test(url)) issues.push(`${pg.url || pg.name || '?'}: 非HTTPS`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// viewport-user-scalable：viewport 允许用户缩放（Lighthouse A11y）
function checkViewportUserScalable(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const vp = findTag(html, /<meta[^>]+name=["']viewport["'][^>]*>/i);
    if (!vp) continue;
    const content = attrMeta(vp, 'content');
    if (/user-scalable\s*=\s*["']?no/i.test(content)) issues.push(`${pg.url || pg.name || '?'}: user-scalable=no`);
    if (/maximum-scale\s*=\s*["']?1(\D|$)/i.test(content)) issues.push(`${pg.url || pg.name || '?'}: maximum-scale=1`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// valid-lang：lang 属性值有效（axe-core）
function checkValidLang(pages) {
  const VALID = new Set(['aa','ab','ae','af','ak','am','an','ar','as','av','ay','az','ba','be','bg','bh','bi','bm','bn','bo','br','bs','ca','ce','ch','co','cr','cs','cu','cv','cy','da','de','dv','dz','ee','el','en','eo','es','et','eu','fa','ff','fi','fj','fo','fr','fy','ga','gd','gl','gn','gu','gv','ha','he','hi','ho','hr','ht','hu','hy','hz','ia','id','ie','ig','ii','ik','io','is','it','iu','ja','jv','ka','kg','ki','kj','kk','kl','km','kn','ko','kr','ks','ku','kv','kw','ky','la','lb','lg','li','ln','lo','lt','lu','lv','mg','mh','mi','mk','ml','mn','mr','ms','mt','my','na','nb','nd','ne','ng','nl','nn','no','nr','nv','ny','oc','oj','om','or','os','pa','pi','pl','ps','pt','qu','rm','rn','ro','ru','rw','sa','sc','sd','se','sg','si','sk','sl','sm','sn','so','sq','sr','ss','st','su','sv','sw','ta','te','tg','th','ti','tk','tl','tn','to','tr','ts','tt','tw','ty','ug','uk','ur','uz','ve','vi','vo','wa','wo','xh','yi','yo','za','zh','zu']);
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const lang = (html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i) || [])[1] || '';
    if (!lang) continue;
    const primary = lang.split('-')[0].toLowerCase();
    if (!VALID.has(primary)) issues.push(`${pg.url || pg.name || '?'}: 无效lang(${lang})`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// autocomplete-valid：autocomplete 属性值有效（axe-core）
function checkAutocompleteValid(pages) {
  const VALID = new Set(['on','off','name','honorific-prefix','given-name','additional-name','family-name','honorific-suffix','nickname','email','username','current-password','new-password','one-time-code','organization-title','organization','street-address','address-line1','address-line2','address-line3','address-level4','address-level3','address-level2','address-level1','country','country-name','postal-code','cc-name','cc-given-name','cc-additional-name','cc-family-name','cc-number','cc-exp','cc-exp-month','cc-exp-year','cc-csc','cc-type','transaction-currency','transaction-amount','language','bday','bday-day','bday-month','bday-year','sex','url','photo','tel','tel-country-code','tel-national','tel-area-code','tel-local','tel-extension','impp']);
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const vals = [...html.matchAll(/\bautocomplete=["']([^"']+)["']/gi)].map((m) => m[1].trim().toLowerCase());
    const bad = vals.filter((v) => v && !VALID.has(v));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个无效autocomplete`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// aria-hidden-focus：aria-hidden 元素不含可聚焦子元素（axe-core）
function checkAriaHiddenFocus(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const hidden = [...html.matchAll(/<(\w+)\b[^>]*aria-hidden=["']true["'][^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2] || '');
    const bad = hidden.filter((inner) => /<(?:a|button|input|select|textarea|iframe|video|audio|details)\b[^>]*(?:\bhref\b|\btabindex\b|[^>]*>)/i.test(inner));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个aria-hidden含可聚焦元素`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// tabindex-valid：tabindex 不大于 0（axe-core）
function checkTabindexValid(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const vals = [...html.matchAll(/\btabindex=["']?(\d+)["']?/gi)].map((m) => parseInt(m[1], 10));
    const bad = vals.filter((v) => v > 0);
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个tabindex>0`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// table-caption：表格有 caption（axe-core）
function checkTableCaption(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1] || '');
    const bad = tables.filter((inner) => !/<caption\b/i.test(inner));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个table缺caption`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// scope-attr-valid：th scope 属性值有效（axe-core）
function checkScopeAttrValid(pages) {
  const VALID = new Set(['row','col','rowgroup','colgroup']);
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const scopes = [...html.matchAll(/<th\b[^>]*\bscope=["']([^"']+)["']/gi)].map((m) => m[1].trim().toLowerCase());
    const bad = scopes.filter((s) => s && !VALID.has(s));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个无效scope`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// text-compression：文本响应已压缩（Lighthouse Perf，响应头）
function checkTextCompression(headers) {
  const h = headers || {};
  const ce = (h['content-encoding'] || h['Content-Encoding'] || '').toLowerCase();
  if (!ce) return { ok: false, detail: '缺 Content-Encoding（未压缩）' };
  if (!/^(gzip|br|deflate|zstd)/.test(ce)) return { ok: false, detail: `Content-Encoding: ${ce}（无效）` };
  return { ok: true, detail: `Content-Encoding: ${ce}` };
}

// no-document-write：不使用 document.write()（Lighthouse）
function checkNoDocumentWrite(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] || '');
    const bad = scripts.filter((s) => /document\s*\.\s*write\s*\(/.test(s));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}处document.write()`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// no-mutation-events：不使用 Mutation Events（Lighthouse）
function checkNoMutationEvents(pages) {
  const mutationEvents = ['onDOMAttrModified', 'onDOMNodeInserted', 'onDOMNodeRemoved', 'onDOMSubtreeModified', 'onDOMNodeInsertedIntoDocument', 'onDOMNodeRemovedFromDocument', 'onDOMCharacterDataModified'];
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const bad = mutationEvents.filter((e) => new RegExp('\\b' + e + '\\s*=', 'i').test(html));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.join(', ')}`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// dlitem：dl 元素的直接子元素只能是 dt/dd（axe-core）
function checkDlItem(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const dls = [...html.matchAll(/<dl\b([^>]*)>([\s\S]*?)<\/dl>/gi)].map((m) => m[2] || '');
    for (let i = 0; i < dls.length; i++) {
      const inner = dls[i];
      const directChildren = [...inner.matchAll(/<(\w+)\b[^>]*>/gi)].map((m) => m[1].toLowerCase());
      const bad = directChildren.filter((t) => t !== 'dt' && t !== 'dd');
      if (bad.length) { issues.push(`${pg.url || pg.name || '?'}: dl#${i}含非法子元素${bad.join(',')}`); break; }
    }
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// no-empty-table：table 元素非空，至少有 tr（axe-core）
function checkNoEmptyTable(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const tables = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].map((m) => ({ attrs: m[1] || '', inner: m[2] || '' }));
    const bad = tables.filter((t) => !/<tr\b/i.test(t.inner));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个空table`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// password-paste：密码输入框不阻止粘贴（Lighthouse）
function checkPasswordPaste(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const pwInputs = [...html.matchAll(/<input\b([^>]*)>/gi)].map((m) => m[1] || '').filter((a) => /\btype\s*=\s*["']password["']/i.test(a));
    const bad = pwInputs.filter((a) => /\bonpaste\s*=\s*["']\s*return\s+false/i.test(a));
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}个密码框禁止粘贴`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// no-emphasis-as-heading：不用 b/strong 模拟标题（axe-core）
function checkNoEmphasisAsHeading(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const emph = [...html.matchAll(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2] || '');
    const bad = emph.filter((t) => {
      const text = t.replace(/<[^>]+>/g, '').trim();
      return text.length > 20 && /<br\s*\/?>/i.test(html.slice(0, html.indexOf(text)));
    });
    if (bad.length) issues.push(`${pg.url || pg.name || '?'}: ${bad.length}处b/strong疑似标题`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// nested-interactive：交互元素不嵌套（axe-core，如 a 套 a、button 套 button）
function checkNestedInteractive(pages) {
  const interactive = ['a', 'button', 'details', 'embed', 'iframe', 'label', 'select', 'textarea'];
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    for (const tag of interactive) {
      const outer = [...html.matchAll(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'gi'))].map((m) => m[1] || '');
      for (let i = 0; i < outer.length; i++) {
        if (new RegExp('<' + tag + '\\b', 'i').test(outer[i])) { issues.push(`${pg.url || pg.name || '?'}: <${tag}>嵌套<${tag}>`); break; }
      }
    }
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// list-structure：ul/ol 直接子元素只有 li（axe-core）
function checkListStructure(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const lists = [...html.matchAll(/<(ul|ol)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((m) => m[3] || '');
    for (let i = 0; i < lists.length; i++) {
      const directChildren = [...lists[i].matchAll(/<(\w+)\b[^>]*>/gi)].map((m) => m[1].toLowerCase());
      const bad = directChildren.filter((t) => t !== 'li');
      if (bad.length) { issues.push(`${pg.url || pg.name || '?'}: list#${i}含非li子元素${bad.join(',')}`); break; }
    }
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// list-item：li 必须在 ul/ol 内（axe-core）
function checkListItem(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const allLi = [...html.matchAll(/<li\b[^>]*>/gi)].length;
    const inList = [...html.matchAll(/<(?:ul|ol)\b[^>]*>([\s\S]*?)<\/(?:ul|ol)>/gi)].reduce((sum, m) => sum + [...(m[1] || '').matchAll(/<li\b[^>]*>/gi)].length, 0);
    if (allLi > inList) issues.push(`${pg.url || pg.name || '?'}: ${allLi - inList}个li不在ul/ol内`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// image-redundant-alt：图片 alt 与链接文本重复（axe-core）
function checkImageRedundantAlt(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const links = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[1] || '');
    for (const link of links) {
      const imgMatch = link.match(/<img\b[^>]*\balt=["']([^"']*)["']/i);
      if (!imgMatch) continue;
      const alt = (imgMatch[1] || '').trim();
      if (!alt) continue;
      const linkText = link.replace(/<[^>]+>/g, '').trim();
      if (linkText && (alt === linkText || linkText.includes(alt) || alt.includes(linkText))) {
        issues.push(`${pg.url || pg.name || '?'}: alt与链接文本重复`);
      }
    }
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// no-old-flexbox：不使用旧 flexbox 语法 display:box（Lighthouse）
function checkNoOldFlexbox(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] || '');
    const inlineStyles = [...html.matchAll(/style=["']([^"']*)["']/gi)].map((m) => m[1] || '');
    const allCss = styles.concat(inlineStyles).join('\n');
    if (/display\s*:\s*box/i.test(allCss)) issues.push(`${pg.url || pg.name || '?'}: 使用旧flexbox(display:box)`);
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

// geolocation-on-start：不在启动时请求地理位置（Lighthouse）
function checkGeolocationOnStart(pages) {
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] || '');
    const allCode = scripts.join('\n');
    if (/navigator\s*\.\s*geolocation\s*\.\s*(getCurrentPosition|watchPosition)/.test(allCode)) {
      if (!/DOMContentLoaded|addEventListener|setTimeout|requestAnimationFrame/.test(allCode)) {
        issues.push(`${pg.url || pg.name || '?'}: 启动时请求地理位置`);
      }
    }
  }
  return { ok: !issues.length, detail: `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过') };
}

module.exports = {
  countOcc,
  attrMeta,
  findTag,
  checkContains,
  checkNotContains,
  checkDataVsHtml,
  checkSitemap,
  checkPageQuality,
  checkLinkHealth,
  checkCountFiles,
  checkMobileFriendly,
  checkSecurityHeaders,
  checkHreflang,
  checkStructuredData,
  checkCoreWebVitals,
  checkAiCrawlable,
  checkFaqContent,
  checkSemanticHtml,
  checkContentStructure,
  checkAiCitations,
  checkTwitterCard,
  checkOpenGraphEnhanced,
  checkAnchorTextQuality,
  checkImageLazyLoad,
  checkAccessibility,
  checkInternalLinks,
  checkCrawlDepth,
  checkDuplicateContent,
  checkHtmlLang,
  checkBreadcrumb,
  checkContentFreshness,
  checkRobotsMeta,
  checkContentLength,
  checkPagination,
  checkIframeSandbox,
  checkPreloadHints,
  checkImageFormat,
  checkHtmlDoctype,
  checkViewportScale,
  checkTitleLength,
  checkDescriptionLength,
  checkImageDimensions,
  checkMixedContent,
  checkExternalLinkRel,
  checkFavicon,
  checkNoscriptFallback,
  checkSkipLink,
  checkFormLabel,
  checkTableHeader,
  checkLandmarkRegions,
  checkAriaRolesValid,
  checkFontDisplay,
  checkPrintStylesheet,
  checkManifestJson,
  checkUrlCanonicalization,
  checkHeadingCount,
  checkWordCount,
  checkLinkTextDescriptive,
  checkImageAltQuality,
  checkVideoSubtitle,
  checkSingleH1,
  checkMetaRefresh,
  checkInlineScript,
  checkCacheHeaders,
  checkCspPresent,
  checkXFrameOptions,
  checkReferrerPolicy,
  checkTapTargetSize,
  checkFontSize,
  checkCrawlableAnchors,
  checkDuplicateId,
  checkButtonName,
  checkEmptyHeading,
  checkLinkName,
  checkHttpsOnly,
  checkViewportUserScalable,
  checkValidLang,
  checkAutocompleteValid,
  checkAriaHiddenFocus,
  checkTabindexValid,
  checkTableCaption,
  checkScopeAttrValid,
  checkTextCompression,
  checkNoDocumentWrite,
  checkNoMutationEvents,
  checkDlItem,
  checkNoEmptyTable,
  checkPasswordPaste,
  checkNoEmphasisAsHeading,
  checkNestedInteractive,
  checkListStructure,
  checkListItem,
  checkImageRedundantAlt,
  checkNoOldFlexbox,
  checkGeolocationOnStart,
};
