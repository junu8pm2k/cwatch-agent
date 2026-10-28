import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Decision, GenericTask } from '@cwatch/core/types';
import { PiModel } from '@cwatch/shared/agent/models';

export interface ConversationRequest {
  messages: Array<{ role: string; content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>;
  tools?: Array<{ function: { name: string } }>;
}
export const conversationTask = (instruction = 'Remember project code BLUE-17 and use it in follow-up answers.'): GenericTask => ({ kind: 'agent', taskId: 'conversation-fixture', instruction, allowedSources: [] });
const checkpoint = JSON.stringify({ userGoal: 'Continue this conversation about BLUE-17.', completedWork: ['Answered the earlier user question.'], keyFiles: [], errorsAndFixes: [], unfinishedTasks: ['Answer the latest follow-up.'], nextSteps: ['Read the latest user message and answer it.'], references: ['BLUE-17'], sourceGaps: [] });
let sequence = 0;
/** Real SDK/worker/HTTP/SSE; deterministic provider content, never a paid model. */
export async function conversationProvider(reply: (request: ConversationRequest, turn: number) => Decision | Promise<Decision>) {
  const requests: ConversationRequest[] = [], business: ConversationRequest[] = [], errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ConversationRequest;
      requests.push(request);
      const maintenance = /SESSION MEMORY UPDATE\.|Create a continuation record/.test(JSON.stringify(request.messages[0]));
      if (!maintenance) business.push(request);
      const decision = maintenance ? { kind: 'respond' as const, text: checkpoint } : await reply(request, business.length);
      const calls = decision.kind === 'respond' ? [] : decision.kind === 'call_tools' ? decision.calls : [decision];
      const delta = decision.kind === 'respond' ? { role: 'assistant', content: decision.text } : { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: 'sdkToolCallId' in call ? call.sdkToolCallId : 'conversation-call-' + business.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
      const chunk = { id: 'conversation-response', object: 'chat.completion.chunk', created: 1, model: 'conversation-fixture', choices: [{ index: 0, delta, finish_reason: null }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: decision.kind === 'respond' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end('conversation fixture error'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
  const model = () => PiModel.fromEnvironment({ MODEL_PROVIDER: 'conversation-provider-' + ++sequence, MODEL_ID: 'conversation-fixture', API_KEY: 'conversation-fixture-key', BASE_URL: 'http://127.0.0.1:' + address.port + '/v1' });
  return { model, requests, business, errors, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
