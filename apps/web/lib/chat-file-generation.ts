import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  CHAT_FILE_TYPES,
  chatFileName,
  MAX_CHAT_GENERATED_FILE_BYTES,
  type ChatFileFormat,
  type ChatFileInfo,
} from "@/lib/chat-files-shared";

export type GeneratedChatFile = ChatFileInfo & { data: string; text: string };
// Resolved from the app root on Next/Vercel and from the workspace in tests.
const fontPath = path.join(process.cwd(), "lib/fonts/DejaVuSans.ttf");
let fontBytes: Promise<Buffer> | undefined;

type Block = { text: string; heading?: 1 | 2 | 3; bullet?: boolean };
function blocks(content: string): Block[] {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading)
        return { text: heading[2]!, heading: heading[1]!.length as 1 | 2 | 3 };
      const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
      return { text: bullet?.[1] ?? line, ...(bullet ? { bullet: true } : {}) };
    });
}

async function createPdf(content: string, title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await (fontBytes ??= readFile(fontPath)), {
    subset: true,
  });
  // Reject unavailable glyphs instead of silently generating missing-character boxes.
  const supported = new Set(font.getCharacterSet());
  for (const character of content.replace(/[\n\r\t]/g, "")) {
    if (!supported.has(character.codePointAt(0)!))
      throw new Error(
        "This PDF font cannot display part of the text. Create a DOCX or TXT file to preserve those characters.",
      );
  }
  let page = pdf.addPage([595.28, 841.89]);
  let y = 790;
  const width = 491;
  for (const block of blocks(content)) {
    const size = block.heading ? 22 - block.heading * 2 : 11;
    const height = size * 1.5;
    const lineText = `${block.bullet ? "• " : ""}${block.text}`.replace(
      /\t/g,
      "    ",
    );
    const lines: string[] = [];
    let line = "";
    for (const word of lineText.split(/(\s+)/)) {
      if (font.widthOfTextAtSize(line + word, size) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      // Long URLs/identifiers must wrap too.
      for (const character of word.trimStart()) {
        if (font.widthOfTextAtSize(line + character, size) > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    lines.push(line.trimEnd());
    for (const text of lines) {
      if (y - height < 50) {
        page = pdf.addPage([595.28, 841.89]);
        y = 790;
      }
      if (text)
        page.drawText(text, {
          x: 52,
          y,
          font,
          size,
          color: rgb(0.1, 0.1, 0.1),
        });
      y -= height;
    }
    if (block.heading) y -= 5;
  }
  return pdf.save();
}

export async function generateChatFile(input: {
  name: string;
  format: ChatFileFormat;
  content: string;
}): Promise<GeneratedChatFile> {
  const stem =
    chatFileName(input.name)
      .replace(/\.(pdf|txt|docx)$/i, "")
      .slice(0, 170) || "document";
  const name = `${stem}.${input.format}`;
  const content = input.content.replace(/\p{Cc}/gu, (character) =>
    "\r\n\t".includes(character) ? character : "",
  );
  if (!content.trim() || content.length > 60_000)
    throw new Error("Files must contain between 1 and 60,000 characters.");
  let data: Uint8Array;
  if (input.format === "txt") data = Buffer.from(content, "utf8");
  else if (input.format === "pdf") data = await createPdf(content, stem);
  else {
    const headings = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
    ];
    data = await Packer.toBuffer(
      new Document({
        title: stem,
        styles: {
          default: {
            document: { run: { font: "Arial", size: 22, color: "202020" } },
          },
        },
        sections: [
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1040, bottom: 1040, left: 1040, right: 1040 },
              },
            },
            children: blocks(content).map(
              (block) =>
                new Paragraph({
                  children: [
                    new TextRun({
                      text: block.text,
                      font: "Arial",
                      color: "202020",
                      size: block.heading ? 44 - block.heading * 4 : 22,
                      bold: Boolean(block.heading),
                    }),
                  ],
                  ...(block.heading
                    ? { heading: headings[block.heading - 1] }
                    : {}),
                  ...(block.bullet ? { bullet: { level: 0 } } : {}),
                  spacing: { after: 100 },
                }),
            ),
          },
        ],
      }),
    );
  }
  if (data.byteLength > MAX_CHAT_GENERATED_FILE_BYTES)
    throw new Error("The generated file exceeds the 1 MB limit.");
  return {
    id: randomUUID(),
    name,
    mediaType: CHAT_FILE_TYPES[input.format],
    size: data.byteLength,
    data: Buffer.from(data).toString("base64"),
    text: content,
  };
}
