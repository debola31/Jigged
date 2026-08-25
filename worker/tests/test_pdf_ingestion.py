"""PDF -> PNG + text, the stage that feeds the vision path.

THE FINDING THIS FILE EXISTS TO PIN: the 4096 px cap binds on nearly every real
engineering sheet, so "300 DPI" is aspirational for all but the smallest. A
D-size print -- the common size for a machined part -- comes out at roughly 120
effective DPI, where 1/8-inch title-block text is about 15 px tall. That is
marginal for a 4B VLM, and it is exactly the kind of thing that fails a quality
gate for a reason nobody diagnoses. So render_page REPORTS what it achieved, and
the gate scores by sheet size rather than in aggregate.

Run: conda run -n jigged pytest worker/tests -q
"""
from __future__ import annotations

import io
from pathlib import Path

import pytest

from worker import pdf

FIXTURES = Path(__file__).resolve().parents[2] / "e2e" / "fixtures" / "drawings"

# ANSI sheet sizes in points (1pt = 1/72in), and the effective DPI each lands at
# once the 4096 px cap is applied. Only A-size escapes it.
SHEETS = {
    "A": (612, 792, 300.0),
    "B": (792, 1224, 240.9),
    "C": (1224, 1584, 186.2),
    "D": (1584, 2448, 120.5),
    "E": (2448, 3168, 93.1),
}


def _pdf(width_pt: float, height_pt: float, pages: int = 1) -> bytes:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument.new()
    for _ in range(pages):
        doc.new_page(width_pt, height_pt)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


class TestRenderSizeCapping:
    @pytest.mark.parametrize("sheet", list(SHEETS))
    def test_the_longest_edge_never_exceeds_the_model_ceiling(self, sheet):
        w, h, _ = SHEETS[sheet]
        page = pdf.render_page(_pdf(w, h), 1)
        assert max(page.width_px, page.height_px) <= pdf.MAX_EDGE_PX, (
            f"{sheet}-size rendered past qwen3-vl's ceiling"
        )

    @pytest.mark.parametrize("sheet", list(SHEETS))
    def test_the_effective_dpi_is_reported_rather_than_assumed(self, sheet):
        """A gate report that cannot say what resolution it measured is not a
        measurement. Only A-size actually gets the 300 DPI the constant names."""
        w, h, expected = SHEETS[sheet]
        page = pdf.render_page(_pdf(w, h), 1)
        assert page.effective_dpi == pytest.approx(expected, abs=0.5)

    def test_only_the_smallest_sheet_escapes_the_cap(self):
        a = pdf.render_page(_pdf(*SHEETS["A"][:2]), 1)
        d = pdf.render_page(_pdf(*SHEETS["D"][:2]), 1)
        assert a.effective_dpi == pdf.DPI
        assert d.effective_dpi < pdf.DPI / 2, (
            "the common engineering sheet size renders at under half the nominal DPI"
        )

    def test_a_pathological_sheet_still_caps(self):
        """200 inches square. Nothing sane produces this; the point is that the cap
        is arithmetic rather than a list of known sizes."""
        page = pdf.render_page(_pdf(200 * 72, 200 * 72), 1)
        assert max(page.width_px, page.height_px) <= pdf.MAX_EDGE_PX

    def test_the_scale_is_computed_before_rendering_not_after(self):
        """CAPPED BY CONSTRUCTION. An E sheet at a true 300 DPI is 10200x13200 --
        about 400 MB of RGB on a box with 8 GB of VRAM to protect. Rendering it and
        then downsampling would allocate that bitmap first.

        Asserted through the arithmetic rather than by watching memory: the scale
        helper is what the renderer uses, and it never returns the uncapped value.
        """
        scale, dpi = pdf._scale_for(*SHEETS["E"][:2])
        assert scale < pdf.DPI / pdf.POINTS_PER_INCH
        assert round(SHEETS["E"][1] * scale) <= pdf.MAX_EDGE_PX
        assert dpi == pytest.approx(SHEETS["E"][2], abs=0.5)

    def test_a_page_with_no_dimensions_raises_rather_than_dividing_by_zero(self):
        with pytest.raises(ValueError):
            pdf._scale_for(0, 0)

    def test_a_page_outside_the_document_raises(self):
        with pytest.raises(IndexError):
            pdf.render_page(_pdf(612, 792), 5)


class TestTextLayer:
    def test_a_scan_yields_empty_text_and_does_not_raise(self):
        """The whole point of the fallback: no text layer means vision-only, not
        failure. A blank synthetic page is the same shape as a scan here -- nothing
        to extract."""
        assert pdf.extract_page_text(_pdf(612, 792), 1) == ""

    def test_a_real_vector_drawing_yields_its_dimension_text(self):
        """Vector CAD exports carry title-block and dimension text losslessly, and
        handing that to the model alongside the image is far cheaper than making it
        read pixels."""
        source = (FIXTURES / "E2E-DRAW-1.pdf").read_bytes()
        text = pdf.extract_page_text(source, 1)
        assert text, "a vector drawing should carry an extractable text layer"

    def test_a_damaged_file_degrades_to_empty_rather_than_exploding(self):
        assert pdf.extract_page_text(b"not a pdf at all", 1) == ""

    def test_asking_past_the_last_page_is_empty_not_an_error(self):
        assert pdf.extract_page_text(_pdf(612, 792), 9) == ""


class TestPageCount:
    @pytest.mark.parametrize("pages", [1, 3, 12])
    def test_the_real_page_count_is_what_reconciliation_compares_against(self, pages):
        """page_count on the job is a CLIENT assertion until this runs. The cap
        bounds the damage; this is what catches a wrong number."""
        assert pdf.page_count(_pdf(612, 792, pages=pages)) == pages

    def test_a_real_fixture_reports_its_pages(self):
        assert pdf.page_count((FIXTURES / "E2E-PDFONLY.pdf").read_bytes()) == 1
