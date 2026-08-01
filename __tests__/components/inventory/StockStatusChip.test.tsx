import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../test-utils';
import StockStatusChip, {
  deriveStockStatus,
  shortfall,
} from '@/components/inventory/StockStatusChip';

describe('deriveStockStatus', () => {
  it('returns "out" when quantity is 0, regardless of reorder point', () => {
    expect(deriveStockStatus(0, null)).toBe('out');
    expect(deriveStockStatus(0, 5)).toBe('out');
    expect(deriveStockStatus(0, 0)).toBe('out');
  });

  it('returns "low" when quantity > 0 but at or below the reorder point', () => {
    expect(deriveStockStatus(3, 5)).toBe('low');
    expect(deriveStockStatus(5, 5)).toBe('low'); // boundary: <= treats equal as low
    expect(deriveStockStatus(0.5, 1)).toBe('low');
  });

  it('returns "in_stock" when quantity > reorder point', () => {
    expect(deriveStockStatus(10, 5)).toBe('in_stock');
    expect(deriveStockStatus(100, 50)).toBe('in_stock');
  });

  it('returns "in_stock" when quantity > 0 and reorder point is null/undefined', () => {
    expect(deriveStockStatus(1, null)).toBe('in_stock');
    expect(deriveStockStatus(1, undefined)).toBe('in_stock');
    expect(deriveStockStatus(0.0001, null)).toBe('in_stock');
  });

  it('treats quantity null/undefined as 0 (out of stock)', () => {
    // Defensive: callers should pass the part's actual quantity, but a null
    // here should not silently render "in stock".
    expect(deriveStockStatus(null, null)).toBe('out');
    expect(deriveStockStatus(undefined, 5)).toBe('out');
  });
});

describe('StockStatusChip', () => {
  it('renders "Out of stock" label for status="out"', () => {
    render(<StockStatusChip status="out" />);
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
  });

  it('renders "Low" label for status="low"', () => {
    render(<StockStatusChip status="low" />);
    expect(screen.getByText('Low')).toBeInTheDocument();
  });

  it('renders "In stock" label for status="in_stock"', () => {
    render(<StockStatusChip status="in_stock" />);
    expect(screen.getByText('In stock')).toBeInTheDocument();
  });
});

/**
 * Powers the "Short by" column on `?status=low`. Derived like `deriveStockStatus`, never stored,
 * so the two cannot disagree about whether a part is short.
 */
describe('shortfall', () => {
  it('is the gap to the reorder point', () => {
    expect(shortfall(4, 10)).toBe(6);
  });

  /** At the line IS on the buy list. Collapsing equality to null drops the row it exists to catch. */
  it('is zero at the line, not null', () => {
    expect(shortfall(10, 10)).toBe(0);
  });

  it('is null above the line', () => {
    expect(shortfall(50, 10)).toBeNull();
  });

  /** No reorder point is not a shortfall of the whole quantity — the question does not apply. */
  it('is null when no reorder point is set', () => {
    expect(shortfall(0, null)).toBeNull();
    expect(shortfall(0, undefined)).toBeNull();
  });

  it('treats a missing quantity as none on hand', () => {
    expect(shortfall(null, 10)).toBe(10);
  });
});
