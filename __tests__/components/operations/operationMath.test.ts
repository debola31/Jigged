import { describe, it, expect } from 'vitest';

import {
  operationCompletionConsequence,
  operationQtyRemaining,
  completionConsequenceCaption,
} from '@/components/operations/operationMath';

// Acceptance criteria AC1–AC5 from the design doc
// (docs/modules/partial-operation-completion-design.md).

describe('operationQtyRemaining', () => {
  it('AC1: remaining = target − good, clamped ≥ 0', () => {
    expect(operationQtyRemaining(12, 0)).toBe(12); // nothing done → full order remains
    expect(operationQtyRemaining(12, 3)).toBe(9);
    expect(operationQtyRemaining(12, 12)).toBe(0);
    // over-completed op shows 0 remaining, never negative
    expect(operationQtyRemaining(12, 30)).toBe(0);
  });
});

describe('operationCompletionConsequence', () => {
  it('AC4: none for empty, zero, negative, or non-numeric input', () => {
    expect(operationCompletionConsequence('', 9).kind).toBe('none');
    expect(operationCompletionConsequence('0', 9).kind).toBe('none');
    expect(operationCompletionConsequence('-3', 9).kind).toBe('none');
    expect(operationCompletionConsequence('abc', 9).kind).toBe('none');
  });

  it('AC2: full when the quantity closes out the remaining', () => {
    expect(operationCompletionConsequence('9', 9)).toEqual({ kind: 'full' });
    expect(operationCompletionConsequence(12, 12)).toEqual({ kind: 'full' });
  });

  it('AC3: partial with the leftover that stays outstanding', () => {
    expect(operationCompletionConsequence('3', 9)).toEqual({ kind: 'partial', leftover: 6 });
  });

  it('AC5: over-completion boundary — 30 entered when only 9 remain is `over`, not blocked', () => {
    // target 12, good 3 so far → remaining 9; entering 30 over-completes by 21.
    // The consequence is a warning; the caller still allows submit.
    expect(operationCompletionConsequence('30', 9)).toEqual({ kind: 'over', excess: 21 });
  });

  it('treats an over-completed op (remaining already clamped to 0) as over', () => {
    expect(operationCompletionConsequence('5', 0)).toEqual({ kind: 'over', excess: 5 });
  });
});

describe('completionConsequenceCaption', () => {
  it('maps each consequence to its shop-floor copy', () => {
    expect(completionConsequenceCaption({ kind: 'none' })).toBe('');
    expect(completionConsequenceCaption({ kind: 'full' })).toBe('Completes this operation');
    expect(completionConsequenceCaption({ kind: 'partial', leftover: 6 })).toBe('6 will remain');
    expect(completionConsequenceCaption({ kind: 'over', excess: 21 })).toBe('Over by 21');
  });
});
