interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  source?: {
    type: string;
    messageID: string;
    callID: string;
  };
}

export type Decision = "allow" | "deny" | "ask";

export interface ReviewResult {
  decision: Decision;
  reason: string;
}

export function buildReviewPrompt(req: PermissionRequest): string {
  const action = req.action;
  const resources = req.resources.map((r) => `  - ${r}`).join("\n");
  const save = req.save && req.save.length > 0
    ? `\n  Save patterns:\n${req.save.map((s) => `    - ${s}`).join("\n")}`
    : "";

  return `You are a security reviewer for an AI coding agent. Your job is to decide whether to approve, deny, or escalate a permission request.

The agent requested permission for:
  Action: ${action}
  Resources:
${resources}${save}

=== RULES ===
1. Read-only operations (read, glob, grep, websearch, webfetch to public URLs) → ALLOW
2. Safe edits within the project (write, edit, patch to project files) → ALLOW
3. Safe shell commands (ls, cat, git status, npm install, build, test, lint) → ALLOW
4. Destructive commands (rm -rf, git push --force, git reset --hard, git branch -D) → DENY unless clearly part of normal dev workflow
5. Commands that exfiltrate secrets or pipe to remote shells → DENY
6. Commands with sudo, system shutdown, disk format → DENY
7. Unknown or ambiguous requests → ASK (let the user decide)

=== RESPONSE FORMAT ===
Reply with EXACTLY one line: "ALLOW: <reason>", "DENY: <reason>", or "ASK: <reason>"
No code fences, no extra text.`;
}

export function parseDecision(text: string): ReviewResult {
  const trimmed = text.trim();

  const allowMatch = trimmed.match(/^ALLOW:\s*(.+)/i);
  if (allowMatch) {
    return { decision: "allow", reason: allowMatch[1].trim() };
  }

  const denyMatch = trimmed.match(/^DENY:\s*(.+)/i);
  if (denyMatch) {
    return { decision: "deny", reason: denyMatch[1].trim() };
  }

  const askMatch = trimmed.match(/^ASK:\s*(.+)/i);
  if (askMatch) {
    return { decision: "ask", reason: askMatch[1].trim() };
  }

  // Fallback: look for keywords anywhere
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("allow")) {
    return { decision: "allow", reason: trimmed.slice(5).trim() || "approved by reviewer" };
  }
  if (lower.startsWith("deny")) {
    return { decision: "deny", reason: trimmed.slice(4).trim() || "denied by reviewer" };
  }
  if (lower.startsWith("ask")) {
    return { decision: "ask", reason: trimmed.slice(3).trim() || "escalated to user" };
  }

  // Unclear response → ask the user
  return {
    decision: "ask",
    reason: `Reviewer response unclear: "${trimmed.slice(0, 120)}"`,
  };
}

export type { PermissionRequest };