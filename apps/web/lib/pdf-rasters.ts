import { withAbort } from "@repo/chat-engine/bounded-response";
import type { RawRaster } from "@/lib/png-encode";

export type PdfDocumentProxy = Awaited<
  ReturnType<(typeof import("unpdf"))["getDocumentProxy"]>
>;

/**
 * A raster at least this many pixels on either side can hold page content (a page, or a strip of
 * one); smaller ones are stamps, logos or placeholders.
 */
export const MIN_CONTENT_RASTER_SIDE = 300;

// PDF.js's decoded image kinds (ImageKind in pdf.js's shared util).
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

type DecodedImage = {
  width?: number;
  height?: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
};

/** Unpack PDF.js's 1-bit rows (padded to whole bytes, a set bit is white) to 8-bit gray. */
function unpackBlackAndWhite(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array | null {
  const rowBytes = Math.ceil(width / 8);
  if (data.length < rowBytes * height) return null;
  const gray = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const byte = data[row * rowBytes + (column >> 3)]!;
      gray[row * width + column] = byte & (0x80 >> (column & 7)) ? 255 : 0;
    }
  }
  return gray;
}

type ImageSize = { width?: unknown; height?: unknown };

/**
 * Whether an image-painting operator paints a raster that can hold page content: one whose width
 * or height reaches MIN_CONTENT_RASTER_SIDE, or whose size PDF.js does not report. Sizes come from
 * the operator's arguments, so nothing is decoded. Solid-color masks and non-image operators never
 * count.
 */
function paintsContentRaster(
  ops: Record<string, number>,
  operator: number,
  args: unknown[] | null | undefined,
): boolean {
  const contentSized = (size: ImageSize | undefined) =>
    typeof size?.width !== "number" ||
    typeof size.height !== "number" ||
    size.width >= MIN_CONTENT_RASTER_SIDE ||
    size.height >= MIN_CONTENT_RASTER_SIDE;
  switch (operator) {
    case ops.paintImageXObject:
      // [objectId, width, height]
      return contentSized({ width: args?.[1], height: args?.[2] });
    case ops.paintImageXObjectRepeat:
      // [objectId, scaleX, scaleY, positions]: the image's own size is not in the arguments.
      return true;
    case ops.paintImageMaskXObject:
    case ops.paintImageMaskXObjectRepeat:
    case ops.paintInlineImageXObject:
    case ops.paintInlineImageXObjectGroup:
      return contentSized(args?.[0] as ImageSize | undefined);
    case ops.paintImageMaskXObjectGroup: {
      const images = args?.[0];
      return (
        !Array.isArray(images) ||
        images.some((image) => contentSized(image as ImageSize))
      );
    }
    default:
      return false;
  }
}

type Matrix = [number, number, number, number, number, number];
/** [minX, minY, maxX, maxY] in the page's coordinates. */
type Box = [number, number, number, number];
/**
 * What a painting operator draws under: the transform in effect, the clip (a box, "unknown" for a
 * clip that is not a plain upright rectangle, or null for none) and the stroke width, in the
 * transform's units.
 */
type PaintState = {
  matrix: Matrix;
  clip: Box | "unknown" | null;
  lineWidth: number;
};

/**
 * A stroke wider than this many points can black out a line of text, as a marker or a thick line
 * drawn over it does; rules, underlines and pen strokes are thinner.
 */
const MAX_THIN_STROKE_WIDTH = 2;

/** How far past the visible area a raster may reach, as a share of its own width and height. */
const VISIBLE_AREA_SLACK = 0.005;

function concatenate(matrix: Matrix, next: ArrayLike<number>): Matrix {
  const [a, b, c, d, e, f] = matrix;
  return [
    a * next[0]! + c * next[1]!,
    b * next[0]! + d * next[1]!,
    a * next[2]! + c * next[3]!,
    b * next[2]! + d * next[3]!,
    a * next[4]! + c * next[5]! + e,
    b * next[4]! + d * next[5]! + f,
  ];
}

