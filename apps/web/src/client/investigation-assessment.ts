import type { CompetitorTask } from '@cwatch/core/types';
import type { RunSnapshot } from '@cwatch/core/types/runs';
import { $, escapeHtml, safeUrl } from './state.ts';

type Policy = NonNullable<CompetitorTask['evidencePolicy']>;
type Source = Policy['sources'][number];
const kinds: Record<Source['kind'], string> = { official_site: '官方网站', documentation: '官方文档', changelog: '发布日志', official_forum: '官方论坛', other: '其他' };
const outcomes: Record<string, string> = { candidate_coverage: '候选覆盖完成', no_new_candidates: '两种策略均无新增候选', budget: '达到工具预算', source_unavailable: '来源或工具不可用', pending: '待查', not_attempted: '未查', read: '已读，暂无核验依据', empty: '已读，结果为空', failed: '访问失败', evidence_found: '已取得核验证据' };
const dimensions: Record<string, string> = { scope: '范围一致', source_identity: '来源与身份', citation: '引用可回查', evidence_support: '证据支撑', conflicts_and_gaps: '冲突与缺口', report_consistency: '报告表达一致' };
const checks: Record<string, string> = { pass: '通过', not_applicable: '不适用', issue: '需修正' };
const findingNames = { verified: '已核验', conflict: '证据冲突', insufficient: '证据不足' };
export const investigationStages: Record<string, string> = { plan: '计划', collection: '采集', analysis: '分析', review: '审查', review_recheck_available: '待定向补查', draft: '草稿', draft_saved: '草稿已生成' };

function addRow(source?: Source): void {
  const host = $('specified-source-rows');
  if (host.childElementCount >= 12) return;
  const row = document.createElement('div');
  row.className = 'specified-source-row';
  row.innerHTML = `<input type="url" maxlength="2000" aria-label="指定来源网址" placeholder="https://example.com/changelog" value="${escapeHtml(source?.url)}"><select aria-label="来源类型">${Object.entries(kinds).map(([key, label]) => `<option value="${key}" ${key === source?.kind ? 'selected' : ''}>${label}</option>`).join('')}</select><button type="button" class="button ghost sm" aria-label="移除此来源">移除</button>`;
  row.querySelector('button')!.addEventListener('click', () => { row.remove(); ($('add-specified-source') as HTMLButtonElement).disabled = false; });
  host.append(row);
  ($('add-specified-source') as HTMLButtonElement).disabled = host.childElementCount >= 12;
  if (!source) row.querySelector('input')!.focus();
}

export function bindSpecifiedSources(): void { $('add-specified-source').addEventListener('click', () => addRow()); }

export function fillSpecifiedSources(policy?: Policy): void {
  $('specified-source-rows').replaceChildren();
  $<HTMLButtonElement>('add-specified-source').disabled = false;
  $<HTMLSelectElement>('specified-source-scope').value = policy?.scope ?? 'prefer';
  for (const source of policy?.sources ?? []) addRow(source);
}

export function readSpecifiedSources(): Policy {
  const scope = $<HTMLSelectElement>('specified-source-scope').value as Policy['scope'];
  const sources = [...$('specified-source-rows').querySelectorAll('.specified-source-row')].flatMap(row => {
    const url = row.querySelector('input')!.value.trim();
    if (!url) return [];
    if (!/^https:\/\//i.test(url)) throw Error('指定来源必须使用 HTTPS 网址。');
    return [{ url, kind: row.querySelector('select')!.value as Source['kind'] }];
  });
  if (scope === 'only' && !sources.length) throw Error('选择「只查指定网址」时至少添加一个入口。');
  return { scope, sources };
}

export function renderInvestigationAssessment(run: RunSnapshot): string {
  const assessment = run.assessment, collection = assessment?.collection;
  if (!collection) return '';
  const questions = collection.questions.map(question => {
    const finding = assessment.findings?.find(row => row.questionId === question.questionId);
    const review = assessment.review?.find(row => row.questionId === question.questionId);
    return `<details><summary>${escapeHtml(question.question)} · ${escapeHtml(outcomes[question.stopReason] ?? question.stopReason)}${finding ? ' · ' + findingNames[finding.status] : ''}</summary>
      <p>候选 ${question.candidates.length}/${question.required}，执行 ${question.rounds.length} 次搜索</p>
      ${question.rounds.length ? `<ul>${question.rounds.map(round => `<li>${escapeHtml(round.query)} · ${round.failed ? '搜索失败' : `返回 ${round.returned} 个，新增 ${round.newCandidates ?? '未核定'} 个`}</li>`).join('')}</ul>` : ''}
      ${finding ? `<p>${escapeHtml(finding.conclusion)}</p>` : ''}
      ${review ? `<ul>${review.checks.map(check => `<li>${escapeHtml(dimensions[check.dimension])} · ${escapeHtml(checks[check.status])}</li>`).join('')}</ul>
      ${review.fixes.map(fix => `<p>${escapeHtml(dimensions[fix.dimension])} · ${escapeHtml(fix.correction)}${fix.claimIds.length ? `<br>结论 ${escapeHtml(fix.claimIds.join('、'))}` : ''}${fix.evidenceIds.length ? `<br>引用 ${escapeHtml(fix.evidenceIds.join('、'))}` : ''}</p>`).join('')}` : ''}</details>`;
  }).join('');
  const sources = collection.sources.map(source => {
    const url = safeUrl(source.url);
    return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>` : escapeHtml(source.url)} · ${escapeHtml(kinds[source.kind as Source['kind']] ?? source.kind)} · ${escapeHtml(outcomes[source.status] ?? source.status)}</li>`;
  }).join('');
  const analysis = assessment.analysisCoverage;
  return `<section class="assessment-summary" aria-label="阶段结束依据"><h3>阶段结束依据</h3>
    <p>必查入口已尝试 ${collection.specifiedCoverage.attempted}/${collection.specifiedCoverage.total}，问题候选已覆盖 ${collection.candidateCoverage.covered}/${collection.candidateCoverage.total}</p>
    ${analysis ? `<p>已分析 ${analysis.questions.processed}/${analysis.questions.total} 个问题${analysis.evidence.total ? `，${analysis.evidence.linked}/${analysis.evidence.total} 条事实主张有证据绑定` : '，本次没有通过审查的事实主张'}</p>` : ''}
    ${sources ? `<details><summary>指定来源处理结果</summary><ul>${sources}</ul></details>` : ''}${questions}</section>`;
}
