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
      last = { status: res.status, body, error: null, ms: Date.now() - t0 };
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
  } else {
    checks.push({ desc: '页面Meta完整(title/desc/canonical/OG/JSON-LD)', ok: false, detail: '抽样页面均不可达' });
  }

  return {
    name: site.name,
    checks,
    online: true,
    fetches: results.length,
    totalMs: results.reduce((a, r) => a + (r.ms || 0), 0),
  };
}

module.exports = { verifySite, httpGetText };
