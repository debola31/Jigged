"""No AGPL Python dependency may enter the product.

THE HARD CONSTRAINT ONLY, AND THAT IS DELIBERATE. The npm side
(scripts/licenseCheck.ts) also requires every licence family to be on a reviewed
allowlist, because pnpm resolves licences consistently. pip metadata does not:
about a third of installed distributions declare nothing machine-readable at all,
so an allowlist here would be mostly "UNKNOWN" entries and would prove nothing
while looking like coverage.

What this DOES catch is the failure that actually threatened this PR. The three
obvious tools for rendering a PDF are PyMuPDF (AGPL-3.0), Ghostscript (AGPL-3.0)
and pdf2image/poppler (GPL-2.0), and reaching for any of them is a one-line
change that nothing else in the pipeline would notice.
"""
from __future__ import annotations

from importlib.metadata import distributions

import pytest

DENIED = ("AGPL", "SSPL")


def _licence_text(dist) -> str:
    meta = dist.metadata
    parts = [
        meta.get("License") or "",
        meta.get("License-Expression") or "",
        *(meta.get_all("Classifier") or []),
    ]
    return " ".join(parts).upper()


def test_no_installed_distribution_is_agpl_or_sspl():
    offenders = []
    for dist in distributions():
        text = _licence_text(dist)
        if any(token in text for token in DENIED):
            offenders.append(f"{dist.metadata['Name']} ({text[:80]})")
    assert offenders == [], (
        "AGPL/SSPL dependencies found: " + "; ".join(sorted(offenders)) +
        ". This product is closed-source; replace them. For PDF work the approved "
        "pair is pypdfium2 (Apache-2.0 over BSD-3 PDFium) and pdfplumber (MIT)."
    )


@pytest.mark.parametrize("banned", ["fitz", "pymupdf", "ghostscript", "pdf2image"])
def test_the_disqualifying_pdf_libraries_are_not_installed(banned):
    """Named individually because these are what someone reaches for first.

    A generic licence scan catches them only if their metadata is honest;
    naming them is cheap and catches a vendored or renamed copy too.
    """
    installed = {d.metadata["Name"].lower().replace("_", "-") for d in distributions()}
    assert banned not in installed, (
        f"{banned} is installed. PyMuPDF/fitz and Ghostscript are AGPL-3.0 and "
        f"pdf2image needs GPL poppler; use pypdfium2 + pdfplumber."
    )


def test_the_approved_pdf_pair_is_what_is_actually_installed():
    """The positive half. Without it this file would pass on a machine with no PDF
    support at all, which is a green tick for the absence of the thing it guards."""
    installed = {d.metadata["Name"].lower() for d in distributions()}
    assert {"pypdfium2", "pdfplumber"} <= installed, (
        "the worker's PDF stage needs pypdfium2 and pdfplumber; "
        "install worker/requirements.txt"
    )
