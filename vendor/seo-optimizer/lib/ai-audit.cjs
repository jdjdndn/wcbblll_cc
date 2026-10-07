/*
 * lib/ai-audit.cjs —— AI 修复建议增强层（Phase 7，默认关闭）
 *
 * 定位：不进入产物生成路径；仅对巡检发现问题（issues）生成"修复建议/定位提示"，
 *       辅助人工判断"要改哪些坏东西"。显式 --ai-audit 才启用。
 *
 * 提供方：Cloudflare Workers AI 免费模型（与 auto-ai-article/src/ai-fallback.ts 同机制：
 *         FREE_TEXT_MODELS 中文优先降级链 + 超时/门禁），每模型每日 10,000 neurons 免费。
 *
 * 配置（环境变量）：
 *   CF_API_TOKEN   Cloudflare API Token（AI 推理权限）
 *   CF_ACCOUNT_ID  Cloudflare Account ID
 *   未配置时 --ai-audit 跳过并提示（不阻塞巡检）。
 */
'use strict';

const FREE_TEXT_MODELS = [
  'qwen3.8-27b',
  'zai-org/glm-5.3',
  'deepseek-v4-pro-0813',
  'moonshotai/kimi-k2.6',
  'qwen3-30b-a3b-fp8',
  'glm-5.2',
  'deepseek-v4-flash',
  'kimi-k2.7-code',
  'glm-5.3-flash',
  'qwen2.5-coder-32b',
  'llama-4-scout',
  'gpt-oss-120b',
  'glm-4.7-flash',
  'mistral-small-3.1',
  'llama-3.3-70b',
];

function cfg() {
  return { apiToken: process.env.CF_API_TOKEN, accountId: process.env.CF_ACCOUNT_ID };
}

async function aiComplete(model, prompt, { apiToken, accountId, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 120000);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 600, chat_template_kwargs: { thinking: false } }),
      }
    );
    const data = await res.json();
    const text = data && data.result && (data.result.response || data.result.text || '');
    return { ok: !!text, text: String(text || '').trim() };
  } catch (e) {
    return { ok: false, text: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 对问题清单生成修复建议：按模型降级链逐个尝试，首个产出非空即用
async function auditIssues(issues, opts) {
  const o = opts || {};
  const c = cfg();
  if (!c.apiToken || !c.accountId) {
    return { enabled: false, note: '未配置 CF_API_TOKEN / CF_ACCOUNT_ID，AI 审计跳过（不影响巡检）' };
  }
  const prompt = `你是 SEO 工程师。以下是一次多站点 SEO 巡检发现的问题（9 字段：site/type/severity/expect/actual/fixSource），请针对每条给出：可能根因、具体修复动作、修复后如何验证。用中文，简洁分点，每条不超过 80 字。\n\n${JSON.stringify((issues || []).slice(0, o.limit || 10), null, 2)}`;
  for (const model of (o.models || FREE_TEXT_MODELS)) {
    const r = await aiComplete(model, prompt, { ...c, timeoutMs: o.timeoutMs || 120000 });
    if (r.ok && r.text.length >= (o.minLength || 20)) {
      return { enabled: true, model, advice: r.text };
    }
    if (r.error) continue;
  }
  return { enabled: true, model: null, note: '全部免费模型未产出有效建议（当日额度或网络）' };
}

module.exports = { auditIssues, FREE_TEXT_MODELS, cfg };
