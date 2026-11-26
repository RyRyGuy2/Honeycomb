export function copilotCodeBlock(text: string, language = "") {
  const fenceLength = [...text.matchAll(/`+/g)].reduce((longest, match) => Math.max(longest, match[0].length + 1), 3);
  const fence = "`".repeat(fenceLength);
  return `${fence}${/^[\w+#.-]*$/.test(language) ? language : ""}\n${text.replace(/\r\n/g, "\n").replace(/\n$/, "")}\n${fence}`;
}

export function copilotClipboardMarkdown(html: string) {
  if (!html || html.length > 2_000_000) return;
  const fragment = document.createElement("template");
  fragment.innerHTML = html;
  if (!fragment.content.querySelector("pre")) return;

  const blocks = /^(blockquote|div|h[1-6]|p|section|table|tr|ul|ol)$/i;
  function render(node: Node, code = false): string {
    if (node.nodeType === Node.TEXT_NODE) return code ? node.textContent ?? "" : (node.textContent ?? "").replace(/\s+/g, " ");
    if (!(node instanceof HTMLElement) || node.matches("script, style, head, button, [role='toolbar'], [aria-hidden='true']")) return "";
    if (node.matches("br")) return "\n";
    if (node.matches("pre")) {
      const source = node.querySelector("code") ?? node;
      const language = source.getAttribute("data-language") ?? node.getAttribute("data-language")
        ?? source.className.match(/(?:^|\s)language-([\w+#.-]+)/)?.[1];
      const text = [...source.childNodes].map((child) => render(child, true)).join("");
      return `\n\n${copilotCodeBlock(text, language)}\n\n`;
    }
    const content = [...node.childNodes].map((child) => render(child, code)).join("");
    if (!code && node.matches("li")) return `\n- ${content.trim()}`;
    return !code && blocks.test(node.tagName) ? `\n\n${content}\n\n` : content;
  }

  return [...fragment.content.childNodes].map((node) => render(node)).join("").trim();
}
