import { copyFile } from "node:fs/promises";

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
