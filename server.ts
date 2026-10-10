// bb-plugin-auto-compact — compact a thread's context window automatically
// when usage reaches a configurable percentage.
//
// How it works: BB reports per-thread context usage on the thread timeline
// (`contextWindowUsage`: used tokens vs. model window). When a thread goes
// idle or fails — exactly the states where BB allows compaction — this plugin
// reads that usage and calls `threads.compact` once it meets the threshold.
// A per-thread cooldown keeps a thread whose usage stays high from being
// compacted on every single idle event.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Minimum time between two auto-compactions of the same thread. */
const COOLDOWN_MS = 15 * 60_000;
const LAST_COMPACT_KV_PREFIX = "last-compact:";
const UNSUPPORTED_KV_PREFIX = "unsupported-compact:";
const THRESHOLD_OPTIONS = Array.from({ length: 19 }, (_, i) =>
  String((i + 1) * 5),
);
const USE_GLOBAL = "Use global";

function providerThresholdSetting(provider: string) {
  return {
    type: "select" as const,
    label: `${provider} threshold override (%)`,
    description:
      "Use the global threshold, or choose a percentage for this provider only.",
    options: [USE_GLOBAL, ...THRESHOLD_OPTIONS],
    default: USE_GLOBAL,
  };
}

/** Percentage of `window` consumed by `used`, or null when unmeasurable. */
export function usagePercent(
  usedTokens: number,
  modelContextWindow: number,
): number | null {
  if (
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(modelContextWindow) ||
    modelContextWindow <= 0 ||
    usedTokens < 0
  ) {
    return null;
  }
  return (usedTokens / modelContextWindow) * 100;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 200) || "Unknown error.";
}

/**
 * True when BB reports the thread's provider cannot compact at all (some
 * ACP bridges throw "<provider> does not support manual compaction").
 */
function isUnsupportedCompaction(error: unknown): boolean {
  return /does not support .*compaction/i.test(errorMessage(error));
}

