/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Plugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode-ai/plugin/tui/context";
import type { ResolvedTheme } from "@opencode-ai/theme/tui";
import { readDecisions } from "./state.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REVIEW_MS = 30_000;
const MAX_RESOURCE = 48;
const POLL_MS = 1_000;

type Reply = "once" | "always" | "reject";

type Pending = {
  requestID: string;
  sessionID: string;
  action: string;
  resource: string;
  at: number;
  escalated: boolean;
};

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function useSpinner(active: () => boolean): () => number {
  const [frame, setFrame] = createSignal(0);
  createEffect(() => {
    if (!active()) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    onCleanup(() => clearInterval(id));
  });
  return frame;
}

function Badge(props: {
  pending: () => Pending | undefined;
  answer: (reply: "once" | "reject") => Promise<void>;
  allowKey: string;
  denyKey: string;
  keymap: Pick<Context["keymap"], "layer">;
  theme: () => ResolvedTheme;
}): JSX.Element {
  const theme = props.theme();

  props.keymap.layer(() => ({
    mode: "base",
    commands: [
      {
        id: "auto-mode.allow",
        title: "Allow pending permission",
        group: "Auto-mode",
        palette: true,
        bind: props.allowKey,
        enabled: () => props.pending() !== undefined,
        run: () => {
          void props.answer("once");
        },
      },
      {
        id: "auto-mode.deny",
        title: "Deny pending permission",
        group: "Auto-mode",
        palette: true,
        bind: props.denyKey,
        enabled: () => props.pending() !== undefined,
        run: () => {
          void props.answer("reject");
        },
      },
    ],
  }));

  const frame = useSpinner(() => props.pending() !== undefined);

  const thinking = createMemo(() => {
    const p = props.pending();
    if (!p || p.escalated) return false;
    return Date.now() - p.at < REVIEW_MS;
  });
  const glyph = createMemo(() => (thinking() ? SPINNER_FRAMES[frame()] : "⚠"));
  const label = createMemo(() => (thinking() ? "reviewing" : "needs your approval"));

  return (
    <box position="absolute" top={0} right={0} zIndex={10_000}>
      <Show
        when={props.pending()}
        fallback={<text fg={theme.text.subdued}>● auto-mode</text>}
      >
        <text fg={theme.text.feedback.warning.default}>
          {glyph()} auto-mode {label()}
        </text>
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: "opencode-auto-mode",
  setup: async (ctx) => {
    const options = ctx.options as Record<string, any>;
    const keybinds = (options.keybinds ?? {}) as Record<string, unknown>;
    const allowKey = str(keybinds.allow, "ctrl+alt+a");
    const denyKey = str(keybinds.deny, "ctrl+alt+d");

    // The TUI host's own permission store (ctx.data.session.permission) is
    // fed by the host's event stream — the same store that drives the
    // permission dialog the host displays. We read from it instead of
    // subscribing to events ourselves, so the badge tracks the host's
    // permission lifecycle exactly.
    const [escalated, setEscalated] = createSignal<Record<string, boolean>>({});
    const firstSeen = new Map<string, number>();

    const derivedPending = (): Pending[] => {
      const requests: Pending[] = [];
      for (const session of ctx.data.session.list()) {
        const perms = ctx.data.session.permission.list(session.id);
        if (!perms || perms.length === 0) continue;
        for (const request of perms) {
          if (!firstSeen.has(request.id)) firstSeen.set(request.id, Date.now());
          requests.push({
            requestID: request.id,
            sessionID: request.sessionID,
            action: request.action,
            resource: truncate(request.resources.join(" ") || request.action, MAX_RESOURCE),
            at: firstSeen.get(request.id) ?? Date.now(),
            escalated: escalated()[request.id] ?? false,
          });
        }
      }
      // The host appends to each session's list on `permission.asked`, so the
      // last entry of the last session is the most recent request.
      return requests;
    };

    const mostRecent = createMemo(() => {
      const requests = derivedPending();
      return requests.length > 0 ? requests[requests.length - 1] : undefined;
    });

    // Escalation polling: mark requests as "needs your approval" when the
    // server plugin decided to ask the user, or once a request has been
    // pending past the review window.
    const poll = setInterval(() => {
      const current = derivedPending();
      if (current.length === 0) {
        if (Object.keys(escalated()).length > 0) setEscalated({});
        return;
      }
      const decisions = readDecisions();
      const next = { ...escalated() };
      const now = Date.now();
      let dirty = false;
      for (const request of current) {
        const record = decisions[request.requestID];
        const shouldEscalate =
          record?.decision === "ask" || now - request.at >= REVIEW_MS;
        if (shouldEscalate && !next[request.requestID]) {
          next[request.requestID] = true;
          dirty = true;
        }
      }
      for (const id of Object.keys(next)) {
        if (!current.some((request) => request.requestID === id)) {
          delete next[id];
          dirty = true;
        }
      }
      if (dirty) setEscalated(next);
    }, POLL_MS);

    const answer = async (reply: "once" | "reject") => {
      const pending = mostRecent();
      if (!pending) return;
      try {
        await ctx.client.permission.reply({
          sessionID: pending.sessionID,
          requestID: pending.requestID,
          reply,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.toast.show({
          variant: "error",
          title: "Auto-mode",
          message: `Failed to reply: ${message}`,
          duration: 4000,
        });
      }
    };

    const disposeBadge = ctx.ui.slot({
      append: "app",
      render: () => (
        <Badge
          pending={mostRecent}
          answer={answer}
          allowKey={allowKey}
          denyKey={denyKey}
          keymap={ctx.keymap}
          theme={() => ctx.theme}
        />
      ),
    });

    return () => {
      clearInterval(poll);
      disposeBadge();
    };
  },
});