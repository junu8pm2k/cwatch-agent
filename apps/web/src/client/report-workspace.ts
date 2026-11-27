import type { ReportReviewView, RunSnapshot } from '@cwatch/core/types/runs';
import { annotateReportApi, fetchReviewApi, saveReportApi, sendReportMessageApi } from './api.ts';
import { renderMarkdown } from './markdown.ts';
import { $, alertError, announce, clearError, escapeHtml, formatTime, isInvestigation, state } from './state.ts';

const cache = new Map<string, ReportReviewView>();
const loading = new Set<string>();
const errors = new Map<string, string>();
const pending = new Map<string, 'annotation' | 'save' | 'reply'>();
let selection = '';
let visibleRun = '';
let pendingMessage: { runId: string; text: string; messageId: string } | undefined;
const key = (id: string, saved: boolean) => `${id}/${saved ? 'saved' : 'draft'}`;

export function invalidateReview(id: string): void {
  for (const saved of [true, false]) {
    cache.delete(key(id, saved));
    errors.delete(key(id, saved));
  }
}

export function currentReview(run: RunSnapshot, ready: () => void): ReportReviewView | undefined {
  if (!run.reportReady || !run.reportReview) return undefined;
  const saved = state.savedReportMode;
  const cacheKey = key(run.id, saved), cached = cache.get(cacheKey);
  const revision = saved ? run.reportReview.savedRevision : run.reportReview.revision;
  if (cached && revision === (saved ? cached.savedRevision : cached.revision)) return cached;
  if (!loading.has(cacheKey) && !errors.has(cacheKey)) {
    loading.add(cacheKey);
    void fetchReviewApi(run.id, saved).then(view => {
      const newest = cache.get(cacheKey);
      if (!newest || view.revision >= newest.revision) cache.set(cacheKey, view);
    }).catch(error => { errors.set(cacheKey, String(error instanceof Error ? error.message : error)); }).finally(() => {
      loading.delete(cacheKey);
      if (state.current?.id === run.id) ready();
    });
  }
  return undefined;
}

export function markAnnotatedPassages(review: ReportReviewView): void {
  const doc = $('report-content').querySelector('.report-document');
  if (!doc) return;
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const annotation of review.annotations) {
    const quote = annotation.replacement ?? annotation.quote;
    if (!quote) continue;
    const matches = textNodes.filter(node => node.parentNode && node.data.includes(quote));
    if (matches.length !== 1) continue;
    const [node] = matches, start = node.data.indexOf(quote);
    if (node.data.indexOf(quote, start + 1) >= 0) continue;
    const tail = node.splitText(start + quote.length);
    const selected = node.splitText(start);
    const mark = document.createElement('mark');
    mark.className = 'report-mark'; mark.title = annotation.note;
    selected.replaceWith(mark); mark.append(selected);
    textNodes.push(tail);
  }
}

export function renderReportReview(run?: RunSnapshot, review?: ReportReviewView): void {
  const visible = Boolean(run?.reportReady && run.reportReview);
  $('report-review').hidden = !visible;
  const save = $<HTMLButtonElement>('save-into-research');
  save.hidden = !visible || state.savedReportMode;
  if (!visible || !run) return;
  if (visibleRun !== run.id) {
    visibleRun = run.id;
    selection = '';
    $<HTMLFormElement>('annotation-form').reset();
    $<HTMLFormElement>('report-followup-form').reset();
    $('annotation-editor').removeAttribute('open');
  }
  const busy = pending.get(run.id);
  const saved = state.savedReportMode;
  const currentSaved = Boolean(review && review.revision === review.savedRevision);
  save.textContent = busy === 'save' ? '正在保存…' : currentSaved ? '已保存到我的调研' : review?.savedAt ? '更新我的调研' : '保存到我的调研';
  save.disabled = !review || Boolean(busy) || currentSaved;
  $('resume-report-review').hidden = !saved;
  $('report-review-title').textContent = saved ? '已保存的报告标注' : '报告标注与追问';
  $('annotation-editor').hidden = saved || !review;
  $('report-followup-form').hidden = saved || !review;
  $('report-review-status').textContent = errors.get(key(run.id, saved)) ?? (busy === 'reply' ? '正在根据报告组织答复…'
    : !review ? '正在读取报告…' : saved ? '正在查看确认保存的版本。' : currentSaved ? '当前版本已保存。' : '当前草稿可以修改，确认后保存到「我的调研」。');
  $('report-annotations').innerHTML = (review?.annotations ?? []).map(item => `<li>${item.quote ? `<blockquote>${escapeHtml(item.quote)}</blockquote>` : ''}<p>${escapeHtml(item.note)}</p>${item.replacement !== undefined ? `<p class="review-replacement">校订为 ${escapeHtml(item.replacement)}</p>` : ''}</li>`).join('');
  const firstRequest = !saved && isInvestigation(run.task) ? run.task.researchBrief?.focus : undefined;
  const messages = firstRequest ? [{ id: 'initial-request', role: 'user', content: firstRequest, createdAt: run.createdAt }, ...review?.messages ?? []] : review?.messages ?? [];
  $('report-dialogue').innerHTML = messages.map(message => `<article class="chat-msg ${message.role === 'user' ? 'chat-user' : 'chat-assistant'}"><div class="chat-msg-head"><span>${message.role === 'user' ? '你' : 'Cwatch Agent'}</span><time datetime="${escapeHtml(message.createdAt)}">${formatTime(message.createdAt)}</time></div><div class="md-body">${message.role === 'user' ? `<p>${escapeHtml(message.content)}</p>` : renderMarkdown(message.content)}</div></article>`).join('');
  for (const form of ['annotation-form', 'report-followup-form']) {
    for (const field of $(form).querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('button,textarea,input')) field.disabled = Boolean(busy);
  }
}

