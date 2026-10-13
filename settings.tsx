import { useEffect, useRef, useState } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

import { replaceNativeSettings } from "./settings-layout";

const THRESHOLDS = Array.from({ length: 19 }, (_, i) => String((i + 1) * 5));
const PROVIDERS = [
  {
    name: "Claude Code",
    mode: "claudeCodeEnabled",
    threshold: "claudeCodeThresholdPercent",
  },
  { name: "Codex", mode: "codexEnabled", threshold: "codexThresholdPercent" },
  { name: "Pi", mode: "piEnabled", threshold: "piThresholdPercent" },
] as const;

function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        aria-label={label}
        className="h-8 w-full min-w-0 gap-1 px-2 text-xs sm:text-sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CompactionSettings() {
  const settingsRef = useRef<HTMLDivElement>(null);
  const { values, isLoading } = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const [display, setDisplay] = useState(values);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDisplay(values), [values]);

  const settingsAvailable = Boolean(display);
  useEffect(() => {
    if (settingsAvailable && settingsRef.current) {
      return replaceNativeSettings(settingsRef.current);
    }
  }, [settingsAvailable]);

  async function save(change: Parameters<typeof rpc.call<"save_settings">>[1]) {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("save_settings", change);
      setDisplay(result.values);
    } catch (error) {
      setError(
        `Could not save: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  // Leave the native form available if settings cannot load.
  if (!display)
    return (
      <p className="text-sm text-muted-foreground">
        {isLoading
          ? "Loading settings…"
          : "Settings unavailable. Use the configuration above."}
      </p>
    );
  const globalMode = display.enabled === true ? "On" : "Off";
  const globalThreshold = String(display.thresholdPercent ?? "80");
  const percentages = THRESHOLDS.map((value) => ({
    value,
    label: `${value}%`,
  }));
  const modes = ["On", "Off"].map((value) => ({ value, label: value }));
  return (
    <div ref={settingsRef} data-auto-compact-settings="" className="space-y-3">
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table
          className="w-full table-fixed text-sm"
          aria-label="Auto-compaction policies"
        >
          <colgroup>
            <col className="w-[30%] sm:w-[38%]" />
            <col className="w-[35%] sm:w-[31%]" />
            <col className="w-[35%] sm:w-[31%]" />
          </colgroup>
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Provider
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                Mode
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                Threshold
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border bg-muted/20">
              <th
                scope="row"
                className="px-3 py-3 text-left text-xs font-medium sm:text-sm"
              >
                Global default
              </th>
              <td className="px-2 py-3">
                <Choice
                  label="Global default mode"
                  value={globalMode}
                  options={modes}
                  disabled={saving}
                  onChange={(value) => void save({ enabled: value === "On" })}
                />
              </td>
              <td className="px-2 py-3">
                <Choice
                  label="Global default threshold"
                  value={globalThreshold}
                  options={percentages}
                  disabled={saving}
                  onChange={(value) => void save({ thresholdPercent: value })}
                />
              </td>
            </tr>
            {PROVIDERS.map((provider) => (
              <tr key={provider.mode} className="border-t border-border">
                <th
                  scope="row"
                  className="px-3 py-3 text-left text-xs font-medium sm:text-sm"
                >
                  {provider.name}
                </th>
                <td className="px-2 py-3">
                  <Choice
                    label={`${provider.name} mode`}
                    value={String(display[provider.mode] ?? "Use global")}
                    options={[
                      { value: "Use global", label: `Default: ${globalMode}` },
                      ...modes,
                    ]}
                    disabled={saving}
                    onChange={(value) => void save({ [provider.mode]: value })}
                  />
                </td>
                <td className="px-2 py-3">
                  <Choice
                    label={`${provider.name} threshold`}
                    value={String(display[provider.threshold] ?? "Use global")}
                    options={[
                      {
                        value: "Use global",
                        label: `Default: ${globalThreshold}%`,
                      },
                      ...percentages,
                    ]}
                    disabled={saving}
                    onChange={(value) =>
                      void save({ [provider.threshold]: value })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Default follows the global row. Off leaves automatic compaction to the
        provider; manual compaction stays available.
      </p>
      <p className="text-xs text-muted-foreground">
        Threshold is a percentage of the model’s context window: 20% of 1M is
        about 200K tokens. Compaction runs after a turn, with a 15-minute
        cooldown.
      </p>
      <p
        aria-live="polite"
        className={
          error ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
      >
        {error ?? (saving ? "Saving…" : "Changes save automatically.")}
      </p>
    </div>
  );
}
