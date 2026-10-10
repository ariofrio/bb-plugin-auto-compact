import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { usagePercent } from "./server";

const THREAD_ID = "thr_test1";

function timelineWith(usedTokens: number, modelContextWindow: number) {
  return {
    contextWindowUsage: {
      estimated: false,
      modelContextWindow,
      usedTokens,
    },
  };
}

async function loadHost(
  usedTokens: number,
  modelContextWindow = 200_000,
  compactImpl?: (
    args: { threadId: string },
    calls: string[],
  ) => Promise<unknown>,
  providerId = "codex",
  settings?: Record<string, string | number | boolean>,
) {
  const compactCalls: string[] = [];
  const compact =
    compactImpl ??
    (async (args: { threadId: string }) => {
      compactCalls.push(args.threadId);
      return { ok: true as const };
    });
  const { bb, harness } = createFakePluginHost({
    pluginId: "auto-compact",
    settings,
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: THREAD_ID, providerId }),
        timeline: async () => timelineWith(usedTokens, modelContextWindow),
        compact: (args: { threadId: string }) => compact(args, compactCalls),
      },
    },
  });
  await plugin(bb);
  return { harness, compactCalls };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("usagePercent", () => {
  it("computes the consumed percentage", () => {
    expect(usagePercent(170_000, 200_000)).toBe(85);
    expect(usagePercent(0, 200_000)).toBe(0);
  });

  it("returns null when unmeasurable", () => {
    expect(usagePercent(10, 0)).toBeNull();
    expect(usagePercent(-1, 200_000)).toBeNull();
    expect(usagePercent(Number.NaN, 200_000)).toBeNull();
  });
});

