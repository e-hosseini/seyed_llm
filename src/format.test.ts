import { describe, expect, it } from "vitest";
import { mdToTelegramHtml, splitText } from "./format.js";

describe("mdToTelegramHtml", () => {
  it("escapes html and converts bold, inline code and links", () => {
    expect(mdToTelegramHtml("a <b> **bold** `x<y` [l](https://e.com)")).toBe(
      'a &lt;b&gt; <b>bold</b> <code>x&lt;y</code> <a href="https://e.com">l</a>',
    );
  });

  it("renders fenced code, including an unclosed fence while streaming", () => {
    expect(mdToTelegramHtml("hi\n```js\nlet a = 1 < 2\n```\nbye")).toBe(
      'hi\n<pre><code class="language-js">let a = 1 &lt; 2</code></pre>\nbye',
    );
    expect(mdToTelegramHtml("```\nopen")).toBe("<pre><code>open</code></pre>");
  });

  it("does not format markdown inside code spans", () => {
    expect(mdToTelegramHtml("`**no**`")).toBe("<code>**no**</code>");
  });
});

describe("splitText", () => {
  it("keeps short text whole and splits long text on newlines under the cap", () => {
    expect(splitText("short")).toEqual(["short"]);
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const parts = splitText(long, 500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join("\n")).toBe(long);
  });
});
