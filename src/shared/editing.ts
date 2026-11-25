export function supportsWorktreeEditing(provider: unknown) {
  return provider === "codex" || provider === "opencode" || provider === "claude";
}

/** Only branches with this prefix were created by Honeycomb, and only they may be deleted. */
export const WORKTREE_BRANCH_PREFIX = "honeycomb/edit-";
