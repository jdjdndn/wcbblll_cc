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
  const attr = (tag, name) => { const m = tag.match(new RegExp(name + '=["\']([^"\']*)["\']', 'i')); return m ? m[1].trim() : ''; };
  const findTag = (html, re) => { const m = html.match(re); return m ? m[0] : ''; };
  const issues = [];
  for (const pg of pages) {
    const html = pg.html || '';
    const t = findTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = t ? t.replace(/<\/?title[^>]*>/gi, '').trim() : '';
    const dmeta = findTag(html, /<meta[^>]+name=["']description["'][^>]*>/i) || findTag(html, /<meta[^>]+content=["'][^"']*["'][^>]*name=["']description["'][^>]*>/i);
    const desc = dmeta ? attr(dmeta, 'content') : '';
    const cano = attr(findTag(html, /<link[^>]+rel=["']canonical["'][^>]*>/i), 'href');
    const bad = [];
    if (!title) bad.push('缺title');
    else if (o.titleMax && title.length > o.titleMax) bad.push(`title超长(${title.length}>${o.titleMax})`);
    if (!desc) bad.push('缺description');
    else if (o.descMin && desc.length < o.descMin) bad.push(`description过短(${desc.length}<${o.descMin})`);
    if (o.canonical && (!cano || !cano.startsWith(o.canonical))) bad.push(`canonical不符(${cano || '无'})`);
    for (const g of (o.og || [])) {
      const ogtag = findTag(html, new RegExp('<meta[^>]+property=["\']' + g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i'));
      if (!ogtag || !attr(ogtag, 'content')) bad.push(`缺${g}`);
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

module.exports = {
  countOcc,
  checkContains,
  checkNotContains,
  checkDataVsHtml,
  checkSitemap,
  checkPageQuality,
  checkLinkHealth,
  checkCountFiles,
};
