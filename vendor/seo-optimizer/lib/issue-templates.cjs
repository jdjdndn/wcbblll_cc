/*
 * lib/issue-templates.cjs —— 问题分类与修复模板（零成本确定性诊断）
 *
 * 按问题 type + actual 模式匹配，将问题归类到标准类型并关联修复模板。
 * 供 AI 审计（ai-audit.cjs）优先使用：模板匹配命中 → 直接给出修复建议（不调 AI），
 * 未命中 → 降级到 AI 生成建议。
 */
'use strict';

const TEMPLATES = [
  { id: 'missing-title', match: { type: 'page-quality', actual: /缺title/ }, fix: '在 <head> 中添加 <title> 标签，内容为页面核心关键词', verify: '重建后重跑 --verify-only' },
  { id: 'title-too-long', match: { type: 'page-quality', actual: /title超长/ }, fix: '缩短 <title> 至 60 字符以内', verify: '重建后重跑 --verify-only' },
  { id: 'missing-description', match: { type: 'page-quality', actual: /缺description/ }, fix: '添加 <meta name="description" content="页面描述（≤160字）">', verify: '重建后重跑 --verify-only' },
  { id: 'desc-too-short', match: { type: 'page-quality', actual: /description过短/ }, fix: '扩充 description 至 80 字符以上', verify: '重建后重跑 --verify-only' },
  { id: 'canonical-mismatch', match: { type: 'page-quality', actual: /canonical不符/ }, fix: '修正 <link rel="canonical" href="正确URL">', verify: '部署后重跑 --smoke' },
  { id: 'missing-og', match: { type: 'page-quality', actual: /缺og:/ }, fix: '添加对应 OG meta 标签（og:title/og:description/og:image/og:url）', verify: '重建后重跑 --verify-only' },
  { id: 'missing-jsonld', match: { type: 'page-quality', actual: /缺合法JSON-LD/ }, fix: '添加 <script type="application/ld+json"> 结构化数据', verify: '重建后重跑 --verify-only' },
  { id: 'broken-link', match: { type: 'link-health', actual: /死链/ }, fix: '修正或删除失效的 href 指向', verify: '重建后重跑 --verify-only' },
  { id: 'missing-alt', match: { type: 'link-health', actual: /缺alt/ }, fix: '为 <img> 添加 alt 属性（描述图片内容）', verify: '重建后重跑 --verify-only' },
  { id: 'sitemap-missing', match: { type: 'sitemap', actual: /loc无产物|loc不可达/ }, fix: '补建页面或从 sitemap 移除该 loc', verify: '重建后重跑 --verify-only' },
  { id: 'sitemap-wrong-host', match: { type: 'sitemap', actual: /域名不符/ }, fix: '修正 sitemap 中 loc 的域名', verify: '重建后重跑 --verify-only' },
  { id: 'sitemap-not-in', match: { type: 'sitemap', actual: /产物未收录/ }, fix: '在 sitemap.xml 中添加缺失页面的 <url><loc>', verify: '重建后重跑 --verify-only' },
  { id: 'fetch-dependency', match: { type: 'not-contains', actual: /fetch/ }, fix: '将动态 fetch 改为构建时静态化（预渲染）', verify: '重建后重跑 --verify-only' },
  { id: 'missing-viewport', match: { type: 'mobile-friendly', actual: /缺viewport/ }, fix: '添加 <meta name="viewport" content="width=device-width, initial-scale=1">', verify: '重建后重跑 --verify-only' },
  { id: 'bad-viewport', match: { type: 'mobile-friendly', actual: /viewport不合理/ }, fix: '修正 viewport content 为 width=device-width, initial-scale=1', verify: '重建后重跑 --verify-only' },
  { id: 'security-header-missing', match: { type: 'security-headers', actual: /缺失/ }, fix: '在 wrangler.jsonc headers 或服务器配置中添加安全响应头', verify: '部署后重跑 --smoke' },
  { id: 'cls-img', match: { type: 'core-web-vitals', actual: /CLS/ }, fix: '为 <img> 添加 width 和 height 属性（防 CLS）', verify: '重建后重跑 --verify-only' },
  { id: 'blocking-script', match: { type: 'core-web-vitals', actual: /阻塞script/ }, fix: '为 <script> 添加 defer 或 async 属性', verify: '重建后重跑 --verify-only' },
  { id: 'image-lazy-load', match: { type: 'image-lazy-load', actual: /loading/ }, fix: '为 <img> 添加 loading="lazy" 属性', verify: '重建后重跑 --verify-only' },
  { id: 'twitter-card', match: { type: 'twitter-card', actual: /缺/ }, fix: '添加 Twitter Card meta 标签（twitter:card/title/description）', verify: '重建后重跑 --verify-only' },
  { id: 'jsonld-invalid', match: { type: 'structured-data', actual: /解析失败/ }, fix: '修正 JSON-LD 为合法 JSON', verify: '重建后重跑 --verify-only' },
  { id: 'heading-skip', match: { type: 'content-structure', actual: /跳级/ }, fix: '修正 heading 层次不跳级', verify: '重建后重跑 --verify-only' },
  { id: 'jsonld-missing-props', match: { type: 'structured-data', actual: /缺/ }, fix: '补全 JSON-LD required 属性', verify: '重建后重跑 --verify-only' },
  { id: 'jsonld-none', match: { type: 'structured-data', actual: /缺JSON-LD/ }, fix: '添加 JSON-LD 结构化数据脚本', verify: '重建后重跑 --verify-only' },
  { id: 'home-unreachable', match: { type: 'online-verify', actual: /首页|HTTP/ }, fix: '检查站点部署状态和 DNS 配置', verify: '部署后重跑 --smoke' },
  { id: 'robots-no-sitemap', match: { type: /robots|online-verify/, actual: /未声明|robots/ }, fix: '在 robots.txt 中添加 Sitemap: 声明', verify: '部署后重跑 --smoke' },
  { id: '404-wrong', match: { type: 'online-verify', actual: /404/ }, fix: '检查 wrangler.jsonc 404 配置', verify: '部署后重跑 --smoke' },
  { id: 'missing-favicon', match: { type: 'favicon', actual: /缺favicon/ }, fix: '在 <head> 中添加 <link rel="icon" href="/favicon.ico">', verify: '重建后重跑 --verify-only' },
  { id: 'missing-noscript', match: { type: 'noscript-fallback', actual: /缺noscript/ }, fix: '为依赖 JS 的页面添加 <noscript> 降级内容', verify: '重建后重跑 --verify-only' },
  { id: 'missing-skip-link', match: { type: 'skip-link', actual: /缺skip-link/ }, fix: '在 <body> 开头添加 <a href="#main">跳到主内容</a>', verify: '重建后重跑 --verify-only' },
  { id: 'missing-dimensions', match: { type: 'image-dimensions', actual: /缺width\/height/ }, fix: '为 <img> 添加 width 和 height 属性', verify: '重建后重跑 --verify-only' },
  { id: 'mixed-content', match: { type: 'mixed-content', actual: /http资源/ }, fix: '将 http:// 资源改为 https://', verify: '部署后重跑 --smoke' },
  { id: 'external-rel', match: { type: 'external-link-rel', actual: /缺rel/ }, fix: '为外链添加 rel="noopener noreferrer"', verify: '重建后重跑 --verify-only' },
  { id: 'missing-form-label', match: { type: 'form-label', actual: /缺label/ }, fix: '为 <input> 添加关联 <label for> 或 aria-label', verify: '重建后重跑 --verify-only' },
  { id: 'missing-table-header', match: { type: 'table-header', actual: /缺thead/ }, fix: '为 <table> 添加 <thead> 或 <th> 表头', verify: '重建后重跑 --verify-only' },
  { id: 'missing-landmark', match: { type: 'landmark-regions', actual: /缺/ }, fix: '添加语义地标标签 <header>/<nav>/<main>/<footer>', verify: '重建后重跑 --verify-only' },
  { id: 'invalid-aria-role', match: { type: 'aria-roles-valid', actual: /无效role/ }, fix: '修正 role 属性为有效的 ARIA role 值', verify: '重建后重跑 --verify-only' },
  { id: 'missing-font-display', match: { type: 'font-display', actual: /缺font-display/ }, fix: '为 @font-face 添加 font-display: swap', verify: '重建后重跑 --verify-only' },
  { id: 'missing-print-css', match: { type: 'print-stylesheet', actual: /缺打印/ }, fix: '添加 <link media="print"> 或 @media print 样式', verify: '重建后重跑 --verify-only' },
  { id: 'missing-manifest', match: { type: 'manifest-json', actual: /缺manifest/ }, fix: '添加 <link rel="manifest" href="/manifest.json">', verify: '重建后重跑 --verify-only' },
  { id: 'url-upper', match: { type: 'url-canonicalization', actual: /大写/ }, fix: '将 URL 转为小写', verify: '重建后重跑 --verify-only' },
  { id: 'title-too-short', match: { type: 'title-length', actual: /字/ }, fix: '扩充 <title> 至 10 字符以上', verify: '重建后重跑 --verify-only' },
  { id: 'desc-too-long', match: { type: 'description-length', actual: /字/ }, fix: '缩短 description 至 160 字符以内', verify: '重建后重跑 --verify-only' },
  { id: 'heading-count-low', match: { type: 'heading-count', actual: /H2/ }, fix: '添加 H2 子标题改善内容结构', verify: '重建后重跑 --verify-only' },
  { id: 'word-count-low', match: { type: 'word-count', actual: /词/ }, fix: '扩充正文内容至 300 词以上', verify: '重建后重跑 --verify-only' },
  { id: 'link-text-bad', match: { type: 'link-text-descriptive', actual: /非描述性/ }, fix: '将"点击这里"等改为描述性链接文本', verify: '重建后重跑 --verify-only' },
  { id: 'alt-quality-bad', match: { type: 'image-alt-quality', actual: /低质量alt/ }, fix: '将文件名 alt 改为描述性文本或空（装饰性）', verify: '重建后重跑 --verify-only' },
  { id: 'video-no-subtitle', match: { type: 'video-subtitle', actual: /缺track/ }, fix: '为 <video> 添加 <track kind="captions"> 字幕', verify: '重建后重跑 --verify-only' },
  { id: 'h1-not-single', match: { type: 'single-h1', actual: /H1/ }, fix: '确保每页只有一个 <h1>，多余改为 <h2>', verify: '重建后重跑 --verify-only' },
  { id: 'meta-refresh-present', match: { type: 'meta-refresh', actual: /meta-refresh/ }, fix: '移除 <meta http-equiv="refresh"> 跳转', verify: '重建后重跑 --verify-only' },
  { id: 'inline-script-too-many', match: { type: 'inline-script', actual: /内联/ }, fix: '将内联 script 移到外部 .js 文件', verify: '重建后重跑 --verify-only' },
  { id: 'cache-header-missing', match: { type: 'cache-headers', actual: /Cache-Control/ }, fix: '在服务器配置中添加 Cache-Control 响应头', verify: '部署后重跑 --smoke' },
  { id: 'csp-missing', match: { type: 'csp-present', actual: /Content-Security-Policy/ }, fix: '添加 Content-Security-Policy 响应头', verify: '部署后重跑 --smoke' },
  { id: 'xfo-missing', match: { type: 'x-frame-options', actual: /X-Frame-Options/ }, fix: '添加 X-Frame-Options: DENY 响应头', verify: '部署后重跑 --smoke' },
  { id: 'referrer-policy-missing', match: { type: 'referrer-policy', actual: /Referrer-Policy/ }, fix: '添加 Referrer-Policy: strict-origin-when-cross-origin 响应头', verify: '部署后重跑 --smoke' },
  { id: 'tap-target-small', match: { type: 'tap-target-size', actual: /小触摸目标/ }, fix: '增大触摸目标至 48x48px 以上', verify: '重建后重跑 --verify-only' },
  { id: 'font-size-small', match: { type: 'font-size', actual: /小字号/ }, fix: '增大字号至 12px 以上', verify: '重建后重跑 --verify-only' },
  { id: 'anchor-not-crawlable', match: { type: 'crawlable-anchors', actual: /不可抓取/ }, fix: '将 javascript: 锚点改为有效 href', verify: '重建后重跑 --verify-only' },
  { id: 'dup-id', match: { type: 'duplicate-id', actual: /重复id/ }, fix: '为重复的 id 添加唯一后缀', verify: '重建后重跑 --verify-only' },
  { id: 'button-no-name', match: { type: 'button-name', actual: /无名/ }, fix: '为 <button> 添加文本或 aria-label', verify: '重建后重跑 --verify-only' },
  { id: 'heading-empty', match: { type: 'empty-heading', actual: /空heading/ }, fix: '为空 heading 添加内容或移除', verify: '重建后重跑 --verify-only' },
  { id: 'link-no-name', match: { type: 'link-name', actual: /无名/ }, fix: '为 <a> 添加文本或 aria-label', verify: '重建后重跑 --verify-only' },
  { id: 'not-https', match: { type: 'https-only', actual: /非HTTPS/ }, fix: '迁移到 HTTPS（配置 SSL/TLS）', verify: '部署后重跑 --smoke' },
  { id: 'viewport-no-scale', match: { type: 'viewport-user-scalable', actual: /user-scalable|maximum-scale/ }, fix: '移除 viewport 中 user-scalable=no 和 maximum-scale=1', verify: '重建后重跑 --verify-only' },
  { id: 'lang-invalid', match: { type: 'valid-lang', actual: /无效lang/ }, fix: '修正 <html lang> 为有效语言代码（如 en/zh-CN）', verify: '重建后重跑 --verify-only' },
  { id: 'autocomplete-invalid', match: { type: 'autocomplete-valid', actual: /无效autocomplete/ }, fix: '修正 autocomplete 属性为有效值', verify: '重建后重跑 --verify-only' },
  { id: 'aria-hidden-focus', match: { type: 'aria-hidden-focus', actual: /aria-hidden/ }, fix: '移除 aria-hidden 元素内的可聚焦元素', verify: '重建后重跑 --verify-only' },
  { id: 'tabindex-invalid', match: { type: 'tabindex-valid', actual: /tabindex/ }, fix: '将 tabindex>0 改为 0 或 -1', verify: '重建后重跑 --verify-only' },
  { id: 'table-no-caption', match: { type: 'table-caption', actual: /缺caption/ }, fix: '为 <table> 添加 <caption> 描述', verify: '重建后重跑 --verify-only' },
  { id: 'scope-invalid', match: { type: 'scope-attr-valid', actual: /无效scope/ }, fix: '修正 th scope 为有效值（row/col/rowgroup/colgroup）', verify: '重建后重跑 --verify-only' },
  { id: 'no-compression', match: { type: 'text-compression', actual: /Content-Encoding/ }, fix: '启用 gzip/brotli 压缩', verify: '部署后重跑 --smoke' },
  { id: 'document-write', match: { type: 'no-document-write', actual: /document\.write/ }, fix: '将 document.write() 改为 DOM API（textContent/innerHTML）', verify: '重建后重跑 --verify-only' },
  { id: 'mutation-events', match: { type: 'no-mutation-events', actual: /onDOM/ }, fix: '将 Mutation Events 改为 MutationObserver', verify: '重建后重跑 --verify-only' },
  { id: 'dlitem-bad', match: { type: 'dlitem', actual: /非法子元素/ }, fix: '确保 <dl> 的直接子元素只有 <dt> 和 <dd>', verify: '重建后重跑 --verify-only' },
  { id: 'empty-table', match: { type: 'no-empty-table', actual: /空table/ }, fix: '为空 <table> 添加内容或移除', verify: '重建后重跑 --verify-only' },
  { id: 'password-no-paste', match: { type: 'password-paste', actual: /禁止粘贴/ }, fix: '移除密码 input 的 onpaste="return false"', verify: '重建后重跑 --verify-only' },
  { id: 'emphasis-as-heading', match: { type: 'no-emphasis-as-heading', actual: /疑似标题/ }, fix: '将 b/strong 模拟的标题改为 <h1>-<h6>', verify: '重建后重跑 --verify-only' },
  { id: 'missing-doctype', match: { type: 'html-doctype', actual: /缺DOCTYPE/ }, fix: '在 HTML 开头添加 <!DOCTYPE html>', verify: '重建后重跑 --verify-only' },
  { id: 'iframe-no-sandbox', match: { type: 'iframe-sandbox', actual: /缺sandbox/ }, fix: '为 <iframe> 添加 sandbox 属性', verify: '重建后重跑 --verify-only' },
  { id: 'viewport-missing-scale', match: { type: 'viewport-scale', actual: /initial-scale/ }, fix: '在 viewport 中添加 initial-scale=1', verify: '重建后重跑 --verify-only' },
  { id: 'nested-interactive', match: { type: 'nested-interactive', actual: /嵌套/ }, fix: '移除交互元素的嵌套（如 a 套 a）', verify: '重建后重跑 --verify-only' },
  { id: 'list-structure-bad', match: { type: 'list-structure', actual: /非li/ }, fix: '确保 ul/ol 的直接子元素只有 li', verify: '重建后重跑 --verify-only' },
  { id: 'list-item-orphan', match: { type: 'list-item', actual: /不在ul/ }, fix: '将孤立的 li 放入 ul/ol 中', verify: '重建后重跑 --verify-only' },
  { id: 'image-redundant-alt', match: { type: 'image-redundant-alt', actual: /重复/ }, fix: '将重复的 img alt 改为空（装饰性）', verify: '重建后重跑 --verify-only' },
  { id: 'old-flexbox', match: { type: 'no-old-flexbox', actual: /display:box/ }, fix: '将 display:box 改为 display:flex', verify: '重建后重跑 --verify-only' },
  { id: 'geolocation-on-start', match: { type: 'geolocation-on-start', actual: /地理位置/ }, fix: '将 geolocation 请求移到用户交互回调中', verify: '重建后重跑 --verify-only' },
];

function matchTemplate(issue) {
  for (const t of TEMPLATES) {
    if (t.match.type) {
      if (t.match.type instanceof RegExp) { if (!t.match.type.test(issue.type || '')) continue; }
      else if (issue.type !== t.match.type) continue;
    }
    if (t.match.actual && !t.match.actual.test(issue.actual || '')) continue;
    return t;
  }
  return null;
}

function classifyIssues(issues) {
  return (issues || []).map((i) => {
    const t = matchTemplate(i);
    return Object.assign({}, i, { template: t ? { id: t.id, fix: t.fix, verify: t.verify } : null });
  });
}

module.exports = { TEMPLATES, matchTemplate, classifyIssues };
