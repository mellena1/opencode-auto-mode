import { Plugin } from "@opencode-ai/plugin";
import { createLogger } from "./logger.js";
import { classify } from "./tiers.js";
import { recordDecision } from "./state.js";
import {
  buildReviewPrompt,
  parseDecision,
  type PermissionRequest,
} from "./reviewer.js";

const REVIEW_TIMEOUT_MS = 30_000;
const MAX_REVIEW_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

type ReviewerModel = { id: string; providerID: string; variant?: string };

// NOTE: deliberately no cross-copy claim here. The host loads one plugin
// copy per config location, and permission.evaluate hooks are consulted
// per-location — so every copy must register its own hook. A module-level
// claim makes hook delivery depend on which location happens to boot first.
let reviewCounter = 0;

export default Plugin.define({
  id: "opencode-auto-mode",
  // Ship the TUI badge (./tui entrypoint) alongside the server plugin and
  // have hosts load it automatically.
  tui: true,
  setup: async (ctx) => {
    const log = createLogger("events.log");
    log.log("=== plugin loaded (permission.evaluate hook) ===");

    const options = ctx.options as {
      model?: ReviewerModel;
      review?: "all" | "prompts";
    };
    const reviewerModel = options.model;
    // "all" (default): LLM-review every evaluation that reaches tier 3, even
    // ones OpenCode's rules would silently allow. "prompts": only review
    // evaluations whose computed effect is already "ask" — the original,
    // lower-cost behavior.
    const reviewScope = options.review === "prompts" ? "prompts" : "all";

    const registration = await ctx.permission.hook("evaluate", async (event) => {
      try {
        await evaluate(ctx, event, reviewerModel, reviewScope, log);
      } catch (err) {
        // The host swallows hook errors silently; log so failures are
        // diagnosable via events.log.
        log.logJSON("hook error", { error: String(err) });
        throw err;
      }
    });

    // Runs when the plugin unloads or reloads.
    return () => {
      void registration.dispose();
      log.log("=== plugin unloaded ===");
    };
  },
});

async function evaluate(
  ctx: { generate: { text(input: { prompt: string; model?: ReviewerModel | null }): Promise<{ text: string }> } },
  event: Evaluation,
  reviewerModel: ReviewerModel | undefined,
  reviewScope: "all" | "prompts",
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const classification = classify(event.action, event.resources);
  log.logJSON("classification", { ...classification, effect: event.effect });

  // Tier 2: Auto-deny — catastrophic commands blocked immediately. Runs
  // before the deny guard below so an incoming deny is re-affirmed.
  if (classification.tier === "auto-deny") {
    event.effect = "deny";
    event.message = `auto-denied: ${classification.reason}`;
    return;
  }

  // Respect denials that already exist. Explicitly configured denies
  // never reach this hook; anything else with a deny effect stays denied.
  if (event.effect === "deny") return;

  // Tier 1: Auto-allow — safe read-only commands skip the LLM entirely.
  if (classification.tier === "auto-allow") {
    event.effect = "allow";
    event.message = `auto-approved: ${classification.reason}`;
    return;
  }

  // Tier 3: LLM review. In "prompts" scope, only evaluations that would
  // prompt the user anyway get reviewed.
  if (reviewScope === "prompts" && event.effect !== "ask") return;

  await reviewWithLLM(ctx, event, reviewerModel, log);
}

// Structural subset of the SDK's PermissionEvaluation used by the helpers
// below. The inline hook registration above is typed by the SDK directly.
interface Evaluation {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: readonly string[];
  effect: "allow" | "deny" | "ask";
  message?: string;
}

async function reviewWithLLM(
  ctx: { generate: { text(input: { prompt: string; model?: ReviewerModel | null }): Promise<{ text: string }> } },
  event: Evaluation,
  reviewerModel: ReviewerModel | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  log.log("reviewing...");

  // No real request ID exists yet (the prompt is only published after the
  // hook returns), so decision records use a synthetic ID. The TUI badge
  // keys off these records to show review progress.
  const reviewID = `review-${Date.now()}-${reviewCounter++}`;
  recordDecision({
    requestID: reviewID,
    sessionID: event.sessionID,
    decision: "reviewing",
    reason: "",
    at: Date.now(),
    action: event.action,
    resources: [...event.resources],
  });

  const req: PermissionRequest = {
    action: event.action,
    resources: [...event.resources],
    agent: event.agent,
  };

  const result = await attemptReview(ctx, req, reviewerModel, log);
  if (!result) {
    // All attempts failed — fall back to the user rather than blocking
    // forever or silently letting the original decision stand.
    const failReason = "auto-mode reviewer failed — please decide yourself";
    log.log(`escalating to user: ${failReason}`);
    recordDecision({
      requestID: reviewID,
      sessionID: event.sessionID,
      decision: "ask",
      reason: failReason,
      at: Date.now(),
    });
    event.effect = "ask";
    event.message = failReason;
    return;
  }

  log.logJSON("reviewer response", result);

  const { decision, reason } = parseDecision(result.text);
  log.log(`decision: ${decision} — ${reason}`);

  recordDecision({
    requestID: reviewID,
    sessionID: event.sessionID,
    decision,
    reason,
    at: Date.now(),
  });

  if (decision === "allow") {
    event.effect = "allow";
    event.message = reason;
    return;
  }

  if (decision === "deny") {
    event.effect = "deny";
    event.message = reason;
    return;
  }

  // ASK: escalate to the user. The message is included in the published
  // permission request, so the reviewer's explanation shows in the dialog.
  event.effect = "ask";
  event.message = reason;
}

async function attemptReview(
  ctx: { generate: { text(input: { prompt: string; model?: ReviewerModel | null }): Promise<{ text: string }> } },
  req: PermissionRequest,
  reviewerModel: ReviewerModel | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<{ text: string } | undefined> {
  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(
        ctx.generate.text({
          prompt: buildReviewPrompt(req),
          model: reviewerModel ?? null,
        }),
        REVIEW_TIMEOUT_MS,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.log(`review attempt ${attempt}/${MAX_REVIEW_ATTEMPTS} failed: ${msg}`);
      if (attempt < MAX_REVIEW_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  // All attempts failed — fall back to the user rather than blocking forever.
  log.log("all review attempts failed — falling back to user");
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`review timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
