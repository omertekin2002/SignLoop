import {
  clip,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endPath,
  lineTo,
  moveTo,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type PDFPage,
} from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it, vi } from "vitest";
import type { RawRaster } from "@/lib/png-encode";
import { largestPageRaster } from "./pdf-rasters";

// Runs the installed PDF.js on synthetic PDFs built with pdf-lib.

/** A page painting raw DeviceGray image XObjects, each at its own size on the page. */
async function pdfWithGrayImages(
  images: Array<{
    width: number;
    height: number;
    bits: 1 | 8;
    data: Uint8Array;
  }>,
  draw: {
    before?: (page: PDFPage) => void;
    after?: (page: PDFPage) => void;
  } = {},
) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  draw.before?.(page);
  images.forEach((image, index) => {
    const name = `Im${index}`;
    const stream = document.context.flateStream(image.data, {
      Type: "XObject",
      Subtype: "Image",
      Width: image.width,
      Height: image.height,
      ColorSpace: "DeviceGray",
      BitsPerComponent: image.bits,
    });
    page.node.setXObject(PDFName.of(name), document.context.register(stream));
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(
        image.width / 4,
        0,
        0,
        image.height / 4,
        10,
        10,
      ),
      drawObject(name),
      popGraphicsState(),
    );
  });
  draw.after?.(page);
  document.addPage([612, 792]).drawText("A vector page.", { x: 40, y: 700 });
  return getDocumentProxy(new Uint8Array(await document.save()));
}

const any = () => true;

