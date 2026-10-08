// ============================================================
// GENERATED FILE — DO NOT EDIT（由 update-ai-config.cjs 从唯一事实源生成）
// 来源：auto-ai-article/src/ai-config.ts（构建产物 dist/ai-config.js）
// 公共修改路径：改 auto-ai-article → npm run build → node update-ai-config.cjs → sync-lib 分发
// ============================================================
"use strict";
// ============================================================
// ai-config.ts —— AI 模型/提供方配置唯一事实源（Single Source of Truth）
//
// 各消费方（seo-optimizer / 15 站点 / template）统一从这里取配置，
// 公共修改只改本文件，经 sync-vendor（15 站点 vendor）与 sync-lib（seo-optimizer）同步。
// 任何使用方不得手抄本文件内容。
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.SITE_DEFAULT_MODELS = exports.FALLBACK_PROVIDERS = exports.OPENROUTER_FREE_MODELS = exports.FREE_TEXT_MODELS = void 0;
exports.getSiteDefaultModel = getSiteDefaultModel;
// —— Cloudflare Workers AI 免费模型清单（按优先级排序）——
// 来源：Cloudflare Workers AI 官方文档（2026-10）
// 免费额度：每个模型每日 10,000 neurons
exports.FREE_TEXT_MODELS = [
    // —— 中文优化模型（优先）——
    { id: '@cf/qwen/qwen3.8-27b', provider: 'Alibaba/Qwen', priority: 1, description: 'Qwen 3.8，中文能力最强', chineseOptimized: true, noThinking: true },
    { id: '@cf/zai-org/glm-5.3', provider: 'Zhipu AI', priority: 2, description: '智谱 GLM 5.3，中文优秀', chineseOptimized: true, noThinking: true },
    { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', provider: 'DeepSeek', priority: 3, description: 'DeepSeek V4 专业版', chineseOptimized: true, noThinking: true },
    { id: '@cf/moonshotai/kimi-k2.6', provider: 'Moonshot AI', priority: 4, description: 'Moonshot Kimi K2.6', chineseOptimized: true, noThinking: true },
    { id: '@cf/qwen/qwen3-30b-a3b-fp8', provider: 'Alibaba/Qwen', priority: 5, description: 'Qwen 3 MoE 架构', chineseOptimized: true, noThinking: true },
    { id: '@cf/zai-org/glm-5.2', provider: 'Zhipu AI', priority: 6, description: '智谱 GLM 5.2', chineseOptimized: true, noThinking: true },
    { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', provider: 'DeepSeek', priority: 7, description: 'DeepSeek V4 快速版', chineseOptimized: true, noThinking: true },
    { id: '@cf/moonshotai/kimi-k2.7-code', provider: 'Moonshot AI', priority: 8, description: 'Kimi K2.7 代码增强版', chineseOptimized: true, noThinking: true },
    { id: '@cf/zai-org/glm-5.3-flash', provider: 'Zhipu AI', priority: 9, description: '智谱 GLM 5.3 快速版', chineseOptimized: true, noThinking: true },
    { id: '@cf/qwen/qwen2.5-coder-32b-instruct', provider: 'Alibaba/Qwen', priority: 10, description: 'Qwen 2.5 Coder 32B', chineseOptimized: true, noThinking: true },
    // —— 通用模型（备选）——
    { id: '@cf/meta/llama-4-scout-17b-16e-instruct', provider: 'Meta', priority: 11, description: 'Meta Llama 4 Scout', chineseOptimized: false, noThinking: true },
    { id: '@cf/openai/gpt-oss-120b', provider: 'OpenAI', priority: 12, description: 'OpenAI 开源 120B', chineseOptimized: false, noThinking: true },
    { id: '@cf/zai-org/glm-4.7-flash', provider: 'Zhipu AI', priority: 13, description: '智谱 GLM 4.7 快速版', chineseOptimized: true, noThinking: true },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', provider: 'Mistral AI', priority: 14, description: 'Mistral Small 3.1', chineseOptimized: false, noThinking: false },
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', provider: 'Meta', priority: 15, description: 'Meta Llama 3.3 70B', chineseOptimized: false, noThinking: true },
];
/** OpenRouter 免费模型链（2026-10-07 实时查询，前 10 个，顺序即降级顺序；:free 后缀的模型无需账户 credits） */
exports.OPENROUTER_FREE_MODELS = [
    'inclusionai/ling-3.1-flash',
    'apodex/apodex-1.1-mini:free',
    'inclusionai/ling-3.0-flash-sante:free',
    'dots-studio/dots-3-note-preview:free',
    'liquid/lfm-2.5-2.6b:free',
    'nvidia/nemotron-3.5-lightning:free',
    'thinkingmachines/inkling-small:free',
    'poolside/laguna-s-2.1:free',
    'thinkingmachines/inkling:free',
    'poolside/laguna-xs-2.1:free',
];
exports.FALLBACK_PROVIDERS = [
    { name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', models: exports.OPENROUTER_FREE_MODELS },
    { name: '阿里百炼', envKey: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo'] },
    { name: 'Google Gemini', envKey: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-1.5-flash'] },
    { name: 'Mistral', envKey: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-small-latest', 'mistral-large-latest'] },
    { name: 'Cerebras', envKey: 'CEREBRAS_API_KEY', baseUrl: 'https://api.cerebras.ai/v1', models: ['llama-3.3-70b', 'llama-3.1-8b'] },
    { name: '自定义 OpenAI 兼容', envKey: 'LLM_API_KEY', baseUrl: 'LLM_BASE_URL', models: ['LLM_MODEL'] },
];
/** 各站点族默认 CF 模型（消费项目不单独声明时使用；当前 15 站点统一） */
exports.SITE_DEFAULT_MODELS = {
    default: '@cf/qwen/qwen3-30b-a3b-fp8',
    // 号卡 / 信用卡 / 随身wifi / article-site / template 全部使用默认；需要单独指定时在此加一行：
    // '号卡/172': '@cf/xxx/yyy',
};
/** 取站点默认模型（未在表中覆盖则用 default） */
function getSiteDefaultModel(siteKey) {
    if (siteKey && exports.SITE_DEFAULT_MODELS[siteKey])
        return exports.SITE_DEFAULT_MODELS[siteKey];
    return exports.SITE_DEFAULT_MODELS.default;
}