describe("auto-compact on thread events", () => {
  it("compacts an idle thread at or above the threshold", async () => {
    const { harness, compactCalls } = await loadHost(170_000);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await waitFor(() => compactCalls.length === 1);
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("leaves an idle thread below the threshold alone", async () => {
    const { harness, compactCalls } = await loadHost(100_000);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(compactCalls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("compacts a failed thread over the threshold", async () => {
    const { harness, compactCalls } = await loadHost(190_000);
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      error: "context window exceeded",
    });
    await waitFor(() => compactCalls.length === 1);
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("cools down: one compaction per thread per window", async () => {
    const { harness, compactCalls } = await loadHost(190_000);
    const event = {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    };
    await harness.behavior.emitThreadEvent("thread.idle", event);
    await waitFor(() => compactCalls.length === 1);
    await harness.behavior.emitThreadEvent("thread.idle", event);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("does nothing while disabled", async () => {
    const { harness, compactCalls } = await loadHost(190_000);
    await harness.behavior.setSettings({ enabled: false });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(compactCalls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("honors a custom threshold", async () => {
    const { harness, compactCalls } = await loadHost(170_000);
    await harness.behavior.setSettings({ thresholdPercent: "90" });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(compactCalls).toEqual([]);
    await harness.lifecycle.dispose();
  });
});

describe("usage RPC", () => {
  it("reports percent, tokens, window, and threshold", async () => {
    const { harness } = await loadHost(170_000);
    const result = await harness.behavior.callRpc("usage", {
      threadId: THREAD_ID,
    });
    expect(result).toEqual({
      enabled: true,
      percent: 85,
      usedTokens: 170_000,
      modelContextWindow: 200_000,
      thresholdPercent: 80,
    });
    await harness.lifecycle.dispose();
  });

  it("rejects an empty thread id", async () => {
    const { harness } = await loadHost(170_000);
    await expect(
      harness.behavior.callRpc("usage", { threadId: "" }),
    ).rejects.toThrow();
    await harness.lifecycle.dispose();
  });
});

describe("providers without compaction support", () => {
  const unsupported = "acp-omp does not support manual compaction";
  async function throwingCompact(args: { threadId: string }, calls: string[]) {
    calls.push(args.threadId);
    throw new Error(unsupported);
  }

  it("compact_now reports unsupported instead of a raw error", async () => {
    const { harness, compactCalls } = await loadHost(
      10_000,
      200_000,
      throwingCompact,
    );
    const result = await harness.behavior.callRpc("compact_now", {
      threadId: THREAD_ID,
    });
    expect(result).toEqual({ result: `unsupported: ${unsupported}` });
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("auto checks go quiet after the first unsupported failure", async () => {
    const { harness, compactCalls } = await loadHost(
      190_000,
      200_000,
      throwingCompact,
    );
    const first = await harness.behavior.runCli(["check", THREAD_ID]);
    expect(first.stdout).toContain(
      "skipped: provider does not support compaction",
    );
    const second = await harness.behavior.runCli(["check", THREAD_ID]);
    expect(second.stdout).toContain(
      "skipped: provider does not support compaction",
    );
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("other compaction errors still surface as errors", async () => {
    const { harness } = await loadHost(10_000, 200_000, async () => {
      throw new Error("boom");
    });
    const result = await harness.behavior.callRpc("compact_now", {
      threadId: THREAD_ID,
    });
    expect(result).toEqual({ result: "error: boom" });
    await harness.lifecycle.dispose();
  });
});

describe("manual compaction", () => {
  it("compact_now RPC compacts regardless of threshold", async () => {
    const { harness, compactCalls } = await loadHost(10_000);
    const result = await harness.behavior.callRpc("compact_now", {
      threadId: THREAD_ID,
    });
    expect(result).toEqual({ result: "compacted" });
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("`now` CLI compacts a below-threshold thread on demand", async () => {
    const { harness, compactCalls } = await loadHost(10_000);
    const result = await harness.behavior.runCli(["now", THREAD_ID]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("compacted");
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("manual compaction starts a fresh auto-compact cooldown", async () => {
    const { harness, compactCalls } = await loadHost(190_000);
    await harness.behavior.runCli(["now", THREAD_ID]);
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });
});

describe("auto-compact CLI", () => {
  it("check compacts an over-threshold thread on demand", async () => {
    const { harness, compactCalls } = await loadHost(180_000);
    const result = await harness.behavior.runCli(["check", THREAD_ID]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("compacted");
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("status reports settings", async () => {
    const { harness } = await loadHost(0);
    const result = await harness.behavior.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      enabled: true,
      thresholdPercent: 80,
    });
    await harness.lifecycle.dispose();
  });
});

describe("threshold settings", () => {
  it("preserves stored configuration from the previous version", async () => {
    const { harness } = await loadHost(0, 200_000, undefined, "codex", {
      enabled: false,
      thresholdPercent: "90",
    });
    const status = await harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      enabled: false,
      thresholdPercent: 90,
      providerThresholds: { "claude-code": null, codex: null, pi: null },
    });
    await harness.lifecycle.dispose();
  });

  it("applies an override to automatic idle checks", async () => {
    const { harness, compactCalls } = await loadHost(10_000);
    await harness.behavior.setSettings({ codexThresholdPercent: "5" });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID, providerId: "codex" }),
      lastAssistantText: "done",
    });
    await waitFor(() => compactCalls.length === 1);
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it("does not compact when the provider lookup fails", async () => {
    const { harness, compactCalls } = await loadHost(190_000);
    await harness.behavior.setSettings({ codexThresholdPercent: "5" });
    harness.inspection.sdk.stub("threads.get", async () => {
      throw new Error("thread unavailable");
    });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await waitFor(() =>
      harness.inspection.logEntries.some((entry) =>
        entry.message.includes("thread unavailable"),
      ),
    );
    expect(compactCalls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it.each([5, 70, 75, 80, 85, 90, 95])(
    "compacts exactly at %s%%",
    async (threshold) => {
      const { harness, compactCalls } = await loadHost(threshold * 2_000);
      await harness.behavior.setSettings({
        thresholdPercent: String(threshold),
      });
      const result = await harness.behavior.runCli(["check", THREAD_ID]);
      expect(result.stdout).toContain("compacted at");
      expect(compactCalls).toEqual([THREAD_ID]);
      await harness.lifecycle.dispose();
    },
  );

  it.each([5, 95])("leaves usage just below %s%% alone", async (threshold) => {
    const { harness, compactCalls } = await loadHost(threshold * 2_000 - 1);
    await harness.behavior.setSettings({ thresholdPercent: String(threshold) });
    await harness.behavior.runCli(["check", THREAD_ID]);
    expect(compactCalls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it.each(["0", "4", "6", "96", "100", "NaN", "80%", ""])(
    "rejects invalid global threshold %j",
    async (threshold) => {
      const { harness } = await loadHost(0);
      await expect(
        harness.behavior.setSettings({ thresholdPercent: threshold }),
      ).rejects.toThrow();
      await harness.lifecycle.dispose();
    },
  );

  it.each([
    ["codex", "codexThresholdPercent"],
    ["claude-code", "claudeCodeThresholdPercent"],
    ["pi", "piThresholdPercent"],
  ])(
    "uses the %s override for checks and display",
    async (providerId, settingKey) => {
      const { harness, compactCalls } = await loadHost(
        10_000,
        200_000,
        undefined,
        providerId,
      );
      await harness.behavior.setSettings({ [settingKey]: "5" });
      expect(
        await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
      ).toMatchObject({ thresholdPercent: 5 });
      await harness.behavior.runCli(["check", THREAD_ID]);
      expect(compactCalls).toEqual([THREAD_ID]);
      await harness.lifecycle.dispose();
    },
  );

  it("a higher override suppresses global compaction", async () => {
    const { harness, compactCalls } = await loadHost(170_000);
    await harness.behavior.setSettings({
      thresholdPercent: "5",
      codexThresholdPercent: "95",
    });
    await harness.behavior.runCli(["check", THREAD_ID]);
    expect(compactCalls).toEqual([]);
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ thresholdPercent: 95 });
    await harness.lifecycle.dispose();
  });

  it("Use global follows changes and restores inheritance after an override", async () => {
    const { harness } = await loadHost(0);
    await harness.behavior.setSettings({ thresholdPercent: "5" });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ thresholdPercent: 5 });
    await harness.behavior.setSettings({
      codexThresholdPercent: "95",
      thresholdPercent: "70",
    });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ thresholdPercent: 95 });
    await harness.behavior.setSettings({ codexThresholdPercent: "Use global" });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ thresholdPercent: 70 });
    await harness.lifecycle.dispose();
  });

  it.each(["acp-custom", "constructor"])(
    "%s inherits global even when an override exists",
    async (providerId) => {
      const { harness, compactCalls } = await loadHost(
        10_000,
        200_000,
        undefined,
        providerId,
      );
      await harness.behavior.setSettings({
        thresholdPercent: "5",
        codexThresholdPercent: "95",
      });
      expect(
        await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
      ).toMatchObject({ thresholdPercent: 5 });
      await harness.behavior.runCli(["check", THREAD_ID]);
      expect(compactCalls).toEqual([THREAD_ID]);
      await harness.lifecycle.dispose();
    },
  );

  it.each([
    "codexThresholdPercent",
    "claudeCodeThresholdPercent",
    "piThresholdPercent",
  ])("rejects invalid %s", async (settingKey) => {
    const { harness } = await loadHost(0);
    await expect(
      harness.behavior.setSettings({ [settingKey]: "100" }),
    ).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("status includes overrides while preserving its global threshold", async () => {
    const { harness } = await loadHost(0);
    await harness.behavior.setSettings({ codexThresholdPercent: "5" });
    const result = await harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      thresholdPercent: 80,
      providerThresholds: { "claude-code": null, codex: 5, pi: null },
    });
    await harness.lifecycle.dispose();
  });
});

describe("provider auto-compaction modes", () => {
  it("retains an independent threshold while Off and uses it after switching On", async () => {
    const { harness, compactCalls } = await loadHost(40_000);
    await harness.behavior.setSettings({
      codexEnabled: "Off",
      codexThresholdPercent: "20",
    });
    await harness.behavior.runCli(["check", THREAD_ID]);
    expect(compactCalls).toEqual([]);
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ enabled: false, thresholdPercent: 20 });
    await harness.behavior.setSettings({ codexEnabled: "On" });
    await harness.behavior.runCli(["check", THREAD_ID]);
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });
  it.each([
    ["claude-code", "claudeCodeEnabled"],
    ["codex", "codexEnabled"],
    ["pi", "piEnabled"],
  ])(
    "%s Off suppresses compaction above its threshold",
    async (providerId, settingKey) => {
      const { harness, compactCalls } = await loadHost(
        190_000,
        200_000,
        undefined,
        providerId,
      );
      await harness.behavior.setSettings({ [settingKey]: "Off" });
      const result = await harness.behavior.runCli(["check", THREAD_ID]);
      expect(result.stdout).toContain("auto-compact is disabled");
      expect(compactCalls).toEqual([]);
      expect(
        await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
      ).toMatchObject({ enabled: false, thresholdPercent: 80 });
      await harness.lifecycle.dispose();
    },
  );

  it.each([
    ["claude-code", "claudeCodeEnabled"],
    ["codex", "codexEnabled"],
    ["pi", "piEnabled"],
  ])(
    "%s On overrides a disabled global default",
    async (providerId, settingKey) => {
      const { harness, compactCalls } = await loadHost(
        160_000,
        200_000,
        undefined,
        providerId,
      );
      await harness.behavior.setSettings({
        enabled: false,
        [settingKey]: "On",
      });
      await harness.behavior.runCli(["check", THREAD_ID]);
      expect(compactCalls).toEqual([THREAD_ID]);
      expect(
        await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
      ).toMatchObject({ enabled: true, thresholdPercent: 80 });
      await harness.lifecycle.dispose();
    },
  );

  it("mode inheritance follows global changes and can be restored", async () => {
    const { harness } = await loadHost(0);
    await harness.behavior.setSettings({ enabled: false });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ enabled: false });
    await harness.behavior.setSettings({ codexEnabled: "On" });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ enabled: true });
    await harness.behavior.setSettings({ codexEnabled: "Use global" });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ enabled: false });
    await harness.behavior.setSettings({ enabled: true });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ enabled: true });
    await harness.lifecycle.dispose();
  });

  it("enables Claude at 20% of 1M while leaving Codex to native compaction", async () => {
    for (const providerId of ["claude-code", "codex"]) {
      const { harness, compactCalls } = await loadHost(
        200_000,
        1_000_000,
        undefined,
        providerId,
      );
      await harness.behavior.setSettings({
        enabled: false,
        claudeCodeEnabled: "On",
        claudeCodeThresholdPercent: "20",
        codexEnabled: "Off",
      });
      await harness.behavior.runCli(["check", THREAD_ID]);
      expect(compactCalls).toEqual(
        providerId === "claude-code" ? [THREAD_ID] : [],
      );
      await harness.lifecycle.dispose();
    }
  });

  it("Off applies to failed events and manual compaction remains available", async () => {
    const { harness, compactCalls } = await loadHost(190_000);
    await harness.behavior.setSettings({ codexEnabled: "Off" });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      error: "context exceeded",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(compactCalls).toEqual([]);
    expect(
      await harness.behavior.callRpc("compact_now", { threadId: THREAD_ID }),
    ).toEqual({ result: "compacted" });
    expect(compactCalls).toEqual([THREAD_ID]);
    await harness.lifecycle.dispose();
  });

  it.each(["acp-custom", "constructor"])(
    "%s inherits global mode despite another provider's On override",
    async (providerId) => {
      const { harness, compactCalls } = await loadHost(
        190_000,
        200_000,
        undefined,
        providerId,
      );
      await harness.behavior.setSettings({
        enabled: false,
        claudeCodeEnabled: "On",
      });
      await harness.behavior.runCli(["check", THREAD_ID]);
      expect(compactCalls).toEqual([]);
      expect(
        await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
      ).toMatchObject({ enabled: false });
      await harness.lifecycle.dispose();
    },
  );

  it.each(["claudeCodeEnabled", "codexEnabled", "piEnabled"])(
    "rejects invalid %s",
    async (settingKey) => {
      const { harness } = await loadHost(0);
      await expect(
        harness.behavior.setSettings({ [settingKey]: "sometimes" }),
      ).rejects.toThrow();
      await harness.behavior.setSettings({ [settingKey]: "Use global" });
      await harness.lifecycle.dispose();
    },
  );

  it("status reports mode overrides and inherited defaults", async () => {
    const { harness } = await loadHost(0);
    await harness.behavior.setSettings({
      enabled: false,
      claudeCodeEnabled: "On",
      codexEnabled: "Off",
    });
    const result = await harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      enabled: false,
      providerEnabledOverrides: { "claude-code": true, codex: false, pi: null },
    });
    const text = await harness.behavior.runCli(["status"]);
    expect(text.stdout).toContain("claude-code: On");
    expect(text.stdout).toContain("codex: Off");
    expect(text.stdout).toContain("pi: Use global (Off)");
    await harness.lifecycle.dispose();
  });
});

describe("settings editor RPC", () => {
  it("persists a partial edit without resetting other settings", async () => {
    const { harness } = await loadHost(40_000, 200_000, undefined, "codex", {
      enabled: false,
      thresholdPercent: "95",
      claudeCodeEnabled: "On",
    });
    await harness.behavior.callRpc("save_settings", {
      codexEnabled: "On",
      codexThresholdPercent: "20",
    });
    expect(
      await harness.behavior.callRpc("usage", { threadId: THREAD_ID }),
    ).toMatchObject({ enabled: true, thresholdPercent: 20 });
    const status = JSON.parse(
      (await harness.behavior.runCli(["status", "--json"])).stdout,
    );
    expect(status).toMatchObject({
      enabled: false,
      thresholdPercent: 95,
      providerEnabledOverrides: { "claude-code": true, codex: true },
    });
    await harness.lifecycle.dispose();
  });

  it.each([
    { thresholdPercent: "0" },
    { codexThresholdPercent: "100" },
    { piEnabled: "maybe" },
    { unknown: true },
    {},
    { enabled: "false" },
  ])("rejects invalid edits atomically: %j", async (input) => {
    const { harness } = await loadHost(0);
    await expect(
      harness.behavior.callRpc("save_settings", input),
    ).rejects.toThrow();
    expect(
      JSON.parse((await harness.behavior.runCli(["status", "--json"])).stdout),
    ).toMatchObject({ enabled: true, thresholdPercent: 80 });
    await harness.lifecycle.dispose();
  });
});
