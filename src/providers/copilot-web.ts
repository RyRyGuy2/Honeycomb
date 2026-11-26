import { BrowserWindow, session } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import type { Run } from "../shared/contracts.js";
import { followUpPrompt } from "../shared/conversations.js";
import { copilotPage } from "./copilot-web-page.js";
import type { CopilotPageAction, CopilotPageState } from "./copilot-web-page.js";
import type { ChatMessage } from "./http-chat.js";
import type { StreamEvent } from "./stream.js";

export const WEB_COPILOT_ID = "copilot-web";
export const WEB_COPILOT_NAME = "Copilot Web";
const HOME = "https://copilot.com/";
const PARTITION = "persist:honeycomb-copilot-web";
const COPILOT_HOSTS = new Set(["copilot.com", "www.copilot.com", "copilot.cloud.microsoft", "m365.cloud.microsoft"]);
const SIGN_IN_HOSTS = new Set(["login.live.com", "account.live.com", "login.microsoftonline.com", "login.microsoft.com", "account.microsoft.com"]);
const SIGN_IN = "Sign in to Copilot Web from Connectors, then try again.";

function site(value: string) {
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password && !url.port ? url : undefined;
}

function isCopilot(value: string) {
  const url = site(value);
  return Boolean(url && COPILOT_HOSTS.has(url.hostname));
}

function canNavigate(value: string) {
  const url = site(value);
  return Boolean(url && (COPILOT_HOSTS.has(url.hostname) || SIGN_IN_HOSTS.has(url.hostname)));
}

export function copilotWebThread(value: string) {
  const url = site(value);
  if (!url || !COPILOT_HOSTS.has(url.hostname) ||
      !/\/(?:chats|chat\/conversation)\/[a-z\d_-]{8,128}\/?$/i.test(url.pathname)) return;
  if (url.hostname === "www.copilot.com") url.hostname = "copilot.com";
  return url.origin + url.pathname.replace(/\/$/, "");
}

