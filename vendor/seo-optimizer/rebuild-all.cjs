#!/usr/bin/env node
/*
 * rebuild-all.cjs —— 多站点一键重建 + 静态校验（共享工具，跨 E:\code 下全部站点）
 *
 * 设计要点：
 *   - 便携化：站点根目录自动探测（脚本放在任意位置都能定位到 E:\code），也支持 --root 显式指定；
 *   - 按站点调用：--site/--skip 只处理指定站点；--prebuild 供单个项目"run build 之前"调用，只重建内容+校验，
 *     不执行该站的 npm build（避免与调用方 build 互相触发形成死循环）；
 *   - 外部配置：与脚本同目录的 sites.json 为站点清单唯一来源（--dump-config 可生成），加站/改站无需改脚本本体；
 *   - 校验类型：contains / not-contains / exists / count-files / data-vs-html（数据源条目数==HTML渲染数，SEO内容可见性）
 *     / sitemap（双向一致性：loc→产物存在、产物→loc收录、域名匹配，SEO可抓取性）
 *     / page-quality（逐页断言 title/description/canonical/OG/JSON-LD，SEO页面质量）
 *     / link-health（站内 href/src 无死链 + 图片 alt 齐全，SEO链接健康）
 *     / --smoke 在线检查（HTTP 状态码+关键字，部署后验证线上）；
 *   - 只重建与校验，绝不部署；部署命令在末尾打印，由你手动执行。
 *
 * 用法（PowerShell / cmd / 批处理）：
 *   node rebuild-all.cjs                           默认：重建"内容静态化"站点 + 校验全部站点
 *   node rebuild-all.cjs --site wcbblll_cc         只处理指定站点（逗号分隔多个，如 wcbblll_cc,github.io）
 *   node rebuild-all.cjs --skip 号卡/hm            跳过指定站点
 *   node rebuild-all.cjs --prebuild wcbblll_cc     预构建模式：重建该站内容+校验，不跑其 npm build
 *                                                  （挂到项目 build/deploy 命令之前，防死循环；
 *                                                   只校验"构建前就存在"的源级配置，不会因产物缺失误拦截构建）
 *   node rebuild-all.cjs --build-ssr               额外重建 SSR 站点（内容在 D1，仅代码/配置变更后才需要）
 *   node rebuild-all.cjs --verify-only             只校验，不重建
 *   node rebuild-all.cjs --smoke                   部署后在线检查（HTTP 状态码+关键字；需先部署，验证线上SEO视角）
 *   node rebuild-all.cjs --root E:\code            显式指定站点根目录（默认自动探测）
 *   node rebuild-all.cjs --list                    列出全部站点与重建/校验配置
 *   node rebuild-all.cjs --dump-config             生成本站清单 sites.json（之后以它为准，可自行增删站点）
 *   node rebuild-all.cjs --json                    输出 JSON 结果（供 CI / 构建钩子解析）
 *   node rebuild-all.cjs --help                    帮助
 *
 * 内容变化后的标准用法：
 *   改数据文件（links-data.json / data.js / app.db / 各站数据）→ node rebuild-all.cjs → 逐站部署
 *
 * 挂在单个项目 build 之前的例子（package.json scripts）：
 *   "prebuild": "node D:/path/rebuild-all.cjs --prebuild <站点名>"
 *   说明：--prebuild 只重建内容 + 校验；内容由 npm run build 生成的站（github.io / xiaoshengyi）会自动跳过重建仅校验。
 */
'use strict';
const isMain = require.main === module;
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
function argVal(name, fallback) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] !== undefined ? argv[i + 1].trim() : fallback;
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1).trim();
  }
  return fallback;
}
const has = (n) => argv.includes(n);
const optSite = argVal('--site', null);
const optSkip = argVal('--skip', null);
const optPrebuild = argVal('--prebuild', null);
const optRoot = argVal('--root', process.env.SITES_ROOT || null);
const buildSSR = has('--build-ssr');
const verifyOnly = has('--verify-only');
const smoke = has('--smoke');
const asJson = has('--json');
const dumpConfig = has('--dump-config');
const listOnly = has('--list');
const help = has('--help');
const daily = has('--daily');
const report = has('--report');
const aiAudit = has('--ai-audit');
const watchMode = has('--watch');

if (isMain && help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0] + '*/');
  process.exit(0);
}

// ---------- 工具函数 ----------
function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function countOcc(t, pat) { if (!t) return 0; let n = 0, i = 0; while ((i = t.indexOf(pat, i)) !== -1) { n++; i += pat.length; } return n; }
function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
const _tty = process.stdout.isTTY;
const C = {
  green: (s) => _tty ? '\x1b[32m' + s + '\x1b[0m' : s,
  red: (s) => _tty ? '\x1b[31m' + s + '\x1b[0m' : s,
  yellow: (s) => _tty ? '\x1b[33m' + s + '\x1b[0m' : s,
  cyan: (s) => _tty ? '\x1b[36m' + s + '\x1b[0m' : s,
  bold: (s) => _tty ? '\x1b[1m' + s + '\x1b[0m' : s,
};
function run(cmd, cmdArgs, cwd) {
  let r;
  if ((cmd === 'npm' || cmd === 'npx') && process.platform === 'win32') {
    // Windows 下 .cmd 不能直接 spawn，走 cmd.exe /c（经 PATHEXT 解析 npm/npx）
    r = spawnSync('cmd.exe', ['/d', '/s', '/c', [cmd, ...cmdArgs].join(' ')], { cwd, encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000 });
  } else {
    r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000 });
  }
  return { ok: r.status === 0, status: r.status, tail: ((r.stdout || '') + (r.stderr || '')).slice(-800) };
}

