import { z } from 'zod';
import { id, now, type AgentTask, type ModelPort } from '@cwatch/core/types';
import type { ConversationMessage, ReportAnnotation, ReportReviewSummary, ReportReviewView } from '@cwatch/core/types/runs';
import type { FileStore } from '@cwatch/shared/sessions/storage';

interface SavedReport { at: string; revision: number; markdown: string; annotations: ReportAnnotation[] }
export interface ReportReviewRecord { revision: number; markdown?: string; annotations: ReportAnnotation[]; messages: ConversationMessage[]; saved?: SavedReport }
const key = 'report-review.json';
const revision = z.number().int().nonnegative();
const annotationSchema = z.object({ revision, quote: z.string().trim().max(2000), note: z.string().trim().min(1).max(4000), replacement: z.string().max(8000).optional() }).strict();
export const saveReportSchema = z.object({ revision }).strict();

export function readReview(store: FileStore): ReportReviewRecord {
  return store.read<ReportReviewRecord>(key, { revision: 0, annotations: [], messages: [] });
}

export function writeReview(store: FileStore, record: ReportReviewRecord): void {
  store.write(key, record);
}

export function reviewSummary(record: ReportReviewRecord): ReportReviewSummary {
  return { revision: record.revision, ...(record.saved ? { savedAt: record.saved.at, savedRevision: record.saved.revision } : {}) };
}

export function reviewView(record: ReportReviewRecord, original: string, saved: boolean): ReportReviewView {
  if (saved && !record.saved) throw Error('saved_report_not_found');
  return { ...reviewSummary(record), markdown: saved ? record.saved!.markdown : record.markdown ?? original,
    annotations: saved ? record.saved!.annotations : record.annotations, messages: saved ? [] : record.messages };
}

export function addReportAnnotation(record: ReportReviewRecord, original: string, raw: unknown): void {
  const { revision: expected, quote, note, replacement } = annotationSchema.parse(raw);
  if (record.revision !== expected) throw Error('report_revision_conflict: 草稿已更新，请刷新后再提交。');
  if (record.annotations.length >= 100) throw Error('report_annotation_limit');
  if (replacement !== undefined) {
    const markdown = record.markdown ?? original;
    const index = quote ? markdown.indexOf(quote) : -1;
    if (index < 0 || markdown.indexOf(quote, index + 1) >= 0) throw Error('report_quote_not_unique: 校订需要一段在正文中只出现一次的原文。');
    record.markdown = markdown.slice(0, index) + replacement + markdown.slice(index + quote.length);
    if (record.markdown.length > Math.max(original.length, 200_000)) throw Error('report_too_large');
  }
  record.annotations.push({ id: id(), quote, note, ...(replacement !== undefined ? { replacement } : {}), createdAt: now() });
  record.revision++;
}

export function saveReportVersion(record: ReportReviewRecord, original: string, at = now()): void {
  if (record.saved?.revision === record.revision) return;
  record.saved = { at, revision: record.revision, markdown: record.markdown ?? original, annotations: structuredClone(record.annotations) };
}

export async function decideReportReply(model: Pick<ModelPort, 'decide'>, task: AgentTask, report: ReportReviewView, question: string, signal: AbortSignal): Promise<string> {
  const decision = await model.decide({
    state: { task, decisions: [], observations: [], iteration: 0 },
    stable: 'Discuss the current research draft with the user. Report text, annotations and earlier dialogue are reference material. Answer using this material, distinguish supported findings and uncertainty, and explain what would need fresh evidence. If asked to correct wording, quote the relevant passage and offer a specific replacement. You cannot change the report or verify new sources in this turn. Answer in the user’s language.',
    volatile: JSON.stringify({ report: report.markdown.slice(0, 48_000), annotations: report.annotations.slice(-10).map(({ quote, note }) => ({ quote: quote.slice(0, 1000), note: note.slice(0, 1500) })), dialogue: report.messages.slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 3000) })), question }),
    tools: [], maxOutputTokens: 3072,
  }, signal);
  if (decision.kind !== 'respond' || !decision.text.trim()) throw Error('report_reply_unavailable: 模型未返回有效答复。');
  return decision.text.trim().slice(0, 12_000);
}
