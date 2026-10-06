#!/usr/bin/env node
/*
 * rebuild-all.cjs —— 多站点一键重建 + 静态校验（共享工具，跨 E:\code 下全部站点）
 *
 * 设计要点：
 *   - 便携化：站点根目录自动探测（脚本放在任意位置都能定位到 E:\code），也支持 --root 显式指定；
 *   - 按站点调用：--site/--skip 只处理指定站点；--prebuild 供单个项目"run build 之前"调用，只重建内容+校验，
 *     不执行该站的 npm build（避免与调用方 build 互相触发形成死循环）；
 *   - 外部配置：与脚本同目录的 sites.json 为站点清单唯一来源（--dump-config 可生成），加站/改站无需改脚本本体；
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
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
const asJson = has('--json');
const dumpConfig = has('--dump-config');
const listOnly = has('--list');
const help = has('--help');

if (help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0] + '*/');
  process.exit(0);
}

// ---------- 工具函数 ----------
function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function countOcc(t, pat) { if (!t) return 0; let n = 0, i = 0; while ((i = t.indexOf(pat, i)) !== -1) { n++; i += pat.length; } return n; }
function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
function run(cmd, cmdArgs, cwd) {
  let r;
  if (cmd === 'npm' || cmd === 'npx') {
    // Windows 下 .cmd 不能直接 spawn，走 cmd.exe /c（经 PATHEXT 解析 npm/npx）
    r = spawnSync('cmd.exe', ['/d', '/s', '/c', [cmd, ...cmdArgs].join(' ')], { cwd, encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000 });
  } else {
    r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000 });
  }
  return { ok: r.status === 0, status: r.status, tail: ((r.stdout || '') + (r.stderr || '')).slice(-800) };
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

function defaultSites() {
  const SITES = [];
  function site(name, dir, opts) { SITES.push(Object.assign({ name, dir, build: null, verify: [], deploy: [] }, opts)); }

  // 1. wcbblll_cc —— 旗舰静态站（内容源 links-data.json；regen==build，均可独立调用）
  site('wcbblll_cc', P('wcbblll_cc'), {
    rebuild: true,
    build: ['node', ['build-static.mjs']],
    regen: ['node', ['build-static.mjs']],
    verify: [
      chk('117条链接全部静态化进HTML', 'contains', 'index.html', 'class="link-card"', 117),
      chk('核心内容不再依赖fetch', 'not-contains', 'index.html', "fetch('links-data.json')"),
      chk('sitemap含首页+12分类页', 'contains', 'sitemap.xml', '<loc>', 13),
      chk('分类页已生成', 'count-files', 'category', '.html', 12),
      chk('wrangler已配404(404-page)', 'contains', 'wrangler.jsonc', '"404-page"'),
    ],
    deploy: [`cd ${P('wcbblll_cc')} && npx wrangler deploy`],
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
const CONFIG_PATH = path.join(path.dirname(__filename), 'sites.json');
function loadSites() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.sites || []);
      if (!Array.isArray(arr) || !arr.length) throw new Error('sites.json 结构无效');
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
}
if (optSkip) {
  const names = optSkip.split(',').map((s) => s.trim());
  sites = sites.filter((s) => !names.includes(s.name));
}

if (dumpConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultSites(), null, 2), 'utf8');
  console.log(`[ok] 已生成站点清单：${CONFIG_PATH}（${defaultSites().length} 个站点；之后以该文件为准，可自行增删条目）`);
  process.exit(0);
}

if (listOnly) {
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
if (!asJson) {
  console.log(`[${ts()}] 站点根目录：${ROOT}`);
  if (prebuildMode) console.log(`[${ts()}] 预构建模式：${sites.map((s) => s.name).join('、')}（只重建内容+校验，不执行 npm build）`);
  else console.log(`[${ts()}] 模式：${verifyOnly ? '仅校验' : (buildSSR ? '重建全部（含 SSR）' : '重建内容静态化站点')}${optSite ? '；站点=' + optSite : ''}${optSkip ? '；跳过=' + optSkip : ''}`);
}

const results = [];
const tStart = Date.now();
for (const s of sites) {
  const dir = s.buildDir || s.dir;
  let buildRes = null;
  let note = null;

  if (prebuildMode) {
    if (s.regen) {
      process.stdout.write(`[${ts()}] [regen] ${s.name} ... `);
      const t0 = Date.now();
      buildRes = run(s.regen[0], s.regen[1], dir);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(buildRes.ok ? `成功 (${sec}s)` : `失败 (${sec}s, exit ${buildRes.status})`);
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
    process.stdout.write(`[${ts()}] [build] ${s.name} ... `);
    const t0 = Date.now();
    buildRes = run(s.build[0], s.build[1], dir);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(buildRes.ok ? `成功 (${sec}s)` : `失败 (${sec}s, exit ${buildRes.status})`);
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
    checks.push({ desc: c.desc, ok, detail });
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
      checks: r.checks.map((c) => ({ desc: c.desc, ok: c.ok, detail: c.detail })),
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
  console.log(pad(r.name, 24) + pad(b, 10) + pad(`${cOk}/${cTotal}`, 8) + (ok ? '通过' : '★失败'));
}

const failed = results.filter((r) => !r.checks.every((x) => x.ok));
if (failed.length) {
  console.log('\n=== 未通过的校验项 ===');
  for (const r of failed) {
    for (const c of r.checks) {
      if (!c.ok) console.log(`  [${r.name}] ${c.desc}：${c.detail}`);
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
