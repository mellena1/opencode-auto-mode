/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Show, type JSX } from "solid-js";
import { Plugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode-ai/plugin/tui/context";
import type { ResolvedTheme } from "@opencode-ai/theme/tui";
import { readDecisions } from "./state.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_RESOURCE = 48;
const POLL_MS = 1_000;
const STALE_MS = 90_000;

type Reply = "once" | "reject";

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

// `ctx.data.session.list()` is unreliable across betas: on 0.0.0-beta-17823
// the host's session store memo never invalidates, so iterating sessions to
// find pending permissions sees an empty list forever. Instead the badge is
// fed by permission events plus the server plugin's decision file: tier-3
// reviews run inside the evaluate hook BEFORE a permission request exists,
// so "reviewing" records (synthetic IDs) create spinner entries, and the
// permission.asked event that follows an escalation adopts the matching
// entry so its spinner time carries over.
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
        // Only real, escalated requests can be answered — during review no
        // server-side permission request exists yet.
        enabled: () => props.pending()?.escalated === true,
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
        enabled: () => props.pending()?.escalated === true,
        run: () => {
          void props.answer("reject");
        },
      },
    ],
  }));

  const thinking = createMemo(() => {
    const p = props.pending();
    return p !== undefined && !p.escalated;
  });
  const label = createMemo(() => (thinking() ? "reviewing" : "needs your approval"));

  // The glyph comes from opentui's intrinsic <spinner>, not our own timer:
  // npm installs can split solid-js into two instances (the plugin's exact
  // pin vs @opentui/solid's peer pin), which freezes timer-driven signal
  // renders. The spinner element animates on its own renderable, so the
  // badge works regardless of how dependencies resolve.
  return (
    <box flexDirection="row" gap={1}>
      <spinner
        frames={SPINNER_FRAMES}
        interval={120}
        color={theme.text.feedback.warning.default}
      />
      <text fg={theme.text.feedback.warning.default}>auto-mode {label()}</text>
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

    // Own pending list, fed by events. Keeping it locally (instead of reading
    // the host's session store) makes the badge independent of host store
    // behavior across betas.
    const [pending, setPending] = createSignal<Pending[]>([]);
    const firstSeen = new Map<string, number>();

    const addPending = (data: {
      id: string;
      sessionID: string;
      action: string;
      resources: readonly string[];
    }) => {
      if (pending().some((p) => p.requestID === data.id)) return;
      // An asked event means the server plugin's review already finished with
      // ASK. Adopt a matching in-review entry so its spinner duration carries
      // over instead of restarting the badge from scratch.
      const inReview = pending().find(
        (p) => !p.escalated && p.sessionID === data.sessionID && p.action === data.action,
      );
      if (inReview) {
        firstSeen.delete(inReview.requestID);
        setPending((prev) =>
          prev.map((p) =>
            p === inReview ? { ...p, requestID: data.id, escalated: true } : p,
          ),
        );
        firstSeen.set(data.id, inReview.at);
        return;
      }
      const at = firstSeen.get(data.id) ?? Date.now();
      firstSeen.set(data.id, at);
      setPending((prev) => [
        ...prev,
        {
          requestID: data.id,
          sessionID: data.sessionID,
          action: data.action,
          resource: truncate(data.resources.join(" ") || data.action, MAX_RESOURCE),
          at,
          escalated: true,
        },
      ]);
    };

    const removePending = (requestID: string) => {
      firstSeen.delete(requestID);
      setPending((prev) => prev.filter((p) => p.requestID !== requestID));
    };

    // Primary channel: the host data bus. Some host versions forward only a
    // subset of event types, so the raw server stream below is the fallback;
    // handlers dedupe by request ID.
    const unsubs = [
      ctx.data.on("permission.asked", (event) => addPending(event.data)),
      ctx.data.on("permission.replied", (event) => removePending(event.data.requestID)),
    ];

    // Fallback channel: the raw server event stream, with reconnection.
    const abort = new AbortController();
    const runStream = async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.client.event.subscribe({ signal: abort.signal })) {
            if (event.type === "permission.asked") addPending(event.data);
            else if (event.type === "permission.replied") removePending(event.data.requestID);
          }
        } catch {
          // fall through to reconnect
        }
        if (abort.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void runStream();

    // Reconcile with the server plugin's decision file:
    // - "reviewing" records create spinner entries (they precede any event,
    //   since the evaluate hook runs before the request is published)
    // - "ask" escalates the entry, "allow"/"deny" resolves it
    // - entries that outlived every record and the review window are pruned
    const poll = setInterval(() => {
      snapshotView();
      const decisions = readDecisions();
      const now = Date.now();
      let next = pending();
      let dirty = false;

      for (const [reviewID, rec] of Object.entries(decisions)) {
        if (rec.decision !== "reviewing") continue;
        if (next.some((p) => p.requestID === reviewID)) continue;
        if (now - rec.at >= STALE_MS) continue;
        firstSeen.set(reviewID, rec.at);
        next = [
          ...next,
          {
            requestID: reviewID,
            sessionID: rec.sessionID,
            action: rec.action ?? "",
            resource: truncate(
              (rec.resources ?? []).join(" ") || rec.action || "",
              MAX_RESOURCE,
            ),
            at: rec.at,
            escalated: false,
          },
        ];
        dirty = true;
      }

      const reconciled: Pending[] = [];
      for (const p of next) {
        const record = decisions[p.requestID];
        if (record?.decision === "allow" || record?.decision === "deny") {
          firstSeen.delete(p.requestID);
          dirty = true;
          continue;
        }
        if (record?.decision === "ask" && !p.escalated) {
          reconciled.push({ ...p, escalated: true });
          dirty = true;
          continue;
        }
        if (!record && now - p.at >= STALE_MS) {
          firstSeen.delete(p.requestID);
          dirty = true;
          continue;
        }
        reconciled.push(p);
      }
      if (dirty) setPending(reconciled);
    }, POLL_MS);

    // View scoping: decision records live in a machine-global file (and on
    // shared servers permission events are global too), so without filtering
    // every open TUI would badge other TUIs' reviews. Router + tabs state is
    // client-local — a foreign session is never the current route nor an open
    // tab here — which discriminates both separate-server and shared-server
    // setups. Snapshotted on the existing poll tick (1s granularity is fine
    // for a status badge) instead of relying on host reactivity.
    const [visibleIDs, setVisibleIDs] = createSignal<ReadonlySet<string>>(new Set());
    const snapshotView = () => {
      const ids = new Set<string>();
      try {
        if (ctx.ui.tabs.enabled()) {
          for (const tab of ctx.ui.tabs.list()) ids.add(tab.sessionID);
        }
      } catch {
        // tabs unavailable — route only
      }
      try {
        const route = ctx.ui.router.current();
        if (route.type === "session") ids.add(route.sessionID);
      } catch {
        // router unavailable — tabs only
      }
      const key = [...ids].sort().join(",");
      const prev = [...visibleIDs()].sort().join(",");
      if (key !== prev) setVisibleIDs(ids);
    };
    snapshotView();

    const mostRecent = createMemo(() => {
      const visible = visibleIDs();
      const requests = pending().filter((p) => visible.has(p.sessionID));
      return requests.length > 0 ? requests[requests.length - 1] : undefined;
    });

    const answer = async (reply: "once" | "reject") => {
      const pendingRequest = mostRecent();
      if (!pendingRequest) return;
      try {
        await ctx.client.permission.reply({
          sessionID: pendingRequest.sessionID,
          requestID: pendingRequest.requestID,
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

    // Top-right overlay, above the permission dialog (which covers the bottom
    // bar). Only visible while this TUI has a session with a pending review:
    // spinner while reviewing, ⚠ when it needs the user.
    const disposeBadge = ctx.ui.slot({
      append: "app",
      render: () => (
        <Show when={mostRecent() !== undefined}>
          <box position="absolute" top={0} right={0} zIndex={10_000}>
            <Badge
              pending={mostRecent}
              answer={answer}
              allowKey={allowKey}
              denyKey={denyKey}
              keymap={ctx.keymap}
              theme={() => ctx.theme}
            />
          </box>
        </Show>
      ),
    });

    return () => {
      for (const unsub of unsubs) unsub();
      abort.abort();
      clearInterval(poll);
      disposeBadge();
    };
  },
});