import { describe, expect, it } from "vitest";
import { extractTextFromPdf } from "./text-extraction";

// A tiny, one-page Quartz PDF. Keep this as bytes so the test exercises the real unpdf/PDF.js
// boundary rather than the mocked extraction guard suite.
const PDF_FIXTURE_BASE64 =
  "JVBERi0xLjMKJcTl8uXrp/Og0MTGCjMgMCBvYmoKPDwgL0ZpbHRlciAvRmxhdGVEZWNvZGUgL0xlbmd0aCAxMSA+PgpzdHJlYW0KeAErVAgEAAHnAOMKZW5kc3RyZWFtCmVuZG9iagoxIDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL1Jlc291cmNlcyA0IDAgUiAvQ29udGVudHMgMyAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1Byb2NTZXQgWyAvUERGIF0gPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9Db3VudCAxIC9LaWRzIFsgMSAwIFIgXSA+PgplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDcxMTE0MjExN1owMCcwMCcpIC9Qcm9kdWNlciAobWFjT1MgVmVyc2lvbiAyNi4zLjEgXChhXCkgXChCdWlsZCAyNUQ3NzEyODBhXCkgUXVhcnR6IFBERkNvbnRleHQpCi9Nb2REYXRlIChEOjIwMjYwNzExMTQyMTE3WjAwJzAwJykgPj4KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDEwNCAwMDAwMCBuIAowMDAwMDAwMjIzIDAwMDAwIG4gCjAwMDAwMDAwMjIgMDAwMDAgbiAKMDAwMDAwMDE4NCAwMDAwMCBuIAowMDAwMDAwMzA2IDAwMDAwIG4gCjAwMDAwMDAzNTUgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA3IC9Sb290IDUgMCBSIC9JbmZvIDYgMCBSIC9JRCBbIDw0ZmU2ZTdkMzU2YjliMmIxYWJhMGYxZmRlMDMxZDUzOD4KPDRmZTZlN2QzNTZiOWIyYjFhYmEwZjFmZGUwMzFkNTM4PiBdID4+CnN0YXJ0eHJlZgo1MjkKJSVFT0YK";

describe("real PDF extraction", () => {
  it("passes owned Uint8Array data to PDF.js without detaching the upload buffer", async () => {
    const source = Buffer.from(PDF_FIXTURE_BASE64, "base64");
    const original = Buffer.from(source);

    const result = await extractTextFromPdf(source);

    expect(["pdf_parse", "pdf_scanned"]).toContain(result.method);
    expect(source.equals(original)).toBe(true);
    expect(source.length).toBeGreaterThan(0);
  });
});
