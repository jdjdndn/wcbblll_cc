/*
 * lib/backup.cjs —— 产物目录手工改动探测与备份（重建边界保护）
 *
 * 原则：重建只写产物目录；重建前对产物目录做哈希快照，重建后对比，
 *       若出现"快照中不存在的文件"或"被修改的文件"，自动备份到
 *       <site>/.seo-optimizer-backup/<ts>/，并列入问题报告（9 字段规范之一）。
 *
 * 用法：
 *   const b = require('./backup.cjs');
 *   const snap = b.snapshot(dir, { skip: ['node_modules','.git','vendor'] });   // [{rel, hash, size}]
 *   b.compare(snap, dir)   // => { added:[], modified:[], removed:[], ok }
 *   b.backupChanged(snap, dir, backupRoot)  // 把 added/modified 文件复制到备份目录
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function walk(dir, skip) {
  const out = [];
  const skipSet = new Set(skip || []);
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipSet.has(f.name)) continue;
      const full = path.join(dir, f.name);
      if (f.isDirectory()) out.push(...walk(full, skip));
      else out.push(full);
    }
  } catch (e) { /* 目录缺失：空 */ }
  return out;
}

// 快照：{rel, hash, size}，rel 为相对 dir 的路径（正斜杠）
function snapshot(dir, opts) {
  const o = opts || {};
  const base = path.resolve(dir);
  const files = walk(base, o.skip || ['node_modules', '.git', 'vendor', '.seo-optimizer-backup', 'dist', '.nuxt', '.output']);
  return files.map((f) => {
    const st = fs.statSync(f);
    return { rel: path.relative(base, f).replace(/\\/g, '/'), hash: sha256(f), size: st.size };
  }).sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function byRel(snap) {
  const m = {};
  for (const s of snap) m[s.rel] = s;
  return m;
}

// 对比：返回 { added, modified, removed, ok }
function compare(snap, dir, opts) {
  const o = opts || {};
  const cur = snapshot(dir, o);
  const oldMap = byRel(snap);
  const curMap = byRel(cur);
  const added = [], modified = [], removed = [];
  for (const c of cur) {
    const old = oldMap[c.rel];
    if (!old) added.push(c.rel);
    else if (old.hash !== c.hash) modified.push(c.rel);
  }
  for (const s of snap) if (!curMap[s.rel]) removed.push(s.rel);
  return { added, modified, removed, ok: !added.length && !modified.length && !removed.length };
}

// 备份 changed 文件到 backupRoot/<ts>/，返回备份文件数
function backupChanged(snap, dir, backupRoot, opts) {
  const o = opts || {};
  const diff = compare(snap, dir, o);
  const changed = [...diff.added, ...diff.modified];
  if (!changed.length) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dstRoot = path.join(backupRoot, ts);
  for (const rel of changed) {
    const src = path.join(dir, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dstRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return changed.length;
}

module.exports = { snapshot, compare, backupChanged, sha256 };
