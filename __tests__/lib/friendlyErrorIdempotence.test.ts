/**
 * The double-translation bug from #708, pinned.
 *
 * `addMachineNote` really did produce *"work center 853e… is not in company 7523…"* — a precise,
 * actionable message — and the operator was shown "Could not save that." Nothing swallowed it:
 * it was translated twice. The first call returned the P0001 text, `new Error(string)` dropped
 * `code`, and the second call (in `useNoteCapture`) found no code to match on and fell through
 * to the generic fallback.
 *
 * It affected every surface routing a save through `useNoteCapture`, not just maintenance.
 */
import { friendlyError, friendlyErrorMessage } from '@/lib/supabaseErrors';

const RAISED = {
  code: 'P0001',
  message: 'work center 853e003b is not in company 752325ba',
};

describe('friendlyErrorMessage is idempotent', () => {
  it('keeps a P0001 diagnostic through a second translation — the #708 regression', () => {
    // What the access layer throws.
    const thrown = friendlyError(RAISED, { entity: 'entry', fallback: 'Could not save that.' });
    expect(thrown.message).toBe(RAISED.message);

    // What the hook then does to it.
    const shown = friendlyErrorMessage(thrown, { entity: 'note', fallback: 'Could not save that.' });

    expect(shown).toBe(RAISED.message);
    expect(shown).not.toBe('Could not save that.');
  });

  it('is what the OLD idiom got wrong, so the test cannot pass vacuously', () => {
    // The exact shape that shipped: translate, then throw a bare Error.
    const legacy = new Error(friendlyErrorMessage(RAISED, { fallback: 'Could not save that.' }));
    const shown = friendlyErrorMessage(legacy, { entity: 'note', fallback: 'Could not save that.' });

    // Reproduces the bug — which is why `friendlyError` exists.
    expect(shown).toBe('Could not save that.');
  });

  it('carries code/details/hint forward, so callers can still branch on them', () => {
    const thrown = friendlyError(
      { code: '23505', message: 'duplicate key', details: 'Key (name)=(Vise) exists.' },
      { entity: 'location' },
    );

    expect((thrown as Error & { code?: string }).code).toBe('23505');
    expect((thrown as Error & { details?: string }).details).toBe('Key (name)=(Vise) exists.');
    // And the user still gets copy, not the raw text.
    expect(thrown.message).toBe('That location already exists — use a different value.');
  });

  it('does not re-derive foreign-key copy from its own prose on a second pass', () => {
    const fk = {
      code: '23503',
      message:
        'delete on table "customer_addresses" violates foreign key constraint ' +
        '"quotes_billing_address_id_fkey" on table "quotes"',
    };
    const thrown = friendlyError(fk, { entity: 'address' });
    expect(friendlyErrorMessage(thrown)).toBe(thrown.message);
    expect(thrown.message).toContain('quotes');
  });

  it('leaves an untranslated error alone', () => {
    expect(friendlyErrorMessage(new Error('boom'), { fallback: 'Nope.' })).toBe('Nope.');
  });

  it('keeps the marker off enumerable keys, so it never leaks into a Sentry extra', () => {
    const thrown = friendlyError(RAISED, { entity: 'entry' });
    expect(Object.keys({ ...thrown })).not.toContain('jigged.friendlyError');
    expect(JSON.stringify(thrown)).not.toContain('friendlyError');
  });
});
