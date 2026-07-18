# opencode-auto-mode

An OpenCode v2 server plugin that mimics **Claude Code's auto mode**: a cheap
LLM reviews each permission request and auto-**approves**, auto-**denies**, or
**falls back to the user** when uncertain.

## How it works

```
permission.v2.asked event
         │
         ▼
   classify (tier 1/2/3)
         │
    ┌────┼────────┐
    ▼    ▼        ▼
 auto-  auto-   LLM review
 allow  deny    (tier 3)
    │    │        │
    ▼    ▼        ▼
 reply  reply   LLM decides
 "once" "reject"  │
                   │
              ┌────┼────┐
              ▼    ▼    ▼
            ALLOW DENY  ASK
              │    │    │
              ▼    ▼    ▼
           reply  reply  (no reply —
           "once" "reject" user decides)
```

### Tiered review

Inspired by [pi-auto-reviewer](https://github.com/vinzenzu/pi-auto-reviewer):

- **Tier 1 (auto-allow, instant, no LLM cost)**: safe read-only commands —
  `ls`, `cat`, `grep`, `git status`, `git log`, `git diff`, `echo`,
  `whoami`, `pwd`, `npm list`, read/glob/grep actions, etc.

- **Tier 2 (auto-deny, instant)**: catastrophic commands — `rm -rf /`,
  `sudo`, `chmod 777`, `dd`, `mkfs`, `shutdown`, `reboot`, etc.

- **Tier 3 (LLM review)**: everything else → a cheap LLM decides ALLOW,
  DENY, or ASK. Commands with pipes, redirects, command substitution, or
  secret-looking env vars are always sent to the reviewer.

### Failure handling

- Retries up to 3 times with a 1-second delay between attempts (handles
  startup races where model connections aren't ready yet).
- On all failures, the permission request stays pending → the user decides.

## Install

```sh
bun install
```

## Configure

Add to your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./src/index.ts",
      "options": {
        "model": { "id": "deepseek-v4-flash", "providerID": "opencode-go" }
      }
    }
  ],
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" }
  ]
}
```

- **`model`** — the cheap LLM used for tier-3 review. Omit to use your
  location's default model.
- **`permissions`** — force `ask` for tools you want the plugin to review.
  Without this, OpenCode's built-in permission rules apply and the plugin
  may never see a `permission.v2.asked` event.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main plugin: subscribes to `permission.v2.asked` events, classifies commands, calls the LLM reviewer, and replies to the permission request via the OpenCode HTTP API |
| `src/client.ts` | Builds an authenticated OpenCode HTTP client by reading the server's registration file — used for `permission.reply` and `generate.text` (not exposed on the plugin `ctx`) |
| `src/tiers.ts` | Command classification: auto-allow, auto-deny, or defer to LLM review |
| `src/reviewer.ts` | Builds the review prompt for the LLM and parses ALLOW/DENY/ASK decisions |
| `src/logger.ts` | File logger that writes to `/tmp` — must stay outside the project to avoid triggering an infinite config reload loop |

## Logs

```sh
tail -f /tmp/opencode-auto-mode/events.log
```

## Limitations

- **No TUI status indicator**: OpenCode v2 does not yet support loading
  external TUI plugins (the V1 TUI plugin API exists but the config
  discovery path is not wired up for project-local plugins). The plugin
  runs entirely in the server process. Permission review happens silently
  in the background.
- **Self-client**: the plugin builds its own HTTP client to call
  `permission.reply` and `generate.text` since the plugin `ctx` does not
  expose these methods.
- **Log path**: logs are written to `/tmp/opencode-auto-mode/` to avoid
  triggering config reload loops. Writing inside `.opencode/` or the
  project root causes the server to detect a file change and reload the
  plugin in an infinite loop.