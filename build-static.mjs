#!/usr/bin/env node
/**
 * build-static.mjs — 券宝(wcbblll.cc) 静态构建脚本
 * 零第三方依赖，纯 Node.js。
 * 用法：node build-static.mjs
 *
 * 读取 links-data.json，一键生成：
 *   - index.html            首页（全部链接静态预渲染）
 *   - category/<cat>.html   每分类独立页
 *   - 404.html              与全站样式一致的 404 页
 *   - sitemap.xml           首页 + 全部分类页
 *   - wrangler.jsonc        追加 assets.not_found_handling
 *
 * 数据更新后重跑本脚本即可。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://wcbblll.cc';

/* ---------- 读取数据 ---------- */
const data = JSON.parse(readFileSync(join(ROOT, 'links-data.json'), 'utf8'));
const LINKS = data.links || [];
const UPDATED = data.updated || new Date().toISOString().slice(0, 10);

/* ---------- 分类展示配置（与原站保持一致；未知分类走兜底） ---------- */
const CATS = {
  ecommerce:  { name: '电商优惠', emoji: '🛒' },
  food:        { name: '外卖餐饮', emoji: '🍜' },
  travel:      { name: '出行旅行', emoji: '✈️' },
  member:      { name: '影视会员', emoji: '👑' },
  netdisk:     { name: '网盘资源', emoji: '💾' },
  simcard:     { name: '号卡办理', emoji: '📱' },
  wifi:        { name: '随身WiFi', emoji: '📶' },
  cloud:       { name: '云服务',   emoji: '☁️' },
  miniprogram: { name: '小程序服务', emoji: '📲' },
  app:         { name: 'App拉新',  emoji: '📢' },
  creditcard:  { name: '信用卡',   emoji: '💳' },
  other:       { name: '其他',     emoji: '🌐' },
};
const CAT_ORDER = Object.keys(CATS);

/* 由 JSON 实际出现的分类重算 */
const catCount = {};
LINKS.forEach(l => { catCount[l.category] = (catCount[l.category] || 0) + 1; });
const actualCats = Object.keys(catCount).sort((a, b) => {
  const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
  return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
});
const totalCount = LINKS.length;

/* ---------- 每分类原创介绍段落 ---------- */
const CAT_INTRO = {
  ecommerce: '本分类汇集京东、淘宝/天猫、拼多多三大主流电商平台的官方优惠券、秒杀会场、满减补贴与签到积分入口，另含苏宁易购、当当网、1688 批发等垂直电商专场。链接多为联盟推广跳转，下单前请留意券后价、有效期与满减门槛；淘宝/天猫系链接建议在淘宝 App 内打开以获得最佳领券体验。',
  food: '本分类覆盖美团、京东外卖红包与团购酒旅集合页，以及洗车、家政等本地生活优惠，并收录微信端电影票预订入口。外卖红包通常限当餐/当日使用，过期自动失效；电影票与小程序类链接为微信专属，请复制后在微信中打开。',
  travel: '本分类集中携程与同程两大 OTA 的酒店、机票、火车票、汽车票、门票、玩乐、租车、跟团/自由行、签证、换汇等全链路出行入口，外加飞猪酒店特价、新人、连锁、亲子、百元等专属会场。酒店预售券多为不约可退，出行前请仔细确认使用日期、预约规则与取消政策。',
  member: '本分类聚合各大视频平台（爱优腾芒等）与音乐平台（网易云/QQ 音乐）的会员优惠办理通道，价格通常低于官方直充；另收录一个粉丝关注类任务站。第三方代充店铺信誉与到账时效不一，下单前请核对是否直充、是否需要账号密码及售后保障。',
  netdisk: '本分类整理了一批公开分享的网盘资源合集，涵盖电子书、AIGC 课程、自媒体运营教程、小吃配方、音乐专辑与车载 MV 等，存储于夸克网盘与百度网盘。资源链接为第三方用户分享，若失效请反馈更新；版权归原作者所有，仅供学习交流，请于下载后 24 小时内自行删除。',
  simcard: '本分类汇集电信、联通、移动、广电四网手机套餐办理入口，月租多在 19–49 元区间，全国免费配送上门激活。号卡资费随运营商政策频繁调整，下单前务必确认首充金额、合约期、注销规则与归属地，避免后续合约纠纷。',
  wifi: '本分类收录免插卡随身 WiFi 与 CPE 无线宽带，资费 39–99 元/月不等，支持三网切换，适合出差、租房、宿舍等不便装固定宽带的场景；另含三家品牌的代理注册入口。部分链接为 http 明文传输，下单前请核对官方资费、流量封顶与设备售后政策。',
  cloud: '本分类整理腾讯云、阿里云、京东云、雨云等主流厂商的新客优惠入口，涵盖云服务器、建站 SaaS、AI 办公工具；雨云提供香港/美国免备案节点。新客价通常仅限首单，续费将恢复原价，购买前请核对配置、带宽、流量与 ICP 备案要求。',
  miniprogram: '本分类均为微信小程序/微信商家链接，覆盖鲜花同城速递、快递寄件优惠、旧家电上门回收、快递上门取件等本地生活服务。此类链接无法在浏览器直接打开，点击后请复制链接，到微信聊天框粘贴发送，再点击即可跳转。',
  app: '本分类为内容类/App 拉新任务入口，完成指定任务（如下载注册、做任务、邀请好友）可获得现金或权益奖励。拉新活动对设备、账号、实名认证有要求，同一设备/IP 频繁参与可能被判作弊，参与前请仔细阅读活动规则与提现门槛。',
  creditcard: '本分类为信用卡申请推广入口，批核速度、新户礼与额度因银行当期政策而异。推广平台仅提供跳转通道，是否批核、额度高低由银行根据个人征信综合评定，请根据自身还款能力理性申卡，切勿过度授信。',
  other: '本分类为未归入上述类别的工具类入口，部分条目暂无详细描述。使用前请自行甄别服务性质、隐私政策与数据授权范围，谨慎提交个人信息。',
};

