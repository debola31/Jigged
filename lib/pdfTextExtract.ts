/**
 * Vector PDF → text items, the SECOND front-end to `lib/drawingText`.
 *
 * A DXF hands us the drawing's model; a PDF hands us only what was printed. The
 * matcher does not care which, so this returns the same `TextItem` shape
 * `extractDxfText` does and, like it, knows nothing about title blocks.
 *
 * WHAT 96 REAL DRAWINGS SETTLED:
 *
 *  - **No run merging.** Not one string was split across text runs, so the
 *    fragment-stitching every PDF-scraping recipe opens with is code with no
 *    case to answer. Its absence is a decision, not an omission.
 *  - **`hasTextLayer` is a first-class answer.** 25 of the 96 carried no text
 *    operators at all — their text had been exported as outlines. Those files
 *    are UNREADABLE, not empty, and a caller has to say the two differently:
 *    a blank row with no explanation reads as "the drawing said nothing".
 *  - **Mojibake is left alone.** A PDF whose fonts lack `/ToUnicode` decodes
 *    CJK to garbage. Repairing it is guesswork; leaving it lets the matcher's
 *    plausibility predicates discard it, so such a file fails to EMPTY rather
 *    than to WRONG — the direction this whole flow is built to fail in.
 */

import type { TextItem } from '@/lib/drawingText';

export interface PdfTextResult {
  items: TextItem[];
  /**
   * Whether the file carried any readable text at all. False means "we cannot
   * read this one" — a scan, or text exported as outlines — which is a
   * different thing to tell a user than "this drawing has no title block".
   */
  hasTextLayer: boolean;
}

/**
 * Extract every text run from a vector PDF.
 *
 * Never throws: a file the user just dropped being unreadable is an expected
 * state of this flow, not an exception. It returns `hasTextLayer: false`.
 */
export async function extractPdfText(data: Uint8Array): Promise<PdfTextResult> {
  // The legacy build, and dynamically. Legacy because the modern one reaches
  // for DOM APIs that are absent outside a browser; dynamic so half a megabyte
  // of pdf.js stays out of every route that never opens a PDF.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // In Node pdf.js disables the worker and has already pointed this at its own
  // module, so only fill it in when nothing has — in the browser it throws
  // without one. `new URL(…, import.meta.url)` is the form bundlers recognise,
  // so the worker ships as an emitted asset rather than as a bare specifier the
  // browser cannot resolve.
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
      import.meta.url,
    ).toString();
  }

  // Declared out here so the `finally` can reach it, and nullable because
  // `getDocument` can throw before there is anything to destroy.
  let task: ReturnType<typeof pdfjs.getDocument> | null = null;

  try {
    // pdf.js TRANSFERS the buffer it is given, detaching the caller's array.
    // The same bytes are read again downstream (the file is uploaded as the
    // part's attachment), so hand over a copy and leave the caller's intact.
    task = pdfjs.getDocument({ data: data.slice() });
    const doc = await task.promise;
    const items: TextItem[] = [];

    // Every page. A title block is usually on sheet 1, but a cut list or a
    // revision table routinely is not.
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();

      for (const run of content.items) {
        // Marked-content boundaries share the array and carry no text.
        if (!('str' in run)) continue;
        if (!run.str.trim()) continue;

        // Index 3 of the text matrix is fontSize x vertical scale, and across
        // the sample it was the only local scale a PDF offered reliably — the
        // matcher sizes its search windows by it, so getting it wrong is not
        // cosmetic. `item.height` is device-space and second choice; 1 is the
        // last resort that keeps a window finite rather than zero-wide.
        const scaledFontSize = Math.abs(Number(run.transform?.[3]));
        const height = scaledFontSize || Math.abs(run.height) || 1;

        items.push({
          text: run.str,
          x: Number(run.transform?.[4]) || 0,
          y: Number(run.transform?.[5]) || 0,
          height,
        });
      }
    }

    return { items, hasTextLayer: items.length > 0 };
  } catch {
    // Corrupt, encrypted, or not a PDF at all — one answer covers all three,
    // and the caller's job is to say so rather than to handle an exception.
    return { items: [], hasTextLayer: false };
  } finally {
    // Unconditionally, or the worker outlives the read. A destroy that itself
    // rejects must not become the exception this function promises never to
    // throw.
    await task?.destroy().catch(() => undefined);
  }
}