describe("largestPageRaster", () => {
  it("unpacks a black-and-white scan to 8-bit gray", async () => {
    // 16×2 pixels, 1 bit each: row 0 is 8 black then 8 white pixels, row 1 alternates.
    const pdf = await pdfWithGrayImages([
      {
        width: 16,
        height: 2,
        bits: 1,
        data: Uint8Array.from([0x00, 0xff, 0x55, 0x55]),
      },
    ]);
    try {
      const raster = await largestPageRaster(pdf, 1, any);

      expect(raster).toMatchObject({ width: 16, height: 2, channels: 1 });
      expect([...raster!.data.subarray(0, 16)]).toEqual([
        ...Array(8).fill(0),
        ...Array(8).fill(255),
      ]);
      expect([...raster!.data.subarray(16)]).toEqual(
        Array.from({ length: 16 }, (_, i) => (i % 2 ? 255 : 0)),
      );
    } finally {
      await pdf.destroy();
    }
  });

  it("returns the page's largest raster, sized before it is accepted", async () => {
    // Smaller images painted beneath it; one painted over it would cover it (see below).
    const pdf = await pdfWithGrayImages([
      { width: 8, height: 8, bits: 8, data: new Uint8Array(64).fill(10) },
      { width: 20, height: 20, bits: 8, data: new Uint8Array(400).fill(90) },
      { width: 40, height: 30, bits: 8, data: new Uint8Array(1200).fill(200) },
    ]);
    try {
      const accept = vi.fn(() => true);
      const raster = await largestPageRaster(pdf, 1, accept);

      expect(accept).toHaveBeenCalledExactlyOnceWith({ width: 40, height: 30 });
      // PDF.js decodes 8-bit gray to RGB.
      expect(raster).toMatchObject({ width: 40, height: 30, channels: 3 });
      expect(raster!.data.every((value) => value === 200)).toBe(true);

      await expect(largestPageRaster(pdf, 1, () => false)).resolves.toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("returns null for a page without images", async () => {
    const pdf = await pdfWithGrayImages([]);
    try {
      await expect(largestPageRaster(pdf, 2, any)).resolves.toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  const scan = () => [
    {
      width: 40,
      height: 30,
      bits: 8 as const,
      data: new Uint8Array(1200).fill(200),
    },
  ];
  const box = (page: PDFPage) =>
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 612,
      height: 792,
      color: rgb(1, 1, 1),
    });

  it("skips a raster that a filled shape (a whiteout or redaction box) is painted over", async () => {
    const pdf = await pdfWithGrayImages(scan(), { after: box });
    try {
      await expect(largestPageRaster(pdf, 1, any)).resolves.toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("skips a raster that another image is painted over", async () => {
    const pdf = await pdfWithGrayImages([
      ...scan(),
      { width: 8, height: 8, bits: 8, data: new Uint8Array(64).fill(0) },
    ]);
    try {
      await expect(largestPageRaster(pdf, 1, any)).resolves.toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("reads a raster with a filled background beneath it and text or thin lines over it", async () => {
    const pdf = await pdfWithGrayImages(scan(), {
      before: box,
      after: (page) => {
        page.drawText("Bates 0001", { x: 500, y: 20, size: 8 });
        page.drawLine({
          start: { x: 40, y: 100 },
          end: { x: 300, y: 100 },
          thickness: 1,
        });
      },
    });
    try {
      await expect(largestPageRaster(pdf, 1, any)).resolves.toMatchObject({
        width: 40,
        height: 30,
      });
    } finally {
      await pdf.destroy();
    }
  });

  /** A blank DeviceGray image; flate compresses it, so content-sized rasters stay small. */
  const blank = (width: number, height: number) => ({
    width,
    height,
    bits: 8 as const,
    data: new Uint8Array(width * height).fill(255),
  });

  /** The raster's size only, so a failing assertion does not print its pixels. */
  const sizeOf = async (raster: Promise<RawRaster | null>) => {
    const read = await raster;
    return read && { width: read.width, height: read.height };
  };

  it("skips a page scanned as two content-sized rasters", async () => {
    // The smaller tile is painted first, so nothing is painted over the largest.
    const pdf = await pdfWithGrayImages([blank(320, 400), blank(640, 400)]);
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("skips a full-page raster with a wide, short strip beside it", async () => {
    // The strip is only 200 px tall, but 1200 px wide: it can hold a line of text.
    const pdf = await pdfWithGrayImages([blank(1200, 200), blank(1200, 1600)]);
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("skips a raster beside a content-sized stencil mask", async () => {
    // Black-and-white scans are often stencil masks (ImageMask), which are not read for OCR.
    const mask = (page: PDFPage) => {
      const stream = page.doc.context.flateStream(
        new Uint8Array((1200 / 8) * 200).fill(0x55),
        {
          Type: "XObject",
          Subtype: "Image",
          Width: 1200,
          Height: 200,
          ImageMask: true,
          BitsPerComponent: 1,
        },
      );
      page.node.setXObject(
        PDFName.of("Mask"),
        page.doc.context.register(stream),
      );
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(300, 0, 0, 50, 10, 700),
        drawObject("Mask"),
        popGraphicsState(),
      );
    };
    const pdf = await pdfWithGrayImages([blank(640, 400)], { before: mask });
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("reads a content raster with a small stamp or logo beside it", async () => {
    // Both of the logo's sides are under 300 px.
    const pdf = await pdfWithGrayImages([blank(299, 120), blank(640, 400)]);
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toEqual({
        width: 640,
        height: 400,
      });
    } finally {
      await pdf.destroy();
    }
  });

  // pdfWithGrayImages paints a 640×400 raster over the page area from (10, 10) to (170, 110).
  const tile = () => [blank(640, 400)];
  const read = { width: 640, height: 400 };

  it("skips a raster that the page's crop box cuts off", async () => {
    const pdf = await pdfWithGrayImages(tile(), {
      before: (page) => page.setCropBox(0, 0, 100, 60),
    });
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("skips a raster placed partly off the page", async () => {
    // 2600 px wide, so it is painted 650 points wide on a page 612 points wide.
    const pdf = await pdfWithGrayImages([blank(2600, 400)]);
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("skips a raster that a clip rectangle cuts off", async () => {
    const pdf = await pdfWithGrayImages(tile(), {
      before: (page) =>
        page.pushOperators(rectangle(10, 10, 80, 50), clip(), endPath()),
    });
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("skips a raster under a clip that is not a rectangle", async () => {
    // A triangle over the raster's corner of the page: its bounds hold the raster, its area may not.
    const pdf = await pdfWithGrayImages(tile(), {
      before: (page) =>
        page.pushOperators(
          moveTo(0, 0),
          lineTo(612, 0),
          lineTo(0, 792),
          closePath(),
          clip(),
          endPath(),
        ),
    });
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it("reads a raster that shows in full inside the crop box and its clip", async () => {
    const pdf = await pdfWithGrayImages(tile(), {
      before: (page) => {
        // The crop box trims 0.3 of the raster's 160 points: within the slack for placement.
        page.setCropBox(10.3, 5, 400, 300);
        page.pushOperators(
          // A clip that ends with its graphics state does not apply to the raster.
          pushGraphicsState(),
          rectangle(0, 0, 20, 20),
          clip(),
          endPath(),
          popGraphicsState(),
          // A page-sized clip, as many PDF writers emit, holds the raster.
          rectangle(0, 0, 612, 792),
          clip(),
          endPath(),
        );
      },
    });
    try {
      expect(await sizeOf(largestPageRaster(pdf, 1, any))).toEqual(read);
    } finally {
      await pdf.destroy();
    }
  });

  /** A page that draws a scanned page (see `tile`) as a form XObject clipped to `box`. */
  async function pdfWithScanInForm(box: {
    left: number;
    bottom: number;
    right: number;
    top: number;
  }) {
    const scan = await PDFDocument.create();
    const scanPage = scan.addPage([612, 792]);
    const image = blank(640, 400);
    const stream = scan.context.flateStream(image.data, {
      Type: "XObject",
      Subtype: "Image",
      Width: image.width,
      Height: image.height,
      ColorSpace: "DeviceGray",
      BitsPerComponent: image.bits,
    });
    scanPage.node.setXObject(PDFName.of("Im0"), scan.context.register(stream));
    scanPage.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(160, 0, 0, 100, 10, 10),
      drawObject("Im0"),
      popGraphicsState(),
    );
    const document = await PDFDocument.create();
    const form = await document.embedPage(scanPage, box);
    document.addPage([612, 792]).drawPage(form, { x: box.left, y: box.bottom });
    return getDocumentProxy(new Uint8Array(await document.save()));
  }

  it("reads a raster inside a form, unless the form's box cuts it off", async () => {
    const whole = await pdfWithScanInForm({
      left: 0,
      bottom: 0,
      right: 612,
      top: 792,
    });
    try {
      expect(await sizeOf(largestPageRaster(whole, 1, any))).toEqual(read);
    } finally {
      await whole.destroy();
    }

    const cut = await pdfWithScanInForm({
      left: 0,
      bottom: 0,
      right: 90,
      top: 792,
    });
    try {
      expect(await sizeOf(largestPageRaster(cut, 1, any))).toBeNull();
    } finally {
      await cut.destroy();
    }
  });
});
