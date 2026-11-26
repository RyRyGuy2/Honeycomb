export type CopilotPageAction = "inspect" | "focus" | "send" | "new";

export interface CopilotPageState {
  ready: boolean;
  signIn: boolean;
  draft: string;
  acted: boolean;
  generating: boolean;
  users: number;
  replies: Array<{ text: string; complete: boolean }>;
}

// Serialized into the hidden window's isolated world. Use only the page's public controls.
export function copilotPage(action: CopilotPageAction, expectedDraft = ""): CopilotPageState {
  const controls = "button, [role='button'], a[href]";
  function visible(element: HTMLElement) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
  }
  function control(root: ParentNode, names: RegExp, testIDs: string[] = []) {
    return [...root.querySelectorAll<HTMLElement>(controls)].find((element) => visible(element) &&
      !element.matches(":disabled, [aria-disabled='true']") &&
      (testIDs.includes(element.dataset.testid ?? "") ||
       names.test(element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText.trim())));
  }
  function normalize(text: string) {
    return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
  }

  const composerSelector = [
    "textarea#userInput", "[data-testid='chat-input']", "[data-testid='chat-composer-input']",
    "[data-testid='composer-input']", "[contenteditable='true'][role='textbox']", "textarea[aria-label]", "textarea[placeholder]",
  ].join(",");
  const composer = [...document.querySelectorAll<HTMLElement>(composerSelector)].find((element) =>
    visible(element) && !element.matches(":disabled, [readonly], [aria-readonly='true']") &&
    (element.matches("textarea, [contenteditable='true']")) &&
    (element.matches("textarea#userInput, [data-testid]") ||
      /message copilot|ask (me )?anything|type a message/i.test(
        [element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.getAttribute("data-placeholder")].join(" "),
      )));
  const draft = normalize(composer instanceof HTMLTextAreaElement ? composer.value : composer?.innerText ?? "");
  const composerArea = composer?.closest("form") ?? composer?.closest("[data-testid='chat-composer']") ?? document;
  const send = control(composerArea, /^(send|submit)( (a )?(message|prompt))?$/i, ["send-button", "send-message-button"]);
  const stop = control(document, /^stop( (generating|response|responding))?$/i, ["stop-button", "stop-generation-button"]);
  const signIn = Boolean(control(document, /^(sign in|sign in to copilot|sign in with a different account)$/i));

  let acted = false;
  if (action === "focus" && composer && !draft) {
    composer.focus({ preventScroll: true });
    acted = document.activeElement === composer;
  }
  if (action === "send" && composer && send && draft && draft === normalize(expectedDraft)) {
    send.click();
    acted = true;
  }
  if (action === "new" && composer && !draft && !stop) {
    const button = control(document, /^(new chat|start a new chat|new conversation)$/i, ["new-chat-button"]) ??
      [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find((link) => visible(link) && link.origin === location.origin &&
        link.innerText.trim() === "New" && /\/(?:home|chat)\/?$/i.test(link.pathname));
    if (button) {
      button.click();
      acted = true;
    }
  }

  const assistantSelector = [
    "[data-message-author-role='assistant']", "[data-role='assistant']", "[data-testid='assistant-message']",
    "[data-testid='copilot-message']", "[id^='copilot-message-'][id$='-title']",
  ].join(",");
  const seen = new Set<HTMLElement>();
  for (const element of document.querySelectorAll<HTMLElement>(assistantSelector)) {
    const message = element.closest<HTMLElement>("article, [role='article']") ?? element;
    if (visible(message)) seen.add(message);
  }
  const replies = [...seen].map((message) => {
    const content = message.querySelector<HTMLElement>("[data-testid='message-content'], [data-message-content]") ?? message;
    const excluded = "button, [role='button'], [role='toolbar'], [aria-hidden='true'], [id$='-title']";
    const labels = new Set([...content.querySelectorAll<HTMLElement>(excluded)].map((element) => element.innerText.trim()).filter(Boolean));
    const text = content.innerText.split("\n").filter((line) => !labels.has(line.trim()))
      .join("\n").replace(/^\s*Copilot said:\s*/i, "").trim().slice(0, 1_000_000);
    return {
      text,
      complete: Boolean(control(message, /^copy( (response|reply|message))?$/i, ["copy-response", "copy-message-button"])),
    };
  });
  const users = document.querySelectorAll(
    "[data-message-author-role='user'], [data-role='user'], [data-testid='user-message'], [id^='user-message-'][id$='-title']",
  ).length;

  return { ready: Boolean(composer), signIn, draft, acted, generating: Boolean(stop), users, replies };
}
