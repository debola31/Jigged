import { describe, it, expect } from 'vitest';
import theme from '@/lib/theme';

/**
 * Status colours have to be readable, and the standard is a number.
 *
 * design-system.md ("Contrast, keyboard, semantics") sets 4.5:1 body / 3:1 large
 * as a FLOOR — WCAG 2.1 AA, SC 1.4.3 — measured against a 500–1000 lux shop
 * floor and "treated as a hard limit rather than a number to squeak past". The
 * same file names the gap this test fills: *"there is no automated accessibility
 * check. No axe, no contrast assertion... Contrast regressions are caught by
 * someone looking — which is how the 4.11:1 canvas survived as long as it did."*
 *
 * That is exactly how the Overdue card shipped at 2.98:1.
 *
 * The backgrounds below are SAMPLED FROM THE PAINTED PAGE, not computed from the
 * theme, and the distinction matters: the cards are translucent over a gradient,
 * so a value derived from `background.default` comes out darker than reality and
 * would make this test more permissive than the screen. Re-sample by
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

/** Sampled at 1440×900, except the canvas, which is opaque and therefore exact. */
const PAGE_CANVAS_BG = [17, 20, 57]; // background.default #111439
const DIALOG_PAPER_BG = [21, 25, 65]; // MuiDialog paper, mid-gradient
const NORMAL_CARD_BG = [33, 41, 84];
/** The Overdue card: 8% warning.main over the canvas. */
const WARNING_CARD_BG = [57, 62, 88];

/** Where ERROR text can appear. Not the warning tint — nothing red renders there. */
const ERROR_TEXT_SURFACES: Array<[string, number[]]> = [
  ['page canvas', PAGE_CANVAS_BG],
  ['dialog paper', DIALOG_PAPER_BG],
  ['card / paper', NORMAL_CARD_BG],
];

const BODY_FLOOR = 4.5;
const LARGE_FLOOR = 3;

describe('status-colour contrast', () => {
  describe('the Overdue card is amber, and amber is readable', () => {
    it('clears the body floor with headroom', () => {
      // Label, count and money are all painted in this colour.
      const ratio = contrast(hexToRgb(theme.palette.warning.light), WARNING_CARD_BG);
      expect(ratio).toBeGreaterThanOrEqual(BODY_FLOOR);
      // Headroom, not a squeak: the standard is measured against a bright shop
      // floor and treated as a hard limit.
      expect(ratio).toBeGreaterThanOrEqual(5);
    });

    it('records why warning.main is not the text colour, though it would pass', () => {
      // The interesting exemption. Unlike error.main, warning.main DOES clear the
      // floor here — at 4.89:1, which is 0.39 above a hard limit. `light` is used
      // anyway, and this pins the reasoning so nobody "simplifies" it back.
      const main = contrast(hexToRgb(theme.palette.warning.main), WARNING_CARD_BG);
      expect(main).toBeGreaterThanOrEqual(BODY_FLOOR);
      expect(main).toBeLessThan(5);
      expect(contrast(hexToRgb(theme.palette.warning.light), WARNING_CARD_BG)).toBeGreaterThan(main);
    });

    it('keeps warning.main usable for the rule and the tint', () => {
      // Non-text, SC 1.4.11, 3:1. The border is what still makes the card read
      // as an alert once the text stopped being red.
      expect(contrast(hexToRgb(theme.palette.warning.main), WARNING_CARD_BG)).toBeGreaterThanOrEqual(
        LARGE_FLOOR,
      );
    });
  });

  describe('error.main is not a text colour on a lifted surface', () => {
    it('is readable as error.light on every surface error text reaches', () => {
      // The reason the rule can be "error.light for error text" full stop, rather
      // than "it depends which panel it lands on".
      for (const [name, bg] of ERROR_TEXT_SURFACES) {
        const ratio = contrast(hexToRgb(theme.palette.error.light), bg);
        expect(ratio, `error.light on ${name}`).toBeGreaterThanOrEqual(BODY_FLOOR);
      }
    });

    it('records that error.main is text-safe ONLY on the raw canvas', () => {
      // Which is where text almost never sits. If a future palette change makes
      // error.main readable on a card, this fails and the rule gets revisited
      // rather than silently outliving it.
      expect(contrast(hexToRgb(theme.palette.error.main), PAGE_CANVAS_BG)).toBeGreaterThanOrEqual(
        BODY_FLOOR,
      );
      for (const [name, bg] of [
        ['dialog paper', DIALOG_PAPER_BG],
        ['card / paper', NORMAL_CARD_BG],
      ] as Array<[string, number[]]>) {
        const ratio = contrast(hexToRgb(theme.palette.error.main), bg);
        expect(ratio, `error.main on ${name} should still be failing`).toBeLessThan(BODY_FLOOR);
      }
    });

    it('keeps error.main usable for icons, which answer to 3:1 not 4.5:1', () => {
      // SC 1.4.11 non-text contrast. This is why the 15 error-coloured icons were
      // measured and left alone rather than swept along with the text.
      for (const [name, bg] of ERROR_TEXT_SURFACES) {
        const ratio = contrast(hexToRgb(theme.palette.error.main), bg);
        expect(ratio, `error.main icon on ${name}`).toBeGreaterThanOrEqual(LARGE_FLOOR);
      }
    });
  });

  it('leaves the upward delta alone, because green already passes', () => {
    expect(
      contrast(hexToRgb(theme.palette.success.main), NORMAL_CARD_BG),
    ).toBeGreaterThanOrEqual(BODY_FLOOR);
  });
});
