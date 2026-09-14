# opencode-auto-mode

An OpenCode v2 server plugin that mimics **Claude Code's auto mode**: a cheap
LLM reviews each permission request and auto-**approves**, auto-**denies**, or
**falls back to the user** when uncertain.

## How it works

The plugin registers a `permission.evaluate` hook, which OpenCode runs after
its own permission rules are evaluated but before an action runs or a
permission prompt is published:

```
permission evaluation (after config rules)
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
  effect effect  LLM decides
  allow  deny     │
                  │
             ┌────┼────┐
             ▼    ▼    ▼
           ALLOW DENY  ASK
             │    │    │
             ▼    ▼    ▼
          effect effect effect "ask"
          allow  deny   (+ reason shown
                         in the permission dialog)
```

Because the hook decides *before* the prompt is published, there is no race
with the host's permission dialog: when the plugin allows or denies, no dialog
appears at all; when it escalates, the dialog opens with the reviewer's
explanation attached.

### Tiered review

Inspired by [pi-auto-reviewer](https://github.com/vinzenzu/pi-auto-reviewer):

- **Tier 1 (auto-allow, instant, no LLM cost)**: safe read-only commands —
  `ls`, `cat`, `grep`, `git status`, `git log`, `git diff`, `echo`,
  `whoami`, `pwd`, `npm list`, read/glob/grep actions, etc. File
  writes/edits inside the project directory are also auto-allowed
  (reviewable via version control); edits outside it go to review.

- **Tier 2 (auto-deny, instant)**: catastrophic commands — `rm -rf /`,
  `sudo`, `chmod 777`, `dd`, `mkfs`, `shutdown`, `reboot`, etc.
  Repeated denials escalate to you (3 in a row or 20 total per session).

- **Tier 3 (LLM review)**: everything else → two-stage review. Stage 1 is
  a cheap BLOCK/ALLOW triage that errs toward blocking; only flagged
  actions pay for stage 2 reasoning, which decides ALLOW, DENY, or ASK.
  The reviewer sees your recent messages plus prior tool calls (assistant
  prose and tool outputs are stripped so injections can't talk it into a
  bad call), evaluates chained commands as one action, and applies
  conservative intent rules: related to your goal is not the same as
  authorized. Subagent delegations (`task`) are always reviewed, since the
  orchestrator's instruction is not your authorization.

By default tier 3 reviews **every** evaluation that reaches it, including
actions OpenCode's rules would silently allow (only explicit configured
`deny` rules skip hooks entirely). Set `"review": "prompts"` to only review
evaluations whose computed effect is already `ask` — the original,
lower-cost behavior.

### Failure handling

- Retries up to 3 times with a 1-second delay between attempts (handles
  startup races where model connections aren't ready yet).
- On all failures, the hook escalates to `ask` with a failure note → the user
  decides.

## Configure

Add the published package to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@mellena1/opencode-auto-mode",
      "options": {
        "model": { "id": "deepseek-v4-flash", "providerID": "opencode-go" }
      }
    }
  ]
}
```

- **`model`** — the cheap LLM used for tier-3 review. Omit to use your
  location's default model.
- **`review`** — `"all"` (default) reviews every permission evaluation that
  reaches tier 3, even ones OpenCode would silently allow. `"prompts"`
  reviews only evaluations that would prompt you anyway.
- **`trusted` / `blocks` / `exceptions`** — override the reviewer's policy
  slots (trust boundary, block rules, narrow carve-outs). Omit for the
  conservative defaults.
- **`allowInProjectEdits`** — `true` (default) auto-allows edits inside the
  project directory. Set `false` to send them to the reviewer.

Tool outputs are also screened for prompt-injection patterns (`ignore
previous instructions`, `curl … | bash`, credential exfiltration); matches
get a warning prepended so the agent treats them as untrusted data.

You no longer need `permissions` rules like
`{ "action": "shell", "resource": "*", "effect": "ask" }` for the plugin to
see requests — the evaluate hook runs for allowed decisions too. Keep such a
rule if you want shell prompts as a fallback when the plugin is disabled.

## TUI status indicator

The same package ships a TUI plugin (`./tui` entrypoint, `src/tui.tsx`) that
shows what auto-mode is doing while you work. It loads automatically with the
server plugin (`tui: true`) — no separate registration needed:

- A small badge in the top-right corner of the screen (above dialogs):
  spinner while the reviewer LLM is thinking, `⚠ needs your approval` when
  it escalates to you. The badge clears as soon as the permission is answered.
- `allow` / `deny` commands (command palette + keybindings) so you can
  answer an escalated permission yourself at any time.

If you prefer to load it explicitly (e.g. CLI-only usage against a remote
server), register it in `cli.json`:

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": [
    { "package": "@mellena1/opencode-auto-mode", "options": {} }
  ]
}
```

For local development, point the package field at the local checkout:

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-auto-mode/src/tui.tsx", "options": {} }
  ]
}
```

- **`keybinds.allow` / `keybinds.deny`** — keybindings for the manual
  allow/deny commands (defaults: `ctrl+alt+a` / `ctrl+alt+d`).

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Server plugin: registers `permission.evaluate` + `tool.execute.after` (injection screen) hooks, fetches transcript/project context, runs two-stage LLM review with denial backstop |
| `src/tui.tsx` | TUI plugin: shows review-in-progress / needs-approval status in a top-right badge, plus manual allow/deny commands and keybindings |
| `src/tiers.ts` | Command classification: auto-allow, auto-deny, or defer to LLM review (incl. in-project fast path) |
| `src/reviewer.ts` | Two-stage review prompts (triage + reasoning) with intent/block policy, and ALLOW/DENY/ASK parsing |
| `src/policy.ts` | Default trust boundary, block rules, and allow exceptions (overridable via options) |
| `src/transcript.ts` | Minimal transcript builder: user messages + tool calls only, assistant prose/outputs stripped |
| `src/probe.ts` | Heuristic prompt-injection screen for tool outputs |
| `src/state.ts` | Decision records written to `/tmp` — the channel that feeds the TUI badge during review (outside the project to avoid config-reload loops) |
| `src/logger.ts` | File logger that writes to `/tmp` — must stay outside the project to avoid triggering an infinite config reload loop |

## Logs

```sh
tail -f /tmp/opencode-auto-mode/events.log
```

## Limitations

- **Review latency on allowed actions**: by default tier 3 reviews every
  evaluation, including ones OpenCode would have allowed silently — expect a
  reviewer round-trip on those. Use `"review": "prompts"` for the old
  lower-cost scope.
- **Log path**: logs and decision records are written under
  `/tmp/opencode-auto-mode/` to avoid triggering config reload loops.
  Writing inside `.opencode/` or the project root causes the server to
  detect a file change and reload the plugin in an infinite loop.

## Development

```sh
bun install
bun run typecheck
```

To test local changes, register the checkout directly in your global config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    {
      // Local directory (not a file path — the server resolves <dir>/index.ts
      // and ignores package.json exports). The repo ships that entrypoint.
      "package": "/path/to/opencode-auto-mode",
      "options": { "model": { "id": "...", "providerID": "..." } }
    }
  ]
}
```

The plugin tracks the published docs at
<https://opencode.ai/v2/docs/build/plugins> and
<https://opencode.ai/v2/docs/build/plugins/cli>.