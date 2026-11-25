import type { ProviderId, RunUsage } from "../shared/contracts.js";

interface ProviderCommand {
  args: readonly string[];
  input: string;
  env?: NodeJS.ProcessEnv;
}

export type ProviderUsageEvent = { type: "usage" } & Partial<Record<keyof RunUsage, unknown>>;

interface ProviderUpdate {
  completed?: boolean;
  failed?: string;
  diagnostic?: string;
  event?: ProviderUsageEvent | { type: "message" | "tool_call" | "tool_result"; text: unknown };
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  npmLaunchers: ReadonlyArray<readonly string[]>;
  override: string;
  authEnvironment: readonly string[];
  probeEnvironment?: NodeJS.ProcessEnv;
  parseVersion(output: string): string | undefined;
  versionIssue?(version: string): string | undefined;
  command(prompt: string, model?: string, version?: string): ProviderCommand;
  decode(event: Record<string, unknown>): ProviderUpdate | undefined;
  diagnoseStderr?(stderr: string): string | undefined;
}
