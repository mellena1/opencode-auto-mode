import { Plugin } from "@opencode-ai/plugin/v2";
import { createLogger } from "./logger.js";
import { makeClient } from "./client.js";
import { classify } from "./tiers.js";
import {
  buildReviewPrompt,
  parseDecision,
  type PermissionRequest,
} from "./reviewer.js";

const REVIEW_TIMEOUT_MS = 30_000;
const MAX_REVIEW_ATTEMPTS = 3;

type ReviewerModel = { id: string; providerID: string } | undefined;

export default Plugin.define({
  id: "opencode-auto-mode",
  setup: async (ctx) => {
    const log = createLogger("events.log");
    log.log("=== plugin loaded ===");

    const client = await makeClient().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.log(`FATAL: could not create client: ${msg}`);
      throw err;
    });
    log.log("client created");

    const reviewerModel = ctx.options.model as ReviewerModel;

    const pending = new Map<string, PermissionRequest>();

    const handle = (async () => {
      try {
        log.log("subscribing to event stream...");
        for await (const event of ctx.event.subscribe()) {
          const type = (event as { type?: string }).type ?? "unknown";

          if (type !== "permission.v2.asked") continue;

          const data = (event as { data?: PermissionRequest }).data;
          if (!data) continue;

          log.logJSON("permission asked", data);
          pending.set(data.id, data);
          void reviewAndReply(client, data, reviewerModel, log).catch((err: unknown) => {
            const e = err instanceof Error ? err.message : String(err);
            log.log(`review error: ${e}`);
          });
        }
        log.log("=== event stream ended ===");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.log(`=== event stream error: ${msg} ===`);
      }
    })();

    return () => {
      log.log("=== plugin unloaded ===");
      handle.catch(() => {});
    };
  },
});

async function reviewAndReply(
  client: Awaited<ReturnType<typeof makeClient>>,
  req: PermissionRequest,
  reviewerModel: ReviewerModel,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const classification = classify(req.action, req.resources);
  log.logJSON("classification", classification);

  // Tier 1: Auto-allow — safe commands skip the LLM entirely
  if (classification.tier === "auto-allow") {
    try {
      await client.permission.reply({
        sessionID: req.sessionID,
        requestID: req.id,
        reply: "once",
        message: `auto-allowed: ${classification.reason}`,
      });
      log.log(`auto-allow: ${classification.reason}`);
    } catch (err: unknown) {
      const e = err instanceof Error ? err.message : String(err);
      log.log(`auto-allow reply failed: ${e}`);
    }
    return;
  }

  // Tier 2: Auto-deny — dangerous commands blocked immediately
  if (classification.tier === "auto-deny") {
    try {
      await client.permission.reply({
        sessionID: req.sessionID,
        requestID: req.id,
        reply: "reject",
        message: `auto-denied: ${classification.reason}`,
      });
      log.log(`auto-deny: ${classification.reason}`);
    } catch (err: unknown) {
      const e = err instanceof Error ? err.message : String(err);
      log.log(`auto-deny reply failed: ${e}`);
    }
    return;
  }

  // Tier 3: LLM review needed
  await reviewWithLLM(client, req, reviewerModel, log);
}

async function reviewWithLLM(
  client: Awaited<ReturnType<typeof makeClient>>,
  req: PermissionRequest,
  reviewerModel: ReviewerModel,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const prompt = buildReviewPrompt(req);

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
    try {
      log.log(`reviewing (attempt ${attempt})...`);

      // Delay before retries to let provider connections settle
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }

      const result = await withTimeout(
        client.generate.text({
          prompt,
          model: reviewerModel ?? null,
        }),
        REVIEW_TIMEOUT_MS,
      );

      log.logJSON("reviewer response", result);

      const { decision, reason } = parseDecision(result.text);
      log.log(`decision: ${decision} — ${reason}`);

      if (decision === "allow") {
        await client.permission.reply({
          sessionID: req.sessionID,
          requestID: req.id,
          reply: "once",
          message: reason,
        });
        log.log("replied: once (allow)");
        return;
      }

      if (decision === "deny") {
        await client.permission.reply({
          sessionID: req.sessionID,
          requestID: req.id,
          reply: "reject",
          message: reason,
        });
        log.log("replied: reject (deny)");
        return;
      }

      // ASK: don't reply, let the user decide
      log.log("no reply — falling back to user");
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : JSON.stringify(err);
      log.log(`attempt ${attempt} failed: ${lastError}`);
    }
  }

  log.log(
    `all review attempts failed: ${lastError} — falling back to user`,
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}