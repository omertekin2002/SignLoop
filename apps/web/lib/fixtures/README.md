# Synthetic Word extraction fixtures

These small DOCX archives contain no user documents. They are consumed by
`../word-extraction.integration.test.ts` using the real installed Word parser.

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
