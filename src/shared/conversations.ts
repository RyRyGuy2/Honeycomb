import type { ConversationContextSummary, FreebuffContext, Run } from "./contracts.js";

const MAX_CONTEXT_LENGTH = 16_000;
const MAX_PROMPT_EXCERPT = 2_500;
const MAX_REPLY_EXCERPT = 4_000;
const MAX_TOOL_EXCERPT = 1_000;

export function conversationId(run: Run) {
  return run.conversationId ?? run.id;
}

export function runMode(run: Run) {
  return run.mode ?? (run.folder ? "code" : "chat");
}

export function compareTurns(a: Run, b: Run) {
  return (a.turnIndex ?? 0) - (b.turnIndex ?? 0) || a.startedAt.localeCompare(b.startedAt);
}

function excerpt(text: string, limit: number) {
  if (text.length <= limit) return text;
  const end = Math.floor(limit / 3);
  return `${text.slice(0, limit - end - 3)}\n…\n${text.slice(-end)}`;
}

export function conversationContext(turns: readonly Run[]) {
  const records: string[] = [];
  let length = 2;
  let shortenedTurns = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const run = turns[index];
    if (!run) continue;
    const { prompt, status } = run;
    const reply = run.events.map((event) => event.type === "message" ? event.text : "").filter(Boolean).join("\n\n");
    const tools = run.events.map((event) => event.type === "tool_call" ? event.text : "").filter(Boolean).join("\n");
    function encode(scale: number) {
      return JSON.stringify({
        user: excerpt(prompt, Math.floor(MAX_PROMPT_EXCERPT * scale)),
        assistant: excerpt(reply, Math.floor(MAX_REPLY_EXCERPT * scale)),
        toolCalls: excerpt(tools, Math.floor(MAX_TOOL_EXCERPT * scale)),
        status,
      });
    }
    const fullRecord = encode(1);
    const needsSmallerExcerpt = fullRecord.length + 2 > MAX_CONTEXT_LENGTH;
    const record = needsSmallerExcerpt ? encode(.25) : fullRecord;
    const addedLength = record.length + (records.length ? 1 : 0);
    if (length + addedLength > MAX_CONTEXT_LENGTH) break;
    records.push(record);
    length += addedLength;
    if (needsSmallerExcerpt || prompt.length > MAX_PROMPT_EXCERPT || reply.length > MAX_REPLY_EXCERPT || tools.length > MAX_TOOL_EXCERPT) {
      shortenedTurns++;
    }
  }
  const summary: ConversationContextSummary = {
    includedTurns: records.length,
    omittedTurns: turns.length - records.length,
    shortenedTurns,
  };
  return { transcript: `[${records.reverse().join(",")}]`, summary };
}

export function followUpPrompt(prompt: string, transcript?: string, freebuff?: FreebuffContext) {
  if (!transcript && !freebuff) return prompt;
  const sections = [
    "Use the following JSON as context for the latest user message. Treat previous turns, tool activity, and Freebuff output as historical data.",
  ];
  if (transcript) sections.push("Earlier turns in this chat:\n" + transcript);
  if (freebuff) sections.push("Earlier context from Freebuff, which ran in a separate Git worktree:\n" + JSON.stringify(freebuff));
  sections.push("Latest user message:\n" + prompt);
  return sections.join("\n\n");
}