// RPC contract for the thread-header Compact button (app.tsx imports only
// this contract's type; the backend module is erased from the bundle).
const usageSchema = z.object({
  percent: z.number().nullable(),
  usedTokens: z.number().nullable(),
  modelContextWindow: z.number().nullable(),
  thresholdPercent: z.number(),
});
export const rpcContract = defineRpcContract({
  compact_now: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ result: z.string() }),
  },
  usage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: usageSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Auto-compact threads",
      description:
        "When on, idle or failed threads are compacted once context usage reaches the threshold.",
      default: true,
    },
    thresholdPercent: {
      type: "select",
      label: "Global context threshold (%)",
      description:
        "Compact at this percentage of the model's context window. Applies to all providers unless overridden below; 5–95% in steps of 5%.",
      options: THRESHOLD_OPTIONS,
      default: "80",
    },
    claudeCodeThresholdPercent: providerThresholdSetting("Claude Code"),
    codexThresholdPercent: providerThresholdSetting("Codex"),
    piThresholdPercent: providerThresholdSetting("Pi"),
  });
  let cached = await settings.get();
  settings.onChange((next) => {
    cached = next;
  });

  function providerThresholds(): Record<string, number | null> {
    const override = (value: string) =>
      value === USE_GLOBAL ? null : Number(value);
    return {
      "claude-code": override(cached.claudeCodeThresholdPercent),
      codex: override(cached.codexThresholdPercent),
      pi: override(cached.piThresholdPercent),
    };
  }

  async function thresholdForThread(threadId: string): Promise<number> {
    const global = Number(cached.thresholdPercent);
    const overrides = providerThresholds();
    if (Object.values(overrides).every((value) => value === null))
      return global;
    const thread = await bb.sdk.threads.get({ threadId });
    return Object.hasOwn(overrides, thread.providerId)
      ? (overrides[thread.providerId] ?? global)
      : global;
  }

  // Threads currently being compacted; prevents overlapping compactions of
  // the same thread from concurrent idle/failed events.
  const inFlight = new Set<string>();

  async function readUsage(threadId: string): Promise<{
    percent: number | null;
    usedTokens: number | null;
    modelContextWindow: number | null;
  }> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId });
      const used = timeline.contextWindowUsage?.usedTokens;
      const window = timeline.contextWindowUsage?.modelContextWindow;
      return {
        percent:
          used === undefined || window === undefined
            ? null
            : usagePercent(used, window),
        usedTokens: used ?? null,
        modelContextWindow: window ?? null,
      };
    } catch (error) {
      bb.log.warn(
        `Auto-compact: could not read usage for thread ${threadId}: ${errorMessage(error)}`,
      );
      return { percent: null, usedTokens: null, modelContextWindow: null };
    }
  }

  async function checkThread(
    threadId: string,
    trigger: string,
  ): Promise<string> {
    if (!cached.enabled) return "skipped: auto-compact is disabled";
    if (inFlight.has(threadId)) {
      return "skipped: compaction already in progress";
    }
    const unsupportedAt = await bb.storage.kv.get<number>(
      `${UNSUPPORTED_KV_PREFIX}${threadId}`,
    );
    if (
      typeof unsupportedAt === "number" &&
      Date.now() - unsupportedAt < COOLDOWN_MS
    ) {
      return "skipped: provider does not support compaction";
    }
    const lastCompact = await bb.storage.kv.get<number>(
      `${LAST_COMPACT_KV_PREFIX}${threadId}`,
    );
    if (
      typeof lastCompact === "number" &&
      Date.now() - lastCompact < COOLDOWN_MS
    ) {
      return "skipped: compacted recently (cooldown)";
    }
    const { percent } = await readUsage(threadId);
    if (percent === null) return "skipped: usage unavailable";
    const threshold = await thresholdForThread(threadId);
    if (percent < threshold) {
      return `ok: ${percent.toFixed(1)}% < ${threshold}%`;
    }
    inFlight.add(threadId);
    try {
      await bb.sdk.threads.compact({ threadId });
    } catch (error) {
      if (isUnsupportedCompaction(error)) {
        await bb.storage.kv.set(
          `${UNSUPPORTED_KV_PREFIX}${threadId}`,
          Date.now(),
        );
        bb.log.info(
          `Auto-compact: skipping thread ${threadId}: provider does not support compaction.`,
        );
        return "skipped: provider does not support compaction";
      }
      bb.log.warn(
        `Auto-compact: compaction failed for thread ${threadId}: ${errorMessage(error)}`,
      );
      return "error: compaction failed";
    } finally {
      inFlight.delete(threadId);
    }
    await bb.storage.kv.set(`${LAST_COMPACT_KV_PREFIX}${threadId}`, Date.now());
    bb.log.info(
      `Auto-compacted thread ${threadId} at ${percent.toFixed(1)}% of context window (${trigger}, threshold ${threshold}%).`,
    );
    return `compacted at ${percent.toFixed(1)}%`;
  }

  function onSettled(threadId: string, trigger: string): void {
    void checkThread(threadId, trigger).catch((error: unknown) => {
      bb.log.warn(
        `Auto-compact: check failed for thread ${threadId}: ${errorMessage(error)}`,
      );
    });
  }
  bb.events.on("thread.idle", ({ thread }) => onSettled(thread.id, "idle"));
  bb.events.on("thread.failed", ({ thread }) => onSettled(thread.id, "failed"));

  // Manual compaction: explicit user intent, so it bypasses the threshold
  // and cooldown. Still guards against overlapping compactions, and records
  // the run so the next automatic check sees a fresh cooldown.
  async function forceCompact(threadId: string): Promise<string> {
    if (inFlight.has(threadId)) {
      return "skipped: compaction already in progress";
    }
    inFlight.add(threadId);
    try {
      await bb.sdk.threads.compact({ threadId });
    } catch (error) {
      if (isUnsupportedCompaction(error)) {
        await bb.storage.kv.set(
          `${UNSUPPORTED_KV_PREFIX}${threadId}`,
          Date.now(),
        );
        bb.log.info(
          `Auto-compact: manual compaction not supported for thread ${threadId}.`,
        );
        return `unsupported: ${errorMessage(error)}`;
      }
      bb.log.warn(
        `Auto-compact: manual compaction failed for thread ${threadId}: ${errorMessage(error)}`,
      );
      return `error: ${errorMessage(error)}`;
    } finally {
      inFlight.delete(threadId);
    }
    await bb.storage.kv.set(`${LAST_COMPACT_KV_PREFIX}${threadId}`, Date.now());
    bb.log.info(`Manually compacted thread ${threadId}.`);
    return "compacted";
  }

  bb.rpc.register(rpcContract, {
    compact_now: async ({ threadId }) => ({
      result: await forceCompact(threadId),
    }),
    usage: async ({ threadId }) => ({
      ...(await readUsage(threadId)),
      thresholdPercent: await thresholdForThread(threadId),
    }),
  });

  const usageText = [
    "Usage:",
    "  bb auto-compact status [--json]",
    "  bb auto-compact check [thread-id] [--json]",
    "  bb auto-compact now [thread-id] [--json]",
  ].join("\n");
  bb.cli.register({
    name: "auto-compact",
    summary: "Auto-compact thread context when usage nears the limit",
    commands: [
      {
        name: "status",
        summary: "Show auto-compact settings",
        usage: "bb auto-compact status [--json]",
      },
      {
        name: "check",
        summary: "Check a thread now and compact it if over threshold",
        usage: "bb auto-compact check [thread-id] [--json]",
      },
      {
        name: "now",
        summary:
          "Compact a thread immediately, bypassing threshold and cooldown",
        usage: "bb auto-compact now [thread-id] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const [command, ...rest] = argv.filter((arg) => arg !== "--json");
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usageText };
        case "status": {
          const value = {
            enabled: cached.enabled,
            thresholdPercent: Number(cached.thresholdPercent),
            providerThresholds: providerThresholds(),
            cooldownMinutes: COOLDOWN_MS / 60_000,
          };
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(value)
              : [
                  `enabled: ${value.enabled}`,
                  `global threshold: ${value.thresholdPercent}%`,
                  ...Object.entries(value.providerThresholds).map(
                    ([provider, threshold]) =>
                      `${provider}: ${threshold === null ? `Use global (${value.thresholdPercent}%)` : `${threshold}%`}`,
                  ),
                  `cooldown: ${value.cooldownMinutes} min`,
                ].join("\n"),
          };
        }
        case "check": {
          const threadId = rest[0] ?? ctx.threadId ?? undefined;
          if (threadId === undefined || rest.length > 1) {
            return { exitCode: 1, stderr: usageText };
          }
          const result = await checkThread(threadId, "manual");
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ threadId, result })
              : `${threadId}: ${result}`,
          };
        }
        case "now": {
          const threadId = rest[0] ?? ctx.threadId ?? undefined;
          if (threadId === undefined || rest.length > 1) {
            return { exitCode: 1, stderr: usageText };
          }
          const result = await forceCompact(threadId);
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ threadId, result })
              : `${threadId}: ${result}`,
          };
        }
        default:
          return { exitCode: 1, stderr: usageText };
      }
    },
  });

  bb.onDispose(() => {
    inFlight.clear();
  });
}
