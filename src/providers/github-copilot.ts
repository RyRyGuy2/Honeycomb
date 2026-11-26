import type { ProviderAdapter } from "./types.js";

const authTokens = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const options = [
  "--no-auto-update", "--silent", "--mode=interactive", "--no-custom-instructions",
  "--disable-builtin-mcps", "--no-ask-user", "--disallow-temp-dir", "--sync-session=off",
];

export const githubCopilot: ProviderAdapter = {
  id: "github-copilot",
  name: "GitHub Copilot CLI",
  executableName: "copilot",
  npmLaunchers: [["@github", "copilot", "npm-loader.js"]],
  override: "HONEYCOMB_GITHUB_COPILOT_PATH",
  authEnvironment: [...authTokens, "COPILOT_HOME", "COPILOT_GH_HOST", "GH_HOST"],
  secretEnvironment: authTokens,
  probeEnvironment: { COPILOT_AUTO_UPDATE: "false" },
  requiredHelpFlags: [...options.map((option) => option.replace(/=.*/, "")), "--available-tools", "--allow-tool", "--deny-tool"],
  parseVersion(output) {
    return output.match(/(?:^|\b)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\s|$)/i)?.[1];
  },
  command(prompt, model, _version, mode, effort) {
    const chat = mode === "chat";
    return {
      args: [...options, "--deny-tool=shell,write,url",
        ...(chat
          ? ["--available-tools=ask_user", "--deny-tool=read"]
          : ["--available-tools=view,grep,glob", "--allow-tool=read"]),
        ...(model ? ["--model=" + model] : []), ...(effort ? ["--effort=" + effort] : [])],
      input: (chat ? "Answer the following directly without tools.\n\n"
        : "Review the project and report your findings without changing files.\n\n") + prompt,
    };
  },
  decode() {
    // Silent text output is captured on process completion.
  },
  diagnoseStderr(stderr) {
    if (/no authentication information|authentication failed|not (?:logged|signed) in|\bcopilot login\b/i.test(stderr)) {
      return "Run copilot login in a terminal to sign in to GitHub Copilot, then try again.";
    }
  },
};
