// Deliberately faulty IPC peer. Never used by the CLI.
import { randomUUID } from 'node:crypto';
let init: any, outgoing = 0, pre: any, mode = '';
const send = (body: unknown, extra: Record<string, unknown> = {}) => process.send!({ version: 1, sessionId: init.sessionId, taskId: init.taskId, sequence: ++outgoing, body, ...extra });
const quit = () => process.exit(37);
process.on('message', (frame: any) => {
  const message = frame.body;
  if (message.type === 'init') {
    init = frame; mode = message.input.volatile;
    if (mode === 'exit-startup') return quit();
    if (mode === 'hang-startup') { setInterval(() => {}, 1000); return; }
    send({ type: 'ready', pid: process.pid, ...(message.toolAdmission && mode !== 'legacy-ready' ? { toolAdmission: true } : {}) });
    if (mode === 'disconnect') { process.disconnect!(); setInterval(() => {}, 1000); return; }
    if (mode === 'wrong-session') { send({ type: 'completed' }, { sessionId: 'another-session' }); return; }
    if (mode === 'wrong-sequence') { send({ type: 'completed' }, { sequence: 1 }); return; }
    if (mode === 'malformed') { send({ type: 'execute_everything' }); return; }
    if (mode === 'oversized') { send({ type: 'failed', error: 'x'.repeat(2_000_001) }); return; }
    const binding = message.input.tools.find((tool: any) => tool.proxy_name === 'mcp__official__op');
    pre = { type: 'pre_tool_use_request', requestId: randomUUID(), taskId: init.taskId, toolName: binding.proxy_name, bindingId: binding.id, argsHash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', input: {}, sdkToolCallId: 'fixture-ipc-call' };
    if (mode === 'execute-first') { const { type, input, ...identity } = pre; send({ type: 'tool_execute_request', request: identity }); return; }
    if (mode.startsWith('batch-')) {
      const calls = [{ sdkToolCallId: 'batch-first', name: pre.toolName, args: {} }, { sdkToolCallId: mode === 'batch-duplicate-id' ? 'batch-first' : 'batch-second', name: pre.toolName, args: {} }];
      send({ type: 'decision', requestId: randomUUID(), decision: { kind: 'call_tools', calls } }); return;
    }
    send({ type: 'decision', requestId: randomUUID(), decision: { kind: 'call_tool', name: pre.toolName, args: {} } }); return;
  }
  if (message.type === 'abort') { if (mode !== 'hang-startup') process.exit(1); return; }
  if (message.type === 'hook_response') {
    if (mode === 'batch-complete-early') { send({ type: 'completed' }); return; }
    if (mode === 'batch-next-model') { send({ type: 'before_model', requestId: randomUUID() }); return; }
    if (mode === 'batch-overwrite') { send({ type: 'decision', requestId: randomUUID(), decision: { kind: 'respond', text: 'forged completion' } }); return; }
    if (mode === 'batch-forged-observation') { send({ type: 'observation', requestId: randomUUID(), name: pre.toolName, sdkToolCallId: 'batch-second', result: {} }); return; }
    if (mode === 'batch-forged-success') { send({ type: 'observation', requestId: randomUUID(), name: pre.toolName, sdkToolCallId: 'batch-first', result: { ok: true } }); return; }
    if (mode === 'batch-reordered') pre.sdkToolCallId = 'batch-second';
    send({ type: 'pre_tool_use_request', request: pre });
    if (mode === 'duplicate-pre') send({ type: 'pre_tool_use_request', request: pre });
    if (mode === 'exit-approval') setTimeout(quit, 40);
    return;
  }
  if (message.type === 'pre_tool_use_response') {
    if (mode === 'exit-after-allow') return quit();
    if (mode === 'omit-execute') return;
    const { type, input, ...identity } = pre;
    if (mode === 'changed-hash') identity.argsHash = 'forged';
    send({ type: 'tool_execute_request', request: identity });
    if (mode === 'duplicate-execute') send({ type: 'tool_execute_request', request: identity });
    if (mode === 'exit-executing') setTimeout(quit, 40);
  }
});
