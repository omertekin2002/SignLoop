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
`../upload-pipeline.test.ts` expect page 2 to be flagged as having little or
no selectable text and the other pages' text to be kept exactly. The raster is
below OCR's minimum size, so the page is not OCR'd.
`.gitattributes` marks the PDF and PNG fixtures binary, since line-ending
conversion would break the PDF's cross-reference offsets.

## PDF with a short cover page

`pdf-short-cover-page.pdf` is a generated three-page PDF 1.4 file in the same
form (US Letter, Helvetica with WinAnsiEncoding, uncompressed streams, no
metadata, document ID or images). Page 1 is an ordinary exhibit cover carrying
only `EXHIBIT A`; page 2 holds `SCHEDULE OF SERVICES` and clauses 1–2, and page
3 clauses 3–4, all as selectable text (12 pt; the cover line starts at (270, 400),
the clause pages at (72, 720) with 16 pt leading). A short Python script wrote each
object, the cross-reference table and the trailer directly; it is not kept.
The tests expect page 1 to be flagged as sparse while `EXHIBIT A` stays in the
extracted text, and the stored upload warning to say that text is included
rather than that the page was not read.

## PDF with a raster page of text

`pdf-ocr-raster-page.pdf` is a one-page US Letter PDF 1.7 file whose page is a
single 1275×1650 8-bit grayscale raster (150 dpi) drawn over the whole page,
with no text layer, metadata or document ID. The raster is white with
`ocr-notice-terms.png` pasted at (150, 150), made with Pillow 12.1.1; pdf-lib
1.17.1 embedded it (`PDFDocument.create({ updateMetadata: false })`, `embedPng`,
`drawImage`, saved with `useObjectStreams: false`). The intermediate PNG and the
scripts are not kept. `../pdf-extraction.integration.test.ts` and
`../upload-pipeline.test.ts` expect OCR to read the page as
`Termination fee: 250 USD Notice period: 30 days` and report it as OCR'd, not
sparse. The integration test also copies the page between two text pages and
thresholds the raster to a 1-bit image, to check reading order and
black-and-white scans.

```sh
bun --no-env-file run test lib/image-extraction.integration.test.ts lib/pdf-extraction.integration.test.ts
```
