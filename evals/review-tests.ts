import { z } from 'zod';
import { benchmarkCase, fixturePath, readJson } from './benchmark-contract.ts';

export function loadReviewTestCases() {
  const cases = z.array(benchmarkCase).nonempty().parse(readJson('evals/datasets/review-tests.json'));
  if (new Set(cases.map(item => item.id)).size !== cases.length
    || new Set(cases.map(item => item.itemId)).size !== cases.length) throw Error('duplicate local review case or item');
  for (const item of cases) fixturePath(item.fixture);
  return cases;
}