function toPage(matrix: Matrix, x: number, y: number): [number, number] {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

/**
 * The width, in points, of a stroke painted in `state`: its line width under the transform's
 * largest stretch. NaN when either is unknown.
 */
function strokeWidth(state: PaintState): number {
  const [a, b, c, d] = state.matrix;
  const squares = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const stretch = Math.sqrt(
    (squares +
      Math.sqrt(Math.max(0, squares * squares - 4 * determinant ** 2))) /
      2,
  );
  return Math.abs(state.lineWidth) * stretch;
}

function isNumberList(
  value: unknown,
  length: number,
): value is ArrayLike<number> {
  return (
    (Array.isArray(value) || ArrayBuffer.isView(value)) &&
    (value as unknown as ArrayLike<unknown>).length === length &&
    Array.from(value as unknown as ArrayLike<unknown>).every(
      (item) => typeof item === "number",
    )
  );
}

/**
 * Narrow the clip to `box`, a rectangle in the current coordinates, or to an unknown shape when
 * `box` is null. Under a rotated or skewed transform the rectangle is no longer upright, so the
 * clip becomes unknown as well.
 */
function narrowClip(state: PaintState, box: ArrayLike<number> | null): void {
  if (state.clip === "unknown") return;
  const [a, b, c, d] = state.matrix;
  const upright = (b === 0 && c === 0) || (a === 0 && d === 0);
  if (!box || !upright) {
    state.clip = "unknown";
    return;
  }
  const [x1, y1] = toPage(state.matrix, box[0]!, box[1]!);
  const [x2, y2] = toPage(state.matrix, box[2]!, box[3]!);
  const previous = state.clip;
  state.clip = [
    Math.max(Math.min(x1, x2), previous?.[0] ?? -Infinity),
    Math.max(Math.min(y1, y2), previous?.[1] ?? -Infinity),
    Math.min(Math.max(x1, x2), previous?.[2] ?? Infinity),
    Math.min(Math.max(y1, y2), previous?.[3] ?? Infinity),
  ];
}

/**
 * The rectangle a constructPath operator draws, as [minX, minY, maxX, maxY], or null when its path
 * is anything else. PDF.js 5 passes [paint operator, [path], bounds]; the path of a PDF `re`
 * rectangle is moveTo (0), three lineTo (1) and closePath (4), each followed by its coordinates.
 */
function pathRectangle(
  args: unknown[] | null | undefined,
): ArrayLike<number> | null {
  const paths: unknown = args?.[1];
  const path: unknown = Array.isArray(paths) ? paths[0] : null;
  const bounds: unknown = args?.[2];
  if (!isNumberList(path, 13) || !isNumberList(bounds, 4)) return null;
  const [move, x0, y0, line1, x1, y1, line2, x2, y2, line3, x3, y3, close] =
    Array.from(path);
  const isRectangle =
    move === 0 &&
    line1 === 1 &&
    line2 === 1 &&
    line3 === 1 &&
    close === 4 &&
    y0 === y1 &&
    x1 === x2 &&
    y2 === y3 &&
    x3 === x0;
  return isRectangle ? bounds : null;
}

/**
 * Whether a raster painted in `state` shows in full: every corner of it lies inside the page's
 * visible box and inside the clip, give or take VISIBLE_AREA_SLACK (placement is often a fraction
 * of a point off; a strip that thin holds no text).
 */
function showsInFull(state: PaintState, view: Box): boolean {
  if (state.clip === "unknown") return false;
  const corners = [
    toPage(state.matrix, 0, 0),
    toPage(state.matrix, 1, 0),
    toPage(state.matrix, 1, 1),
    toPage(state.matrix, 0, 1),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const slackX = (Math.max(...xs) - Math.min(...xs)) * VISIBLE_AREA_SLACK;
  const slackY = (Math.max(...ys) - Math.min(...ys)) * VISIBLE_AREA_SLACK;
  return [view, state.clip].every(
    (box) =>
      !box ||
      corners.every(
        ([x, y]) =>
          x >= box[0] - slackX &&
          x <= box[2] + slackX &&
          y >= box[1] - slackY &&
          y <= box[3] + slackY,
      ),
  );
}

function toRaster(image: DecodedImage): RawRaster | null {
  const { width, height, kind, data } = image;
  if (!data || !width || !height) return null;
  if (kind === GRAYSCALE_1BPP) {
    const gray = unpackBlackAndWhite(data, width, height);
    return gray ? { data: gray, width, height, channels: 1 } : null;
  }
  const channels = kind === RGB_24BPP ? 3 : kind === RGBA_32BPP ? 4 : null;
  if (!channels || data.length !== width * height * channels) return null;
  return { data, width, height, channels };
}

/**
 * The largest raster painted on a PDF page, decoded to raw pixels, or null when the page paints
 * none that PDF.js can decode here (vector-only pages, stencil masks, or encodings such as JBIG2
 * or JPX that fail to decode in Node). Like unpdf's extractImages, it reads image XObjects from
 * the page's operator list; unlike it, it also accepts PDF.js's packed 1-bit images, the usual
 * form of black-and-white scans. `accept` sees each candidate's size before its pixels are
 * converted, so a raster too small or too large for OCR is never copied. The page's decoded
 * objects are released before this returns.
 *
 * It also returns null when anything that can cover the raster is painted after it: a filled
 * path (a whiteout or redaction box), a shading, another image, or a stroke wider than
 * MAX_THIN_STROKE_WIDTH (a marker or thick line drawn over text). OCR reads the raster alone,
 * so it would otherwise read text that the page does not show. Thin strokes and text on top are
 * allowed; they cannot hide a page of text.
 *
 * And it returns null when the page paints another content-sized raster (see
 * MIN_CONTENT_RASTER_SIDE), before or after the largest: a page scanned as several tiles or
 * strips would otherwise lose the text in all but one of them while counting as read. Small
 * stamps and logos beside the raster are allowed.
 *
 * And it returns null when the raster does not show in full: part of it lies outside the page's
 * visible box (the crop box) or the clip it is painted under, or that clip is not a plain
 * rectangle. OCR would otherwise read text that the page cuts off.
 *
 * `strict` is the same document opened with PDF.js's stopAtErrors. PDF.js leaves out what it
 * cannot use, such as an image over the document's maxImageSize, without a trace in the operator
 * list, so a page could count as read from a stamp while its real scan was dropped. With
 * stopAtErrors the page's list ends at the first such error instead, so when the two lists differ
 * in length something was left out and this returns null.
 */
export async function largestPageRaster(
  pdf: PdfDocumentProxy,
  pageNumber: number,
  accept: (size: { width: number; height: number }) => boolean,
  signal?: AbortSignal,
  strict?: PdfDocumentProxy,
): Promise<RawRaster | null> {
  const { getResolvedPDFJS } = await import("unpdf");
  const { OPS } = await getResolvedPDFJS();
  const ops = OPS as Record<string, number>;
  // Painting operators that can cover what was painted before them: fills, shadings and images
  // always, strokes when they are wide. Older pdf.js versions emit a path's painting operator on
  // its own.
  const fills = new Set(
    [
      "fill",
      "eoFill",
      "fillStroke",
      "eoFillStroke",
      "closeFillStroke",
      "closeEOFillStroke",
    ].map((name) => ops[name]),
  );
  const strokes = new Set(["stroke", "closeStroke"].map((name) => ops[name]));
  const coverings = new Set([
    ...fills,
    ops.shadingFill,
    ...Object.entries(ops)
      .filter(
        ([name]) =>
          name.startsWith("paint") && !name.startsWith("paintFormXObject"),
      )
      .map(([, value]) => value),
  ]);
  const page = await pdf.getPage(pageNumber);
  try {
    const operators = await withAbort(page.getOperatorList(), signal);
    let largest: DecodedImage | null = null;
    let largestIndex = -1;
    let largestShowsInFull = false;
    let lastCoveringIndex = -1;
    const contentRasterIndexes: number[] = [];
    // The page's visible box: its crop box, within its media box.
    const [viewX1, viewY1, viewX2, viewY2] = page.view as Box;
    const view: Box = [
      Math.min(viewX1, viewX2),
      Math.min(viewY1, viewY2),
      Math.max(viewX1, viewX2),
      Math.max(viewY1, viewY2),
    ];
    // Follow the transform and clip each operator paints under, as PDF.js's canvas does.
    const initial = (): PaintState => ({
      matrix: [1, 0, 0, 1, 0, 0],
      clip: null,
      lineWidth: 1,
    });
    let state = initial();
    const saved: PaintState[] = [];
    const save = () => saved.push({ ...state });
    const restore = () => {
      state = saved.pop() ?? state;
    };
    // A clip operator applies to the path that the next constructPath draws.
    let clipPending = false;
    for (let index = 0; index < operators.fnArray.length; index++) {
      const args: unknown[] | null | undefined = operators.argsArray[index];
      switch (operators.fnArray[index]) {
        case OPS.save:
        case OPS.beginGroup:
          save();
          break;
        case OPS.restore:
        case OPS.endGroup:
        case OPS.paintFormXObjectEnd:
        case OPS.endAnnotation:
          restore();
          break;
        case OPS.transform:
          if (isNumberList(args, 6)) {
            state.matrix = concatenate(state.matrix, args);
          } else {
            state.clip = "unknown";
          }
          break;
        case OPS.paintFormXObjectBegin: {
          // [matrix, bounding box]: the form is drawn under its matrix, clipped to its box.
          save();
          const [matrix, box] = args ?? [];
          if (isNumberList(matrix, 6)) {
            state.matrix = concatenate(state.matrix, matrix);
          } else if (matrix) {
            state.clip = "unknown";
          }
          if (box) narrowClip(state, isNumberList(box, 4) ? box : null);
          break;
        }
        case OPS.beginAnnotation: {
          // [id, rectangle, transform, matrix]: an annotation's appearance starts from the
          // page's own coordinates and a fresh graphics state, is clipped to its rectangle and
          // drawn under both matrices.
          save();
          state = initial();
          const [, rectangle, transform, matrix] = args ?? [];
          if (rectangle) {
            narrowClip(state, isNumberList(rectangle, 4) ? rectangle : null);
          }
          for (const next of [transform, matrix]) {
            state.matrix = isNumberList(next, 6)
              ? concatenate(state.matrix, next)
              : [NaN, NaN, NaN, NaN, NaN, NaN];
          }
          break;
        }
        case OPS.setLineWidth:
          state.lineWidth = typeof args?.[0] === "number" ? args[0] : NaN;
          break;
        case OPS.setGState: {
          // [[key, value], ...] from an ExtGState dictionary; LW is its line width.
          const entries: unknown = args?.[0];
          for (const entry of Array.isArray(entries) ? entries : []) {
            if (Array.isArray(entry) && entry[0] === "LW") {
              state.lineWidth = typeof entry[1] === "number" ? entry[1] : NaN;
            }
          }
          break;
        }
        case OPS.clip:
        case OPS.eoClip:
          clipPending = true;
          break;
        case OPS.constructPath:
          if (clipPending) narrowClip(state, pathRectangle(args));
          clipPending = false;
          break;
      }
      // pdf.js 5 folds a path's painting operator into constructPath's first argument.
      const operator = operators.fnArray[index]!;
      const paint: unknown =
        operator === OPS.constructPath ? args?.[0] : operator;
      if (
        operator === OPS.constructPath
          ? fills.has(paint as number)
          : coverings.has(operator)
      ) {
        lastCoveringIndex = index;
      } else if (
        strokes.has(paint as number) &&
        // Also when the width is unknown (NaN).
        !(strokeWidth(state) <= MAX_THIN_STROKE_WIDTH)
      ) {
        lastCoveringIndex = index;
      }
      if (
        paintsContentRaster(
          ops,
          operators.fnArray[index]!,
          operators.argsArray[index],
        )
      ) {
        contentRasterIndexes.push(index);
      }
      if (operators.fnArray[index] !== OPS.paintImageXObject) continue;
      const key: unknown = operators.argsArray[index]?.[0];
      if (typeof key !== "string") continue;
      const objects = key.startsWith("g_") ? page.commonObjs : page.objs;
      const image = await withAbort(
        new Promise<DecodedImage | null>((resolve) =>
          objects.get(key, (decoded: unknown) =>
            resolve(decoded as DecodedImage | null),
          ),
        ),
        signal,
      );
      if (!image?.data || !image.width || !image.height) continue;
      if (
        !largest ||
        image.width * image.height > largest.width! * largest.height!
      ) {
        largest = image;
        largestIndex = index;
        largestShowsInFull = showsInFull(state, view);
      }
    }
    if (largest && lastCoveringIndex > largestIndex) return null;
    if (contentRasterIndexes.some((index) => index !== largestIndex)) {
      return null;
    }
    if (largest && !largestShowsInFull) return null;
    if (
      !largest ||
      !accept({ width: largest.width!, height: largest.height! })
    ) {
      return null;
    }
    if (strict) {
      const strictPage = await strict.getPage(pageNumber);
      try {
        const complete = await withAbort(strictPage.getOperatorList(), signal);
        if (complete.fnArray.length !== operators.fnArray.length) return null;
      } finally {
        strictPage.cleanup();
      }
    }
    return toRaster(largest);
  } finally {
    page.cleanup();
  }
}
