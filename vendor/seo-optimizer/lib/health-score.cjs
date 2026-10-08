/*
 * lib/health-score.cjs —— 站点健康评分（0-100）+; 0-100）+ 评级 S/A/B/C/D
 *
 * 评分逻辑：
 *   基础分 100，按问题严重度扣分：
 *   - high 问题 -15 分（首页不可达/404 错误等）
 *   - medium 问题 -5 分（Meta 缺失/结构化数据等）
 *   - low 问题 -1 分（安全头/性能优化等）
 *   (  0- low 问题 -1 分（安全头/性能优化等）
 *   最低 0 分
 *
 * 评级：
 *   S(95-100) / A(85-94) / B(70-84) / C(50-69) / D(0-49)
 */
'use strict';

function calculateHealthScore(checks) {
  if (!checks || !checks.length) return 100;
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return 100;
  let score = 100;
  for (const c of failed) {
    const desc = (c.desc || '').toLowerCase();
    let severity;
    if (/首页可达|404|sitemap.*HTTP|robots.*HTTP|首页.*HTTP/.test(desc)) severity = 'high';
    else if (/安全头/.test(desc)) severity = 'low';
    else severity = 'medium';
    if (severity === 'high') score -= 15;
    else if (severity === 'medium') score -= 5;
    else score -= 1;
  }
  return Math.max(0, score);
}

function getGrade(score) {
  if (score >= 95) return { grade: 'S', color: '#1a7f37', label: '优秀' };
  if (score >= 85) return { grade: 'A', color: '#2da44e', label: '良好' };
  if (score >= 70) return { grade: 'B', color: '#d29922', label: '合格' };
  if (score >= 50) return { grade: 'C', color: '#db6d28', label: '待改进' };
  return { grade: 'D', color: '#cf222e', label: '不合格' };
}

function scoreSite(site) {
  const checks = site.checks || [];
  const score = calculateHealthScore(checks);
  const grade = getGrade(score);
  return { score, grade: grade.grade, gradeColor: grade.color, gradeLabel: grade.label, passed: checks.filter((c) => c.ok).length, total: checks.length };
}

function scoreAll(sites) {
  return (sites || []).map((s) => ({ name: s.name, ...scoreSite(s) }));
}

module.exports = { calculateHealthScore, getGrade, scoreSite, scoreAll };
