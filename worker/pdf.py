"""PDF -> PNG + text, for the vision path. Worker-side only.

This is the first server-side binary file handling in the repo, and it is a
deliberate departure from a contract routes/drawing_routes.py states outright
("It never sees a file"). It lives on the desktop precisely because of that: a
~4.5 MB body ceiling and a 60-second wall make rasterisation on Vercel a
non-starter, whereas here there is a GPU box with no wall at all.

LICENCE CONSTRAINT, NOT A PREFERENCE. No AGPL anywhere in this product, which
rules out the three obvious tools for this job: PyMuPDF/fitz (AGPL-3.0),
Ghostscript (AGPL-3.0) and pdf2image/poppler (GPL-2.0). pypdfium2 (Apache-2.0 over
BSD-3 PDFium) and pdfplumber (MIT over MIT pdfminer.six) are the approved pair,
and scripts/licenseCheck.ts enforces it rather than trusting this comment.
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

DPI = 300
# qwen3-vl's native resolution ceiling. Anything larger is downsampled by the
# model anyway, and would cost VRAM to produce for nothing.
MAX_EDGE_PX = 4096
POINTS_PER_INCH = 72.0


@dataclass(frozen=True)
class RenderedPage:
    png: bytes
    width_px: int
    height_px: int
    # What we ACTUALLY achieved, not what we asked for. See render_page.
    effective_dpi: float


def _scale_for(width_pt: float, height_pt: float) -> tuple[float, float]:
    """Render scale, and the DPI it really represents.

    CAPPED BY CONSTRUCTION, NEVER RENDER-THEN-DOWNSAMPLE: an ANSI E sheet at 300 DPI
    is 10200 x 13200 px, roughly 400 MB of RGB, on a box with 8 GB of VRAM to
    protect. Computing the scale first means that bitmap is never allocated.

    THE CAP BINDS ON NEARLY EVERY REAL ENGINEERING SHEET, and that is the fact most
    likely to be missed:

        A  8.5x11   ->  2550x3300   uncapped      300 DPI
        B  11x17    ->  2650x4096   capped        241 DPI
        C  17x22    ->  3166x4096   capped        186 DPI
        D  22x34    ->  2650x4096   capped        120 DPI   <- the common size
        E  34x44    ->  3166x4096   capped         93 DPI

    At ~120 DPI, 1/8-inch title-block text is about 15 px tall -- marginal for a 4B
    VLM. That is why this returns the effective DPI and why the drawing gate scores
    by sheet size rather than in aggregate: a corpus skewed to A-size would report a
    parity that evaporates in production.
    """
    longest_pt = max(width_pt, height_pt)
    if longest_pt <= 0:
        raise ValueError("page has no dimensions")
    scale = min(DPI / POINTS_PER_INCH, MAX_EDGE_PX / longest_pt)
    return scale, scale * POINTS_PER_INCH


def render_page(pdf_bytes: bytes, page_number: int) -> RenderedPage:
    """Render one 1-indexed page to PNG."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        if not 1 <= page_number <= len(doc):
            raise IndexError(
                f"page {page_number} is outside this document's {len(doc)} page(s)"
            )
        page = doc[page_number - 1]
        scale, effective_dpi = _scale_for(page.get_width(), page.get_height())
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            return RenderedPage(
                png=buf.getvalue(),
                width_px=image.width,
                height_px=image.height,
                effective_dpi=round(effective_dpi, 1),
            )
        finally:
            image.close()
    finally:
        doc.close()


def page_count(pdf_bytes: bytes) -> int:
    """How many pages the file REALLY has.

    The enqueue path takes page_count from the browser, which is a client
    assertion. This is what the worker reconciles it against on the first page of a
    batch: a cap alone still trusts the number, and jobs for pages that do not
    exist fail with a named error rather than rendering nothing.
    """
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        return len(doc)
    finally:
        doc.close()


def extract_page_text(pdf_bytes: bytes, page_number: int) -> str:
    """The embedded text layer for one page, or '' for a scan.

    Vector CAD exports carry dimension and title-block text losslessly, and handing
    it to the model alongside the image is far cheaper than making it read pixels.
    A scan yields nothing and the job proceeds VISION-ONLY -- that fallback is the
    point of this function, not an error path.

    Empty here should agree with what the browser already told the user: pdf.js
    reports hasTextLayer and the drawings UI surfaces "This looks like a scan". If
    the two ever disagree, the user's message and the model's context are telling
    different stories, and that is a bug rather than a tolerance.
    """
    import pdfplumber

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            if not 1 <= page_number <= len(pdf.pages):
                return ""
            return (pdf.pages[page_number - 1].extract_text() or "").strip()
    except Exception as exc:  # noqa: BLE001 - a scan or a damaged file is not fatal
        logger.warning("text extraction failed on page %s: %s", page_number, type(exc).__name__)
        return ""


__all__ = ["DPI", "MAX_EDGE_PX", "RenderedPage", "extract_page_text", "page_count", "render_page"]
