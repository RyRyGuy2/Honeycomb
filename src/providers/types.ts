import type { CliProviderId, RunUsage } from "../shared/contracts.js";

interface ProviderCommand {
  args: readonly string[];
  input: string;
  env?: NodeJS.ProcessEnv;
}

export type ProviderUsageEvent = { type: "usage" } & Partial<Record<keyof RunUsage, unknown>>;

export type ProviderEvent = ProviderUsageEvent | { type: "message" | "tool_call" | "tool_result"; text: unknown };

interface ProviderUpdate {
  completed?: boolean;
  failed?: string;
  diagnostic?: string;
  event?: ProviderEvent;
  /** Additional events, in order, for providers that report several items in one line. */
  events?: ProviderEvent[];
}

export interface ProviderAdapter {
  id: CliProviderId;
  name: string;
  npmLaunchers: ReadonlyArray<readonly string[]>;
  override: string;
  authEnvironment: readonly string[];
  /** Environment values that must never appear in displayed errors. */
  secretEnvironment?: readonly string[];
  probeEnvironment?: NodeJS.ProcessEnv;
  /** Flags that `--help` must list before the connector is usable. */
  requiredHelpFlags?: readonly string[];
  helpIssue?: string;
  parseVersion(output: string): string | undefined;
  versionIssue?(version: string): string | undefined;
  command(prompt: string, model?: string, version?: string, mode?: "review" | "edit"): ProviderCommand;
  decode(event: Record<string, unknown>): ProviderUpdate | undefined;
  diagnoseStderr?(stderr: string): string | undefined;
}
