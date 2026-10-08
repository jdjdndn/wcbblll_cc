/*
 * lib/online-verify.cjs —— 线上 SEO 校验执行器（云端持久巡检核心）
 *
 * 与本地 verify 同规则（复用 lib/asserts.cjs 纯函数），但数据来源是"线上产物本身"：
 *   - 不依赖任何本地构建：fetch 线上页面/XML/数据文件后跑断言；
 *   - 每日 smoke 频率分层（≤10 次/站）由调度方控制（--daily / Worker cron）；
 *   - 返回与本地 verify 相同结构（site → checks[{desc, ok, detail}]），
 *     便于本地 runs/ 落盘与云端 KV 集中汇总共用同一协议。
 *
 * 用法：
 *   const ov = require('./online-verify.cjs');
 *   const res = await ov.verifySite(siteDef, { base: 'https://example.com', limitLoc: 30 });
 */
'use strict';
const asserts = require('./asserts.cjs');

// fetch 封装：跟随重定向，非 200/网络错误时重试 1 次（防 Cloudflare 瞬时限流误报），返回 { status, body, error }
async function httpGetText(url, timeoutMs) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ctl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; seo-optimizer-online-verify/1.0)' },
      });
      const body = await res.text();
      last = { status: res.status, body, error: null, ms: Date.now() - t0, headers: Object.fromEntries(res.headers.entries()) };
      if (res.status === 200) return last;
      // 非 200：若为重试最后一轮则返回；否则继续重试
      if (attempt === 1) return last;
    } catch (e) {
      last = { status: 0, body: '', error: e.name === 'AbortError' ? 'timeout' : e.message, ms: Date.now() - t0 };
      if (attempt === 1) return last;
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

// 站点定义 → 线上断言（与本地 verify 的 desc 一一对应）
// 依赖：s.dir 的本地配置不用于校验本身；校验全部基于线上 URL。
// 线上 URL 映射：site.onlineBase 为线上根（如 https://wcbblll.cc），缺省由 s.smoke[0].url 推导或调用方传入。
async function verifySite(site, opts) {
  const o = opts || {};
  const base = (o.base || site.onlineBase || '').replace(/\/+$/, '');
  if (!base) return { name: site.name, checks: [{ desc: '线上根 URL 未配置', ok: false, detail: '需在站点定义 onlineBase 或调用时传 base' }], online: true };

  const checks = [];
  const results = [];
  const seen = {};
  async function get(rel) {
    const url = rel.startsWith('http') ? rel : base + '/' + rel.replace(/^\/+/, '');
    if (seen[url]) return seen[url];
    const r = await httpGetText(url, o.timeoutMs || 15000);
    seen[url] = r;
    results.push({ url, ...r });
    return r;
  }

  // 1) 首页可达 + 关键字（对应本地 smoke 的核心，也是每日最小集）
  const home = await get('');
  checks.push({ desc: '首页可达(200)', ok: home.status === 200, detail: home.error ? `错误: ${home.error}` : `HTTP ${home.status}` });

  // 2) 首页含内容标记（本地 data-vs-html 的线上轻量版：核心内容不再依赖 fetch）
  const homeHtml = home.body || '';
  const noFetch = asserts.checkNotContains(homeHtml, "fetch('links-data.json')");
  checks.push({ desc: '核心内容不依赖fetch', ok: noFetch.ok, detail: noFetch.detail });

  // 3) sitemap 双向一致性（线上：loc 域名匹配 + 抽查可达；页面覆盖由 pageLocations 提供）
  const sm = await get('sitemap.xml');
  if (sm.status === 200) {
    const locs = [...(sm.body || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter(Boolean);
    const sample = locs.slice(0, o.limitLoc || 10);
    const reachable = new Set();
    for (const l of sample) {
      const r = await get(l);
      if (r.status === 200) reachable.add(l);
    }
    const c = asserts.checkSitemap(sm.body, base, (l) => (sample.includes(l) ? reachable.has(l) : true), []);
    // 修正 detail：说明抽查范围（未抽查的 loc 不判错，全量由每周 verify 承担）
    checks.push({ desc: 'sitemap与线上产物一致(抽查)', ok: c.ok, detail: `${c.detail}（抽查 ${sample.length}/${locs.length} 个 loc）` });
  } else {
    checks.push({ desc: 'sitemap与线上产物一致(抽查)', ok: false, detail: `sitemap.xml HTTP ${sm.status}${sm.error ? ' ' + sm.error : ''}` });
  }

  // 4) robots.txt 声明 Sitemap（线上可抓取性）
  const rb = await get('robots.txt');
  const hasSitemapDecl = (rb.body || '').includes('Sitemap:');
  checks.push({ desc: 'robots声明Sitemap', ok: rb.status === 200 && hasSitemapDecl, detail: rb.error ? `错误: ${rb.error}` : (hasSitemapDecl ? 'HTTP ' + rb.status + ' 已声明' : 'HTTP ' + rb.status + ' 未声明 Sitemap') });

  // 5) 404 行为（线上）——取 smoke 配置中期望 404 的 url，无则跳过
  const expect404 = (site.smoke || []).filter((m) => m.status === 404)[0];
  if (expect404) {
    const r404 = await get(expect404.url.replace(base + '/', ''));
    checks.push({ desc: '404页行为正确', ok: r404.status === 404, detail: `HTTP ${r404.status}（期望 404）` });
  }

  // 6) page-quality（首页 + 分类页抽样，对应本地 page-quality 的线上版）
  const pageList = site.onlinePages || ['', 'category/ecommerce.html'];
  const pages = [];
  for (const p of pageList) {
    const r = await get(p);
    if (r.status === 200) pages.push({ url: base + '/' + p.replace(/^\/+/, ''), html: r.body });
  }
  if (pages.length) {
    const pq = asserts.checkPageQuality(pages, { canonical: base, og: ['og:title', 'og:description', 'og:image', 'og:url'], jsonld: true });
    checks.push({ desc: '页面Meta完整(title/desc/canonical/OG/JSON-LD)', ok: pq.ok, detail: pq.detail });

    // 7) 移动端适配
    const mf = asserts.checkMobileFriendly(pages);
    checks.push({ desc: '移动端适配(viewport)', ok: mf.ok, detail: mf.detail });

    // 8) 结构化数据深度校验
    const sd = asserts.checkStructuredData(pages);
    checks.push({ desc: '结构化数据深度校验', ok: sd.ok, detail: sd.detail });

    // 9) Core Web Vitals 影响因素
    const cwv = asserts.checkCoreWebVitals(pages);
    checks.push({ desc: 'Core Web Vitals(CLS/阻塞script)', ok: cwv.ok, detail: cwv.detail });

    // GEO 断言
    const faq = asserts.checkFaqContent(pages);
    checks.push({ desc: 'FAQ/QA内容(GEO)', ok: faq.ok, detail: faq.detail });
    const sem = asserts.checkSemanticHtml(pages);
    checks.push({ desc: '语义化HTML(GEO)', ok: sem.ok, detail: sem.detail });
    const cs = asserts.checkContentStructure(pages);
    checks.push({ desc: 'heading层次(GEO)', ok: cs.ok, detail: cs.detail });
    const cit = asserts.checkAiCitations(pages);
    checks.push({ desc: '引用/来源(GEO)', ok: cit.ok, detail: cit.detail });

    // SEO 增强断言
    const tc = asserts.checkTwitterCard(pages);
    checks.push({ desc: 'Twitter Card', ok: tc.ok, detail: tc.detail });
    const oge = asserts.checkOpenGraphEnhanced(pages);
    checks.push({ desc: '增强OG标签(og:type/site_name/locale)', ok: oge.ok, detail: oge.detail });
    const atq = asserts.checkAnchorTextQuality(pages);
    checks.push({ desc: '锚文本质量', ok: atq.ok, detail: atq.detail });
    const ill = asserts.checkImageLazyLoad(pages);
    checks.push({ desc: '图片懒加载', ok: ill.ok, detail: ill.detail });
    const acc = asserts.checkAccessibility(pages); checks.push({ desc: '无障碍(aria)', ok: acc.ok, detail: acc.detail });
    const il = asserts.checkInternalLinks(pages); checks.push({ desc: '内链结构', ok: il.ok, detail: il.detail });
    const dc = asserts.checkDuplicateContent(pages); checks.push({ desc: '重复内容检测', ok: dc.ok, detail: dc.detail });
    const hl = asserts.checkHtmlLang(pages); checks.push({ desc: 'html lang属性', ok: hl.ok, detail: hl.detail });
    const bc = asserts.checkBreadcrumb(pages); checks.push({ desc: '面包屑导航', ok: bc.ok, detail: bc.detail });
    const cf = asserts.checkContentFreshness(pages); checks.push({ desc: '内容更新日期', ok: cf.ok, detail: cf.detail });
    const rm = asserts.checkRobotsMeta(pages); checks.push({ desc: 'robots meta', ok: rm.ok, detail: rm.detail });
    const cl = asserts.checkContentLength(pages); checks.push({ desc: '内容长度', ok: cl.ok, detail: cl.detail });
    const pg = asserts.checkPagination(pages); checks.push({ desc: '分页标记', ok: pg.ok, detail: pg.detail });
    const ifs = asserts.checkIframeSandbox(pages); checks.push({ desc: 'iframe安全', ok: ifs.ok, detail: ifs.detail });
    const ph = asserts.checkPreloadHints(pages); checks.push({ desc: 'preload提示', ok: ph.ok, detail: ph.detail });
    const imf = asserts.checkImageFormat(pages); checks.push({ desc: '图片格式', ok: imf.ok, detail: imf.detail });
    const dt = asserts.checkHtmlDoctype(pages); checks.push({ desc: 'DOCTYPE声明', ok: dt.ok, detail: dt.detail });
    const vs = asserts.checkViewportScale(pages); checks.push({ desc: 'viewport scale', ok: vs.ok, detail: vs.detail });
    const tl = asserts.checkTitleLength(pages); checks.push({ desc: 'title长度', ok: tl.ok, detail: tl.detail });
    const dl = asserts.checkDescriptionLength(pages); checks.push({ desc: 'description长度', ok: dl.ok, detail: dl.detail });
    const idm = asserts.checkImageDimensions(pages); checks.push({ desc: '图片尺寸', ok: idm.ok, detail: idm.detail });
    const mc = asserts.checkMixedContent(pages); checks.push({ desc: '混合内容', ok: mc.ok, detail: mc.detail });
    const elr = asserts.checkExternalLinkRel(pages); checks.push({ desc: '外链rel安全', ok: elr.ok, detail: elr.detail });
    const fv = asserts.checkFavicon(pages); checks.push({ desc: 'favicon', ok: fv.ok, detail: fv.detail });
    const ns = asserts.checkNoscriptFallback(pages); checks.push({ desc: 'noscript降级', ok: ns.ok, detail: ns.detail });
    const sl = asserts.checkSkipLink(pages); checks.push({ desc: 'skip-link', ok: sl.ok, detail: sl.detail });
    const fl = asserts.checkFormLabel(pages); checks.push({ desc: '表单label', ok: fl.ok, detail: fl.detail });
    const th = asserts.checkTableHeader(pages); checks.push({ desc: '表格表头', ok: th.ok, detail: th.detail });
    const lr = asserts.checkLandmarkRegions(pages); checks.push({ desc: '地标区域', ok: lr.ok, detail: lr.detail });
    const ar = asserts.checkAriaRolesValid(pages); checks.push({ desc: 'ARIA role', ok: ar.ok, detail: ar.detail });
    const fd = asserts.checkFontDisplay(pages); checks.push({ desc: 'font-display', ok: fd.ok, detail: fd.detail });
    const ps = asserts.checkPrintStylesheet(pages); checks.push({ desc: '打印样式', ok: ps.ok, detail: ps.detail });
    const mj = asserts.checkManifestJson(pages); checks.push({ desc: 'manifest', ok: mj.ok, detail: mj.detail });
    const uc = asserts.checkUrlCanonicalization(pages); checks.push({ desc: 'URL规范化', ok: uc.ok, detail: uc.detail });
    const hc = asserts.checkHeadingCount(pages); checks.push({ desc: 'H2数量', ok: hc.ok, detail: hc.detail });
    const wc = asserts.checkWordCount(pages); checks.push({ desc: '正文词数', ok: wc.ok, detail: wc.detail });
    const ltd = asserts.checkLinkTextDescriptive(pages); checks.push({ desc: '链接文本描述性', ok: ltd.ok, detail: ltd.detail });
    const iaq = asserts.checkImageAltQuality(pages); checks.push({ desc: 'alt质量', ok: iaq.ok, detail: iaq.detail });
    const vsu = asserts.checkVideoSubtitle(pages); checks.push({ desc: '视频字幕', ok: vsu.ok, detail: vsu.detail });
    const sh1 = asserts.checkSingleH1(pages); checks.push({ desc: '单一H1', ok: sh1.ok, detail: sh1.detail });
    const mr = asserts.checkMetaRefresh(pages); checks.push({ desc: 'meta-refresh', ok: mr.ok, detail: mr.detail });
    const is = asserts.checkInlineScript(pages); checks.push({ desc: '内联script', ok: is.ok, detail: is.detail });
    const tts = asserts.checkTapTargetSize(pages); checks.push({ desc: '触摸目标尺寸', ok: tts.ok, detail: tts.detail });
    const fs = asserts.checkFontSize(pages); checks.push({ desc: '字号', ok: fs.ok, detail: fs.detail });
    const ca = asserts.checkCrawlableAnchors(pages); checks.push({ desc: '锚点可抓取', ok: ca.ok, detail: ca.detail });
    const di = asserts.checkDuplicateId(pages); checks.push({ desc: '重复id', ok: di.ok, detail: di.detail });
    const bn = asserts.checkButtonName(pages); checks.push({ desc: '按钮名称', ok: bn.ok, detail: bn.detail });
    const eh = asserts.checkEmptyHeading(pages); checks.push({ desc: '空heading', ok: eh.ok, detail: eh.detail });
    const ln = asserts.checkLinkName(pages); checks.push({ desc: '链接名称', ok: ln.ok, detail: ln.detail });
    const ho = asserts.checkHttpsOnly(pages); checks.push({ desc: 'HTTPS', ok: ho.ok, detail: ho.detail });
    const vus = asserts.checkViewportUserScalable(pages); checks.push({ desc: 'viewport缩放', ok: vus.ok, detail: vus.detail });
    const vl = asserts.checkValidLang(pages); checks.push({ desc: 'lang有效', ok: vl.ok, detail: vl.detail });
    const av = asserts.checkAutocompleteValid(pages); checks.push({ desc: 'autocomplete', ok: av.ok, detail: av.detail });
    const ahf = asserts.checkAriaHiddenFocus(pages); checks.push({ desc: 'aria-hidden焦点', ok: ahf.ok, detail: ahf.detail });
    const tiv = asserts.checkTabindexValid(pages); checks.push({ desc: 'tabindex', ok: tiv.ok, detail: tiv.detail });
    const tcap = asserts.checkTableCaption(pages); checks.push({ desc: '表格caption', ok: tcap.ok, detail: tcap.detail });
    const sv = asserts.checkScopeAttrValid(pages); checks.push({ desc: 'scope属性', ok: sv.ok, detail: sv.detail });
    const ndw = asserts.checkNoDocumentWrite(pages); checks.push({ desc: '无document.write', ok: ndw.ok, detail: ndw.detail });
    const nme = asserts.checkNoMutationEvents(pages); checks.push({ desc: '无MutationEvents', ok: nme.ok, detail: nme.detail });
    const dli = asserts.checkDlItem(pages); checks.push({ desc: 'dl结构', ok: dli.ok, detail: dli.detail });
    const net = asserts.checkNoEmptyTable(pages); checks.push({ desc: '无空table', ok: net.ok, detail: net.detail });
    const pp = asserts.checkPasswordPaste(pages); checks.push({ desc: '密码可粘贴', ok: pp.ok, detail: pp.detail });
    const neah = asserts.checkNoEmphasisAsHeading(pages); checks.push({ desc: '无b/strong模拟标题', ok: neah.ok, detail: neah.detail });
    const ni = asserts.checkNestedInteractive(pages); checks.push({ desc: '无交互嵌套', ok: ni.ok, detail: ni.detail });
    const ls = asserts.checkListStructure(pages); checks.push({ desc: '列表结构', ok: ls.ok, detail: ls.detail });
    const li = asserts.checkListItem(pages); checks.push({ desc: 'li在列表内', ok: li.ok, detail: li.detail });
    const ira = asserts.checkImageRedundantAlt(pages); checks.push({ desc: 'alt不重复', ok: ira.ok, detail: ira.detail });
    const nof = asserts.checkNoOldFlexbox(pages); checks.push({ desc: '无旧flexbox', ok: nof.ok, detail: nof.detail });
    const gos = asserts.checkGeolocationOnStart(pages); checks.push({ desc: '无启动地理位置', ok: gos.ok, detail: gos.detail });
  } else {
    checks.push({ desc: '页面Meta完整(title/desc/canonical/OG/JSON-LD)', ok: false, detail: '抽样页面均不可达' });
  }

  // 10) 安全头（从首页响应头读取）
  if (home.headers) {
    const sh = asserts.checkSecurityHeaders(home.headers, ['strict-transport-security', 'x-content-type-options']);
    checks.push({ desc: '安全头(HSTS/X-Content-Type)', ok: sh.ok, detail: sh.detail });
    const ch = asserts.checkCacheHeaders(home.headers); checks.push({ desc: '缓存头(Cache-Control)', ok: ch.ok, detail: ch.detail });
    const csp = asserts.checkCspPresent(home.headers); checks.push({ desc: 'CSP头', ok: csp.ok, detail: csp.detail });
    const xfo = asserts.checkXFrameOptions(home.headers); checks.push({ desc: 'X-Frame-Options', ok: xfo.ok, detail: xfo.detail });
    const rp = asserts.checkReferrerPolicy(home.headers); checks.push({ desc: 'Referrer-Policy', ok: rp.ok, detail: rp.detail });
    const tc2 = asserts.checkTextCompression(home.headers); checks.push({ desc: '文本压缩', ok: tc2.ok, detail: tc2.detail });
  }

  // 11) AI 爬虫可抓取性（GEO）
  const aiCrawl = asserts.checkAiCrawlable((rb.body || ''));
  checks.push({ desc: 'AI爬虫可抓取(GEO)', ok: aiCrawl.ok, detail: aiCrawl.detail });

  return {
    name: site.name,
    checks,
    online: true,
    fetches: results.length,
    totalMs: results.reduce((a, r) => a + (r.ms || 0), 0),
  };
}

module.exports = { verifySite, httpGetText };
