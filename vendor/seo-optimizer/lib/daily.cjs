/*
 * lib/daily.cjs —— 每日持久巡检（本地侧）＋ 统一问题报告协议
 *
 * 一、巡检内容（频率分层，云端消耗可控）：
 *   1. 本地 verify（读取本地产物，离线零消耗）：spawn rebuild-all.cjs --verify-only --json
 *   2. 线上 smoke（每日 ≤10 次/站，来自站点 smoke 配置）
 *   3. 线上 SEO 断言（每日抽查：首页/robots/sitemap 抽查 ≤10 loc/站/页质量抽样）
 *   4. deadline 扫描（数据源 links-data.json 等条目 deadline < 今日 → 过期清单，构建时不渲染）
 *   5. 产物保护（重建型站点产物目录哈希快照对比，发现手工改动即备份并告警）
 *
 * 二、落盘：runs/YYYY-MM-DD.json（结构化，Phase 6 云端聚合协议同源）
 * 三、报告：生成 report.html（本地统一看板骨架；Phase 6 云端看板复用同款模板与数据结构）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const onlineVerify = require('./online-verify.cjs');
const backup = require('./backup.cjs');

const LIB = __dirname;
const ROOT = path.join(LIB, '..');
const CONFIG = path.join(ROOT, 'rebuild.config.json');
const RUNS_DIR = path.join(ROOT, 'runs');

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }

// ---------- 本地 verify（子进程复用 CLI，行为同源） ----------
function localVerify(siteNames) {
  const args = ['--verify-only', '--json'];
  if (siteNames) args.push('--site', String(siteNames));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'rebuild-all.cjs'), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  try { return JSON.parse(out.slice(out.indexOf('{'))); } catch (e) { return { allOk: false, error: '无法解析本地 verify 输出', tail: out.slice(-400) }; }
}

// ---------- deadline 扫描 ----------
// 数据源约定：站目录下 links-data.json（或 data.json）的条目含 deadline（YYYY-MM-DD）时视为带过期时间链接
function scanDeadline(sites) {
  const out = [];
  for (const s of sites) {
    const candidates = ['links-data.json', 'data.json', 'data.js'];
    let found = null;
    for (const c of candidates) {
      const p = path.join(s.dir, c);
      if (fs.existsSync(p)) { found = p; break; }
    }
    if (!found) { out.push({ site: s.name, expired: 0, total: 0, note: '无数据源' }); continue; }
    let arr = null, raw = null;
    if (found.endsWith('.json')) { raw = readJson(found); }
    else { /* data.js：尝试提取首个数组字面量 */ const t = readFile(found) || ''; const m = t.match(/\[[\s\S]*?\]/); if (m) { try { arr = JSON.parse(m[0].replace(/,\s*\]/g, ']')); } catch (e) { arr = null; } } }
    if (!raw && arr === null) { out.push({ site: s.name, expired: 0, total: 0, note: '数据源解析失败' }); continue; }
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.links) ? raw.links : null);
    const arr2 = arr !== null ? arr : list;
    if (!Array.isArray(arr2)) { out.push({ site: s.name, expired: 0, total: 0, note: '无条目数组' }); continue; }
    const today = todayStr();
    const withDeadline = arr2.filter((it) => it && it.deadline);
    const expired = withDeadline.filter((it) => String(it.deadline) < today);
    out.push({ site: s.name, expired: expired.length, total: withDeadline.length, note: withDeadline.length ? '' : '无deadline字段' });
  }
  return out;
}

// ---------- 产物保护（重建型站点） ----------
// 首次运行建立基线快照；之后对比，发现 changed 则备份并告警
function productGuard(sites) {
  const guardDir = path.join(ROOT, '.seo-optimizer-backup');
  fs.mkdirSync(guardDir, { recursive: true });
  const out = [];
  for (const s of sites) {
    if (!s.rebuild && !s.regen) continue; // 只保护"会被重建覆盖"的站
    const targetDir = s.buildDir || s.dir;
    const baseSnap = path.join(guardDir, 'baseline-' + s.name.replace(/[/\\]/g, '_') + '.json');
    if (!fs.existsSync(baseSnap)) {
      const snap = backup.snapshot(targetDir, {});
      fs.writeFileSync(baseSnap, JSON.stringify(snap, null, 2), 'utf8');
      out.push({ site: s.name, status: '基线已建立' });
      continue;
    }
    const prev = readJson(baseSnap);
    const diff = backup.compare(prev, targetDir, {});
    if (diff.ok) { out.push({ site: s.name, status: '无手工改动' }); }
    else {
      const n = backup.backupChanged(prev, targetDir, guardDir, {});
      fs.writeFileSync(baseSnap, JSON.stringify(backup.snapshot(targetDir, {}), null, 2), 'utf8');
      out.push({ site: s.name, status: '检测到改动并备份', added: diff.added.length, modified: diff.modified.length, removed: diff.removed.length, backedUp: n });
    }
  }
  return out;
}

