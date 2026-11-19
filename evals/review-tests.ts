import { z } from 'zod';
import { benchmarkCase, readJson } from './benchmark-contract.ts';

const localReviewCases = z.array(z.strictObject({
  id: z.string(),
  category: z.string(),
  reference: z.string(),
  stage: z.enum(['main', 'branch', 'stop', 'boundary', 'handoff']),
  input: z.string(),
  answer: z.string(),
})).nonempty();

export function loadReviewTestCases() {
  const cases = localReviewCases.parse(readJson('evals/datasets/review-tests.json'));
  return cases.map(({ id, category, reference, stage, input, answer }) => benchmarkCase.parse({
    id,
    itemId: 'local-review-test-' + id,
    category,
    metrics: ['tool_correctness', 'evidence_review'],
    tags: ['regression'],
    dataClass: 'synthetic',
    origin: { type: 'sop', reference, stage },
    fixture: id + '.txt',
    profile: 'competitor-review',
    input,
    expected: { toolPolicy: 'review-checklist', answer },
  }));
}
