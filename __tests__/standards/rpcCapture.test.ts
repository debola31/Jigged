/**
 * Enforces the one part of #708's standard that still lives in per-call-site code.
 *
 * `.from()` reads and writes are reported by the Supabase integration as configuration, so
 * there is nothing there to enforce. `.rpc()` and storage are not instrumented, and rpc is
 * additionally suppressed from the net on purpose, so those call sites are the only place a
 * human still has to write something down — and therefore the only place a rule can rot.
 */
import path from 'path';
import {
  ALLOWLIST,
  findRpcCaptureViolations,
  scanRepo,
  splitTopLevelFunctions,
} from '@/scripts/rpcCaptureCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('rpcCaptureCheck', () => {
  it('finds no unreported .rpc() or storage call in the access layer', () => {
    const violations = scanRepo(REPO_ROOT);
    const detail = violations.map((v) => `${v.file}:${v.line} ${v.fn}`).join('\n');
    expect(violations, `Unreported call sites:\n${detail}`).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    for (const [key, reason] of ALLOWLIST) {
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(30);
    }
  });

  describe('the rule itself', () => {
    it('flags an rpc call whose error branch reports nothing', () => {
      const src = `
export async function moveStock(id: string) {
  const { error } = await supabase.rpc('transfer_stock', { p_id: id });
  if (error) throw error;
}`;
      const found = findRpcCaptureViolations(src, 'utils/xAccess.ts');
      expect(found).toHaveLength(1);
      expect(found[0].fn).toBe('moveStock');
    });

    it('accepts one that reports', () => {
      const src = `
export async function moveStock(id: string) {
  const { error } = await supabase.rpc('transfer_stock', { p_id: id });
  if (error) {
    reportWriteFailure(error, { op: 'moveStock', area: 'inventory' });
    throw error;
  }
}`;
      expect(findRpcCaptureViolations(src, 'utils/xAccess.ts')).toEqual([]);
    });

    it('leaves .from() alone — that is the integration\'s job, not a call site\'s', () => {
      const src = `
export async function listParts(companyId: string) {
  const { data, error } = await supabase.from('parts').select('id').eq('company_id', companyId);
  if (error) throw error;
  return data;
}`;
      expect(findRpcCaptureViolations(src, 'utils/xAccess.ts')).toEqual([]);
    });

    it('does not trip on ".rpc()" written in a comment', () => {
      const src = `
export async function listParts(companyId: string) {
  // Uses .from() rather than .rpc() because RLS already scopes it.
  const { data } = await supabase.from('parts').select('id');
  return data;
}`;
      expect(findRpcCaptureViolations(src, 'utils/xAccess.ts')).toEqual([]);
    });

    it('flags a storage upload with no reporting', () => {
      const src = `
export async function putFile(p: string, f: File) {
  const { error } = await supabase.storage.from('b').upload(p, f);
  if (error) throw error;
}`;
      expect(findRpcCaptureViolations(src, 'utils/storageHelpers.ts')).toHaveLength(1);
    });

    it('attributes a violation to its enclosing top-level function', () => {
      const src = `
export async function first(id: string) {
  const { error } = await supabase.from('parts').select('id');
  if (error) throw error;
}

export async function second(id: string) {
  const { error } = await supabase.rpc('do_thing', { p_id: id });
  if (error) throw error;
}`;
      const found = findRpcCaptureViolations(src, 'utils/xAccess.ts');
      expect(found.map((v) => v.fn)).toEqual(['second']);
    });
  });

  describe('splitTopLevelFunctions', () => {
    it('closes a function on its own brace, not on a nested one', () => {
      const src = `
export async function outer() {
  const cb = () => { return 1; };
  if (true) { doThing(); }
  return cb;
}

export function after() {
  return 2;
}`;
      expect(splitTopLevelFunctions(src).map((f) => f.name)).toEqual(['outer', 'after']);
    });
  });
});
