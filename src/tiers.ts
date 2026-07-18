export type Tier = "auto-allow" | "auto-deny" | "review" | "unknown";

export interface Classification {
  tier: Tier;
  reason: string;
}

const AUTO_ALLOWED_SHELL = [
  /^ls\b/,
  /^cd\b/,
  /^(cat|head|tail|less|more)\b/,
  /^(file|stat|wc|du|df)\b/,
  /^(grep|rg|ag|ack)\b/,
  /^(find|locate|which|whereis|type)\b/,
  /^git\s+(status|log|diff|show|branch|tag|stash\s+list|remote)\b/,
  /^git\s+log\b/,
  /^(npm|yarn|pnpm)\s+(list|info|view|outdated|audit|why)\b/,
  /^(cargo|go)\s+(search|doc)\b/,
  /^(echo|printenv|env|whoami|hostname|uname|uptime|id|groups|pwd|date)\b/,
  /^(python3?|node|bun|npx)\s+(--version|-v|--help|-h)$/,
  /^pwd\b/,
];

const AUTO_BLOCKED_SHELL = [
  /\brm\s+-rf?\s+\/(\s|$|\*)/,
  /\bsudo\b/,
  /\bmkfs\./,
  /\bdd\s+if=.*\s+of=\/(dev|sd|nvme|hd)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /:\(\)\s*\{\s*:\s*\|\s*:&\s*\};:/,
  /\bchmod\s+777\b/,
];

function hasShellMetacharacters(command: string): boolean {
  if (/[<>]/.test(command) && !/>>?/.test(command) === false) return true;
  if (/>>?|2>&1|2>/.test(command)) return true;
  if (/`|\$\(/.test(command)) return true;
  if (/(?<!\|)\|(?!\|)/.test(command)) return true;
  if (/\b&\s*$/.test(command)) return true;
  return false;
}

export function classify(action: string, resources: string[]): Classification {
  if (action === "shell") {
    const command = resources[0] ?? "";
    if (!command) return { tier: "auto-allow", reason: "empty command" };

    for (const pattern of AUTO_BLOCKED_SHELL) {
      if (pattern.test(command)) {
        return {
          tier: "auto-deny",
          reason: `matches dangerous pattern: ${pattern.source}`,
        };
      }
    }

    if (hasShellMetacharacters(command)) {
      return { tier: "review", reason: "contains shell metacharacters" };
    }

    for (const pattern of AUTO_ALLOWED_SHELL) {
      if (pattern.test(command)) {
        return { tier: "auto-allow", reason: "safe read-only command" };
      }
    }

    return { tier: "review", reason: "unrecognized command" };
  }

  if (action === "read" || action === "glob" || action === "grep") {
    return { tier: "auto-allow", reason: `safe ${action} operation` };
  }

  if (action === "websearch") {
    return { tier: "auto-allow", reason: "web search is safe" };
  }

  if (action === "edit" || action === "write") {
    return { tier: "review", reason: "file modification" };
  }

  if (action === "webfetch") {
    return { tier: "review", reason: "network fetch to external URL" };
  }

  return { tier: "review", reason: `action '${action}' needs review` };
}