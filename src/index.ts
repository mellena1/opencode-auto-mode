import { Plugin } from "@opencode-ai/plugin/effect";
import { Effect, Stream } from "effect";
import { createLogger } from "./logger.js";
import { makeClient } from "./client.js";
import { classify } from "./tiers.js";
import { recordDecision } from "./state.js";
import {
  buildReviewPrompt,
  parseDecision,
  type PermissionRequest,
} from "./reviewer.js";

const REVIEW_TIMEOUT_MS = 30_000;
const MAX_REVIEW_ATTEMPTS = 3;

type ReviewerModel = { id: string; providerID: string } | undefined;

// Module-level claim: the beta host loads one copy of the plugin per active
// config location (global config location + project location), but every copy
// shares this module instance (same entrypoint specifier). Only the first
// copy to activate does the work; the rest exit immediately, so each
// permission request is reviewed exactly once per process. The claim resets
// when the claiming copy unloads, so a later location boot can take over.
let claimed = false;

/** The payload of a `permission.asked` event. */
type Asked = {
  id: string;
  sessionID: string;
  action: string;
  resources: readonly string[];
  save?: readonly string[];
  metadata?: Record<string, unknown>;
  source?: { type: string; messageID: string; id: string };
};

export default Plugin.define({
  id: "opencode-auto-mode",
  effect: (ctx) =>
    Effect.gen(function* () {
      const log = createLogger("events.log");
      if (claimed) {
        log.log("=== skipping duplicate instance (already claimed) ===");
        return;
      }
      claimed = true;
      log.log("=== plugin loaded ===");

      // Runs when the plugin's scope closes — on reload or unload, even
      // when the plugin is interrupted mid-flight.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          claimed = false;
          log.log("=== plugin unloaded ===");
        }),
      );

      const client = yield* Effect.tryPromise({
        try: () => makeClient(),
        catch: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.log(`FATAL: could not create client: ${msg}`);
          // Throwing in the mapper turns this into a defect, which kills the
          // plugin without touching the effect's error channel (E must be
          // never for the plugin effect).
          throw err instanceof Error ? err : new Error(msg);
        },
      });
      log.log("client created");

      const reviewerModel = ctx.options.model as ReviewerModel;

      // The plugin effect must COMPLETE for activation to finish — the
      // supervisor awaits it, and /api/model waits on plugins.flush with a
      // 5s timeout (503 "Model catalog initialization timed out"). Long-lived
      // work is forked into the plugin's scope instead: the supervisor holds
      // the scope open until reload/unload, which interrupts the fork and
      // releases the bus subscription.
      yield* (
        ctx.event
          .subscribe()
          .pipe(
            // The stream carries an error channel; log and end instead of
            // failing the plugin effect (its error channel must stay never).
            Stream.catch((err) => {
              log.log(`event stream error: ${err instanceof Error ? err.message : String(err)}`);
              return Stream.empty;
            }),
            Stream.filter(
              (event): event is Extract<typeof event, { type: "permission.asked" }> =>
                event.type === "permission.asked",
            ),
            Stream.runForEach((event) => {
              // Reviews run concurrently on their own scoped fibers.
              const review = reviewAndReply(client, event.data, reviewerModel, log) as Effect.Effect<void, never, never>;
              return Effect.forkScoped(review).pipe(Effect.asVoid);
            }),
          ) as Effect.Effect<void, never, never>
      ).pipe(Effect.forkScoped(), Effect.asVoid);
    }),
});

