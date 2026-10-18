# Synthetic extraction fixtures

These small files contain no user documents. Tests read them with the real
installed parsers rather than mocks.

## Word

These DOCX archives are consumed by `../word-extraction.integration.test.ts`
using the real installed Word parser.

- `word-semantic-parts.docx` contains a payment clause in the body, a termination
  fee in a footnote, renewal terms in an endnote, and a liability cap in a body
  textbox. Its header/footer and header textbox contain separate clauses. An
  editorial comment is deliberately excluded from extracted contract text.
- `word-body-only.docx` contains only `Only the agreed body terms.` and verifies
  that empty supplementary parts do not add labels.
- `word-combined-limit.docx` contains 1,000,000 ASCII `a` characters in the body
  and 1,000,000 ASCII `b` characters in a footnote. Each part is individually
  below the text limit; combined section labels and separators exceed it.
  Compression keeps the fixture small, and expanded XML stays below 16 MiB.

The archives use ordinary OOXML parts (`[Content_Types].xml`, package/document
relationships, `word/document.xml`, and the named supplementary parts), deflate
compression, and fixed ZIP entry timestamps of 2026-01-01. Textboxes use the VML
`w:pict/v:shape/v:textbox/w:txbxContent` representation supported by the parser.
Footnote/endnote references use ID 1. The document references the header/footer
parts through `w:sectPr`. Test expectations record the exact substantive text.

Reproduce the extraction and limit checks from `apps/web`:

```sh
bun --no-env-file run test lib/word-extraction.integration.test.ts
```

The tests also assert that parsing leaves original bytes unchanged, preserving
the upload pipeline's subsequent storage operation.

## Image OCR

`ocr-notice-terms.png` is a 520×130 8-bit grayscale PNG with two lines of black
text on white: `Termination fee: 250 USD` and `Notice period: 30 days`. It was
drawn with Pillow 12.1.1 in DejaVu Sans at 32 px (left margin 24 px, lines at
y = 20 and 68 px) and saved with `optimize=True`. The font is only rasterized;
no font file is distributed. `../image-extraction.integration.test.ts` runs the
installed tesseract.js worker, WebAssembly core and the bundled
`@tesseract.js-data/eng` model on it, without network access.

## PDF with a scanned page

`pdf-scanned-middle-page.pdf` is a hand-assembled three-page PDF 1.4 file
(US Letter, uncompressed streams, no metadata or document ID). Pages 1 and 3
have a text layer in the standard Helvetica font with WinAnsiEncoding: an
agreement title and clauses 1–2, then clauses 3–4. Page 2 stands in for a
scanned signature page: it paints one 8×8 DeviceGray raster and has no text
operators. `../pdf-extraction.integration.test.ts` and
`../upload-pipeline.test.ts` expect page 2 to be reported as unread and the
other pages' text to be kept exactly. `.gitattributes` marks both files binary,
since line-ending conversion would break the PDF's cross-reference offsets.

```sh
bun --no-env-file run test lib/image-extraction.integration.test.ts lib/pdf-extraction.integration.test.ts
```
