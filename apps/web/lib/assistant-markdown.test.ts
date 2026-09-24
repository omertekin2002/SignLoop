import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeAssistantMarkdown } from "./assistant-markdown";

function render(markdown: string) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  }, normalizeAssistantMarkdown(markdown)));
}

describe("assistant markdown", () => {
  it("keeps bracketed legal references and dates as ordinary prose", () => {
    const text = "See [Section 12], [Buyer/Seller], and [2026-09-23].";
    expect(normalizeAssistantMarkdown(text)).toBe(text);
    expect(render(text)).not.toContain('class="katex');
    expect(render(text)).toContain("[Section 12]");
  });

  it("renders explicit dollar and LaTeX math while preserving prose line breaks", () => {
    const text = String.raw`Inline \(x + y\), existing $z^2$,<br>and display \[x^2 + y^2\].`;
    const normalized = normalizeAssistantMarkdown(text);
    expect(normalized).toContain("Inline $x + y$, existing $z^2$,\nand display \n$$\nx^2 + y^2\n$$\n.");
    expect(render(text)).toContain('class="katex');
    expect(render(text)).toContain('class="katex-display');
  });

  it.each([
    "```html\n<br>\\(x + y\\)\n```",
    "~~~html\n<br>\\[x + y\\]\n~~~",
    "    <br>\\(x + y\\)\n",
    "> ```html\n> <br>\\(x + y\\)\n> ```",
    "- ~~~html\n  <br>\\(x + y\\)\n  ~~~",
    "```html\n<br>\\(x + y\\)",
  ])("preserves fenced, indented, nested and unfinished code: %s", (text) => {
    expect(normalizeAssistantMarkdown(text)).toBe(text);
  });

  it("keeps several code spans literal, including nested backticks and multiline spans", () => {
    const text = "`\\(a\\)` and ``one ` <br> \\[b\\]`` then `line one\n\\(c\\)` followed by \\(d\\).";
    expect(normalizeAssistantMarkdown(text)).toBe(
      "`\\(a\\)` and ``one ` <br> \\[b\\]`` then `line one\n\\(c\\)` followed by $d$.",
    );
    expect(render("`<br>`")).toContain("<code>&lt;br&gt;</code>");
  });

  it("does not pair a stray backtick across a fence or paragraph boundary", () => {
    const text = "Stray `\n\n\\(a\\)\n~~~\n`<br>\n~~~\n\\(b\\)";
    expect(normalizeAssistantMarkdown(text)).toBe("Stray `\n\n$a$\n~~~\n`<br>\n~~~\n$b$");
  });

  it("preserves an indented continuation inside a multiline code span", () => {
    const text = "`first\n    continuation\n\\(literal\\)\nlast` then \\(math\\)";
    expect(normalizeAssistantMarkdown(text)).toBe("`first\n    continuation\n\\(literal\\)\nlast` then $math$");
  });

  it("does not treat escaped backticks as code openers", () => {
    const text = "\\` literal then \\(a\\) and `code`";
    expect(normalizeAssistantMarkdown(text)).toBe("\\` literal then $a$ and `code`");
  });
});
