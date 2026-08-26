import * as fs from "node:fs";
import * as path from "node:path";

export type DecisionKind = "reviewing" | "allow" | "deny" | "ask";

export interface DecisionRecord {
  requestID: string;
  sessionID: string;
  decision: DecisionKind;
  reason: string;
  at: number;
  // Only present on "reviewing" records: the evaluate hook runs before a
  // permission request exists, so there is no real request ID yet. Records
  // use a synthetic ID and carry enough context for the TUI badge to render.
  action?: string;
  resources?: string[];
}

export const STATE_FILE = "/tmp/opencode-auto-mode/state.json";

const MAX_AGE_MS = 10 * 60 * 1000;

export function readDecisions(): Record<string, DecisionRecord> {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, DecisionRecord>;
  } catch {
    return {};
  }
}

export function recordDecision(record: DecisionRecord): void {
  const all = readDecisions();
  all[record.requestID] = record;
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, rec] of Object.entries(all)) {
    if (rec.at < cutoff) delete all[id];
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
  } catch {
    // best effort — the TUI falls back to heuristics when the file is missing
  }
}
