/*
 * lib/ai-audit.cjs —— AI 修复建议增强层（Phase 7，默认关闭）
 *
 * 定位：不进入产物生成路径；仅对巡检发现问题（issues）生成"修复建议/定位提示"，
 *       辅助人工判断"要改哪些坏东西"。显式 --ai-audit 才启用。
 *
 * 多提供方统一降级（移植 auto-ai-article/src/ai-fallback.ts 逻辑）：
 *   1. Cloudflare Workers AI 免费模型链（FREE_TEXT_MODELS，中文优先，每日 10,000 neurons/模型）
 *   2. OpenAI 兼容备用提供方（哪个配了 key 用哪个，按优先级）：
 *        OPENROUTER_API_KEY  → OpenRouter（https://openrouter.ai/api/v1）
 *        DASHSCOPE_API_KEY   → 阿里百炼（https://dashscope.aliyuncs.com/compatible-mode/v1）
 *        GEMINI_API_KEY      → Google Gemini OpenAI 兼容端点（https://generativelanguage.googleapis.com/v1beta/openai）
 *        MISTRAL_API_KEY     → Mistral（https://api.mistral.ai/v1）
 *        CEREBRAS_API_KEY    → Cerebras（https://api.cerebras.ai/v1）
 *        LLM_API_KEY         → 自定义 OpenAI 兼容（配合 LLM_BASE_URL）
 *   CF 全部失败（额度/限流/超时等）后自动切换备用提供方；全部失败则跳过不阻塞巡检。
 *
 * 配置（环境变量，seo-optimizer/.env 或 --env-file 加载）：
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（或 CF_API_TOKEN / CF_ACCOUNT_ID）
 *   以及上方任一备用提供方 key。
 *   未配置任何凭证时 --ai-audit 跳过并提示。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// —— AI 模型/提供方配置：唯一事实源 auto-ai-article/src/ai-config.ts
//    通过 vendor/ai-article-pipeline 引用（file: 依赖），改模型只改 auto-ai-article 一处
const { FREE_TEXT_MODELS, OPENROUTER_FREE_MODELS, FALLBACK_PROVIDERS } = require('ai-article-pipeline/ai-config');
const { LocalAiProvider, CfRestProvider, FallbackChain } = require('ai-article-pipeline/ai-fallback');

// —— 凭证读取 ——
function cfg() {
  return {
    apiToken: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || null,
    accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || null,
  };
}

// —— 当天失败记忆（runs/bad-ai-models.json，跨进程当天复用）——
function badModelStore() {
  const file = path.join(__dirname, '..', 'runs', 'bad-ai-models.json');
  return {
    load() {
      try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d) ? d : null; } catch { return null; }
    },
    save(list) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(list)); } catch {}
    },
  };
}

// —— 响应提取（兼容 CF 与 OpenAI 兼容格式）——
function extractResponse(data) {
  if (typeof data === 'string') return data;
  const pick = (v) => (typeof v === 'string' && v.trim() ? v : '');
  const r1 = pick(data && data.result && data.result.response); if (r1) return r1;
  const r2 = pick(data && data.result); if (r2) return r2;
  const r3 = pick(data && data.result && data.result.choices && data.result.choices[0] && data.result.choices[0].message && data.result.choices[0].message.content); if (r3) return r3;
  if (Array.isArray(data && data.result)) { const r4 = pick(data.result[0] && data.result[0].content); if (r4) return r4; }
  const r5 = pick(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content); if (r5) return r5;
  const r6 = pick(data && data.response); if (r6) return r6;
  const r7 = pick(data && data.result && data.result.choices && data.result.choices[0] && data.result.choices[0].message && data.result.choices[0].message.reasoning_content); if (r7) return r7;
  const r8 = pick(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.reasoning_content); if (r8) return r8;
  return pick(data && data.result && data.result.content) || pick(data && data.result && data.result.text) || pick(data && data.text) || '';
}

// —— 错误分类 ——
function classifyError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (msg.includes('rate') || msg.includes('429')) return 'rate_limit';
  if (msg.includes('quota') || msg.includes('exceeded') || msg.includes('not verified') || msg.includes('402') || msg.includes('insufficient credits')) return 'quota_exceeded';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('server')) return 'server_error';
  if (msg.includes('400') || msg.includes('invalid') || msg.includes('bad request') || msg.includes('401') || msg.includes('unauthorized')) return 'invalid_request';
  return 'unknown';
}

function isDeterministicFailure(err) {
  const reason = classifyError(err);
  if (['quota_exceeded', 'rate_limit', 'timeout', 'invalid_request'].includes(reason)) return true;
  return /被截断|没有返回内容|过短|结尾不完整/.test(err.message || '');
}

// —— OpenAI 兼容客户端（备用提供方）——
function oaiClient(baseUrl, apiKey, model, timeoutMs) {
  return async (messages) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('AI 请求超时', 'TimeoutError')), timeoutMs || 120000);
    try {
      const res = await fetch(`${(baseUrl || '').replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}) },
        body: JSON.stringify({ model, messages, max_tokens: 15360, stream: false }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = await res.json();
      const content = extractResponse(data);
      if (!content) throw new Error('AI 没有返回内容');
      return content;
    } finally { clearTimeout(timer); }
  };
}

// —— 统一降级链：CF 15 模型 → 备用提供方 ——
function createUnifiedClient(opts) {
  const o = opts || {};
  const c = cfg();
  const store = badModelStore();
  const badModels = new Set(store.load() || []);
  const quotaExhausted = new Set();
  const log = (...args) => console.log(new Date().toISOString(), '[ai-audit]', ...args);
  const minLength = o.minLength || 20;

  function endingOk(content) {
    const tail = content.trim().replace(/`{3,}/g, '').trim();
    return /[。！？…!?.]$/.test(tail) || /https?:\/\/\S+$/.test(tail);
  }

  async function tryClient(client, label, messages) {
    try {
      const content = await client(messages);
      if (content.trim().length < minLength) throw new Error(`内容过短(${content.trim().length}字 < ${minLength})`);
      if (o.requireEnding && !endingOk(content)) throw new Error('内容被截断(结尾不完整)');
      return { ok: true, content, label };
    } catch (e) {
      const reason = classifyError(e);
      log(`失败：${label}（${reason}）: ${e.message.slice(0, 120)}`);
      if (reason === 'quota_exceeded' || reason === 'invalid_request') {
        // 记录当天失败：同一进程/当天不再尝试
        badModels.add(label);
        store.save([...badModels]);
      }
      return { ok: false, reason, error: e.message };
    }
  }

  // FallbackChain（local + CF REST，降级逻辑委托给 dist，dist 升级自动跟进）
  const chainProviders = [];
  if (process.env.LLM_BASE_URL && process.env.LLM_MODEL) {
    chainProviders.push(new LocalAiProvider({ baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, apiKey: process.env.LLM_API_KEY || 'any' }));
  }
  if (c.apiToken && c.accountId) {
    chainProviders.push(new CfRestProvider({ apiToken: c.apiToken, accountId: c.accountId }));
  }
  const chain = chainProviders.length ? new FallbackChain(chainProviders) : null;

  return async (messages) => {
    // 1. FallbackChain（本地网关 + CF REST，降级委托给 dist）
    if (chain) {
      try {
        const content = await chain.run(messages);
        return { ok: true, content, provider: chain.lastSuccess || 'fallback-chain', model: chain.lastSuccess || 'unknown' };
      } catch (e) {
        log(`FallbackChain 失败，切换备用提供方: ${String(e.message || e).slice(0, 120)}`);
      }
    }

    // 2. 备用提供方（有 key 且非当天失败；每个提供方内按模型链降级）
    for (const p of FALLBACK_PROVIDERS) {
      const key = process.env[p.envKey];
      if (!key || badModels.has(p.name)) continue;
      const baseUrl = p.name === '自定义 OpenAI 兼容' ? (process.env[p.baseUrl] || 'https://api.openai.com/v1') : p.baseUrl;
      let providerAuthFailed = false;
      for (const model of p.models) {
        const resolved = p.name === '自定义 OpenAI 兼容' ? (process.env[model] || 'gpt-4o-mini') : model;
        const r = await tryClient(oaiClient(baseUrl, key, resolved, o.timeoutMs), `${p.name}/${resolved}`, messages);
        if (r.ok) return { ok: true, content: r.content, provider: p.name, model: resolved };
        // 认证类失败（401/403：key 无效/域名未验证）→ 换提供方无意义，整体放弃
        if (/401|403|unauthorized|forbidden/.test(String(r.error || ''))) { providerAuthFailed = true; break; }
        // 其余（402 无额度/404 模型下架/429 限流/5xx/超时/内容不合格）→ 继续下一模型（:free 模型无需 credits）
      }
      if (providerAuthFailed && p.models.length > 1) continue;
    }

    const cfConfigured = c.apiToken && c.accountId;
    const fallbackConfigured = FALLBACK_PROVIDERS.some((p) => process.env[p.envKey] && !badModels.has(p.name));
    return { ok: false, reason: 'all_failed', note: cfConfigured ? (fallbackConfigured ? '所有提供方失败（额度/网络/当天失败记忆）' : 'CF 失败且未配置备用提供方（添加 OPENROUTER_API_KEY / DASHSCOPE_API_KEY 等后自动启用）') : '未配置任何 AI 凭证，AI 审计跳过（不影响巡检）' };
  };
}

// —— AI 建议质量评分（0-100） ——
function scoreAdvice(advice, issueCount) {
  let score = 0;
  const reasons = [];
  if (/修复|添加|删除|修改|设置|配置|修正|补全|缩短|扩充/.test(advice)) { score += 30; reasons.push('含具体动作'); }
  else { reasons.push('缺具体动作'); }
  if (/验证|重跑|确认|检查|部署后/.test(advice)) { score += 20; reasons.push('含验证步骤'); }
  else { reasons.push('缺验证步骤'); }
  if (/\.html|\.json|\.js|wrangler|meta|title|link|script|sitemap|viewport|alt|canonical/.test(advice)) { score += 20; reasons.push('引用正确文件/标签'); }
  else { reasons.push('未引用具体文件'); }
  const lines = advice.split('\n').filter((l) => l.trim());
  if (issueCount && lines.length >= issueCount) { score += 15; reasons.push('按问题逐条回复'); }
  else { reasons.push('未逐条回复'); }
  if (advice.length >= 80 && advice.length <= 1000) { score += 15; reasons.push('长度合理'); }
  else { reasons.push('长度异常'); }
  return { score, reasons };
}

// —— 对问题清单生成修复建议（模板优先 + AI 降级 + 质量评分） ——
async function auditIssues(issues, opts) {
  const o = opts || {};
  const all = issues || [];

  // 1. 模板匹配（零成本确定性诊断）
  const { classifyIssues } = require('./issue-templates.cjs');
  const classified = classifyIssues(all.slice(0, o.limit || 10));
  const templated = classified.filter((i) => i.template);
  const unmatched = classified.filter((i) => !i.template);

  const result = {
    enabled: true,
    templated: templated.map((i) => ({ site: i.site, type: i.type, actual: i.actual, fix: i.template.fix, verify: i.template.verify })),
    unmatchedCount: unmatched.length,
  };

  // 2. 未匹配问题调 AI 生成建议
  if (!unmatched.length) {
    return Object.assign(result, { advice: null, note: '全部问题已由模板匹配，无需 AI 诊断' });
  }

  const c = cfg();
  const anyConfigured = (c.apiToken && c.accountId) || FALLBACK_PROVIDERS.some((p) => process.env[p.envKey]);
  if (!anyConfigured) {
    return Object.assign(result, { advice: null, note: '未配置 AI 凭证，未匹配问题跳过 AI 诊断（不影响巡检）' });
  }

  const prompt = `你是 SEO 工程师。以下是 SEO 巡检发现的问题，请针对每条给出：可能根因、具体修复动作、修复后如何验证。用中文，简洁分点，每条不超过 80 字。\n\n${JSON.stringify(unmatched, null, 2)}`;
  const messages = [{ role: 'user', content: prompt }];
  const client = createUnifiedClient(o);
  const r = await client(messages);
  if (r.ok) {
    const quality = scoreAdvice(r.content, unmatched.length);
    return Object.assign(result, { provider: r.provider, model: r.model, advice: r.content, quality });
  }
  return Object.assign(result, { advice: null, note: r.note });
}

// —— 提取首个平衡的 JSON 数组（处理 markdown 代码块/嵌套） ——
function extractJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// —— 方向B：巡检全绿时，AI 主动审查断言未覆盖的盲区 ——
// pages: [{ site, htmlExcerpt, passedAssertions: [断言类型] }]
// 输出: { enabled, blindSpots: [{site, issue, location, severity, suggestion}], provider, model }
async function auditBlindSpots(pages, opts) {
  const o = opts || {};
  const list = (pages || []).filter((p) => p && p.htmlExcerpt && String(p.htmlExcerpt).trim()).slice(0, o.limit || 5);
  if (!list.length) return { enabled: true, blindSpots: [], note: '无页面摘要，跳过盲区审查' };

  const c = cfg();
  const anyConfigured = (c.apiToken && c.accountId) || FALLBACK_PROVIDERS.some((p) => process.env[p.envKey]);
  if (!anyConfigured) return { enabled: true, blindSpots: [], note: '未配置 AI 凭证，盲区审查跳过（不影响巡检）' };

  const prompt = '你是 SEO/GEO 审查员。以下页面已通过确定性断言（见 passedAssertions）。请只从断言未覆盖的维度审查，找出潜在问题：\n- 内容质量与用户意图匹配度\n- E-E-A-T（经验/专业/权威/可信）\n- AI 可引用性（答案是否清晰可核实，GEO 核心）\n- heading 与正文的语义一致性\n- 结构化数据断言未深查的字段\n只输出 JSON 数组，无问题输出 []：[{site, issue, location, severity, suggestion}]\nseverity 取 high/medium/low。\n\n页面与已通过断言：\n' + JSON.stringify(list.map((p) => ({ site: p.site, passedAssertions: p.passedAssertions || [], htmlExcerpt: p.htmlExcerpt })), null, 2);

  const client = createUnifiedClient(o);
  const r = await client([{ role: 'user', content: prompt }]);
  if (r.ok) {
    const cleaned = r.content.replace(/```(?:json)?\s*/g, '').trim();
    const jsonStr = extractJsonArray(cleaned);
    let blindSpots = [];
    if (jsonStr) { try { blindSpots = JSON.parse(jsonStr); } catch (e) {} }
    if (!Array.isArray(blindSpots)) blindSpots = [];
    return { enabled: true, blindSpots, provider: r.provider, model: r.model, count: blindSpots.length };
  }
  return { enabled: true, blindSpots: [], note: r.note || 'AI 调用失败' };
}

module.exports = { auditIssues, auditBlindSpots, scoreAdvice, extractJsonArray, FREE_TEXT_MODELS, cfg, createUnifiedClient, classifyError, extractResponse };
