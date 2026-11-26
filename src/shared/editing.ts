import { CLI_PROVIDER_IDS } from "./contracts.js";
import type { CliProviderId } from "./contracts.js";

export function isCliProvider(provider: unknown): provider is CliProviderId {
  return CLI_PROVIDER_IDS.some((id) => id === provider);
}

export function supportsWorktreeEditing(provider: unknown): provider is "codex" | "opencode" | "claude" {
  return provider === "codex" || provider === "opencode" || provider === "claude";
}

/** Only branches with this prefix were created by Honeycomb, and only they may be deleted. */
export const WORKTREE_BRANCH_PREFIX = "honeycomb/edit-";
