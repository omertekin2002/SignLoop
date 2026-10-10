"use client";

import {
  memo,
  type ComponentPropsWithoutRef,
  useDeferredValue,
  useMemo,
} from "react";
import { Download } from "lucide-react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { marked } from "marked";
import { cn } from "@/lib/utils";
import { normalizeAssistantMarkdown } from "@/lib/assistant-markdown";
// Loaded with this lazy chunk, so the ~24KB stylesheet arrives only once assistant markdown renders.
import "katex/dist/katex.min.css";

function markdownUrlTransform(url: string): string {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(url)) {
    return url;
  }

  if (/^blob:/i.test(url)) {
    return url;
  }

  return defaultUrlTransform(url);
}

function inferImageExtension(src: string): string {
  const dataUriMatch = src.match(/^data:image\/([a-z0-9.+-]+);base64,/i);
  if (dataUriMatch?.[1]) {
    const raw = dataUriMatch[1].toLowerCase();
    if (raw === "jpeg") return "jpg";
    if (raw === "svg+xml") return "svg";
    return raw.replace(/[^a-z0-9]+/g, "");
  }

  try {
    const parsed = new URL(src);
    const fileName = parsed.pathname.split("/").pop() ?? "";
    const extensionMatch = fileName.match(/\.([a-z0-9]{2,5})$/i);
    if (extensionMatch?.[1]) {
      return extensionMatch[1].toLowerCase();
    }
  } catch {
    // ignore parse failures and fall back to png
  }

  return "png";
}

function makeDownloadFileName(src: string): string {
  const extension = inferImageExtension(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `signloop-image-${stamp}.${extension}`;
}

function clickDownloadAnchor(href: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function downloadImageFromSrc(src: string): Promise<void> {
  const fileName = makeDownloadFileName(src);

  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) {
    clickDownloadAnchor(src, fileName);
    return;
  }

  try {
    const response = await fetch(src);
    if (response.ok) {
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      clickDownloadAnchor(blobUrl, fileName);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      return;
    }
  } catch {
    // fall through to direct URL download
  }

  clickDownloadAnchor(src, fileName);
}

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & {
  src?: string | Blob;
  alt?: string;
};

const MarkdownImage = ({
  src,
  alt,
  className,
  // react-markdown passes the hast node down to custom components. Pull it out of the rest so it
  // isn't spread onto the real <img>, where React would serialize it as node="[object Object]".
  node: _node,
  ...props
}: MarkdownImageProps & { node?: unknown }) => {
  if (typeof src !== "string" || !src) {
    return null;
  }

  const isInlineImage =
    /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(src) ||
    /^blob:/i.test(src) ||
    /^\/api\/chat\/threads\/[a-f0-9-]{36}\/images\/[a-f0-9-]{36}$/.test(src);

  // Model-authored remote image URLs must not become automatic browser requests. A non-anchor
  // placeholder also stays valid when Markdown wraps the image in a link.
  if (!isInlineImage) {
    return (
      <span className="break-all text-sm text-muted-foreground">
        {alt?.trim() ? `Linked image (${alt.trim()}): ` : "Linked image: "}
        {src}
      </span>
    );
  }

  return (
    <span className="group relative my-4 block w-fit max-w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? "Generated image"}
        className={cn(
          "max-h-[32rem] w-auto max-w-full rounded-card border object-contain",
          className,
        )}
        {...props}
      />
      <button
        type="button"
        className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border bg-popover/90 text-foreground backdrop-blur transition-colors hover:bg-popover"
        onClick={() => {
          void downloadImageFromSrc(src);
        }}
        title="Download image"
        aria-label="Download image"
      >
        <Download className="h-4 w-4" />
      </button>
    </span>
  );
};

const markdownComponents: Components = {
  img: (props) => <MarkdownImage {...props} />,
};

// Hoisted so the plugin arrays keep a stable identity across every block render.
const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

// Split the accumulated markdown into top-level blocks (paragraphs, headings, fenced code,
// tables, whole lists, …). `marked.lexer` keeps each block's source in `token.raw`, and the
// raw strings of completed leading blocks stay byte-for-byte identical as more text streams
// in — only the trailing, still-growing block changes. That's what makes per-block memoization
// avoid the O(n²) re-parse of the whole string on every NDJSON delta.
//
// Tradeoff (inherent to block-level memoization): a reference-style link/footnote whose
// definition lands in a different block won't resolve, since each block is parsed in isolation.
// Chat models emit inline links, so this practically never bites; everything else — GFM tables,
// loose/ordered lists, fenced code with blank lines, KaTeX `$...$`/`$$...$$` — stays intact
// because the lexer never splits inside those constructs.
function parseMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) return [];
  // Reference definitions need one document scope (including GFM footnotes).
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(markdown)) return [markdown];

  try {
    // The lexer emits a `space` token for every blank line between blocks — roughly half of all
    // tokens. Each one would otherwise mount a full ReactMarkdown instance (remark-parse →
    // remark-gfm → remark-math → rehype-katex → rehype-react) to render nothing. Blocks are parsed
    // in isolation anyway, so dropping the blank ones changes no output.
    return marked
      .lexer(markdown)
      .map((token) => token.raw)
      .filter((raw) => raw.trim().length > 0);
  } catch {
    // The lexer is tolerant of partial markdown, but never let a hiccup break rendering.
    return [markdown];
  }
}

// One block of already-split markdown. Memoized on its raw source so a block only re-parses
// (remark/rehype/KaTeX) when its own text changes — settled blocks are skipped entirely.
const MarkdownBlock = memo(function MarkdownBlock({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={markdownUrlTransform}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
});

export default function ChatMarkdownBlocks({ markdown }: { markdown: string }) {
  // While streaming, `markdown` is the cumulative message text, so it changes on every delta and
  // this memo always misses — re-lexing the whole message (plus four full-string regex passes) per
  // token, which is O(n^2) over a turn. Deferring lets React skip intermediate parses under load
  // and keep the newest text; settled messages are unaffected because the value stops changing.
  const deferredMarkdown = useDeferredValue(markdown);
  const blocks = useMemo(
    () => parseMarkdownIntoBlocks(normalizeAssistantMarkdown(deferredMarkdown)),
    [deferredMarkdown],
  );

  return blocks.map((block, index) => (
    // Blocks are append-only while streaming (earlier blocks never reorder), so the index
    // is a stable key.
    <MarkdownBlock key={index} content={block} />
  ));
}
