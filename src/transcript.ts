const MAX_USERS = 10;
const MAX_TOOLS = 20;
const MAX_ENTRY_CHARS = 500;
const MAX_TRANSCRIPT_CHARS = 6000;

interface ToolEntry {
  name: string;
  input: unknown;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function userText(message: unknown): string | undefined {
  const record = asRecord(message);
  if (record?.["type"] !== "user") return undefined;
  const text = record["text"];
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function assistantTools(message: unknown): ToolEntry[] {
  const record = asRecord(message);
  if (record?.["type"] !== "assistant") return [];
  const content = record["content"];
  if (!Array.isArray(content)) return [];
  const tools: ToolEntry[] = [];
  for (const part of content) {
    const entry = asRecord(part);
    if (entry?.["type"] !== "tool") continue;
    const name = entry["name"];
    if (typeof name !== "string" || !name) continue;
    tools.push({ name, input: entry["state"] });
  }
  return tools;
}

function formatTool(tool: ToolEntry): string {
  let detail = "";
  try {
    const state = asRecord(tool.input);
    const input = state?.["input"] ?? tool.input;
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    if (raw) detail = truncate(raw, MAX_ENTRY_CHARS);
  } catch {
    detail = "";
  }
  return detail ? `${tool.name} ${detail}` : tool.name;
}

export function extractTranscript(messages: unknown[]): string {
  const users: string[] = [];
  const tools: string[] = [];
  for (const message of messages) {
    const text = userText(message);
    if (text !== undefined) users.push(text);
    for (const tool of assistantTools(message)) tools.push(formatTool(tool));
  }
  const recentUsers = users.slice(-MAX_USERS).map((text) => `- ${truncate(text, MAX_ENTRY_CHARS)}`);
  const recentTools = tools.slice(-MAX_TOOLS).map((text) => `- ${text}`);
  let transcript = "";
  if (recentUsers.length > 0) transcript += `User messages (most recent last):\n${recentUsers.join("\n")}\n`;
  if (recentTools.length > 0) transcript += `Prior tool calls (most recent last):\n${recentTools.join("\n")}\n`;
  if (!transcript) return "(no prior user messages or tool calls in this session)";
  return truncate(transcript, MAX_TRANSCRIPT_CHARS);
}