export function createCopilotWeb() {
  let signingIn = false;
  let running = false;

  function makeWindow(signIn: boolean) {
    const partition = session.fromPartition(PARTITION);
    partition.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    partition.setPermissionCheckHandler(() => false);
    const preferences = {
      partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webviewTag: false, backgroundThrottling: false,
    };
    const window = new BrowserWindow({
      title: "Copilot Web sign-in", show: false, skipTaskbar: !signIn, focusable: signIn,
      width: 1040, height: 760, autoHideMenuBar: true, webPreferences: preferences,
    });

    function restrict(target: BrowserWindow, allowPopup: boolean) {
      target.webContents.on("will-navigate", (event) => {
        if (!canNavigate(event.url)) event.preventDefault();
      });
      target.webContents.on("will-redirect", (event) => {
        if (event.isMainFrame && !canNavigate(event.url)) event.preventDefault();
      });
      target.webContents.setWindowOpenHandler(({ url }) => allowPopup && (canNavigate(url) || url === "about:blank") ? {
        action: "allow",
        overrideBrowserWindowOptions: { parent: window, autoHideMenuBar: true, webPreferences: preferences },
      } : { action: "deny" });
      target.webContents.on("did-create-window", (child) => restrict(child, false));
    }
    restrict(window, signIn);
    return window;
  }

  async function page(window: BrowserWindow, action: CopilotPageAction = "inspect", draft = "") {
    if (!isCopilot(window.webContents.getURL())) return;
    try {
      return await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{
        code: `(${copilotPage.toString()})(${JSON.stringify(action)}, ${JSON.stringify(draft)})`,
      }]) as CopilotPageState;
    } catch {
      // A sign-in redirect or chat navigation can replace the document during a poll.
      return;
    }
  }

  async function load(window: BrowserWindow, url: string, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      await window.loadURL(url);
    } catch {
      signal.throwIfAborted();
      if (window.isDestroyed()) throw new Error("The Copilot browser window was closed.");
      if (!canNavigate(window.webContents.getURL())) throw new Error("Could not open Copilot Web. Check your network and try again.");
    }
  }

  function closeOnAbort(window: BrowserWindow, signal: AbortSignal) {
    const close = () => { if (!window.isDestroyed()) window.destroy(); };
    signal.addEventListener("abort", close, { once: true });
    return () => {
      signal.removeEventListener("abort", close);
      close();
    };
  }

  async function ready(window: BrowserWindow, signal: AbortSignal) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const state = await page(window);
      if (state?.ready && !state.signIn) return state;
      if (state?.signIn || SIGN_IN_HOSTS.has(site(window.webContents.getURL())?.hostname ?? "")) throw new Error(SIGN_IN);
      await delay(500, undefined, { signal });
    }
    throw new Error("Copilot Web's chat box was unavailable. Check the session using Sign in to Copilot.");
  }

  return {
    async signIn(signal: AbortSignal) {
      if (running) throw new Error("Stop the current Copilot Web response before signing in again.");
      if (signingIn) throw new Error("Copilot Web sign-in is already open.");
      signingIn = true;
      let close: (() => void) | undefined;
      try {
        const window = makeWindow(true);
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
        close = closeOnAbort(window, deadline);
        window.show();
        await load(window, HOME, deadline);
        while (!window.isDestroyed()) {
          const state = await page(window);
          if (state?.ready && !state.signIn && !window.webContents.isDestroyed()) {
            await window.webContents.session.cookies.flushStore();
            return;
          }
          await delay(400, undefined, { signal: deadline });
        }
        throw new Error("Copilot sign-in was closed before chat was ready.");
      } finally {
        close?.();
        signingIn = false;
      }
    },

    async stream(run: Run, messages: ChatMessage[], signal: AbortSignal, receive: (event: StreamEvent) => void) {
      if (signingIn) throw new Error("Finish signing in to Copilot Web before sending a message.");
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
      let close: (() => void) | undefined;
      running = true;
      try {
        const window = makeWindow(false);
        close = closeOnAbort(window, deadline);
        const thread = run.copilotWebThread && copilotWebThread(run.copilotWebThread);
        const currentThread = () => copilotWebThread(window.webContents.getURL());
        const prompt = !thread && messages.length > 1
          ? followUpPrompt(run.prompt, JSON.stringify(messages.slice(0, -1)))
          : run.prompt;
        await load(window, thread || HOME, deadline);
        let initial = await ready(window, deadline);
        if (thread && currentThread() !== thread) throw new Error("Copilot Web could not reopen this conversation.");
        if (!thread && (initial.users || initial.replies.length || currentThread())) {
          if (!(await page(window, "new"))?.acted) throw new Error("Copilot Web could not start a fresh conversation.");
          for (let attempt = 0; attempt < 20; attempt++) {
            await delay(250, undefined, { signal: deadline });
            const state = await page(window);
            if (state?.ready && !state.users && !state.replies.length && !currentThread()) {
              initial = state;
              break;
            }
          }
          if (initial.users || initial.replies.length || currentThread()) throw new Error("Copilot Web did not open a fresh conversation.");
        }
        if (initial.draft || initial.generating || !(await page(window, "focus"))?.acted) {
          throw new Error("Copilot Web's chat box was busy. Try again.");
        }
        await window.webContents.insertText(prompt);
        let submitted = false;
        for (let attempt = 0; attempt < 20 && !submitted; attempt++) {
          deadline.throwIfAborted();
          if (currentThread() !== (thread || undefined)) throw new Error("The Copilot conversation changed before sending.");
          const result = await page(window, "send", prompt);
          if (!result) throw new Error("The Copilot page changed while sending. Check the conversation before retrying.");
          submitted = result.acted;
          if (!submitted) await delay(150, undefined, { signal: deadline });
        }
        if (!submitted) throw new Error("Copilot Web could not submit the draft. Check the chat session in Connectors.");

        let reply = "";
        let stable = 0;
        let generated = false;
        let activeThread = thread || undefined;
        while (true) {
          await delay(250, undefined, { signal: deadline });
          const state = await page(window);
          if (!state) continue;
          const location = currentThread();
          if (activeThread && location && activeThread !== location) throw new Error("The Copilot conversation changed while replying.");
          if (location) activeThread = location;
          generated ||= state.generating;
          const latest = state.replies.at(-1);
          if (!latest?.text || (state.replies.length <= initial.replies.length &&
              (state.users <= initial.users || latest.text === initial.replies.at(-1)?.text))) continue;
          if (latest.text === reply) stable++;
          else {
            stable = 0;
            reply = latest.text;
            receive({ type: "message", id: WEB_COPILOT_ID, text: reply });
          }
          if (stable >= 2 && !state.generating && (latest.complete || generated)) {
            run.copilotWebThread = activeThread;
            return;
          }
        }
      } catch (error) {
        if (deadline.aborted && !signal.aborted) throw new Error("Copilot Web timed out. Check the conversation before retrying.");
        if (error instanceof Error && /execution context|object has been destroyed|render frame/i.test(error.message)) {
          throw new Error("Copilot Web's page closed or changed. Check the session in Connectors.");
        }
        throw error;
      } finally {
        close?.();
        running = false;
      }
    },
  };
}