/* ---------- 工具函数 ---------- */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function typeLabel(type) {
  if (type === 'miniprogram' || type === 'wechat-business' || type === 'wechat-other') return '微信小程序';
  if (type === 'alipay-miniprogram') return '支付宝小程序';
  return '网站';
}

function catMeta(cat) {
  return CATS[cat] || { name: cat, emoji: '🔗' };
}

function cardHtml(l) {
  const cm = catMeta(l.category);
  let tags = '<span class="tag">' + typeLabel(l.type) + '</span>';
  if (l.isHttp) tags += '<span class="tag tag-warn">非HTTPS</span>';
  if (l.category === 'wifi' && /代理/.test(l.name)) tags += '<span class="tag tag-web">代理</span>';
  const price = l.price ? '<span class="price">' + esc(l.price) + '</span>' : '';
  const deadline = l.deadline ? '<span class="deadline">至 ' + esc(l.deadline) + '</span>' : '';
  const targetAttr = l.type === 'web' ? ' target="_blank" rel="noopener noreferrer"' : '';
  return '<a class="link-card" href="' + esc(l.url) + '" data-cat="' + esc(l.category) + '" data-type="' + esc(l.type) + '"'
    + ' data-name="' + esc(l.name) + '" data-desc="' + esc(l.desc || '') + '"'
    + targetAttr + ' aria-label="' + esc(l.name) + '">'
    + '<div class="card-top"><div class="card-icon">' + cm.emoji + '</div>'
    + '<div class="card-name">' + esc(l.name) + '</div></div>'
    + '<div class="card-desc">' + esc(l.desc || '暂无描述') + '</div>'
    + '<div class="card-meta">' + tags + price + deadline + '</div>'
    + '</a>';
}

