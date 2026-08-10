import { describe, it, expect, vi } from 'vitest';

import { drawShopHeaderBlock } from '@/utils/packingSlipPdf';
import type { Company } from '@/utils/companyAccess';

/**
 * The shop header block — logo above, address beneath, sized to the space the header already has.
 *
 * **The property under test is that the logo is free.** A document header is as tall as its tallest
 * column, and on all three documents that is the right one. Every point of the left column above
 * that line costs the page nothing, and the whole point of this block is to spend it. A regression
 * here is silent: the logo just gets small again, exactly as it was when it sat in a 56×56 box while
 * the header had 110pt to give.
 */

const company: Company = {
  id: 'c1',
  name: 'L&L Machine & Tool',
  address_line1: '1495 Valencia Street, Apt 5',
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94110',
  country: 'USA',
  phone: '(817) 448-4963',
};

/** A 1.44:1 landscape wordmark — the shape a shop logo usually is. */
const WIDE = { width: 1484, height: 1030, fileType: 'PNG' };

function target(props: { width: number; height: number; fileType: string } | null = WIDE) {
  const addImage = vi.fn();
  const text = vi.fn();
  return {
    addImage,
    text,
    doc: {
      getImageProperties: () => {
        if (!props) throw new Error('unreadable');
        return props;
      },
      addImage,
      setFont: vi.fn(),
      setFontSize: vi.fn(),
      setTextColor: vi.fn(),
      text,
    },
  };
}

/** The quote's real geometry: header runs 40 → 150, so 110pt is available. */
const QUOTE = { x: 40, y: 40, availableBottom: 150 };

const drawn = (t: ReturnType<typeof target>) => t.text.mock.calls.map((c) => c[0]);
const logo = (t: ReturnType<typeof target>) => {
  const [, , x, y, w, h] = t.addImage.mock.calls[0];
  return { x, y, w, h };
};

describe('drawShopHeaderBlock — the logo is free', () => {
  it('never draws past the height the header already occupies', () => {
    const t = target();
    const bottom = drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false, ...QUOTE,
    });
    expect(bottom).toBeLessThanOrEqual(QUOTE.availableBottom);
  });

  it('is far larger than the 56pt box it replaced', () => {
    const t = target();
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false, ...QUOTE,
    });
    expect(logo(t).w).toBeGreaterThan(56);
  });

  it('preserves the aspect ratio — a wordmark is never squashed', () => {
    const t = target();
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false, ...QUOTE,
    });
    const { w, h } = logo(t);
    expect(w / h).toBeCloseTo(1484 / 1030, 5);
  });

  it('stacks the text under the logo, not beside it', () => {
    const t = target();
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false, ...QUOTE,
    });
    const { x, y, h } = logo(t);
    // Every text baseline sits below the logo and starts at the same left edge.
    const ys = t.text.mock.calls.map((c) => c[2] as number);
    const xs = t.text.mock.calls.map((c) => c[1] as number);
    expect(Math.min(...ys)).toBeGreaterThan(y + h);
    expect(new Set(xs)).toEqual(new Set([x]));
  });
});

describe('drawShopHeaderBlock — the "logo includes my name" answer', () => {
  it('prints the company name when the logo does not contain it', () => {
    const t = target();
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false, ...QUOTE,
    });
    expect(drawn(t)).toContain('L&L Machine & Tool');
  });

  /**
   * **The document must never go out unnamed.**
   *
   * `logoIncludesName` is a claim about the logo, so it means nothing without one — and a shop
   * reaches that state trivially: tick the box, then remove the logo. Honouring the setting anyway
   * printed a quote with no company name anywhere on it, which is the exact outcome the setting
   * exists to prevent.
   */
  it('still prints the name when the box is ticked but there is no logo', () => {
    const t = target();
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: null, logoIncludesName: true, ...QUOTE,
    });
    expect(drawn(t)).toContain('L&L Machine & Tool');
  });

  it('still prints the name when the logo was ticked but could not be read', () => {
    const t = target(null);
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,broken', logoIncludesName: true, ...QUOTE,
    });
    expect(t.addImage).not.toHaveBeenCalled();
    expect(drawn(t)).toContain('L&L Machine & Tool');
  });

  it('still prints the name when the header was too short to draw the logo', () => {
    const t = target();
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: true,
      x: 40, y: 40, availableBottom: 70,
    });
    expect(t.addImage).not.toHaveBeenCalled();
    expect(drawn(t)).toContain('L&L Machine & Tool');
  });

  it('omits it when the logo already says it', () => {
    const t = target();
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: true, ...QUOTE,
    });
    expect(drawn(t)).not.toContain('L&L Machine & Tool');
    // …and the address survives; suppressing the name must not suppress the block.
    expect(drawn(t)).toContain('San Francisco, CA 94110');
  });

  /**
   * The trade that makes the checkbox worth asking about: a stacked layout spends budget on text,
   * so removing a line of text hands it back to the logo. This is the number that argues for the
   * setting existing at all.
   */
  it('gives the logo more room when the name is not printed', () => {
    const withName = target();
    const withoutName = target();
    drawShopHeaderBlock(withName.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false, ...QUOTE,
    });
    drawShopHeaderBlock(withoutName.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: true, ...QUOTE,
    });
    expect(logo(withoutName).w).toBeGreaterThan(logo(withName).w);
  });
});

describe('drawShopHeaderBlock — it never breaks a document', () => {
  it('prints the text exactly as before when there is no logo', () => {
    const t = target();
    const bottom = drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: null, logoIncludesName: false, ...QUOTE,
    });
    expect(t.addImage).not.toHaveBeenCalled();
    expect(drawn(t)).toContain('L&L Machine & Tool');
    expect(bottom).toBeLessThanOrEqual(QUOTE.availableBottom);
  });

  it('falls back to text when the image cannot be read', () => {
    const t = target(null);
    expect(() =>
      drawShopHeaderBlock(t.doc, {
        company, logoDataUrl: 'data:image/png;base64,broken', logoIncludesName: false, ...QUOTE,
      }),
    ).not.toThrow();
    expect(t.addImage).not.toHaveBeenCalled();
    expect(drawn(t)).toContain('L&L Machine & Tool');
  });

  it('draws no logo at all rather than a squashed one when the header is too short for it', () => {
    const t = target();
    // A header with almost no right column — the text alone already fills it.
    drawShopHeaderBlock(t.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false,
      x: 40, y: 40, availableBottom: 70,
    });
    expect(t.addImage).not.toHaveBeenCalled();
    expect(drawn(t)).toContain('L&L Machine & Tool');
  });

  /**
   * The traveler's right column is taller on a hot job (the HOT stamp extends it). Without a cap the
   * same shop's logo would print bigger on a hot traveler than a cold one — the same paperwork
   * disagreeing with itself about how big the mark is.
   */
  it('caps the logo so a tall right column cannot inflate it', () => {
    const normal = target();
    const veryTall = target();
    drawShopHeaderBlock(normal.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: true, ...QUOTE,
    });
    drawShopHeaderBlock(veryTall.doc, {
      company, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: true,
      x: 40, y: 40, availableBottom: 400,
    });
    expect(logo(veryTall).h).toBe(logo(normal).h);
  });

  it('handles a company with no address at all', () => {
    const t = target();
    const bare: Company = { id: 'c1', name: 'Bare Shop' };
    expect(() =>
      drawShopHeaderBlock(t.doc, {
        company: bare, logoDataUrl: 'data:image/png;base64,x', logoIncludesName: false, ...QUOTE,
      }),
    ).not.toThrow();
    expect(drawn(t)).toEqual(['Bare Shop']);
  });
});