// ---------- 线上巡检（smoke + 线上断言，受频率与限额约束） ----------
async function onlineCheck(sites, opts) {
  const o = opts || {};
  const out = [];
  for (const s of sites) {
    const smoke = s.smoke || [];
    const smRes = [];
    for (const item of smoke.slice(0, o.maxSmoke || 10)) {
      const r = await onlineVerify.httpGetText(item.url, 15000);
      const ok = r.status === item.status && (!item.contains || (r.body || '').includes(item.contains));
      smRes.push({ url: item.url, ok, status: r.status, expect: item.status, contains: item.contains || null, error: r.error });
    }
    // 线上断言（有 smoke 配置或 onlineBase 的站做完整线上检查；否则跳过）
    let ores = null;
    if (smoke.length || s.onlineBase) {
      const base = s.onlineBase || (smoke[0] ? new URL(smoke[0].url).origin : null);
      if (base) ores = await onlineVerify.verifySite(s, { base, limitLoc: o.limitLoc || 10 });
    }
    out.push({ site: s.name, smoke: smRes, onlineVerify: ores, onlineBase: s.onlineBase || null });
  }
  return out;
}

// ---------- 报告 HTML（统一看板骨架；云端复用同款） ----------
function renderReport(rec) {
  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = rec.online.map((o) => {
    const sm = o.smoke;
    const smOk = sm.length && sm.every((x) => x.ok);
    const smTxt = sm.length ? `${sm.filter((x) => x.ok).length}/${sm.length}` : '—';
    const ov = o.onlineVerify;
    const ovTxt = ov ? `${ov.checks.filter((c) => c.ok).length}/${ov.checks.length}` : '—';
    const lv = (rec.localVerify.sites || []).find((s) => s.name === o.site);
    const lvTxt = lv ? `${lv.checks.filter((c) => c.ok).length}/${lv.checks.length}` : '—';
    const dl = (rec.deadline || []).find((d) => d.site === o.site);
    const dlTxt = dl ? (dl.total ? `${dl.expired}/${dl.total}` : '—') : '—';
    const bad = [];
    if (lv && !lv.checks.every((c) => c.ok)) bad.push('本地校验');
    if (!smOk && sm.length) bad.push('线上smoke');
    if (ov && !ov.checks.every((c) => c.ok)) bad.push('线上断言');
    if (dl && dl.expired > 0) bad.push(`过期${dl.expired}`);
    return `<tr><td>${esc(o.site)}</td><td class="${lv && lv.checks.every((c) => c.ok) ? 'ok' : 'bad'}">${lvTxt}</td><td class="${smOk ? 'ok' : 'bad'}">${smTxt}</td><td class="${ov && ov.checks.every((c) => c.ok) ? 'ok' : 'bad'}">${ovTxt}</td><td class="${dl && dl.expired ? 'bad' : 'ok'}">${dlTxt}</td><td>${bad.length ? esc(bad.join('、')) : '✓'}</td></tr>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>seo-optimizer 巡检看板</title>
<style>
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:24px;background:#f6f8fa;color:#24292f}
h1{font-size:20px}.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#f0f3f6}.ok{color:#1a7f37}.bad{color:#cf222e;font-weight:600}
.sum{color:#57606a;font-size:12px;margin-bottom:8px}
</style></head><body>
<h1>seo-optimizer 巡检看板</h1>
<div class="card sum">巡检时间：${esc(rec.ts)} ｜ 本地校验 allOk=${rec.localVerify.allOk} ｜ 线上 smoke 通过 ${rec.online.filter((o) => o.smoke.length && o.smoke.every((x) => x.ok)).length}/${rec.online.filter((o) => o.smoke.length).length} 站 ｜ 线上断言 ${rec.online.filter((o) => o.onlineVerify && o.onlineVerify.checks.every((c) => c.ok)).length}/${rec.online.filter((o) => o.onlineVerify).length} 站 ｜ 过期链接 ${rec.deadline.reduce((a, d) => a + d.expired, 0)} 条</div>
<div class="card"><table><thead><tr><th>站点</th><th>本地校验</th><th>线上smoke</th><th>线上断言</th><th>过期/deadline</th><th>问题</th></tr></thead><tbody>
${rows}
</tbody></table></div>
<div class="card"><b>问题明细（9 字段规范：site/page/type/severity/expect/actual/fix-source/fix-hint/verify-after）</b><pre style="font-size:12px;white-space:pre-wrap">${esc(JSON.stringify(rec.issues, null, 2))}</pre></div>
</body></html>`;
}

// ---------- 主巡检 ----------
async function runDaily(opts) {
  const o = opts || {};
  const sites = readJson(CONFIG);
  const rec = {
    ts: new Date().toISOString(),
    date: todayStr(),
    localVerify: null,
    online: [],
    deadline: [],
    productGuard: [],
    issues: [],
  };

  rec.localVerify = localVerify(o.siteNames || null);

  rec.deadline = scanDeadline(sites);

  rec.productGuard = productGuard(sites);

  const online = await onlineCheck(sites, { maxSmoke: o.maxSmoke || 10, limitLoc: o.limitLoc || 10 });
  rec.online = online;

  // 问题明细（9 字段）：聚合本地失败项 + 线上失败项 + 产物保护告警
  const issues = [];
  for (const s of (rec.localVerify.sites || [])) {
    for (const c of s.checks) {
      if (!c.ok) issues.push({ site: s.name, page: null, type: 'local-verify', severity: 'high', expect: '校验通过', actual: c.detail, fixSource: '站点构建/数据', fixHint: '见规则注册表 rebuild.config.json 对应校验项', verifyAfter: '重建后重跑 --verify-only' });
    }
  }
  for (const o2 of online) {
    for (const m of o2.smoke) if (!m.ok) issues.push({ site: o2.site, page: m.url, type: 'smoke', severity: 'high', expect: `HTTP ${m.expect}`, actual: m.error || `HTTP ${m.status}`, fixSource: '部署/站点配置', fixHint: '检查线上部署与 smoke 配置', verifyAfter: '部署后重跑 --smoke' });
    if (o2.onlineVerify) for (const c of o2.onlineVerify.checks) if (!c.ok) issues.push({ site: o2.site, page: null, type: 'online-verify', severity: 'medium', expect: '断言通过', actual: c.detail, fixSource: '站点模板/内容', fixHint: '见线上断言规则', verifyAfter: '修复后重跑 --daily' });
  }
  for (const g of rec.productGuard) if (g.status && g.status.startsWith('检测到')) issues.push({ site: g.site, page: null, type: 'product-guard', severity: 'warning', expect: '产物未被手工改动', actual: `新增${g.added || 0} 修改${g.modified || 0} 删除${g.removed || 0}（已备份 ${g.backedUp}）`, fixSource: '产物目录', fixHint: '改动已备份至 .seo-optimizer-backup/', verifyAfter: '确认改动意图后重建' });
  rec.issues = issues;

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const runFile = path.join(RUNS_DIR, rec.date + '.json');
  fs.writeFileSync(runFile, JSON.stringify(rec, null, 2), 'utf8');

  const reportFile = path.join(ROOT, 'report.html');
  fs.writeFileSync(reportFile, renderReport(rec), 'utf8');

  if (!o.quiet) {
    console.log(`[${ts()}] 巡检完成：本地 ${rec.localVerify.allOk ? '通过' : '有失败'} / 线上 smoke ${online.filter((x) => x.smoke.length && x.smoke.every((m) => m.ok)).length} 站通过 / 线上断言 ${online.filter((x) => x.onlineVerify && x.onlineVerify.checks.every((c) => c.ok)).length} 站通过`);
    console.log(`[${ts()}] 过期链接 ${rec.deadline.reduce((a, d) => a + d.expired, 0)} 条；问题 ${issues.length} 条`);
    console.log(`[${ts()}] 落盘：${runFile}`);
    console.log(`[${ts()}] 看板：${reportFile}`);
  }
  return rec;
}

module.exports = { runDaily, renderReport, scanDeadline, productGuard, localVerify, onlineCheck, todayStr };
