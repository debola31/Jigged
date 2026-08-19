import type { SxProps, Theme } from '@mui/material/styles';

/**
 * Typography for a legal document's own markup, layered on top of
 * `LegalPageContainer` (which already styles h1/h2/h3/p/a/ul/li/strong).
 *
 * DELIBERATELY SMALL. The retired inline ToS carried a ~36-line block of
 * `.toc`, `.disclaimer-block`, `.contact-block` and `.section-divider`
 * selectors. The Common Paper agreement that replaced it uses **no classes at
 * all** — only `h1, h2, p, strong, em, a` — so carrying those selectors forward
 * would have been dead CSS that reads like a live contract with the container.
 * `app/(marketing)/cookies/page.tsx` keeps its own copy of them, which is why
 * removing them here breaks nothing.
 *
 * Shared with the archive routes so `/terms/v1` renders identically to `/terms`
 * — an archived version a stored hash points at must not look like a different
 * document from the one that was accepted.
 */
export const legalHtmlSx: SxProps<Theme> = {
  // `<em>Order Form</em>` and `<em>Key Terms</em>` are section labels in the
  // Common Paper structure, not emphasis inside a sentence. Setting them apart
  // is what keeps the Cover Page readable as a form rather than as prose.
  '& em': {
    display: 'block',
    fontStyle: 'normal',
    fontWeight: 700,
    fontSize: '0.95rem',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'text.secondary',
    mt: 4,
    mb: 1.5,
  },
  // Each clause opens with a bolded run-in label ("Framework Terms:",
  // "Governing Law:"). Give the paragraphs room so the labels scan as a list.
  '& p': { mb: 2.5 },
  '& h2': { mt: 5 },
};