function reviewAndReply(
  client: Awaited<ReturnType<typeof makeClient>>,
  data: Asked,
  reviewerModel: ReviewerModel,
  log: ReturnType<typeof createLogger>,
): Effect.Effect<void> {
  const req = toPermissionRequest(data);
  return Effect.gen(function* () {
    const classification = classify(req.action, req.resources);
    log.logJSON("classification", classification);

    // Tier 1: Auto-allow — safe commands skip the LLM entirely
    if (classification.tier === "auto-allow") {
      recordDecision({
        requestID: req.id,
        sessionID: req.sessionID,
        decision: "allow",
        reason: classification.reason,
        at: Date.now(),
      });
      yield* reply(
        client,
        req,
        "once",
        `auto-allowed: ${classification.reason}`,
        log,
        `auto-allow: ${classification.reason}`,
      );
      return;
    }

    // Tier 2: Auto-deny — dangerous commands blocked immediately
    if (classification.tier === "auto-deny") {
      recordDecision({
        requestID: req.id,
        sessionID: req.sessionID,
        decision: "deny",
        reason: classification.reason,
        at: Date.now(),
      });
      yield* reply(
        client,
        req,
        "reject",
        `auto-denied: ${classification.reason}`,
        log,
        `auto-deny: ${classification.reason}`,
      );
      return;
    }

    // Tier 3: LLM review needed
    yield* reviewWithLLM(client, req, reviewerModel, log);
  });
}

function reviewWithLLM(
  client: Awaited<ReturnType<typeof makeClient>>,
  req: PermissionRequest,
  reviewerModel: ReviewerModel,
  log: ReturnType<typeof createLogger>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    log.log("reviewing...");

    const result = yield* attemptReview(client, req, reviewerModel, log);
    if (result === undefined) return; // all attempts failed — logged and recorded above

    log.logJSON("reviewer response", result);

    const { decision, reason } = parseDecision(result.text);
    log.log(`decision: ${decision} — ${reason}`);

    recordDecision({
      requestID: req.id,
      sessionID: req.sessionID,
      decision,
      reason,
      at: Date.now(),
    });

    if (decision === "allow") {
      yield* reply(client, req, "once", reason, log, "replied: once (allow)");
      return;
    }

    if (decision === "deny") {
      yield* reply(client, req, "reject", reason, log, "replied: reject (deny)");
      return;
    }

    // ASK: don't reply, let the user decide
    log.log("no reply — falling back to user");
  });
}

function attemptReview(
  client: Awaited<ReturnType<typeof makeClient>>,
  req: PermissionRequest,
  reviewerModel: ReviewerModel,
  log: ReturnType<typeof createLogger>,
): Effect.Effect<{ text: string } | undefined> {
  const attempt = Effect.tryPromise({
    try: () =>
      client.generate.text({
        prompt: buildReviewPrompt(req),
        model: reviewerModel ?? null,
      }),
    catch: (err) => err,
  }).pipe(Effect.timeout(REVIEW_TIMEOUT_MS));

  return attempt.pipe(
    Effect.retry({
      times: MAX_REVIEW_ATTEMPTS - 1,
      delay: "1 seconds",
      while: (error) => !isPermissionNotFound(error),
    }),
    Effect.catch((error) => {
      const msg = error instanceof Error ? error.message : JSON.stringify(error);
      log.log(`all review attempts failed: ${msg} — falling back to user`);
      recordDecision({
        requestID: req.id,
        sessionID: req.sessionID,
        decision: "ask",
        reason: `review failed: ${msg}`,
        at: Date.now(),
      });
      return Effect.succeed(undefined);
    }),
  );
}

function reply(
  client: Awaited<ReturnType<typeof makeClient>>,
  req: PermissionRequest,
  replyType: "once" | "reject",
  message: string,
  log: ReturnType<typeof createLogger>,
  successLog: string,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () =>
      client.permission.reply({
        sessionID: req.sessionID,
        requestID: req.id,
        reply: replyType,
        message,
      }),
    catch: (err) => err,
  }).pipe(
    Effect.tap(() => Effect.sync(() => log.log(successLog))),
    Effect.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.log(`reply failed: ${msg}`);
      return Effect.void;
    }),
  );
}

function toPermissionRequest(data: Asked): PermissionRequest {
  return {
    id: data.id,
    sessionID: data.sessionID,
    action: data.action,
    resources: [...data.resources],
    save: data.save ? [...data.save] : undefined,
    source: data.source
      ? { type: data.source.type, messageID: data.source.messageID, callID: data.source.id }
      : undefined,
  };
}

function isPermissionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as Record<string, unknown>)._tag === "PermissionNotFoundError"
  );
}
