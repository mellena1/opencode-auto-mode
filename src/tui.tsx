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

type State = {
  pending: Pending[];
};

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function mostRecentPending(state: State): Pending | undefined {
  return state.pending.reduce<Pending | undefined>(
    (best, p) => (best === undefined || p.at > best.at ? p : best),
    undefined,
  );
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
  state: State;
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
        enabled: () => mostRecentPending(props.state) !== undefined,
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
        enabled: () => mostRecentPending(props.state) !== undefined,
        run: () => {
          void props.answer("reject");
        },
      },
    ],
  }));

  const pending = createMemo(() => mostRecentPending(props.state));
  const frame = useSpinner(() => pending() !== undefined);

  const thinking = createMemo(() => {
    const p = pending();
    if (!p || p.escalated) return false;
    return Date.now() - p.at < REVIEW_MS;
  });
  const glyph = createMemo(() => (thinking() ? SPINNER_FRAMES[frame()] : "⚠"));
  const label = createMemo(() => (thinking() ? "reviewing" : "needs your approval"));

  return (
    <box position="absolute" top={0} right={0} zIndex={10_000}>
      <Show
        when={pending()}
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

    const [state, mutate] = ctx.storage.memory<State>("opencode-auto-mode", {
      initial: { pending: [] },
    });

    const removePending = (requestID: string) => {
      mutate((draft) => {
        draft.pending = draft.pending.filter((p) => p.requestID !== requestID);
      });
    };

    const handleAsked = (data: {
      id: string;
      sessionID: string;
      action: string;
      resources: string[];
    }) => {
      if (state.pending.some((p) => p.requestID === data.id)) return;
      mutate((draft) => {
        draft.pending = [
          ...draft.pending,
          {
            requestID: data.id,
            sessionID: data.sessionID,
            action: data.action,
            resource: truncate(data.resources.join(" ") || data.action, MAX_RESOURCE),
            at: Date.now(),
            escalated: false,
          },
        ];
      });
    };

    const handleReplied = (data: { requestID: string }) => {
      removePending(data.requestID);
    };

    const answer = async (reply: "once" | "reject") => {
      const pending = mostRecentPending(state);
      if (!pending) return;
      try {
        await ctx.client.permission.reply({
          sessionID: pending.sessionID,
          requestID: pending.requestID,
          reply,
        });
        removePending(pending.requestID);
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

    // The TUI data bus forwards some event types only, so listen on both it
    // and the raw server stream; handlers dedupe by request ID.
    const unsubs = [
      ctx.data.on("permission.asked", (event) => handleAsked(event.data)),
      ctx.data.on("permission.replied", (event) => handleReplied(event.data)),
    ];

    const abort = new AbortController();
    const runStream = async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.client.event.subscribe({ signal: abort.signal })) {
            if (event.type === "permission.asked") handleAsked(event.data);
            else if (event.type === "permission.replied") handleReplied(event.data);
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          console.error("[opencode-auto-mode] event stream error:", err);
        }
        if (abort.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    const stream = runStream();

    const poll = setInterval(() => {
      if (state.pending.length === 0) return;
      const decisions = readDecisions();
      const escalated: string[] = [];
      for (const p of state.pending) {
        const record = decisions[p.requestID];
        if (record?.decision === "ask") escalated.push(p.requestID);
      }
      if (escalated.length) {
        mutate((draft) => {
          for (const p of draft.pending) {
            if (escalated.includes(p.requestID)) p.escalated = true;
          }
        });
      }
      // Requests the server no longer considers pending were answered (by
      // the user or another client) — drop them so the badge clears even if
      // the replied event never reaches this plugin.
      for (const p of state.pending) {
        void ctx.client.permission
          .list({ sessionID: p.sessionID })
          .then((requests) => {
            if (!requests.some((request) => request.id === p.requestID)) removePending(p.requestID);
          })
          .catch(() => {});
      }
    }, POLL_MS);

    const disposeBadge = ctx.ui.slot({
      append: "app",
      render: () => (
        <Badge
          state={state}
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
      abort.abort();
      void stream.catch(() => {});
      unsubs.forEach((unsub) => unsub());
      disposeBadge();
    };
  },
});
