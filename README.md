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
  may never see a `permission.asked` event.

## TUI status indicator

The same package ships a TUI plugin (`./tui` entrypoint, `src/tui.tsx`) that
shows what auto-mode is doing while you work:

- A small badge in the top-right corner of the screen (above dialogs):
  spinner while the reviewer LLM is thinking, `⚠ needs your approval` when
  it escalates to you. The badge clears as soon as the permission is
  answered — no toasts, no footer clutter.
- `allow` / `deny` commands (command palette + keybindings) so you can
  answer a pending permission yourself at any time.

Local file plugins for the TUI are discovered automatically from
`.opencode/plugins/tui/` (the runtime does not read project `tui.json`):

```ts
// .opencode/plugins/tui/opencode-auto-mode.tsx
export { default } from "../../../src/tui.tsx";
```

- **`keybinds.allow` / `keybinds.deny`** — keybindings for the manual
  allow/deny commands (defaults: `ctrl+alt+a` / `ctrl+alt+d`).

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Server plugin: subscribes to `permission.asked` events, classifies commands, calls the LLM reviewer, and replies to the permission request via the OpenCode HTTP API |
| `src/tui.tsx` | TUI plugin: shows review-in-progress / allow-deny status in the prompt footer, plus manual allow/deny commands and keybindings |
| `src/client.ts` | Builds an authenticated OpenCode HTTP client by reading the server's registration file — used for `permission.reply` and `generate.text` (not exposed on the plugin `ctx`) |
| `src/tiers.ts` | Command classification: auto-allow, auto-deny, or defer to LLM review |
| `src/reviewer.ts` | Builds the review prompt for the LLM and parses ALLOW/DENY/ASK decisions |
| `src/logger.ts` | File logger that writes to `/tmp` — must stay outside the project to avoid triggering an infinite config reload loop |

## Logs

```sh
tail -f /tmp/opencode-auto-mode/events.log
```

## Limitations

- **Self-client**: the server plugin builds its own HTTP client to call
  `permission.reply` and `generate.text` since the plugin `ctx` does not
  expose these methods.
- **Log path**: logs are written to `/tmp/opencode-auto-mode/` to avoid
  triggering config reload loops. Writing inside `.opencode/` or the
  project root causes the server to detect a file change and reload the
  plugin in an infinite loop.
- **No reason in the result UI**: the `permission.replied` event carries
  the reply type but not the reviewer's reason message, so the badge shows
  only the state (reviewing / needs your approval), never the LLM's
  explanation.
- **Sticky host permission dialog (17444)**: on some `next` builds the
  host's permission dialog does not dismiss itself when a permission is
  answered by a plugin — the dialog stays until answered manually. This is
  a host bug; upgrading OpenCode fixes it.