export function bindReportReview(refresh: () => void, changed: (id: string, review: ReportReviewView) => void, resume: () => void): void {
  async function act(kind: 'annotation' | 'save' | 'reply', execute: (run: RunSnapshot, review: ReportReviewView) => Promise<ReportReviewView>, done?: () => void): Promise<void> {
    const run = state.current;
    if (!run || state.savedReportMode || pending.has(run.id)) return;
    const review = cache.get(key(run.id, false));
    if (!review) return;
    clearError();
    pending.set(run.id, kind);
    refresh();
    try {
      const updated = await execute(run, review);
      cache.set(key(run.id, false), updated);
      if (kind === 'save') cache.delete(key(run.id, true));
      changed(run.id, updated);
      if (state.current?.id === run.id) done?.();
    } catch (error) {
      if (String(error).includes('report_revision_conflict')) invalidateReview(run.id);
      alertError(error);
    } finally {
      pending.delete(run.id);
      if (state.current?.id === run.id) refresh();
    }
  }

  document.addEventListener('selectionchange', () => {
    const selected = document.getSelection();
    if (!selected?.anchorNode || !selected.focusNode || !$('report-content').contains(selected.anchorNode) || !$('report-content').contains(selected.focusNode)) return;
    if (selected.toString().trim()) selection = selected.toString().trim().slice(0, 2000);
  });
  $('capture-report-quote').addEventListener('click', () => {
    if (!selection) { announce('请先在报告正文中选中文字。'); return; }
    const quote = $<HTMLTextAreaElement>('annotation-quote');
    quote.value = selection;
    quote.focus();
  });
  const annotation = $<HTMLFormElement>('annotation-form');
  annotation.addEventListener('submit', event => {
    event.preventDefault();
    const quote = $<HTMLTextAreaElement>('annotation-quote').value.trim(), note = $<HTMLTextAreaElement>('annotation-note').value.trim();
    const replacement = $<HTMLTextAreaElement>('annotation-replacement').value;
    if (!note) return;
    void act('annotation', (run, review) => annotateReportApi(run.id, { revision: review.revision, quote, note, ...(replacement.trim() ? { replacement } : {}) }), () => { annotation.reset(); announce('标注已添加。'); });
  });
  const dialogue = $<HTMLFormElement>('report-followup-form');
  dialogue.addEventListener('submit', event => {
    event.preventDefault();
    const text = $<HTMLTextAreaElement>('report-question').value.trim();
    if (!text) return;
    void act('reply', (run) => {
      const messageId = pendingMessage?.runId === run.id && pendingMessage.text === text ? pendingMessage.messageId : crypto.randomUUID();
      pendingMessage = { runId: run.id, text, messageId };
      return sendReportMessageApi(run.id, { messageId, text });
    }, () => { dialogue.reset(); pendingMessage = undefined; });
  });
  $('save-into-research').addEventListener('click', () => { void act('save', (run, review) => saveReportApi(run.id, review.revision), () => announce('报告已保存到我的调研。')); });
  $('resume-report-review').addEventListener('click', resume);
}
