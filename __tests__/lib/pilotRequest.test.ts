import { describe, it, expect } from 'vitest';

import {
  PILOT_MAX_FILE_BYTES,
  parsePilotRequestBody,
  pilotContentType,
  pilotFileExtension,
  pilotFileProblem,
  pilotFileType,
  pilotStoragePath,
} from '@/lib/pilotRequest';

const ID = '3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f';

const VALID = {
  email: '  Owner@Shop.Example ',
  name: 'Pat',
  company_name: '',
  note: null,
  file_name: 'bracket.STEP',
  file_size: 1024,
  website: '',
};

describe('pilotFileType — by extension, never by MIME', () => {
  it.each([
    ['bracket.step', 'step'],
    ['bracket.STP', 'step'],
    ['housing.igs', 'iges'],
    ['housing.iges', 'iges'],
    ['shaft.x_t', 'parasolid'],
    ['shaft.X_B', 'parasolid'],
    ['plate.SLDPRT', 'solidworks'],
    ['drawing.pdf', 'pdf'],
  ])('%s is %s', (name, type) => {
    expect(pilotFileType(name)).toBe(type);
  });

  it.each(['part.stl', 'part.dwg', 'part.step.exe', 'step', '.step', 'part.'])('refuses %s', (name) => {
    expect(pilotFileType(name)).toBeNull();
  });

  it('sends PDF as a PDF and every CAD format as octet-stream — the bucket allows exactly those', () => {
    expect(pilotContentType('pdf')).toBe('application/pdf');
    expect(pilotContentType('step')).toBe('application/octet-stream');
    expect(pilotContentType('parasolid')).toBe('application/octet-stream');
  });
});

describe('pilotFileExtension — the format for analytics, never the name', () => {
  it.each([
    ['acme-bracket-rev3.STEP', 'step'],
    ['flange.dxf', 'dxf'],
    ['housing.x_t', 'other'],
    ['no-extension', 'none'],
    ['.hidden', 'none'],
    ['trailing.', 'none'],
    ['weird.verylongextension', 'other'],
    ['customer name.with spaces', 'other'],
  ])('%s → %s', (name, ext) => {
    expect(pilotFileExtension(name)).toBe(ext);
  });
});

describe('pilotFileProblem', () => {
  it('accepts a file at exactly the limit and refuses one byte over', () => {
    expect(pilotFileProblem({ name: 'a.step', size: PILOT_MAX_FILE_BYTES })).toBeNull();
    expect(pilotFileProblem({ name: 'a.step', size: PILOT_MAX_FILE_BYTES + 1 })).toMatch(/over 50 MB/);
  });

  it('refuses an empty file and a wrong format', () => {
    expect(pilotFileProblem({ name: 'a.step', size: 0 })).toMatch(/empty/);
    expect(pilotFileProblem({ name: 'a.zip', size: 10 })).toMatch(/STEP/);
  });
});

describe('pilotStoragePath — the server-minted key', () => {
  it('files under the request id and keeps the extension whole', () => {
    expect(pilotStoragePath(ID, 'Shaft Rev B.x_t')).toBe(`${ID}/Shaft_Rev_B.x_t`);
  });

  it('truncates the stem, never the extension', () => {
    const path = pilotStoragePath(ID, `${'a'.repeat(200)}.x_b`);
    expect(path.endsWith('.x_b')).toBe(true);
    expect(path.length).toBe(ID.length + 1 + 80 + 4);
  });

  it('cannot be steered out of its folder', () => {
    const path = pilotStoragePath(ID, '../../other-request/evil.step');
    expect(path.startsWith(`${ID}/`)).toBe(true);
    expect(path.slice(ID.length + 1)).not.toContain('/');
    expect(path).not.toContain('..');
  });

  it('names a nameless stem', () => {
    expect(pilotStoragePath(ID, '###.pdf')).toBe(`${ID}/part.pdf`);
  });
});

describe('parsePilotRequestBody', () => {
  it('normalises the email and turns blank optionals into null', () => {
    const parsed = parsePilotRequestBody(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.honeypot).toBe(false);
    expect(parsed.value).toEqual({
      email: 'owner@shop.example',
      name: 'Pat',
      company_name: null,
      note: null,
      file_name: 'bracket.STEP',
      file_size: 1024,
      file_type: 'step',
    });
  });

  it('requires a valid email and a file it can take', () => {
    expect(parsePilotRequestBody({ ...VALID, email: '' }).ok).toBe(false);
    expect(parsePilotRequestBody({ ...VALID, email: 'not-an-email' }).ok).toBe(false);
    expect(parsePilotRequestBody({ ...VALID, file_name: 'model.stl' }).ok).toBe(false);
    expect(parsePilotRequestBody({ ...VALID, file_size: PILOT_MAX_FILE_BYTES + 1 }).ok).toBe(false);
    expect(parsePilotRequestBody({ ...VALID, file_size: '1024' }).ok).toBe(false);
    expect(parsePilotRequestBody(null).ok).toBe(false);
  });

  it('refuses an over-long field rather than silently truncating it', () => {
    expect(parsePilotRequestBody({ ...VALID, note: 'x'.repeat(4001) }).ok).toBe(false);
    expect(parsePilotRequestBody({ ...VALID, note: 'x'.repeat(4000) }).ok).toBe(true);
  });

  it('flags a filled honeypot', () => {
    const parsed = parsePilotRequestBody({ ...VALID, website: 'http://spam.example' });
    expect(parsed.ok && parsed.honeypot).toBe(true);
  });

  it('has nowhere to put a storage path, content type or file type', () => {
    const parsed = parsePilotRequestBody({
      ...VALID,
      storage_path: 'someone-else/x.step',
      content_type: 'text/html',
      file_type: 'pdf',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.file_type).toBe('step');
    expect(JSON.stringify(parsed.value)).not.toContain('someone-else');
    expect(JSON.stringify(parsed.value)).not.toContain('text/html');
  });
});
