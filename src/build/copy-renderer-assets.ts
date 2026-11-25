import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("../../src/renderer/", import.meta.url);
const destination = new URL("../renderer/", import.meta.url);

await Promise.all([
  ...["index.html", "styles.css"].map((file) =>
    copyFile(new URL(file, source), new URL(file, destination))),
  copyFile(new URL("../../honeycomb-logo.svg", import.meta.url),
    new URL("honeycomb-logo.svg", destination)),
  copyFile(new URL("../../src/main/honeycomb-icon.png", import.meta.url),
    new URL("../main/honeycomb-icon.png", import.meta.url)),
  copyFile(new URL("../../node_modules/markdown-it/dist/markdown-it.min.js", import.meta.url),
    new URL("markdown-it.js", destination)),
]);

if (process.platform === "win32") {
  const framework = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
  const output = fileURLToPath(new URL("../providers/windows-copilot.exe", import.meta.url));
  const source = fileURLToPath(new URL("../../src/providers/windows-copilot.cs", import.meta.url));
  execFileSync(join(framework, "csc.exe"), [
    "/nologo", "/target:exe", `/out:${output}`,
    `/reference:${join(framework, "WPF", "UIAutomationClient.dll")}`,
    `/reference:${join(framework, "WPF", "UIAutomationTypes.dll")}`,
    `/reference:${join(framework, "WPF", "WindowsBase.dll")}`, source,
  ], { windowsHide: true, stdio: "inherit" });
}
