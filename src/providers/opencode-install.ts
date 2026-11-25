import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import extract from "extract-zip";

const VERSION = "1.19.6";
const RELEASE_URL = `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/`;
const MAX_DOWNLOAD = 128 * 1024 * 1024;

interface OpenCodeRelease {
  version: string;
  url: string;
  sha256: string;
  executable: string;
}

const assets: Partial<Record<string, readonly [string, string]>> = {
  "win32-x64": ["windows-x64-baseline.zip", "d4fc63f09bd14ee2308c05d34c231a8d09c3e945fd2e86ef4ea1a41b31dd1830"],
  "win32-arm64": ["windows-arm64.zip", "dc72cf0cc9d5b434607e83efc4d172b19020bbc749842681fa195a4c051a4deb"],
  "darwin-x64": ["darwin-x64-baseline.zip", "5f08d3f7d7555fdef8025f57aef89c5bc2448460827d4e225f815a308ce6976b"],
  "darwin-arm64": ["darwin-arm64.zip", "c0be3f34dde2fdcb31b25120f303c6ed5b69b828f16e5e0fbecff21a882adda1"],
};

export function openCodeRelease(platform = process.platform, arch = process.arch): OpenCodeRelease | undefined {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) return;
  const [file, sha256] = asset;
  return { version: VERSION, url: `${RELEASE_URL}opencode-${file}`, sha256, executable: platform === "win32" ? "opencode.exe" : "opencode" };
}

export function managedOpenCodePath(root: string, release = openCodeRelease()): string | undefined {
  return release && join(root, "connectors", "opencode", release.version, release.executable);
}

export async function installOpenCodeRelease(
  root: string,
  release: OpenCodeRelease,
  verifyExecutable: (file: string, version: string) => Promise<void>,
  download = fetch,
  signal?: AbortSignal,
) {
  const directory = resolve(root, "connectors", "opencode", release.version);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, ".download-"));
  try {
    const archive = join(staging, "opencode.zip");
    const deadline = AbortSignal.timeout(180_000);
    const response = await download(release.url, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      credentials: "omit",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`OpenCode download failed (HTTP ${response.status}).`);
    }

    const digest = createHash("sha256");
    let bytes = 0;
    await pipeline(response.body, async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > MAX_DOWNLOAD) throw new Error("The OpenCode archive exceeds the download limit.");
        digest.update(chunk);
        yield chunk;
      }
    }, createWriteStream(archive, { flags: "wx" }));

    if (digest.digest("hex") !== release.sha256) throw new Error("The OpenCode download failed its checksum check.");
    const extracted = join(staging, "extracted");
    await extract(archive, { dir: extracted });
    signal?.throwIfAborted();
    const file = join(extracted, release.executable);
    if (!(await stat(file)).isFile()) throw new Error("The OpenCode executable was missing from the download.");
    if (process.platform !== "win32") await chmod(file, 0o755);
    await verifyExecutable(file, release.version);
    await rename(file, join(directory, release.executable));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
