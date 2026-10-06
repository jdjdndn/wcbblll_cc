# wcbblll.cc — 优惠链接导航站

优惠聚合站「券宝」的独立导航站点，汇集电商、出行、会员、网盘、号卡、随身WiFi、云服务等全网优惠链接与小程序的入口导航页。

线上地址：<https://wcbblll.cc>

---

## 页面说明

| 文件 | 说明 |
|------|------|
| `index.html` | 站点首页（构建产物）。117 条优惠链接已全部静态预渲染进 HTML，核心内容不依赖 JS 运行时加载 |
| `links-data.json` | 链接数据文件（114 个链接 + 更新时间），由构建脚本自动生成 |

## 目录结构

```
wcbblll_cc/
├── index.html          # 首页（构建产物，117 条链接已静态化）
├── links-data.json     # 链接数据（内容源，勿手改）
├── build-static.mjs    # 构建脚本（读 links-data.json 生成全套产物）
├── category/           # 12 个分类独立页（构建产物）
├── 404.html            # 真实 404 页（构建产物）
├── sitemap.xml         # 站点地图（构建产物）
├── wrangler.jsonc      # Cloudflare Workers 静态资源部署配置
├── rebuild-all.cjs     # 一键重建脚本副本（见下方使用说明）
└── README.md
```

---

## 数据来源

链接数据从 **github.io 主站**（`E:\code\github.io`）的以下数据源提取、去重、分类生成：

| 数据源 | 提取内容 |
|--------|---------|
| `src/data.js` | tabs 各分类活动链接、friendLinks、FRIEND_LINKS_DATA |
| `src/views/fuye-data.js` | 项目入口链接 |
| `src/templates/wifi-data.js` | 随身WiFi 购买/代理链接 |
| `src/views/Huiyuan.vue` | 会员购买链接 |

规则：排除 `.html` 文章链接；URL 去重（重复项自动合并 name/price/deadline 字段）；按分类体系归类（电商/外卖/出行/会员/网盘/号卡/WiFi/云/小程序/App拉新/信用卡）。

## 数据更新

修改主站数据源后，在主站目录执行：

```bash
# 仅更新链接数据（links-data.json）
npm run build

# 或单独运行
node scripts/build-links-page.mjs json   # 只生成 links-data.json
node scripts/build-links-page.mjs index  # 生成 index.html + links-data.json
```

`npm run build` 会在构建末尾自动执行 `build-links-page.mjs json`，输出最新的 `links-data.json`。

> 更新完 `links-data.json` 后，回到本目录执行 `node rebuild-all.cjs --prebuild wcbblll_cc` 重建全部静态产物（见下节）。

---

## 内容重建与 SEO 校验（rebuild-all.cjs）

本目录已内置一键重建脚本副本 `rebuild-all.cjs`（本目录无 package.json，无法加 npm prebuild 钩子，需手动执行）。

### 内容更新后重建（改完 links-data.json 后）

```powershell
node rebuild-all.cjs --prebuild wcbblll_cc
```

自动完成：重建 index.html（117 条链接全量静态化 + 分类计数从 JSON 重算）、12 个分类页 `category/*.html`、404.html、sitemap.xml（首页 + 12 分类页），并把 `wrangler.jsonc` 的 `not_found_handling` 写回 `"404-page"`；随后自动校验 5 项（链接条数、无核心 fetch、sitemap 条数、分类页数量、404 配置），任一不通过则以非零退出码终止。

### 部署（当前为 Cloudflare Workers 静态资源）

```powershell
node rebuild-all.cjs --prebuild wcbblll_cc; if ($?) { npx wrangler deploy }
```

### 其他

- 全站一键重建 + 校验（含 github.io、xiaoshengyi 等全部 20 站）：在任意目录执行 `node rebuild-all.cjs`
- 等效的原生构建脚本：`node build-static.mjs`（rebuild-all 内部即调用它）
- 脚本升级：以 `E:\code\rebuild-all.cjs` 为规范版，更新后重新复制到本目录

---

## 部署（Cloudflare Pages）

1. 将本目录推送到 Git 仓库（如 GitHub）
2. Cloudflare Dashboard → **Workers & Pages → Create → Pages** → 连接仓库
3. 构建配置：
   - 构建命令：**留空**（纯静态文件）
   - 输出目录：`/`（或 `.`）
4. 部署完成后绑定自定义域名 `wcbblll.cc`
5. 自动获得 SSL 证书，启用 HTTPS 强制跳转

> 提示：如域名已在 Cloudflare 管理，绑定时会自动完成 DNS 配置；否则手动添加 CNAME 记录指向 `xxx.pages.dev`。

## 友情链接

- <https://zh.wcbblll.cc> — 中文站

---

## 注意事项

- **本地打开**：`index.html` 依赖 fetch 加载 JSON，需通过 HTTP 服务访问（`python -m http.server`）。
- **跨域**：当前 index.html 与 links-data.json 同目录部署，为同源请求，无跨域问题；如需跨域拉取其他站数据，需在 Cloudflare 侧加代理/CORS。
- **小程序链接**：微信小程序（`#小程序://`、`weixin://`）仅在微信内可打开，页面已内置"非微信环境复制链接"提示；支付宝小程序（`alipays://`）脚本已支持识别。
- **时效性**：部分优惠链接有截止日期，页面会展示"至 20xx.xx.xx"；优惠信息以各平台实际为准。
- **安全**：外链统一 `target="_blank" rel="noopener noreferrer"`；HTTP 链接在页面标注"非HTTPS"提示。
