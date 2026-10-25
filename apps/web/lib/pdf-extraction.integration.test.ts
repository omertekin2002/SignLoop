import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFString, type PDFPage } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractTextFromPdf } from "./text-extraction";

// A tiny, one-page Quartz PDF. Keep this as bytes so the test exercises the real unpdf/PDF.js
// boundary rather than the mocked extraction guard suite.
const PDF_FIXTURE_BASE64 =
  "JVBERi0xLjMKJcTl8uXrp/Og0MTGCjMgMCBvYmoKPDwgL0ZpbHRlciAvRmxhdGVEZWNvZGUgL0xlbmd0aCAxMSA+PgpzdHJlYW0KeAErVAgEAAHnAOMKZW5kc3RyZWFtCmVuZG9iagoxIDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL1Jlc291cmNlcyA0IDAgUiAvQ29udGVudHMgMyAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1Byb2NTZXQgWyAvUERGIF0gPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9Db3VudCAxIC9LaWRzIFsgMSAwIFIgXSA+PgplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDcxMTE0MjExN1owMCcwMCcpIC9Qcm9kdWNlciAobWFjT1MgVmVyc2lvbiAyNi4zLjEgXChhXCkgXChCdWlsZCAyNUQ3NzEyODBhXCkgUXVhcnR6IFBERkNvbnRleHQpCi9Nb2REYXRlIChEOjIwMjYwNzExMTQyMTE3WjAwJzAwJykgPj4KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDEwNCAwMDAwMCBuIAowMDAwMDAwMjIzIDAwMDAwIG4gCjAwMDAwMDAwMjIgMDAwMDAgbiAKMDAwMDAwMDE4NCAwMDAwMCBuIAowMDAwMDAwMzA2IDAwMDAwIG4gCjAwMDAwMDAzNTUgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA3IC9Sb290IDUgMCBSIC9JbmZvIDYgMCBSIC9JRCBbIDw0ZmU2ZTdkMzU2YjliMmIxYWJhMGYxZmRlMDMxZDUzOD4KPDRmZTZlN2QzNTZiOWIyYjFhYmEwZjFmZGUwMzFkNTM4PiBdID4+CnN0YXJ0eHJlZgo1MjkKJSVFT0YK";

/** Build a synthetic annotation without using any uploaded customer documents. */
function addPdfAnnotation(
  document: PDFDocument,
  page: PDFPage,
  subtype: string,
  text: string,
  y: number,
  flags = 4,
): void {
  const annotation = document.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of(subtype),
    Rect: [40, y, 430, y + 24],
    Contents: PDFString.of(text),
    DA: PDFString.of("/Helv 12 Tf 0 g"),
    F: flags,
  });
  page.node.addAnnot(document.context.register(annotation));
}

describe("real PDF extraction", () => {
  it("passes owned Uint8Array data to PDF.js without detaching the upload buffer", async () => {
    const source = Buffer.from(PDF_FIXTURE_BASE64, "base64");
    const original = Buffer.from(source);

    const result = await extractTextFromPdf(source);

    expect(["pdf_parse", "pdf_scanned"]).toContain(result.method);
    expect(source.equals(original)).toBe(true);
    expect(source.length).toBeGreaterThan(0);
  });

  it("flags an image-only page between text pages and keeps the text layer", async () => {
    // Synthetic three-page PDF; page 2 is a raster with no text (fixtures/README.md).
    const source = await readFile(
      new URL("./fixtures/pdf-scanned-middle-page.pdf", import.meta.url),
    );

    const result = await extractTextFromPdf(source);

    expect(result).toEqual({
      text:
        "MASTER SERVICES AGREEMENT " +
        "1. Services. The Supplier will provide the services described in Schedule A. " +
        "2. Fees. The Customer will pay the fees in Schedule B within thirty days of invoice. " +
        "3. Term. This Agreement starts on the Effective Date and lasts twelve months. " +
        "4. Termination. Either party may terminate on sixty days written notice.",
      method: "pdf_parse",
      confidence: 66,
      sparseTextPages: [2],
    });
  });

  it("keeps a short cover page's selectable text while flagging the page as sparse", async () => {
    // Synthetic three-page text PDF; page 1 carries only "EXHIBIT A" (fixtures/README.md).
    const source = await readFile(
      new URL("./fixtures/pdf-short-cover-page.pdf", import.meta.url),
    );

    const result = await extractTextFromPdf(source);

    expect(result).toEqual({
      text:
        "EXHIBIT A " +
        "SCHEDULE OF SERVICES " +
        "1. Scope. The Supplier will host and maintain the Customer portal. " +
        "2. Support. The Supplier will answer support requests within one business day. " +
        "3. Fees. The Customer will pay a monthly fee of 2,000 USD in advance. " +
        "4. Termination. Either party may end this Exhibit on thirty days written notice.",
      method: "pdf_parse",
      confidence: 66,
      sparseTextPages: [1],
    });
  });
  it("extracts visible FreeText values even when they are absent from the page text layer", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage();
    page.drawText("Transfer funds to the IBAN written in the blank line below.", {
      x: 40,
      y: 730,
    });

    const syntheticIban = "TR000000000000000000000000";
    for (let index = 0; index < 3; index++)
      addPdfAnnotation(document, page, "FreeText", syntheticIban, 650 - index * 40);
    // Sticky-note comments are not visible field values and should not enter the document text.
    addPdfAnnotation(document, page, "Text", "Internal review comment", 350);
    // The display-intent read must exclude hidden annotations.
    addPdfAnnotation(document, page, "FreeText", "HIDDEN_PRIVATE_VALUE", 310, 2);

    const source = Buffer.from(await document.save());
    const original = Buffer.from(source);
    const result = await extractTextFromPdf(source);

    expect(result.text).toContain("Transfer funds to the IBAN");
    expect(result.text.match(/TR000000000000000000000000/g)).toHaveLength(3);
    expect(result.text).not.toContain("Internal review comment");
    expect(result.text).not.toContain("HIDDEN_PRIVATE_VALUE");
    expect(source.equals(original)).toBe(true);
  });

  it("includes populated text form fields and omits empty ones", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage();
    page.drawText("Bank instruction with an account field.", { x: 40, y: 730 });

    const form = document.getForm();
    const account = form.createTextField("recipientAccount");
    account.setText("EXAMPLE-ACCOUNT-123");
    account.addToPage(page, { x: 40, y: 650, width: 250, height: 24 });
    const emptyField = form.createTextField("unfilledField");
    emptyField.addToPage(page, { x: 40, y: 600, width: 250, height: 24 });

    const source = Buffer.from(await document.save());
    const result = await extractTextFromPdf(source);

    expect(result.text).toContain("recipientAccount: EXAMPLE-ACCOUNT-123");
    expect(result.text).not.toContain("unfilledField");
  });

});
