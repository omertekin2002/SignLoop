import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ExtractionLimitError, processValidatedFile } from "./text-extraction";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// These tiny synthetic OOXML archives exercise the installed Word parser, including the
// separate document parts that MIME/signature mocks cannot verify. No customer data is used.
const fixture = (name: string) =>
  readFile(new URL(`./fixtures/${name}.docx`, import.meta.url));

describe("real Word extraction", () => {
  it("retains notes, body textboxes and header/footer text as labeled document sections", async () => {
    const source = await fixture("word-semantic-parts");
    const original = Buffer.from(source);
    const result = await processValidatedFile(source, DOCX_MIME);

    expect(result).toEqual({
      text: [
        "Standard payment terms apply.",
        "[Footnotes]\nBuyer owes a 50 percent termination fee.",
        "[Endnotes]\nRenewal requires written approval.",
        "[Body textboxes]\nLiability is capped at the annual contract value.",
        "[Headers and footers]\nSchedule A: supplier obligations\n\nGoverning law: England and Wales",
        "[Header and footer textboxes]\nHeader exception: delivery insurance is required.",
      ].join("\n\n"),
      method: "word_parse",
      confidence: 100,
    });
    expect(result.text).not.toContain("EDITORIAL COMMENT");
    expect(source.equals(original)).toBe(true);
  });

  it("keeps body-only documents free of empty section labels", async () => {
    const result = await processValidatedFile(
      await fixture("word-body-only"),
      DOCX_MIME,
    );
    expect(result.text).toBe("Only the agreed body terms.");
  });

  it("applies the text budget to combined parts and their section labels", async () => {
    // Body and footnote are each 1M characters. The archive is well below the upload/ZIP caps,
    // but labels and separators push the combined extracted text above the 2M-character bound.
    await expect(
      processValidatedFile(await fixture("word-combined-limit"), DOCX_MIME),
    ).rejects.toBeInstanceOf(ExtractionLimitError);
  });
});
