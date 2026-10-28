import { sessionEntryToContextMessages, type SessionEntry, type SessionMessageEntry } from '@earendil-works/pi-coding-agent';

type Message = SessionMessageEntry['message'];
export interface ApiRound { firstEntryId: string; assistantEntryId: string; startIndex: number; endIndex: number; toolCallIds: string[] }

function scan(items: Array<{ entryId: string; index: number; message: Message }>): ApiRound[] {
  const rounds: ApiRound[] = [];
  let userStart: { entryId: string; index: number } | undefined;
  let pending: { round: ApiRound; tools: Map<string, string> } | undefined;
  for (const { entryId, index, message } of items) {
    if (message.role === 'user') {
      if (pending) throw new Error('context_round_incomplete: user message before all tool results');
      userStart ??= { entryId, index };
    } else if (message.role === 'assistant') {
      if (pending) throw new Error('context_round_incomplete: next assistant before all tool results');
      const calls = message.content.filter(item => item.type === 'toolCall');
      const tools = new Map(calls.map(call => [call.id, call.name]));
      if (tools.size !== calls.length) throw new Error('context_round_invalid: duplicate tool call ID in one API round');
      const round: ApiRound = { firstEntryId: userStart?.entryId ?? entryId, assistantEntryId: entryId, startIndex: userStart?.index ?? index, endIndex: index, toolCallIds: calls.map(call => call.id) };
      userStart = undefined;
      if (tools.size) pending = { round, tools }; else rounds.push(round);
    } else if (message.role === 'toolResult') {
      if (!pending || pending.tools.get(message.toolCallId) !== message.toolName) throw new Error('context_round_invalid: orphan, duplicate or mismatched tool result');
      pending.tools.delete(message.toolCallId); pending.round.endIndex = index;
      if (!pending.tools.size) { rounds.push(pending.round); pending = undefined; }
    }
  }
  if (pending) throw new Error('context_round_incomplete: missing tool results');
  return rounds;
}

/** A cut can occur only between API responses and their complete result sets. */
export function groupApiRounds(entries: SessionEntry[]): ApiRound[] {
  return scan(entries.flatMap((entry, index) => sessionEntryToContextMessages(entry).map(message => ({ entryId: entry.id, index, message }))));
}
export function assertCompleteApiRounds(messages: Message[]): void {
  scan(messages.map((message, index) => ({ entryId: String(index), index, message })));
}
