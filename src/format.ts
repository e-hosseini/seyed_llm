export const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function inline(md: string): string {
  const codes: string[] = [];
  let s = md.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => {
    return `<a href="${url.replaceAll('"', "&quot;")}">${text}</a>`;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Converts the Markdown Claude tends to emit into Telegram's HTML subset. Always well-formed except for exotic nesting. */
export function mdToTelegramHtml(md: string): string {
  const out: string[] = [];
  let text: string[] = [];
  let code: string[] | null = null;
  let lang = "";

  const flushText = () => {
    if (text.length) out.push(inline(text.join("\n")));
    text = [];
  };
  const flushCode = () => {
    const cls = /^[\w+-]+$/.test(lang) ? ` class="language-${lang}"` : "";
    out.push(`<pre><code${cls}>${escapeHtml((code ?? []).join("\n"))}</code></pre>`);
    code = null;
    lang = "";
  };

  for (const line of md.split("\n")) {
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      if (code === null) {
        flushText();
        code = [];
        lang = fence[1];
      } else {
        flushCode();
      }
    } else if (code !== null) {
      code.push(line);
    } else {
      text.push(line);
    }
  }
  if (code !== null) flushCode(); // unclosed fence while streaming
  flushText();
  return out.join("\n");
}

/** Splits at newlines (then spaces) so each part stays under Telegram's 4096-character cap. */
export function splitText(text: string, max = 3500): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts;
}
