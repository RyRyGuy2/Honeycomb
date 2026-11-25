import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = new URL("../../src/renderer/", import.meta.url);
const destination = new URL("../renderer/", import.meta.url);
await mkdir(destination, { recursive: true });

await Promise.all([
  // Bundle the React renderer into the single app.js the main process serves.
  build({
    entryPoints: [fileURLToPath(new URL("main.tsx", source))],
    outfile: fileURLToPath(new URL("app.js", destination)),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome140",
    jsx: "automatic",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  }),
  ...["index.html", "styles.css"].map((file) =>
    copyFile(new URL(file, source), new URL(file, destination))),
  copyFile(new URL("../../honeycomb-logo.svg", import.meta.url),
    new URL("honeycomb-logo.svg", destination)),
  copyFile(new URL("../../src/main/honeycomb-icon.png", import.meta.url),
    new URL("../main/honeycomb-icon.png", import.meta.url)),
  copyFile(new URL("../../node_modules/markdown-it/dist/markdown-it.min.js", import.meta.url),
    new URL("markdown-it.js", destination)),
]);
