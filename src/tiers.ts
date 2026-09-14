import * as path from "node:path";

export type Tier = "auto-allow" | "auto-deny" | "review" | "unknown";

export interface Classification {
  tier: Tier;
  reason: string;
}

export interface ClassifyOptions {
  projectDir?: string;
}

const SAFE_TOOL_ACTIONS = new Set(["read", "glob", "grep", "websearch"]);

const DELEGATION_ACTIONS = new Set(["task", "subagent"]);

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
  if (/`|\$\(/.test(command)) return true;
  if (/>>?|2>&1|2>/.test(command)) return true;
  if (/<(?![a-z0-9_-]+=)/i.test(command)) return true;
  if (/(?<!\|)\|(?!\|)/.test(command)) return true;
  if (/(&&|\|\||;)/.test(command)) return true;
  if (/\b&\s*$/.test(command)) return true;
  return false;
}

export function isInProject(target: string, projectDir: string): boolean {
  const resolved = path.resolve(projectDir, target);
  const root = path.resolve(projectDir);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function fileTargets(resources: readonly string[]): string[] {
  return resources.filter((resource) => typeof resource === "string" && resource.length > 0);
}

export function classify(
  action: string,
  resources: readonly string[],
  options?: ClassifyOptions,
): Classification {
  if (DELEGATION_ACTIONS.has(action)) {
    return { tier: "review", reason: `subagent delegation ('${action}') needs intent review` };
  }

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
      return { tier: "review", reason: "chained or redirected command evaluated as one action" };
    }

    for (const pattern of AUTO_ALLOWED_SHELL) {
      if (pattern.test(command)) {
        return { tier: "auto-allow", reason: "safe read-only command" };
      }
    }

    return { tier: "review", reason: "unrecognized command" };
  }

  if (SAFE_TOOL_ACTIONS.has(action)) {
    return { tier: "auto-allow", reason: `safe ${action} operation` };
  }

  if ((action === "edit" || action === "write") && options?.projectDir) {
    const targets = fileTargets(resources);
    if (targets.length > 0 && targets.every((target) => isInProject(target, options.projectDir as string))) {
      return { tier: "auto-allow", reason: "in-project edit reviewable via version control" };
    }
    return { tier: "review", reason: "file modification outside the project directory" };
  }

  if (action === "edit" || action === "write") {
    return { tier: "review", reason: "file modification" };
  }

  if (action === "webfetch") {
    return { tier: "review", reason: "network fetch to external URL" };
  }

  return { tier: "review", reason: `action '${action}' needs review` };
}
