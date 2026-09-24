function normalizeProse(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, value: string) => `\n$$\n${value.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, value: string) => `$${value.trim()}$`);
}

function normalizeOutsideCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)];
  // Link equal-length delimiters in one backward pass instead of rescanning the suffix
  // for every code span. A double-backtick span can contain a single literal backtick.
  const nextByLength = new Map<number, number>();
  const closingRuns: Array<number | undefined> = [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const length = runs[index]![0].length;
    closingRuns[index] = nextByLength.get(length);
    nextByLength.set(length, index);
  }
  let output = "";
  let cursor = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index]!;
    let escapes = 0;
    for (let pos = opening.index - 1; pos >= 0 && text[pos] === "\\"; pos -= 1) escapes += 1;
    if (escapes % 2) continue;
    const closingIndex = closingRuns[index];
    if (closingIndex === undefined) continue;
    const closing = runs[closingIndex]!;
    const end = closing.index + closing[0].length;
    output += normalizeProse(text.slice(cursor, opening.index));
    output += text.slice(opening.index, end);
    cursor = end;
    index = closingIndex;
  }
  return output + normalizeProse(text.slice(cursor));
}

/** Preserve code and legal placeholders while adapting explicit LaTeX delimiters. */
export function normalizeAssistantMarkdown(markdown: string): string {
  let output = "";
  let prose = "";
  const flushProse = () => {
    output += normalizeOutsideCodeSpans(prose);
    prose = "";
  };
  let fence: { marker: string; length: number } | null = null;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const withoutQuote = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const fenceMatch = withoutQuote.match(/^\s*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)/);
    if (fence) {
      output += line;
      if (fenceMatch && fenceMatch[1]![0] === fence.marker &&
          fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch && !(fenceMatch[1]![0] === "`" && fenceMatch[2]!.includes("`"))) {
      flushProse();
      output += line;
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    // Conservatively preserve indented code; never match inline spans across blank lines,
    // fences, headings or list-item boundaries into another Markdown block.
    if ((/^(?: {4}|\t)/.test(withoutQuote) && !prose) || !withoutQuote.trim()) {
      flushProse();
      output += line;
      continue;
    }
    if (/^ {0,3}#{1,6}[ \t]/.test(withoutQuote)) {
      flushProse();
      output += normalizeOutsideCodeSpans(line);
      continue;
    }
    if (/^ {0,3}(?:[-+*]|\d+[.)])[ \t]/.test(withoutQuote)) flushProse();
    prose += line;
  }
  flushProse();
  return output;
}
