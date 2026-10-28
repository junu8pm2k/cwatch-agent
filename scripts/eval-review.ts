import { parseArgs } from 'node:util';
import { loadDataset } from './evaluation/dataset.ts';
import { approveCases } from './evaluation/review.ts';

try {
  const { values } = parseArgs({ options: {
    dataset: { type: 'string', default: 'evals/model-diagnostic/dataset.json' },
    case: { type: 'string', multiple: true }, by: { type: 'string' }, approve: { type: 'boolean' },
    'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`查看题单：npm run eval:review
查看一道题：npm run eval:review -- --case model-kimi-window-boundary
审核通过：npm run eval:review -- --case model-kimi-window-boundary --by Swing --approve
预览变更：在审核命令后加 --dry-run，不写文件
批量审核：重复 --case，仅列出你已核验的案例
契约题：增加 --dataset evals/regression/dataset.json
审核不会调用模型。--approve 表示你已人工核验题目、材料和评分标准。
程序自动记录实际时间、增加修订与题单版本、计算哈希、同步catalog并保存旧题单快照。`);
  } else if (values.approve) {
    if (!values.by) throw Error('请用 --by 填写实际审核者');
    const result = approveCases({ dataset: values.dataset!, caseIds: values.case ?? [], reviewer: values.by, dryRun: values['dry-run'] });
    console.log(result.dryRun ? '预览完成，未写入任何审核记录。' : '已登记审核通过，并完成题单校验。');
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (values.by || values['dry-run']) throw Error('--by 和 --dry-run 需与 --approve 一起使用');
    const data = loadDataset(values.dataset!);
    if (values.case?.length) {
      for (const id of values.case) {
        const c = data.entries.find(entry => entry.value.id === id);
        if (!c) throw Error('review_case_not_found: ' + id);
        console.log(JSON.stringify(c.value, null, 2));
      }
    } else {
      console.log(`题单 ${data.manifest.id} · ${data.manifest.version}`);
      for (const { value: c } of data.entries) console.log(`${c.status.padEnd(12)} r${c.revision} ${c.id} — ${c.title}`);
      console.log('\n先查看题目并核验标准，再用 --case <ID> --by <审核者> --approve 登记。');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'evaluation_review_failed');process.exitCode = 1;
}
