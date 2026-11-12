import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from './evaluation/langfuse-client.ts';
import { pushAgentPrompts, pullAgentPrompts, saveAgentPromptSnapshot } from './evaluation/agent-prompts.ts';

try {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'push' }, label: { type: 'string', default: 'prompt-eval' },
    update: { type: 'boolean' }, pin: { type: 'string', multiple: true }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('prompts:langfuse -- --mode push [--update] | --mode pull [--label prompt-eval] [--pin competitor-review=2]');
  } else {
    const config = readLangfuseConfig(); if (!config) throw Error('langfuse_config_missing');
    const client = new LangfuseClient(config), root = resolve('.');
    if (!values.label?.trim()) throw Error('agent_prompt_label_required');
    if (values.mode === 'push') {
      if (values.pin?.length) throw Error('pins_require_pull_mode');
      console.log(JSON.stringify({ prompts: await pushAgentPrompts(client, root, { label: values.label, update: values.update }) }, null, 2));
    } else if (values.mode === 'pull') {
      if (values.update) throw Error('update_requires_push_mode');
      const pins: Record<string, number> = {};
      for (const pin of values.pin ?? []) { const match = /^([a-z-]+)=([1-9][0-9]*)$/.exec(pin); if (!match || Object.hasOwn(pins, match[1])) throw Error('invalid_or_duplicate_agent_prompt_pin'); pins[match[1]] = Number(match[2]); }
      const snapshot = await pullAgentPrompts(client, { label: values.label, pins });
      const file = saveAgentPromptSnapshot(snapshot, root), current = resolve(root, 'artifacts/agent-prompts/current.json'), temporary = current + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' }); renameSync(temporary, current);
      console.log(JSON.stringify({ snapshot: file, current, sha256: snapshot.sha256,
        prompts: snapshot.entries.map(({ key, name, version }) => ({ key, name, version })) }, null, 2));
    } else throw Error('agent_prompt_mode_must_be_push_or_pull');
  }
} catch (error) {
  const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
  console.error(redactor.clean(error instanceof Error ? error.message : 'agent_prompt_sync_failed')); process.exitCode = 1;
}