/* ---------- CSS（与原站完全一致，仅追加 .cat-intro） ---------- */
const CSS = `
:root {
  --bg: #f5f5f7; --card: #ffffff; --border: #e5e2dd; --text: #1a1a2e; --text-2: #6b7280;
  --primary: #FF6B35; --primary-light: #fff4ed; --success: #16a34a; --success-light: #f0fdf4;
  --warn: #d97706; --warn-light: #fffbeb; --shadow: 0 2px 12px rgba(0,0,0,.06); --radius: 12px;
}
[data-theme="dark"] {
  --bg: #12121f; --card: #1e1e35; --border: #2d2d45; --text: #e8e8f0; --text-2: #9a9ab0;
  --primary-light: #2a2118; --success-light: #14291c; --warn-light: #2a2310;
  --shadow: 0 2px 12px rgba(0,0,0,.35);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5; transition: background .3s, color .3s;
}
a { color: inherit; text-decoration: none; }
.container { max-width: 1280px; margin: 0 auto; padding: 0 16px; }

/* Header */
header.site {
  position: sticky; top: 0; z-index: 100; background: var(--bg); border-bottom: 1px solid var(--border);
  backdrop-filter: blur(8px); padding: 12px 0;
}
.header-inner { display: flex; align-items: center; gap: 12px; }

.header-inner h1 { font-size: 18px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-stat { font-size: 12px; color: var(--text-2); white-space: nowrap; }
.header-stat strong { color: var(--primary); }
.theme-btn {
  width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--border); background: var(--card);
  font-size: 16px; cursor: pointer; flex-shrink: 0;
}

/* Search */
.search-wrap { padding: 16px 0 4px; }
.search-box {
  display: flex; align-items: center; gap: 8px; background: var(--card); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px; max-width: 520px; transition: border-color .2s;
}
.search-box:focus-within { border-color: var(--primary); }
.search-box .icon { font-size: 15px; opacity: .5; }
.search-box input {
  flex: 1; border: 0; outline: 0; background: transparent; font-size: 14px; color: var(--text); min-width: 0;
}
.search-box input::placeholder { color: var(--text-2); }
.search-clear { border: 0; background: none; cursor: pointer; font-size: 16px; color: var(--text-2); padding: 2px; display: none; }
.search-clear.show { display: block; }

/* Tabs */
.tabs {
  display: flex; gap: 8px; padding: 14px 0 6px; overflow-x: auto; -webkit-overflow-scrolling: touch;
  scrollbar-width: none; position: sticky; top: 63px; z-index: 99; background: var(--bg);
}
.tabs::-webkit-scrollbar { display: none; }
@media (min-width: 768px) {
  .tabs { flex-wrap: wrap; overflow-x: visible; }
}
.tab {
  display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--card); font-size: 13px; color: var(--text);
  cursor: pointer; white-space: nowrap; transition: all .2s;
}
.tab:hover { border-color: var(--primary); }
.tab.active { background: var(--primary); border-color: var(--primary); color: #fff; }
.tab-count { font-size: 11px; background: var(--primary-light); color: var(--primary); padding: 1px 6px; border-radius: 999px; }
.tab.active .tab-count { background: rgba(255,255,255,.25); color: #fff; }

/* Stats */
.stats-bar { font-size: 12px; color: var(--text-2); padding: 4px 2px 12px; }

/* Category intro */
.cat-intro {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px 16px; margin: 6px 0 14px; font-size: 13px; color: var(--text-2); line-height: 1.7;
}
.cat-intro strong { color: var(--text); }

/* Grid */
.link-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; padding-bottom: 40px; }
@media (max-width: 1023px) { .link-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 767px) { .link-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; } }
@media (max-width: 479px) { .link-grid { grid-template-columns: 1fr; } }

.link-card {
  display: flex; flex-direction: column; gap: 8px; padding: 16px; background: var(--card);
  border: 1px solid var(--border); border-radius: var(--radius); transition: all .2s; cursor: pointer;
  box-shadow: var(--shadow);
}
.link-card:hover { border-color: var(--primary); transform: translateY(-2px); box-shadow: 0 6px 18px rgba(255,107,53,.12); }
.card-top { display: flex; align-items: center; gap: 10px; }
.card-icon {
  width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center;
  font-size: 20px; background: var(--primary-light); flex-shrink: 0;
}
.card-name { font-size: 14px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-desc { font-size: 12px; color: var(--text-2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 36px; }
.card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: auto; }
.tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--primary-light); color: var(--primary); }
.tag-web { background: var(--success-light); color: var(--success); }
.tag-warn { background: var(--warn-light); color: var(--warn); }
.price { font-size: 12px; font-weight: 600; color: var(--primary); }
.deadline { font-size: 11px; color: var(--text-2); margin-left: auto; }

/* Empty */
.empty-state { display: none; text-align: center; padding: 60px 0; color: var(--text-2); }
.empty-state.show { display: block; }
.empty-state .big { font-size: 40px; margin-bottom: 10px; }

/* Modal */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: center; justify-content: center;
  z-index: 1000; padding: 20px;
}
.modal-mask.show { display: flex; }
.modal {
  background: var(--card); border-radius: 16px; padding: 24px; max-width: 420px; width: 100%;
  box-shadow: 0 10px 40px rgba(0,0,0,.2);
}
.modal-icon { font-size: 34px; text-align: center; margin-bottom: 10px; }
.modal h3 { font-size: 16px; text-align: center; margin-bottom: 8px; }
.modal p { font-size: 13px; color: var(--text-2); text-align: center; margin-bottom: 16px; }
.modal-link {
  font-size: 12px; word-break: break-all; background: var(--bg); border: 1px dashed var(--border);
  border-radius: 8px; padding: 10px; margin-bottom: 16px; max-height: 120px; overflow-y: auto;
}
.modal-btns { display: flex; gap: 10px; }
.modal-btns button {
  flex: 1; padding: 10px; border-radius: 8px; border: 0; font-size: 14px; cursor: pointer; transition: all .2s;
}
.btn-copy { background: var(--primary); color: #fff; }
.btn-copy:hover { opacity: .9; }
.btn-close { background: var(--bg); color: var(--text); border: 1px solid var(--border); }

/* Friend links */
.friend-links {
  display: flex; justify-content: center; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 14px; font-size: 13px;
}
.fl-label { font-weight: 600; color: var(--text); }
.friend-links a {
  color: var(--text-2); padding: 4px 12px; border: 1px solid var(--border); border-radius: 999px;
  transition: all .2s;
}
.friend-links a:hover { color: var(--primary); border-color: var(--primary); }

/* Footer */
footer.site {
  border-top: 1px solid var(--border); padding: 24px 0 32px; text-align: center; font-size: 12px; color: var(--text-2);
}
footer.site p { margin-bottom: 4px; }

/* Toast */
.toast {
  position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(20px); z-index: 1100;
  background: #333; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px;
  opacity: 0; transition: all .3s; pointer-events: none; max-width: 90vw; text-align: center;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

/* 404 */
.err-wrap { text-align: center; padding: 80px 0 60px; }
.err-code { font-size: 64px; font-weight: 800; color: var(--primary); line-height: 1; }
.err-tip { font-size: 15px; color: var(--text-2); margin: 14px 0 24px; }
.err-home {
  display: inline-block; padding: 10px 22px; background: var(--primary); color: #fff;
  border-radius: 999px; font-size: 14px;
}
`;

