import { describe, it, expect } from 'vitest';
import theme from '@/lib/theme';

/**
 * The Overdue card's text has to be readable, and the standard is a number.
 *
 * design-system.md ("Contrast, keyboard, semantics") sets 4.5:1 body / 3:1 large
 * as a FLOOR — WCAG 2.1 AA, SC 1.4.3 — measured against a 500–1000 lux shop
 * floor and "treated as a hard limit rather than a number to squeak past". The
 * same file names the gap this test fills: *"there is no automated accessibility
 * check. No axe, no contrast assertion... Contrast regressions are caught by
 * someone looking — which is how the 4.11:1 canvas survived as long as it did."*
 *
 * That is precisely what happened here. `error.main` (#ef4444) on the alert-tinted
 * card measured **2.98:1** — failing even the easier large-text clause — and it
 * shipped because nothing measures. `error.light` exists to be the readable one.
 *
 * The backgrounds below are SAMPLED FROM THE PAINTED PAGE, not computed from the
 * theme, and that distinction matters: the cards are translucent over a gradient
 * canvas, so a value derived from `background.default` comes out darker than
 * reality and would make this test more permissive than the screen. Re-sample by
 * screenshotting a card and reading a pixel from a blank corner of it.
 */

/** WCAG 2.1 relative luminance (sRGB). */
function luminance([r, g, b]: number[]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: number[], bg: number[]): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function hexToRgb(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Sampled from the running app at 1440×900. */
const ALERT_CARD_BG = [57, 55, 92];
const NORMAL_CARD_BG = [33, 41, 84];

const BODY_FLOOR = 4.5;
const LARGE_FLOOR = 3;

describe('alert-card contrast', () => {
  it('renders error TEXT in a red that clears the body floor on the alert tint', () => {
    // Label, count and money are all painted in this colour.
    const ratio = contrast(hexToRgb(theme.palette.error.light), ALERT_CARD_BG);
    expect(ratio).toBeGreaterThanOrEqual(BODY_FLOOR);
  });

  it('clears it with headroom, not by squeaking past', () => {
    // The standard is measured against a bright shop floor and treated as a hard
    // limit; a value at 4.51:1 satisfies the arithmetic and not the intent.
    const ratio = contrast(hexToRgb(theme.palette.error.light), ALERT_CARD_BG);
    expect(ratio).toBeGreaterThanOrEqual(5);
  });

  it('keeps a falling delta readable on a normal card too', () => {
    const ratio = contrast(hexToRgb(theme.palette.error.light), NORMAL_CARD_BG);
    expect(ratio).toBeGreaterThanOrEqual(BODY_FLOOR);
  });

  it('records why error.main is not usable as text on these surfaces', () => {
    // Not a rule being enforced — a measurement kept next to the fix, so the
    // next person who reaches for error.main on a tinted panel sees the number
    // rather than rediscovering it by eye.
    const onTint = contrast(hexToRgb(theme.palette.error.main), ALERT_CARD_BG);
    const onCard = contrast(hexToRgb(theme.palette.error.main), NORMAL_CARD_BG);

    expect(onTint).toBeLessThan(LARGE_FLOOR); // 2.98:1 — fails even large text
    expect(onCard).toBeLessThan(BODY_FLOOR); // 3.70:1 — fails body text
  });

  it('leaves the upward delta alone, because green already passes', () => {
    const ratio = contrast(hexToRgb(theme.palette.success.main), NORMAL_CARD_BG);
    expect(ratio).toBeGreaterThanOrEqual(BODY_FLOOR);
  });
});
