import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chatPresets, isChatPreset } from "../shared/chat-presets.js";
import type { ChatProfile } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";

interface StoredProfile extends Omit<ChatProfile, "hasApiKey"> {
  encryptedKey?: string;
}

export function parseChatModel(value: unknown) {
  if (typeof value !== "string" || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Enter a valid model ID.");
  }
  return value.trim();
}

export function parseChatBaseUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value.trim())) {
    throw new Error("Enter an HTTP or HTTPS API base URL.");
  }
  const url = URL.parse(value.trim());
  if (!url || url.username || url.password || url.search || url.hash || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("Enter an API base URL without credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

function publicProfile({ encryptedKey, ...profile }: StoredProfile): ChatProfile {
  return { ...profile, hasApiKey: Boolean(encryptedKey) };
}

export function createChatProfileStore(filename: () => string, secrets: { encrypt(value: string): string; decrypt(value: string): string }) {
  let profiles: StoredProfile[] = [];
  let pending = Promise.resolve();
  let unreadable = false;

  function requireProfile(id: unknown) {
    const profile = profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error("This chat connection is no longer saved.");
    return profile;
  }

  function update<T>(change: () => { next: StoredProfile[]; result: T }) {
    const job = pending.then(async () => {
      if (unreadable) throw new Error("Honeycomb could not read the saved connections file. Restore it before saving changes.");
      const { next, result } = change();
      const file = filename();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, profiles: next }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      profiles = next;
      return result;
    });
    pending = job.then(() => {}, () => {});
    return job;
  }

  return {
    async load() {
      const path = filename();
      try {
        const data = asRecord(JSON.parse(await readFile(path, "utf8")));
        if (data?.version !== 1 || !Array.isArray(data.profiles)) throw new Error("Invalid chat connection file.");
        profiles = data.profiles.map((entry: unknown): StoredProfile => {
          const profile = asRecord(entry);
          if (!profile || typeof profile.id !== "string" || !profile.id.startsWith("chat:") ||
              !isChatPreset(profile.preset) || typeof profile.name !== "string") {
            throw new Error("Invalid saved chat connection.");
          }
          return {
            id: profile.id as StoredProfile["id"], preset: profile.preset, name: profile.name,
            baseUrl: parseChatBaseUrl(profile.baseUrl), model: parseChatModel(profile.model),
            manualModel: parseChatModel(profile.manualModel ?? "") || undefined,
            encryptedKey: typeof profile.encryptedKey === "string" ? profile.encryptedKey : undefined,
          };
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          unreadable = true;
          throw error;
        }
      }
    },
    list: () => profiles.map(publicProfile),
    find(id: unknown) {
      const profile = profiles.find((entry) => entry.id === id);
      return profile && publicProfile(profile);
    },
    connection(id: unknown) {
      const profile = requireProfile(id);
      return { ...publicProfile(profile), apiKey: profile.encryptedKey ? secrets.decrypt(profile.encryptedKey) : undefined };
    },
    save(request: unknown) {
      return update(() => {
        const { id, preset, name, baseUrl: rawUrl, manualModel: rawModel, apiKey } = asRecord(request) ?? {};
        const current = id === undefined ? undefined : requireProfile(id);
        if (!isChatPreset(preset) || (current && current.preset !== preset)) throw new Error("Choose a chat connector.");
        if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
          throw new Error("Enter a connection name of up to 100 characters.");
        }
        const baseUrl = parseChatBaseUrl(rawUrl);
        const manualModel = parseChatModel(rawModel ?? "");
        if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 8192 || /[^\x21-\x7e]/.test(apiKey))) {
          throw new Error("Enter a valid API key.");
        }
        const keepKey = current?.baseUrl === baseUrl;
        if (!apiKey && chatPresets[preset].requiresKey && !(apiKey === undefined && keepKey && current?.encryptedKey)) {
          throw new Error(`Enter your ${chatPresets[preset].name} API key.`);
        }
        if (apiKey === undefined && current?.encryptedKey && !keepKey) {
          throw new Error("Enter a key for the new URL or clear the saved key.");
        }
        const priorModel = keepKey ? current?.model : undefined;
        const manualChanged = manualModel !== (current?.manualModel ?? "");
        const model = manualChanged ? (manualModel || (priorModel === current?.manualModel ? "" : priorModel)) : priorModel || manualModel;
        const profile: StoredProfile = {
          id: current?.id ?? `chat:${randomUUID()}`, preset, name: name.trim(), baseUrl,
          model: model ?? "",
          manualModel: manualModel || undefined,
          encryptedKey: apiKey === undefined ? current?.encryptedKey : apiKey ? secrets.encrypt(apiKey) : undefined,
        };
        return { next: current ? profiles.map((entry) => entry === current ? profile : entry) : [...profiles, profile], result: publicProfile(profile) };
      });
    },
    setModel(id: unknown, value: unknown) {
      return update(() => {
        const current = requireProfile(id);
        const model = parseChatModel(value);
        if (!model) throw new Error("Choose a model.");
        return { next: profiles.map((entry) => entry === current ? { ...entry, model } : entry), result: undefined };
      });
    },
    remove(id: unknown) {
      return update(() => {
        const current = requireProfile(id);
        return { next: profiles.filter((entry) => entry !== current), result: undefined };
      });
    },
  };
}
