import { z } from 'zod';

export const MarkdownTableExpectationSchema=z.object({headers:z.array(z.string()).min(1),rows:z.array(z.array(z.string()))}).strict()
  .refine(value=>value.rows.every(row=>row.length===value.headers.length),'All rows must match the declared columns');

/** A declared table-only contract: spacing/alignment may vary; cell values, order and absence of prose may not. */
export function markdownTableMatches(text:string,expectation:z.infer<typeof MarkdownTableExpectationSchema>):boolean {
  const lines=text.replaceAll('\r\n','\n').trim().split('\n').filter(line=>line.trim());
  if(lines.length!==expectation.rows.length+2||lines.some(line=>!line.trim().startsWith('|')||!line.trim().endsWith('|')))return false;
  const cells=(line:string)=>line.trim().slice(1,-1).split(/(?<!\\)\|/).map(cell=>cell.trim());
  const separator=cells(lines[1]);
  return separator.length===expectation.headers.length&&separator.every(cell=>/^:?-{3,}:?$/.test(cell))&&
    JSON.stringify(cells(lines[0]))===JSON.stringify(expectation.headers)&&
    JSON.stringify(lines.slice(2).map(cells))===JSON.stringify(expectation.rows);
}