/* ---------- 运行时 JS（作用于已渲染 DOM，不再 fetch） ---------- */
const RUNTIME_JS = `
(function () {
  var currentCat = 'all', currentQuery = '';
  var grid = document.getElementById('linkGrid');
  var statsBar = document.getElementById('statsBar');
  var emptyState = document.getElementById('emptyState');
  var searchInput = document.getElementById('searchInput');
  var searchClear = document.getElementById('searchClear');
  var modalMask = document.getElementById('modalMask');
  var modalLink = document.getElementById('modalLink');
  var pendingUrl = '';
  var isHome = document.body.getAttribute('data-page') === 'home';
  var cards = grid ? Array.prototype.slice.call(grid.querySelectorAll('.link-card')) : [];

  function isWechat() { return /MicroMessenger/i.test(navigator.userAgent); }

  function applyFilter() {
    if (!grid) return;
    var q = currentQuery.trim().toLowerCase();
    var visible = 0;
    cards.forEach(function (c) {
      var catOk = !isHome || currentCat === 'all' || c.getAttribute('data-cat') === currentCat;
      var hay = (c.getAttribute('data-name') + ' ' + (c.getAttribute('data-desc') || '')).toLowerCase();
      var qOk = !q || hay.indexOf(q) !== -1;
      var show = catOk && qOk;
      c.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    var catName = '全部';
    var active = document.querySelector('.tab.active');
    if (active) catName = active.getAttribute('data-cat-name') || catName;
    if (statsBar) statsBar.textContent = catName + '分类下 ' + visible + ' 个链接';
    if (emptyState) emptyState.classList.toggle('show', visible === 0);
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); return true; } catch (e) { return false; }
    finally { document.body.removeChild(ta); }
  }
  function openWechat(url) {
    if (isWechat()) { window.location.href = url; return; }
    pendingUrl = url;
    modalLink.textContent = url;
    modalMask.classList.add('show');
  }

  // 卡片点击：微信类弹窗复制，web 类新窗口打开
  if (grid) grid.addEventListener('click', function (e) {
    var card = e.target.closest('.link-card');
    if (!card) return;
    var type = card.getAttribute('data-type');
    if (type === 'web') return;
    e.preventDefault();
    openWechat(card.getAttribute('href'));
  });

  var closeBtn = document.getElementById('closeBtn');
  if (closeBtn) closeBtn.addEventListener('click', function () { modalMask.classList.remove('show'); });
  if (modalMask) modalMask.addEventListener('click', function (e) { if (e.target === modalMask) modalMask.classList.remove('show'); });
  var copyBtn = document.getElementById('copyBtn');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    copyText(pendingUrl).then(function (ok) {
      modalMask.classList.remove('show');
      showToast(ok ? '已复制，请打开微信粘贴发送，点击即可打开' : '复制失败，请长按链接手动复制');
    });
  });

  // 首页 tabs 为按钮（同页筛选）；分类页 tabs 为 <a>（跨页导航），不绑定
  var tabsEl = document.getElementById('tabs');
  if (isHome && tabsEl) {
    tabsEl.addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      e.preventDefault();
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentCat = tab.getAttribute('data-cat') || 'all';
      if (currentCat !== 'all') { try { history.replaceState(null, '', '#cat-' + currentCat); } catch (e) {} }
      applyFilter();
    });
  }

  if (searchInput) searchInput.addEventListener('input', function () {
    currentQuery = this.value;
    if (searchClear) searchClear.classList.toggle('show', this.value.length > 0);
    applyFilter();
  });
  if (searchClear) searchClear.addEventListener('click', function () {
    searchInput.value = '';
    currentQuery = '';
    searchClear.classList.remove('show');
    applyFilter();
    searchInput.focus();
  });

  // 暗色模式
  var themeBtn = document.getElementById('themeBtn');
  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (themeBtn) themeBtn.textContent = dark ? '☀️' : '🌙';
    try { localStorage.setItem('links-theme', dark ? 'dark' : 'light'); } catch (e) {}
  }
  if (themeBtn) themeBtn.addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark');
  });
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('links-theme'); } catch (e) {}
  var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(savedTheme ? savedTheme === 'dark' : systemDark);

  // URL hash 恢复分类（仅首页）
  if (isHome) {
    try {
      var h = location.hash.replace('#cat-', '');
      if (h && h !== 'all' && document.querySelector('.tab[data-cat="' + h + '"]')) {
        document.querySelector('.tab[data-cat="' + h + '"]').click();
      }
    } catch (e) {}
  }

  applyFilter();
})();
`;