// 在线冒烟：HTTP GET（跟随重定向，最多5跳），返回最终状态码 + body + 错误信息
function httpGet(url, timeoutMs, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve) => {
    let req;
    try {
      req = (url.startsWith('https') ? https : http).get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rebuild-all-smoke/1.0)' },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(httpGet(new URL(res.headers.location, url).toString(), timeoutMs, redirects + 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), error: null }));
      });
    } catch (e) { return resolve({ status: 0, body: '', error: e.message }); }
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(timeoutMs || 10000, () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

// --smoke：部署后在线检查（状态码 + 关键字），验证的是搜索引擎视角而非本地产物
async function runSmoke(sites, { asJson }) {
  const results = [];
  const t0 = Date.now();
  for (const s of sites) {
    const list = s.smoke || [];
    if (!list.length) { if (!asJson) console.log(`[${ts()}] [smoke] ${s.name}：未配置在线检查，跳过`); continue; }
    for (const item of list) {
      process.stdout.write(`[${ts()}] [smoke] ${s.name} ${item.url} ... `);
      const r = await httpGet(item.url, 10000);
      const statusOk = r.status === item.status;
      const bodyOk = !item.contains || r.body.includes(item.contains);
      const ok = statusOk && bodyOk && !r.error;
      console.log(ok
        ? `✓ ${r.status}${item.contains ? (bodyOk ? ' 含关键字' : ' 缺关键字') : ''}`
        : `✗ ${r.error || (r.status + (bodyOk ? '' : ' 缺关键字'))}（期望 ${item.status}）`);
      results.push({ site: s.name, url: item.url, ok, status: r.status, expect: item.status, contains: item.contains || null, bodyHit: bodyOk, error: r.error || null });
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const allOk = results.length > 0 && results.every((r) => r.ok);
  if (asJson) {
    console.log(JSON.stringify({ mode: 'smoke', totalSec: Number(sec), checks: results, allOk }, null, 2));
  } else {
    const okN = results.filter((r) => r.ok).length;
    console.log(`\n[${ts()}] === 在线检查汇总（${okN}/${results.length} 通过，耗时 ${sec}s）===`);
    for (const r of results) if (!r.ok) console.log(`  ✗ [${r.site}] ${r.url}：${r.error || ('状态 ' + r.status + ' 期望 ' + r.expect + (r.contains && !r.bodyHit ? '，缺关键字' : ''))}`);
    if (results.length === 0) console.log('  未配置任何 smoke 检查项（站点定义中加 smoke: [{url,status,contains}]）。');
  }
  return allOk;
}

// ---------- 站点根目录（便携化：自动探测 + 可覆盖） ----------
function detectRoot(startDir) {
  const markers = ['wcbblll_cc', 'article-site', 'github.io'];
  let dir = path.resolve(startDir);
  for (;;) {
    if (markers.every((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：找不到 markers 时，若当前目录是站点子目录（如 github.io/），返回其父目录
  const base = path.basename(path.resolve(startDir));
  const parent = path.dirname(path.resolve(startDir));
  if (base !== 'code' && fs.existsSync(path.join(parent, 'github.io'))) return parent;
  return path.resolve(startDir);
}
const ROOT = optRoot ? path.resolve(optRoot) : detectRoot(path.dirname(__filename));

// ---------- 站点定义（内置默认；sites.json 存在时以它为准） ----------
const P = (...s) => path.join(ROOT, ...s);
const chk = (desc, type, file, pattern, min) => ({ desc, type, file, pattern, min });

// @deprecated 仅作首次初始化兜底（--dump-config 生成 rebuild.config.json）。
// 运行时始终以 rebuild.config.json 为唯一事实源（loadSites 优先读取）。
// 站点增删改 rebuild.config.json，勿手动维护本函数与 config 的同步。
function defaultSites() {
  const SITES = [];
  function site(name, dir, opts) { SITES.push(Object.assign({ name, dir, build: null, verify: [], deploy: [] }, opts)); }

  // 1. wcbblll_cc —— 旗舰静态站（内容源 links-data.json；regen==build，均可独立调用）
  site('wcbblll_cc', P('wcbblll_cc'), {
    rebuild: true,
    build: ['node', ['build-static.mjs']],
    regen: ['node', ['build-static.mjs']],
    verify: [
      chk('链接数据全量静态化进HTML', 'data-vs-html', 'index.html', { dataFile: 'links-data.json', dataPath: 'links', htmlPattern: 'class="link-card"' }),
      chk('核心内容不再依赖fetch', 'not-contains', 'index.html', "fetch('links-data.json')"),
      chk('sitemap与页面产物双向一致', 'sitemap', 'sitemap.xml', { domain: 'https://wcbblll.cc', pageFiles: ['index.html', 'category/*.html'] }),
      chk('页面Meta完整(title/desc/canonical/OG/JSON-LD)', 'page-quality', 'index.html', { pages: ['index.html', 'category/*.html'], canonical: 'https://wcbblll.cc', og: ['og:title', 'og:description', 'og:image', 'og:url'], jsonld: true }),
      chk('站内链接无死链+图片alt齐全', 'link-health', 'index.html', { pages: ['index.html', 'category/*.html'] }),
      chk('分类页已生成', 'count-files', 'category', '.html', 12),
      chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
    ],
    deploy: [`cd ${P('wcbblll_cc')} && npx wrangler deploy`],
    smoke: [
      { url: 'https://wcbblll.cc/', status: 200, contains: 'link-card' },
      { url: 'https://wcbblll.cc/category/ecommerce.html', status: 200, contains: 'link-card' },
      { url: 'https://wcbblll.cc/sitemap.xml', status: 200, contains: '<loc>' },
      { url: 'https://wcbblll.cc/robots.txt', status: 200 },
      { url: 'https://wcbblll.cc/__smoke_missing__.html', status: 404 },
    ],
  });

  // 2. github.io —— Vite + 预渲染（内容由 npm run build 生成；预构建模式下仅做源级校验）
  site('github.io', P('github.io'), {
    rebuild: true,
    build: ['npm', ['run', 'build']],
    regenIsBuild: true,
    prechecks: [
      chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
    ],
    verify: [
      chk('首页含预渲染区块', 'contains', 'dist/index.html', 'seo-prerender-full'),
      chk('首页含优惠正文', 'contains', 'dist/index.html', '美团外卖红包'),
      chk('sitemap条目充足(>=900)', 'contains', 'dist/sitemap.xml', '<loc>', 900),
      chk('404页存在', 'exists', 'dist/404.html'),
      chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
    ],
    deploy: [`cd ${P('github.io')} && git add dist && git commit -m "build" && git push`, `cd ${P('github.io')} && npm run cf:build && npm run cf:deploy`],
  });

  // 3. xiaoshengyi —— Vue SPA + 构建期预渲染（内容由 npm run build 生成；预构建模式下仅做源级校验）
  site('xiaoshengyi', P('xiaoshengyi'), {
    rebuild: true,
    build: ['npm', ['run', 'build']],
    buildDir: P('xiaoshengyi', 'web'),
    regenIsBuild: true,
    prechecks: [
      chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
    ],
    verify: [
      chk('首页含预渲染列表', 'contains', 'web/dist/index.html', 'data-prerender'),
      chk('sitemap已生成', 'contains', 'web/dist/sitemap.xml', '<loc>'),
      chk('404页存在', 'exists', 'web/dist/404.html'),
      chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
    ],
    deploy: [`cd ${P('xiaoshengyi')} && npx wrangler deploy`],
  });

  // 4. 号卡/dlhaoka —— 纯静态站（内容直接改 public/index.html，无需构建）
  site('号卡/dlhaoka', P('号卡', 'dlhaoka'), {
    rebuild: false,
    build: null,
    verify: [
      chk('sitemap已生成', 'contains', 'public/sitemap.xml', '<loc>https://dlhaoka.com/'),
      chk('404页存在', 'exists', 'public/404.html'),
      chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
    ],
    deploy: [`cd ${P('号卡', 'dlhaoka')} && npx wrangler deploy`],
  });

  // 5. article-site —— Nuxt4 SSR（内容在 D1，改内容无需本地重建）
  site('article-site', P('article-site'), {
    rebuild: false, ssr: true,
    build: ['npm', ['run', 'build']],
    verify: [
      chk('wrangler已配404(none)', 'contains', 'wrangler.jsonc', '"none"'),
      chk('robots声明Sitemap', 'contains', 'public/robots.txt', 'Sitemap:'),
    ],
    deploy: [`cd ${P('article-site')} && npm run build && npx wrangler deploy`],
  });

  // 6. 号卡 Nuxt SSR 站
  ['172', 'gc', 'hk'].forEach((s) => {
    site('号卡/' + s, P('号卡', s), {
      rebuild: false, ssr: true,
      build: ['npm', ['run', 'build']],
      verify: [
        chk('wrangler已配404(none)', 'contains', 'wrangler.jsonc', '"none"'),
        chk('robots声明Sitemap', 'contains', 'public/robots.txt', 'Sitemap:'),
      ],
      deploy: [`cd ${P('号卡', s)} && npm run build && npx wrangler deploy`],
    });
  });
  ['hm', 'kd', 'ksj', 'yk'].forEach((s) => {
    site('号卡/' + s, P('号卡', s), {
      rebuild: false, ssr: true,
      build: ['npx', ['nuxt', 'build']],
      verify: [
        chk('wrangler已配404(none)', 'contains', 'wrangler.jsonc', '"none"'),
        chk('robots声明Sitemap', 'contains', 'public/robots.txt', 'Sitemap:'),
        chk('文章404逻辑已修复', 'contains', path.join('app', 'pages', 'article', '[id].vue'), 'statusCode: 404'),
      ],
      deploy: [`cd ${P('号卡', s)} && npm run build && npx wrangler deploy`],
    });
  });

  // 7. 随身wifi —— Nuxt4 SSR
  ['chaoneng-wifi', 'feilimao-wifi', 'gexing-wifi', 'liantong-wifi'].forEach((s) => {
    site('随身wifi/' + s, P('随身wifi', s), {
      rebuild: false, ssr: true,
      build: ['npx', ['nuxt', 'build']],
      verify: [
        chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
      ],
      deploy: [`cd ${P('随身wifi', s)} && npm run build && npx wrangler deploy`],
    });
  });

  // 8. 信用卡 —— Nuxt4 SSR
  ['kahe', 'suishou', 'zhangshang'].forEach((s) => {
    site('信用卡/' + s, P('信用卡', s), {
      rebuild: false, ssr: true,
      build: ['npm', ['run', 'build']],
      verify: [
        chk('wrangler已配404(none)', 'contains', 'wrangler.jsonc', '"none"'),
        chk('sitemap路由已新增', 'exists', path.join('server', 'routes', 'sitemap.xml.get.ts')),
      ],
      deploy: [`cd ${P('信用卡', s)} && npm run build && npm run deploy`],
    });
  });

  // 9. GitHub自动文章 —— 生成器（非站点，校验 P0 修复是否落地）
  site('GitHub自动文章', P('GitHub自动文章'), {
    rebuild: false,
    build: null,
    verify: [
      chk('P0修复已落地(key兜底反查)', 'contains', path.join('template', 'src', 'index.js'), 'item.date'),
    ],
    deploy: ['（文章系统修复后：git push 触发 CI 部署，见该项目 README）'],
  });

  return SITES;
}

// ---------- 站点清单：sites.json 存在则以其为准（可增删站点），否则用内置 ----------
const _configCandidates = ['rebuild.config.json', 'sites.json'].map((f) => path.join(path.dirname(__filename), f));
const CONFIG_PATH = _configCandidates.find((f) => fs.existsSync(f)) || _configCandidates[0];
function loadSites() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.sites || []);
      if (!Array.isArray(arr) || !arr.length) throw new Error('sites.json 结构无效');
      if (process.env.SITES_ROOT && raw.sitesRoot) {
        const root = process.env.SITES_ROOT.replace(/\\/g, '/');
        const localRoot = raw.sitesRoot.replace(/\\/g, '/');
        for (const s of arr) {
          if (s.dir) s.dir = s.dir.replace(/\\/g, '/').replace(localRoot, root);
          if (s.buildDir) s.buildDir = s.buildDir.replace(/\\/g, '/').replace(localRoot, root);
          if (s.deploy) s.deploy = s.deploy.map((d) => d.replace(/\\/g, '/').replace(localRoot, root));
          for (const key of ['verify', 'prechecks']) {
            if (s[key]) s[key] = s[key].map((c) => { if (c.file) c.file = c.file.replace(/\\/g, '/'); return c; });
          }
        }
      }
      return arr;
    } catch (e) {
      console.error(`[warn] 读取 ${CONFIG_PATH} 失败（${e.message}），回退到内置站点清单。`);
    }
  }
  return defaultSites();
}
let sites = loadSites();

// 站点选择 / 跳过 / 预构建
const prebuildMode = !!optPrebuild;
if (optSite || optPrebuild) {
  const names = (optPrebuild || optSite).split(',').map((s) => s.trim()).filter(Boolean);
  const hit = new Set(names);
  sites = sites.filter((s) => hit.has(s.name));
  if (!sites.length) {
    console.error(`[error] 未找到站点：${names.join(', ')}。可用站点见 --list。`);
    process.exit(2);
  }
  // standalone/CI 克隆：detectRoot 得到的 ROOT 下不存在 monorepo 路径（如 号卡/ksj），
  // 但脚本目录本身就是站点（含 wrangler.jsonc）时，回退用脚本目录，避免校验路径落空报 0/1
  const scriptDir = path.dirname(__filename);
  for (const s of sites) {
    if (!fs.existsSync(s.dir) && fs.existsSync(path.join(scriptDir, 'wrangler.jsonc'))) {
      s.dir = scriptDir;
    }
  }
}
if (optSkip) {
  const names = optSkip.split(',').map((s) => s.trim());
  sites = sites.filter((s) => !names.includes(s.name));
}

if (isMain && dumpConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultSites(), null, 2), 'utf8');
  console.log(`[ok] 已生成站点清单：${CONFIG_PATH}（${defaultSites().length} 个站点；之后以该文件为准，可自行增删条目）`);
  process.exit(0);
}

if (isMain && listOnly) {
  console.log(`站点根目录：${ROOT}\n`);
  const pad = (t, n) => { t = String(t); return t.length >= n ? t : t + ' '.repeat(n - t.length); };
  console.log(pad('站点', 24) + pad('内容重建', 9) + pad('SSR', 5) + '说明');
  for (const s of sites) {
    const kind = s.rebuild ? '静态化重建' : (s.regen ? '内容重建' : (s.build ? '构建时生成' : '—'));
    console.log(pad(s.name, 24) + pad(kind, 9) + pad(s.ssr ? '是' : '—', 5) + (s.rebuild ? '内容变化后需跑重建' : '内容在 D1/静态，无需本地重建'));
  }
  process.exit(0);
}

// ---------- 执行 ----------
if (isMain && watchMode) {
  const watchFiles = sites.flatMap((s) => ['links-data.json', 'data.json', 'data.js'].map((f) => path.join(s.dir, f)).filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }));
  if (!watchFiles.length) { console.error(C.red('[error] 未找到可监听的数据文件')); process.exit(1); }
  console.log(C.cyan(`[watch] 监听 ${watchFiles.length} 个数据文件，变化时自动校验（Ctrl+C 退出）...`));
  let debounce = null;
  for (const f of watchFiles) {
    try {
      fs.watch(f, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log(C.cyan(`\n[${ts()}] [watch] 检测到变化，重新校验...`));
          const r = spawnSync(process.execPath, [__filename, '--verify-only', '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000 });
          try {
            const out = (r.stdout || '') + (r.stderr || '');
            const json = JSON.parse(out.slice(out.indexOf('{')));
            const passN = (json.sites || []).filter((s) => s.ok).length;
            console.log(json.allOk ? C.green(`✓ 全部通过（${passN}/${(json.sites || []).length} 站）`) : C.red(`✗ 有失败（${passN}/${(json.sites || []).length} 站通过）`));
          } catch (e) { console.log(C.red('解析输出失败')); }
        }, 1000);
      });
    } catch (e) { /* 文件监听失败：跳过 */ }
  }
  setInterval(() => {}, 1000000);
} else if (isMain && daily) {
  // 每日持久巡检：本地 verify + 线上 smoke + 线上断言 + deadline + 产物保护 → runs/ 落盘 + report.html
  (async () => {
    try {
      const { runDaily } = require('./lib/daily.cjs');
      const rec = await runDaily({ aiAudit });
      process.exit(rec.issues.some((i) => i.severity === 'high') ? 1 : 0);
    } catch (e) {
      console.error('[error] --daily 巡检失败：' + e.message);
      process.exit(2);
    }
  })();
} else if (isMain && report) {
  // 仅刷新看板：读取最近一次巡检记录重新渲染 report.html（不重新巡检）
  try {
    const { renderReport } = require('./lib/daily.cjs');
    const runsDir = path.join(path.dirname(__filename), 'runs');
    const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort() : [];
    if (!files.length) { console.error('[error] 无巡检记录，请先运行 --daily'); process.exit(1); }
    const latest = files[files.length - 1];
    const rec = JSON.parse(fs.readFileSync(path.join(runsDir, latest), 'utf8'));
    fs.writeFileSync(path.join(path.dirname(__filename), 'report.html'), renderReport(rec), 'utf8');
    console.log(`[ok] 已刷新 report.html（基于 ${latest}）`);
    process.exit(0);
  } catch (e) {
    console.error('[error] --report 失败：' + e.message);
    process.exit(2);
  }
} else if (isMain && smoke) {
  // 仅在线检查（部署后冒烟），不重建不本地校验
  (async () => {
    const ok = await runSmoke(sites, { asJson });
    process.exit(ok ? 0 : 1);
  })();
} else if (isMain) {
if (!asJson) {
  console.log(`[${ts()}] 站点根目录：${ROOT}`);
  if (prebuildMode) console.log(`[${ts()}] 预构建模式：${sites.map((s) => s.name).join('、')}（只重建内容+校验，不执行 npm build）`);
  else console.log(`[${ts()}] 模式：${verifyOnly ? '仅校验' : (buildSSR ? '重建全部（含 SSR）' : '重建内容静态化站点')}${optSite ? '；站点=' + optSite : ''}${optSkip ? '；跳过=' + optSkip : ''}`);
}

const results = [];
const tStart = Date.now();
for (let si = 0; si < sites.length; si++) {
  const s = sites[si];
  const dir = s.buildDir || s.dir;
  let buildRes = null;
  let note = null;

  if (prebuildMode) {
    if (s.regen) {
      process.stdout.write(`[${ts()}] [${si+1}/${sites.length}] [regen] ${s.name} ... `);
      const t0 = Date.now();
      buildRes = run(s.regen[0], s.regen[1], dir);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(buildRes.ok ? C.green(`✓ 成功 (${sec}s)`) : C.red(`✗ 失败 (${sec}s, exit ${buildRes.status})`));
      if (!buildRes.ok) {
        const lines = buildRes.tail.split('\n').filter((l) => l.trim()).slice(-8);
        for (const l of lines) console.log('        ' + l);
      }
    } else if (s.regenIsBuild) {
      note = '内容由 npm run build 生成，预构建跳过（防死循环），仅校验';
      if (!asJson) console.log(`[${ts()}] [skip] ${s.name}：${note}`);
    } else {
      note = '无内容重建步骤，仅校验';
      if (!asJson) console.log(`[${ts()}] [skip] ${s.name}：${note}`);
    }
  } else if (s.build && !verifyOnly && (s.rebuild || buildSSR)) {
    process.stdout.write(`[${ts()}] [${si+1}/${sites.length}] [build] ${s.name} ... `);
    const t0 = Date.now();
    buildRes = run(s.build[0], s.build[1], dir);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(buildRes.ok ? C.green(`✓ 成功 (${sec}s)`) : C.red(`✗ 失败 (${sec}s, exit ${buildRes.status})`));
    if (!buildRes.ok) {
      const lines = buildRes.tail.split('\n').filter((l) => l.trim()).slice(-8);
      for (const l of lines) console.log('        ' + l);
    }
  } else if (s.build && !verifyOnly && s.ssr) {
    note = 'SSR 站内容在 D1，默认不重建（加 --build-ssr 可重建）';
    if (!asJson) console.log(`[${ts()}] [skip] ${s.name}：${note}`);
  }

  const vlist = prebuildMode ? (s.prechecks || s.verify) : s.verify;
  const checks = [];
  const seenTitles = new Set();
  for (const c of vlist) {
    const abs = path.isAbsolute(c.file) ? c.file : path.join(s.dir, c.file);
    let ok = false, detail = '';
    if (c.type === 'contains') { const n = countOcc(readFile(abs), c.pattern); ok = n >= (c.min || 1); detail = `命中 ${n}/${c.min || 1}`; }
    else if (c.type === 'not-contains') { const n = countOcc(readFile(abs), c.pattern); ok = n === 0; detail = n === 0 ? '未命中' : `异常命中 ${n} 次`; }
    else if (c.type === 'exists') { ok = fs.existsSync(abs); detail = ok ? '存在' : '缺失'; }
    else if (c.type === 'count-files') {
      try { const n = fs.readdirSync(abs).filter((f) => f.endsWith(c.pattern)).length; ok = n >= (c.min || 1); detail = `${n} 个文件`; }
      catch (e) { ok = false; detail = '目录缺失'; }
    }
    else if (c.type === 'data-vs-html') {
      // SEO 内容可见性：数据源条目数 == HTML 渲染节点数（新增/删减内容时自动暴露漏渲染）
      const o = (typeof c.pattern === 'object' && c.pattern) || {};
      try {
        const raw = readFile(path.join(s.dir, o.dataFile || 'links-data.json'));
        const data = raw ? JSON.parse(raw) : null;
        const arr = data ? (o.dataPath ? (data[o.dataPath] || []) : data) : [];
        if (!Array.isArray(arr)) throw new Error('dataPath 指向的不是数组');
        const expect = arr.length;
        const actual = countOcc(readFile(abs), o.htmlPattern || 'class="link-card"');
        ok = actual === expect;
        detail = `数据 ${expect} 条 / HTML 渲染 ${actual} 处` + (ok ? '' : '（不一致：漏渲染或重复渲染）');
      } catch (e) { ok = false; detail = '数据源解析失败: ' + e.message; }
    }
    else if (c.type === 'sitemap') {
      // SEO 可抓取性：sitemap 双向一致性（XML 合法 + loc 域名匹配 + loc→产物存在 + 产物→loc 收录）
      const o = (typeof c.pattern === 'object' && c.pattern) || {};
      const xml = readFile(abs) || '';
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter(Boolean);
      const domain = (o.domain || '').replace(/\/+$/, '');
      const wrongHost = [], missing = [], notInSitemap = [];
      if (!locs.length) { ok = false; detail = 'sitemap 无 <loc>（XML 无效或为空）'; }
      else {
        const locSet = new Set(locs);
        for (const l of locs) { // loc → 产物文件必须存在
          if (domain && !l.startsWith(domain)) { wrongHost.push(l); continue; }
          const rel = l.slice(domain.length).replace(/\/+$/, '');
          const f = rel === '' ? 'index.html' : rel;
          if (!fs.existsSync(path.join(s.dir, f))) missing.push(l);
        }
        for (const pf of (o.pageFiles || [])) { // 产物文件 → 必须被 sitemap 收录
          const files = [];
          if (pf.includes('*')) {
            const d = path.join(s.dir, path.dirname(pf) === '.' ? '' : path.dirname(pf));
            const ext = pf.slice(pf.indexOf('*') + 1);
            try { for (const f of fs.readdirSync(d)) if (f.endsWith(ext)) files.push((path.dirname(pf) + '/' + f).replace(/\\/g, '/').replace(/^\.\//, '')); }
            catch (e) { /* 目录缺失：视为无文件 */ }
          } else {
            files.push(pf.replace(/\\/g, '/'));
          }
          for (const f of files) {
            const loc = domain + '/' + (f === 'index.html' ? '' : f);
            if (!locSet.has(loc)) notInSitemap.push(loc);
          }
        }
        ok = !wrongHost.length && !missing.length && !notInSitemap.length;
        detail = `loc ${locs.length} 个`
          + (wrongHost.length ? `；域名不符 ${wrongHost.length}（${wrongHost.slice(0, 3).join(', ')}）` : '')
          + (missing.length ? `；loc无产物 ${missing.length}（${missing.slice(0, 3).join(', ')}）` : '')
          + (notInSitemap.length ? `；产物未收录 ${notInSitemap.length}（${notInSitemap.slice(0, 3).join(', ')}）` : '');
      }
    }
    else if (c.type === 'page-quality') {
      // SEO 页面质量：逐页断言 title/description/canonical/OG/JSON-LD
      const o = (typeof c.pattern === 'object' && c.pattern) || {};
      const pages = [];
      for (const p of (o.pages || [])) {
        if (p.includes('*')) {
          const d = path.join(s.dir, path.dirname(p) === '.' ? '' : path.dirname(p));
          const ext = p.slice(p.indexOf('*') + 1);
          try { for (const f of fs.readdirSync(d)) if (f.endsWith(ext)) pages.push((path.dirname(p) + '/' + f).replace(/\\/g, '/').replace(/^\.\//, '')); }
          catch (e) { /* 目录缺失：无页面 */ }
        } else {
          pages.push(p.replace(/\\/g, '/'));
        }
      }
      const attr = (tag, name) => { const m = tag.match(new RegExp(name + '=["\']([^"\']*)["\']', 'i')); return m ? m[1].trim() : ''; };
      const findTag = (html, re) => { const m = html.match(re); return m ? m[0] : ''; };
      const issues = [];
      for (const pg of pages) {
        const html = readFile(path.join(s.dir, pg)) || '';
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
        if (bad.length) issues.push(`${pg}: ${bad.join('、')}`);
      }
      ok = !issues.length;
      detail = `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过');
    }
    else if (c.type === 'link-health') {
      // SEO 链接健康：站内 a/link href 与 img src 无死链 + 图片 alt 齐全
      const o = (typeof c.pattern === 'object' && c.pattern) || {};
      const pages = [];
      for (const p of (o.pages || [])) {
        if (p.includes('*')) {
          const d = path.join(s.dir, path.dirname(p) === '.' ? '' : path.dirname(p));
          const ext = p.slice(p.indexOf('*') + 1);
          try { for (const f of fs.readdirSync(d)) if (f.endsWith(ext)) pages.push((path.dirname(p) + '/' + f).replace(/\\/g, '/').replace(/^\.\//, '')); }
          catch (e) { /* 目录缺失：无页面 */ }
        } else {
          pages.push(p.replace(/\\/g, '/'));
        }
      }
      const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?|javascript:|mailto:|data:)/i.test(u);
      const broken = [], noAlt = [];
      for (const pg of pages) {
        const html = readFile(path.join(s.dir, pg)) || '';
        const pageDir = path.dirname(pg) === '.' ? s.dir : path.join(s.dir, path.dirname(pg));
        const reHref = /<(?:a|link)\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
        let m;
        while ((m = reHref.exec(html)) !== null) {
          const u = m[1].trim();
          if (!u || isExternal(u)) continue;
          if (!fs.existsSync(path.normalize(path.join(pageDir, u)))) broken.push(`${pg} → ${u}`);
        }
        const reImg = /<img\b[^>]*>/gi;
        while ((m = reImg.exec(html)) !== null) {
          const tag = m[0];
          const altM = tag.match(/\balt=["']([^"']*)["']/i);
          if (!altM || altM[1].trim() === '') noAlt.push(pg);
          const srcM = tag.match(/\bsrc=["']([^"']+)["']/i);
          if (srcM) {
            const u = srcM[1].trim();
            if (u && !isExternal(u) && !fs.existsSync(path.normalize(path.join(pageDir, u)))) broken.push(`${pg} → ${u}`);
          }
        }
      }
      const checkAlt = o.imgAlt !== false;
      ok = !broken.length && (!checkAlt || !noAlt.length);
      detail = `页面 ${pages.length} 个`
        + (broken.length ? `；死链 ${broken.length}（${broken.slice(0, 3).join('; ')}${broken.length > 3 ? '…' : ''}）` : '')
        + (checkAlt && noAlt.length ? `；缺alt ${noAlt.length}（${noAlt.slice(0, 3).join('; ')}…）` : '')
        + (!broken.length && (!checkAlt || !noAlt.length) ? '，链接与图片均正常' : '');
    }
    else if (c.type === 'mobile-friendly' || c.type === 'structured-data' || c.type === 'core-web-vitals' || c.type === 'hreflang' || c.type === 'faq-content' || c.type === 'semantic-html' || c.type === 'content-structure' || c.type === 'ai-citations' || c.type === 'twitter-card' || c.type === 'open-graph-enhanced' || c.type === 'anchor-text-quality' || c.type === 'image-lazy-load' || c.type === 'accessibility' || c.type === 'internal-links' || c.type === 'duplicate-content' || c.type === 'html-lang' || c.type === 'breadcrumb' || c.type === 'content-freshness' || c.type === 'robots-meta' || c.type === 'content-length' || c.type === 'pagination' || c.type === 'iframe-sandbox' || c.type === 'preload-hints' || c.type === 'image-format' || c.type === 'html-doctype' || c.type === 'viewport-scale') {
      const o = (typeof c.pattern === 'object' && c.pattern) || {};
      const pages = [];
      for (const p of (o.pages || [])) {
        if (p.includes('*')) {
          const d = path.join(s.dir, path.dirname(p) === '.' ? '' : path.dirname(p));
          const ext = p.slice(p.indexOf('*') + 1);
          try { for (const f of fs.readdirSync(d)) if (f.endsWith(ext)) pages.push((path.dirname(p) + '/' + f).replace(/\\/g, '/').replace(/^\.\//, '')); }
          catch (e) {}
        } else { pages.push(p.replace(/\\/g, '/')); }
      }
      const issues = [];
      for (const pg of pages) {
        const html = readFile(path.join(s.dir, pg)) || '';
        const bad = [];
        if (c.type === 'mobile-friendly') {
          const vp = (html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i) || [])[0] || '';
          const content = vp ? (vp.match(/content=["']([^"']*)["']/i) || [])[1] || '' : '';
          if (!vp) bad.push('缺viewport');
          else if (!content.includes('width=device-width') && !content.includes('initial-scale')) bad.push('viewport不合理');
        } else if (c.type === 'structured-data') {
          const lds = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
          if (!lds.length) bad.push('缺JSON-LD');
          else { for (const m of lds) { try { const obj = JSON.parse(m[1]); const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']].filter(Boolean); const reqs = { Article: ['headline','datePublished','author','image'], BreadcrumbList: ['itemListElement'], Organization: ['name','url','logo'], WebSite: ['name','url'] }; for (const t of types) { const r = reqs[t]; if (r) { const miss = r.filter((x) => !obj[x]); if (miss.length) bad.push(`${t}缺${miss.join('/')}`); } } } catch (e) { bad.push('JSON-LD解析失败'); } } }
        } else if (c.type === 'core-web-vitals') {
          const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
          for (const m of imgs) { if (!m[0].match(/\bwidth=["']\d+["']/i) || !m[0].match(/\bheight=["']\d+["']/i)) { bad.push('图片缺width/height(CLS)'); break; } }
          const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi)].map((m) => m[0]);
          const blocking = scripts.filter((t) => !t.includes('defer') && !t.includes('async') && !t.includes('type="application/ld+json"'));
          if (blocking.length > 1) bad.push(`${blocking.length}个阻塞script`);
        } else if (c.type === 'hreflang') {
          const alts = [...html.matchAll(/<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["'][^>]*>/gi)];
          if (!alts.length) bad.push('缺hreflang');
          else if (!alts.some((m) => m[1] === 'x-default')) bad.push('缺x-default');
        } else if (c.type === 'faq-content') {
          const lds = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
          const hasFaq = lds.some((m) => { try { return JSON.parse(m[1])['@type'] === 'FAQPage'; } catch (e) { return false; } });
          if (!hasFaq && !/<details\b/i.test(html) && !/<h[23][^>]*>[^<]*[?？]/i.test(html)) bad.push('缺FAQ/QA');
        } else if (c.type === 'semantic-html') {
          const stags = ['article', 'nav', 'section', 'main', 'header', 'footer'];
          const missing = stags.filter((t) => !new RegExp('<' + t + '\\b', 'i').test(html));
          if (missing.length) bad.push(`缺${missing.join('/')}`);
        } else if (c.type === 'content-structure') {
          const h1s = [...html.matchAll(/<h1\b[^>]*>/gi)];
          if (!h1s.length) bad.push('缺H1');
          else if (h1s.length > 1) bad.push(`H1不唯一(${h1s.length})`);
          const hs = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => +m[1]);
          for (let i = 1; i < hs.length; i++) { if (hs[i] > hs[i - 1] + 1) { bad.push(`跳级(H${hs[i-1]}→H${hs[i]})`); break; } }
        } else if (c.type === 'ai-citations') {
          if (!/<blockquote\b/i.test(html) && !/<cite\b/i.test(html) && !/<a\b[^>]*href=["']https?:\/\//i.test(html)) bad.push('缺引用/来源');
        } else if (c.type === 'twitter-card') {
          const tcReq = ['twitter:card', 'twitter:title', 'twitter:description'];
          const missing = tcReq.filter((t) => !new RegExp('<meta[^>]+name=["\']' + t + '["\']', 'i').test(html));
          if (missing.length) bad.push(`缺${missing.join('/')}`);
        } else if (c.type === 'open-graph-enhanced') {
          const ogEnh = ['og:type', 'og:site_name', 'og:locale'];
          const missing = ogEnh.filter((t) => !new RegExp('<meta[^>]+property=["\']' + t + '["\']', 'i').test(html));
          if (missing.length) bad.push(`缺${missing.join('/')}`);
        } else if (c.type === 'anchor-text-quality') {
          const badT = ['点击这里','了解更多','查看更多','这里','更多','详情','点击','link','here','more','click','click here','read more','查看详情','点击查看'];
          const anchors = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[1].trim().toLowerCase()).filter((t) => t && t.length < 20);
          const badAnchors = anchors.filter((t) => badT.includes(t));
          if (badAnchors.length) bad.push(`泛化锚文本${badAnchors.length}个`);
        } else if (c.type === 'image-lazy-load') {
          const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
          const nonLazy = imgs.filter((t) => !t.match(/\bloading=["']lazy["']/i));
          if (nonLazy.length > 2) bad.push(`${nonLazy.length}个图片缺loading=lazy`);
        } else if (c.type === 'accessibility') {
          const btns = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
          for (const m of btns) { if (!/aria-label=/i.test(m[1]) && !m[2].trim()) { bad.push('按钮缺aria-label'); break; } }
          const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
          for (const m of links) { if (!m[2].trim() && !/aria-label=/i.test(m[1])) { bad.push('链接缺文本'); break; } }
        } else if (c.type === 'internal-links') {
          const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
          const internal = links.filter((h) => !h.startsWith('http') && !h.startsWith('#'));
          if (internal.length < 3) bad.push(`内链${internal.length}个`);
        } else if (c.type === 'duplicate-content') {
          const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
          if (title && seenTitles.has(title)) bad.push(`title重复`);
          if (title) seenTitles.add(title);
        } else if (c.type === 'html-lang') {
          const m = html.match(/<html\b([^>]*)>/i);
          if (!m || !/lang=["']/i.test(m[1] || '')) bad.push('缺lang属性');
        } else if (c.type === 'breadcrumb') {
          if (!/BreadcrumbList/i.test(html) && !/breadcrumb/i.test(html)) bad.push('缺面包屑');
        } else if (c.type === 'content-freshness') {
          if (!/article:(published|modified)_time/i.test(html) && !/date(Published|Modified)/i.test(html)) bad.push('缺日期标记');
        } else if (c.type === 'robots-meta') {
          const rm = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);
          if (rm && /noindex|nofollow/i.test(rm[1])) bad.push(`robots:${rm[1]}`);
        } else if (c.type === 'content-length') {
          const text = html.replace(/<[^>]+>/g, '').trim();
          if (text.length < 300) bad.push(`内容${text.length}字`);
        } else if (c.type === 'pagination') {
          if (!/rel=["']prev["']/i.test(html) && !/rel=["']next["']/i.test(html)) bad.push('缺分页标记');
        } else if (c.type === 'iframe-sandbox') {
          const iframes = [...html.matchAll(/<iframe\b([^>]*)>/gi)].map((m) => m[1] || '');
          if (iframes.some((a) => !/\bsandbox\b/i.test(a))) bad.push('iframe缺sandbox');
        } else if (c.type === 'preload-hints') {
          if (!/rel=["']preload["']/i.test(html) && !/rel=["']preconnect["']/i.test(html)) bad.push('缺preload/preconnect');
        } else if (c.type === 'image-format') {
          const srcs = [...html.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]);
          if (srcs.filter((s) => /\.(png|jpg|jpeg|gif|bmp)/i.test(s)).length > 2) bad.push('传统格式图片过多');
        } else if (c.type === 'html-doctype') {
          if (!/<!DOCTYPE\s+html>/i.test(html)) bad.push('缺DOCTYPE');
        } else if (c.type === 'viewport-scale') {
          const vp = (html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i) || [])[0] || '';
          if (!vp) bad.push('缺viewport');
          else if (!/initial-scale=/i.test(vp)) bad.push('缺initial-scale');
        }
        if (bad.length) issues.push(`${pg}: ${bad.join('、')}`);
      }
      ok = !issues.length;
      detail = `页面 ${pages.length} 个` + (issues.length ? `；${issues.length} 个有问题（${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}）` : '，全部通过');
    }
    else if (c.type === 'security-headers') {
      ok = true; detail = '本地不检查 HTTP 头（线上巡检覆盖）';
    }
    else if (c.type === 'ai-crawlable') {
      const robotsPath = path.join(s.dir, c.file || 'public/robots.txt');
      const robotsTxt = readFile(robotsPath) || readFile(path.join(s.dir, 'robots.txt')) || '';
      const bots = ['GPTBot', 'CCBot', 'PerplexityBot', 'Google-Extended', 'ClaudeBot'];
      const blocked = bots.filter((b) => new RegExp('User-agent:\\s*' + b + '[\\s\\S]*?Disallow:\\s*/\\s', 'i').test(robotsTxt + '\n'));
      ok = !blocked.length; detail = blocked.length ? `禁止 AI 爬虫 ${blocked.length} 个（${blocked.join(', ')}）` : `AI 爬虫可抓取（检查 ${bots.length} 个）`;
    }
    const _pages = (c.pattern && typeof c.pattern === 'object' && c.pattern.pages) || undefined;
    checks.push({ desc: c.desc, type: c.type, file: c.file, pages: _pages, ok, detail });
  }
  results.push({ name: s.name, buildRes, note, checks });
}

const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);

if (asJson) {
  const out = {
    root: ROOT,
    mode: prebuildMode ? 'prebuild' : (verifyOnly ? 'verify-only' : (buildSSR ? 'build-all' : 'default')),
    totalSec: Number(totalSec),
    sites: results.map((r) => ({
      name: r.name,
      build: r.buildRes ? (r.buildRes.ok ? 'success' : 'failed') : (r.note ? 'skipped' : null),
      note: r.note || null,
      checks: r.checks.map((c) => ({ desc: c.desc, type: c.type, file: c.file, pages: c.pages, ok: c.ok, detail: c.detail })),
      ok: (!r.buildRes || r.buildRes.ok) && r.checks.every((c) => c.ok),
    })),
    allOk: results.every((r) => (!r.buildRes || r.buildRes.ok) && r.checks.every((c) => c.ok)),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.allOk ? 0 : 1);
}

// —— 汇总表 ——
console.log(`\n[${ts()}] === 汇总表（总耗时 ${totalSec}s）===`);
const pad = (t, n) => { t = String(t); return t.length >= n ? t : t + ' '.repeat(n - t.length); };
console.log(pad('站点', 24) + pad('重建', 10) + pad('校验', 8) + '结论');
let allOk = true;
for (const r of results) {
  const b = r.buildRes ? (r.buildRes.ok ? '成功' : '失败') : (r.note ? '跳过' : '—');
  const cOk = r.checks.filter((x) => x.ok).length;
  const cTotal = r.checks.length;
  const ok = (!r.buildRes || r.buildRes.ok) && cOk === cTotal;
  if (!ok) allOk = false;
  console.log(pad(r.name, 24) + pad(b === '成功' ? C.green(b) : b === '失败' ? C.red(b) : b === '跳过' ? C.yellow(b) : b, 10) + pad(`${cOk}/${cTotal}`, 8) + (ok ? C.green('通过') : C.red('★失败')));
}

const failed = results.filter((r) => !r.checks.every((x) => x.ok));
if (failed.length) {
  console.log(C.red('\n=== 未通过的校验项 ==='));
  for (const r of failed) {
    for (const c of r.checks) {
      if (!c.ok) console.log(C.red(`  [${r.name}] ${c.desc}：${c.detail}`));
    }
  }
}

console.log('\n=== 部署命令（由你手动执行；本脚本不部署、不推送）===');
for (const s of sites) {
  console.log(`# ${s.name}`);
  for (const d of s.deploy) console.log('  ' + d);
}
console.log('\n全部校验通过后，按上方顺序逐站部署；部署后在百度搜索资源平台 / Google Search Console / Bing 提交对应 sitemap.xml。');
process.exit(allOk ? 0 : 1);
}
// ---------- 库化 API（子进程复用同一 CLI 逻辑，行为同源，零漂移） ----------
const _spawn = require('child_process').spawnSync;
const _runSelf = (args) => {
  const r = _spawn(process.execPath, [__filename, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000 });
  const out = ((r.stdout || '') + (r.stderr || ''));
  let json = null;
  try { json = JSON.parse(out.slice(out.indexOf('{'))); } catch (e) {}
  return { ok: r.status === 0, status: r.status, out, json };
};
module.exports = {
  loadSites: () => {
    if (fs.existsSync(CONFIG_PATH)) {
      try { const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); const arr = Array.isArray(raw) ? raw : (raw.sites || []); if (Array.isArray(arr) && arr.length) return arr; } catch (e) {}
    }
    return defaultSites();
  },
  runVerify: (siteNames) => { const args = ['--verify-only', '--json']; if (siteNames) args.push('--site', String(siteNames)); const r = _runSelf(args); return r.json || { allOk: false, error: '无法解析输出', out: r.out.slice(-500) }; },
  runBuild: (siteName, opts) => { const args = ['--json']; if (opts && opts.prebuild) { args.unshift('--prebuild', String(siteName)); } else { args.push('--site', String(siteName)); } const r = _runSelf(args); return r.json || { allOk: false, error: '无法解析输出', out: r.out.slice(-500) }; },
  runSmoke: (siteNames) => { const args = ['--smoke', '--json']; if (siteNames) args.push('--site', String(siteNames)); const r = _runSelf(args); return r.json || { allOk: false, error: '无法解析输出', out: r.out.slice(-500) }; },
  runDaily: async (siteNames) => {
    const v = module.exports.runVerify(siteNames);
    const s = module.exports.runSmoke(siteNames);
    const rec = { ts: new Date().toISOString(), verify: v, smoke: s, allOk: !!(v && v.allOk) && !!(s && s.allOk) };
    try { const runsDir = path.join(path.dirname(__filename), 'runs'); fs.mkdirSync(runsDir, { recursive: true }); fs.writeFileSync(path.join(runsDir, new Date().toISOString().slice(0, 10) + '.json'), JSON.stringify(rec, null, 2), 'utf8'); } catch (e) {}
    return rec;
  },
};
