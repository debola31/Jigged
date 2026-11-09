import { describe, it, expect, vi, beforeEach } from 'vitest';

import { COMPANY_NOT_FOUND, assistantAccessRefusal, resolveCompany, type CompanyInScope } from '@/lib/mcp/company';

/**
 * Which company an assistant's call acts in. The demo cases are the reason this file exists: a
 * demo answers to its real company, so a stale mirrored membership in the demo never decides.
 */

interface AccessRow {
  role: string;
  companies: { id: string; name: string; is_demo: boolean; settings: unknown } | null;
}

// The database as the caller can see it under RLS.
let sourceOfDemo: Record<string, string> = {};
let accessByCompany: Record<string, AccessRow> = {};
let demoMemberships = new Set<string>();

function query(table: string, columns: string) {
  const filters: Record<string, string> = {};
  const builder = {
    eq(column: string, value: string) {
      filters[column] = value;
      return builder;
    },
    async maybeSingle() {
      if (table === 'companies') {
        const source = sourceOfDemo[filters.demo_company_id];
        return { data: source ? { id: source } : null, error: null };
      }
      if (columns === 'id') {
        return { data: demoMemberships.has(filters.company_id) ? { id: 'mirror-row' } : null, error: null };
      }
      return { data: accessByCompany[filters.company_id] ?? null, error: null };
    },
  };
  return builder;
}

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ from: (table: string) => ({ select: (columns: string) => query(table, columns) }) }),
}));

const mockSync = vi.fn();
vi.mock('@/utils/demoAccess', () => ({ syncDemoAccess: (...a: unknown[]) => mockSync(...a) }));

const caller = { token: 't', clientId: 'c', userId: 'user-1', email: null, expiresAt: 0 };

const REAL = 'real-co';
const DEMO = 'demo-co';
const acme = (role: string, extra: Partial<AccessRow['companies']> = {}): AccessRow => ({
  role,
  companies: { id: REAL, name: 'Acme Machining', is_demo: false, settings: { features: {} }, ...extra },
});

describe('resolveCompany', () => {
  beforeEach(() => {
    sourceOfDemo = {};
    accessByCompany = {};
    demoMemberships = new Set();
    mockSync.mockReset().mockResolvedValue(undefined);
  });

  it('resolves a company where the caller holds an office role', async () => {
    accessByCompany[REAL] = acme('user');
    const res = await resolveCompany(caller, REAL);
    expect(res).toEqual({
      ok: true,
      company: {
        id: REAL,
        name: 'Acme Machining',
        role: 'user',
        isDemo: false,
        governingCompanyId: REAL,
        settings: { features: {} },
      },
    });
  });

  it('answers not-found for a company the caller is not in', async () => {
    expect(await resolveCompany(caller, REAL)).toEqual({ ok: false, message: COMPANY_NOT_FOUND });
  });

  it('refuses an operator by name', async () => {
    accessByCompany[REAL] = acme('operator');
    const res = await resolveCompany(caller, REAL);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/operator in Acme Machining/);
  });

  it('resolves a demo through its real company, and mirrors membership the caller lacks', async () => {
    sourceOfDemo[DEMO] = REAL;
    accessByCompany[REAL] = acme('admin');
    const res = await resolveCompany(caller, DEMO);
    expect(res).toEqual({
      ok: true,
      company: expect.objectContaining({
        id: DEMO,
        name: 'Acme Machining (demo)',
        role: 'admin',
        isDemo: true,
        governingCompanyId: REAL,
      }),
    });
    expect(mockSync).toHaveBeenCalledWith(REAL, DEMO);
  });

  it('does not re-mirror a demo membership that already exists', async () => {
    sourceOfDemo[DEMO] = REAL;
    accessByCompany[REAL] = acme('admin');
    demoMemberships.add(DEMO);
    await resolveCompany(caller, DEMO);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("goes by the real company's role, not a stale admin row in the demo", async () => {
    sourceOfDemo[DEMO] = REAL;
    accessByCompany[REAL] = acme('operator');
    accessByCompany[DEMO] = { role: 'admin', companies: { id: DEMO, name: 'Acme - Demo', is_demo: true, settings: null } };
    const res = await resolveCompany(caller, DEMO);
    expect(res.ok).toBe(false);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('treats a leftover demo membership as no access once the caller has left the company', async () => {
    // The source is invisible (no longer a member), so only the demo's own row is found.
    accessByCompany[DEMO] = { role: 'admin', companies: { id: DEMO, name: 'Acme - Demo', is_demo: true, settings: null } };
    expect(await resolveCompany(caller, DEMO)).toEqual({ ok: false, message: COMPANY_NOT_FOUND });
  });
});

describe('assistantAccessRefusal', () => {
  const company = (features: Record<string, boolean>): CompanyInScope => ({
    id: REAL,
    name: 'Acme Machining',
    role: 'admin',
    isDemo: false,
    governingCompanyId: REAL,
    settings: { features },
  });

  it('allows reads and writes by default', () => {
    expect(assistantAccessRefusal(company({}), false)).toBeNull();
    expect(assistantAccessRefusal(company({}), true)).toBeNull();
  });

  it('turned off refuses everything', () => {
    expect(assistantAccessRefusal(company({ ai_assistants: false }), false)).toMatch(/turned off/);
  });

  it('read-only refuses writes only', () => {
    expect(assistantAccessRefusal(company({ ai_assistant_writes: false }), false)).toBeNull();
    expect(assistantAccessRefusal(company({ ai_assistant_writes: false }), true)).toMatch(/read-only/);
  });
});