/* ---------- HTML 骨架 ---------- */
function headHtml({ title, description, canonical, ogTitle }) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="keywords" content="优惠链接,电商优惠,会员优惠,随身WiFi,号卡办理,券宝,省钱,优惠券">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="index, follow">
<meta name="geo.region" content="CN">
<meta name="geo.placename" content="中国">
<meta name="geo.position" content="39.9042;116.4074">
<meta name="ICBM" content="39.9042, 116.4074">
<link rel="alternate" hreflang="zh-CN" href="${esc(canonical)}">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<meta name="theme-color" content="#FF6B35">
<meta name="application-name" content="券宝">
<meta property="og:title" content="${esc(ogTitle || title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="券宝">
<meta property="og:locale" content="zh_CN">
<meta property="og:image" content="https://wcbblll.cc/favicon.svg">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(ogTitle || title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="https://wcbblll.cc/favicon.svg">
<style>${CSS}</style>
</head>`;
}

function footerHtml() {
  return `
<footer class="site">
  <div class="friend-links" role="navigation" aria-label="友情链接">
    <span class="fl-label">友情链接</span>
    <a href="https://jdjdndn.github.io" target="_blank" rel="noopener noreferrer">jdjdndn.github.io</a>
    <a href="https://zh.wcbblll.cc" target="_blank" rel="noopener noreferrer">zh.wcbblll.cc</a>
  </div>
  <p>© 2026 券宝 · 优惠链接导航 · 最后更新 ${esc(UPDATED)}</p>
  <p>优惠信息有时效性，以各平台实际为准 · 小程序链接请在微信中打开</p>
</footer>

<div class="modal-mask" id="modalMask">
  <div class="modal" role="dialog" aria-modal="true" aria-label="微信链接提示">
    <div class="modal-icon">📲</div>
    <h3>需要在微信中打开</h3>
    <p>此链接为微信专属链接，请复制后在微信中粘贴打开</p>
    <div class="modal-link" id="modalLink"></div>
    <div class="modal-btns">
      <button class="btn-copy" id="copyBtn">复制链接</button>
      <button class="btn-close" id="closeBtn">关闭</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>`;
}

/* tabs：home=true 时渲染为按钮（同页筛选）；否则渲染为链接（跨页导航） */
function tabsHtml({ home, activeCat }) {
  const parts = [];
  if (home) {
    parts.push(`<button class="tab ${activeCat === 'all' ? 'active' : ''}" data-cat="all" data-cat-name="全部">全部<span class="tab-count">${totalCount}</span></button>`);
    actualCats.forEach(c => {
      const cm = catMeta(c);
      parts.push(`<button class="tab ${activeCat === c ? 'active' : ''}" data-cat="${esc(c)}" data-cat-name="${esc(cm.name)}">${cm.emoji} ${esc(cm.name)}<span class="tab-count">${catCount[c]}</span></button>`);
    });
  } else {
    parts.push(`<a class="tab ${activeCat === 'all' ? 'active' : ''}" href="../index.html" data-cat="all" data-cat-name="全部">全部<span class="tab-count">${totalCount}</span></a>`);
    actualCats.forEach(c => {
      const cm = catMeta(c);
      parts.push(`<a class="tab ${activeCat === c ? 'active' : ''}" href="${esc(c)}.html" data-cat="${esc(c)}" data-cat-name="${esc(cm.name)}">${cm.emoji} ${esc(cm.name)}<span class="tab-count">${catCount[c]}</span></a>`);
    });
  }
  return parts.join('\n    ');
}

function headerHtml({ home }) {
  return `
<header class="site">
  <div class="container header-inner">
    <h1><a href="${home ? 'index.html' : '../index.html'}">券宝 · 优惠链接导航</a></h1>
    <span class="header-stat">已收录 <strong>${totalCount}</strong> 个链接</span>
    <button class="theme-btn" id="themeBtn" aria-label="切换深浅色">🌙</button>
  </div>
</header>`;
}

/* ---------- 生成首页 ---------- */
function buildIndex() {
  const cardsHtml = LINKS.map(cardHtml).join('\n    ');
  const html = headHtml({
    title: '券宝 — 优惠链接导航 · 电商/出行/会员/生活优惠一站直达',
    description: '券宝优惠链接导航：汇集京东、淘宝、拼多多、携程、美团等平台优惠，影视音乐会员、随身WiFi、号卡办理一站直达。实时更新，免费使用。',
    canonical: SITE + '/',
  }) + `
<body data-page="home">
${headerHtml({ home: true })}
<main class="container">
  <div class="search-wrap">
    <div class="search-box">
      <span class="icon">🔍</span>
      <input id="searchInput" type="search" placeholder="搜索链接名称/关键词…" aria-label="搜索链接">
      <button class="search-clear" id="searchClear" aria-label="清除搜索">✕</button>
    </div>
  </div>
  <nav class="tabs" id="tabs" aria-label="链接分类">
    ${tabsHtml({ home: true, activeCat: 'all' })}
  </nav>
  <div class="stats-bar" id="statsBar"></div>
  <div class="link-grid" id="linkGrid">
    ${cardsHtml}
  </div>
  <div class="empty-state" id="emptyState">
    <div class="big">🔍</div>
    <p>没有找到匹配的链接，换个关键词试试</p>
  </div>
</main>
${footerHtml()}
<noscript><p style="text-align:center;padding:20px;color:#6b7280">当前未启用 JavaScript，搜索与分类筛选功能不可用；您仍可浏览页面中已静态渲染的全部链接。</p></noscript>
<script>${RUNTIME_JS}</script>
</body>
</html>
`;
  writeFileSync(join(ROOT, 'index.html'), html, 'utf8');
}

/* ---------- 生成分类页 ---------- */
function buildCategory(cat) {
  const cm = catMeta(cat);
  const list = LINKS.filter(l => l.category === cat);
  const cardsHtml = list.map(cardHtml).join('\n    ');
  const intro = CAT_INTRO[cat] || '本分类收录相关优惠链接，具体使用规则与时效以各平台实际为准。';
  const html = headHtml({
    title: `券宝 · ${cm.name}优惠链接导航（${list.length}个）`,
    description: `${cm.name}分类：${intro.slice(0, 80)}…数据更新于 ${UPDATED}。`,
    canonical: `${SITE}/category/${cat}.html`,
    ogTitle: `券宝 · ${cm.name}优惠链接导航`,
  }) + `
<body data-page="category">
${headerHtml({ home: false })}
<main class="container">
  <div class="search-wrap">
    <div class="search-box">
      <span class="icon">🔍</span>
      <input id="searchInput" type="search" placeholder="在「${esc(cm.name)}」内搜索…" aria-label="搜索链接">
      <button class="search-clear" id="searchClear" aria-label="清除搜索">✕</button>
    </div>
  </div>
  <nav class="tabs" id="tabs" aria-label="链接分类">
    ${tabsHtml({ home: false, activeCat: cat })}
  </nav>
  <div class="cat-intro">
    <p><strong>${cm.emoji} ${cm.name}</strong>（共 ${list.length} 条，更新于 ${esc(UPDATED)}）：${intro}</p>
  </div>
  <div class="stats-bar" id="statsBar"></div>
  <div class="link-grid" id="linkGrid">
    ${cardsHtml}
  </div>
  <div class="empty-state" id="emptyState">
    <div class="big">🔍</div>
    <p>没有找到匹配的链接，换个关键词试试</p>
  </div>
</main>
${footerHtml()}
<noscript><p style="text-align:center;padding:20px;color:#6b7280">当前未启用 JavaScript，搜索功能不可用；您仍可浏览本分类下全部 ${list.length} 条链接。</p></noscript>
<script>${RUNTIME_JS}</script>
</body>
</html>
`;
  const dir = join(ROOT, 'category');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, cat + '.html'), html, 'utf8');
}

/* ---------- 生成 404 页 ---------- */
function build404() {
  const html = headHtml({
    title: '404 · 页面未找到 — 券宝优惠链接导航',
    description: '您访问的页面不存在，返回首页继续浏览优惠链接。',
    canonical: SITE + '/404.html',
  }) + `
<body data-page="other">
${headerHtml({ home: true })}
<main class="container">
  <div class="err-wrap">
    <div class="err-code">404</div>
    <p class="err-tip">您访问的页面不存在或已被移除</p>
    <a class="err-home" href="/">返回券宝首页</a>
  </div>
</main>
${footerHtml()}
</body>
</html>
`;
  writeFileSync(join(ROOT, '404.html'), html, 'utf8');
}

/* ---------- 生成 sitemap.xml ---------- */
function buildSitemap() {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  lines.push(`  <url>
    <loc>${SITE}/</loc>
    <lastmod>${esc(UPDATED)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>`);
  actualCats.forEach(c => {
    lines.push(`  <url>
    <loc>${SITE}/category/${esc(c)}.html</loc>
    <lastmod>${esc(UPDATED)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`);
  });
  lines.push('</urlset>');
  writeFileSync(join(ROOT, 'sitemap.xml'), lines.join('\n') + '\n', 'utf8');
}

/* ---------- 更新 wrangler.jsonc ---------- */
function updateWrangler() {
  const p = join(ROOT, 'wrangler.jsonc');
  let raw = readFileSync(p, 'utf8');
  // 保留注释风格：直接在 assets 对象里追加 not_found_handling。
  // 用 JSON.parse 解析（jsonc 在此文件里无注释，安全），写回时用 2 空格缩进。
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
  cfg.assets = cfg.assets || {};
  // wrangler 4.x 合法取值: "single-page-application" | "404-page" | "none"
  // "404-page" 会自动向上查找 404.html 并以 404 状态返回
  cfg.assets.not_found_handling = '404-page';
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/* ---------- 主流程 ---------- */
function main() {
  console.log('[build] 读取 links-data.json：' + totalCount + ' 条链接，更新于 ' + UPDATED);
  console.log('[build] 分类：' + actualCats.map(c => c + '(' + catCount[c] + ')').join(', '));

  // 清理旧 category 目录（保证分类被删后不残留）
  const catDir = join(ROOT, 'category');
  if (existsSync(catDir)) rmSync(catDir, { recursive: true, force: true });

  buildIndex();
  console.log('[build] 生成 index.html');

  actualCats.forEach(c => { buildCategory(c); });
  console.log('[build] 生成 category/*.html 共 ' + actualCats.length + ' 个');

  build404();
  console.log('[build] 生成 404.html');

  buildSitemap();
  console.log('[build] 生成 sitemap.xml（' + (1 + actualCats.length) + ' 条 URL）');

  updateWrangler();
  console.log('[build] 更新 wrangler.jsonc：assets.not_found_handling = "404-page"');

  console.log('[build] 完成。');
}

main();
