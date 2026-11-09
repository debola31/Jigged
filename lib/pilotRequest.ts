import { isValidEmail } from '@/lib/validators';

/**
 * The rules a showcase pilot request is held to — one part file plus contact details from a
 * visitor without an account (supabase/migrations/20261105014457_showcase_pilot_requests.sql).
 *
 * Shared by the form (`app/(marketing)/showcase/_components/PilotRequest.tsx`) and the route
 * handlers under `app/pilot-requests/`, so the browser's check and the server's cannot drift. The
 * server's is the one that counts; the bucket's own size and MIME limits back it up. Isomorphic:
 * nothing here may import a server-only module, because the form bundles it.
 */

/** The private Storage bucket the files land in. */
export const PILOT_REQUEST_BUCKET = 'pilot-requests';

/**
 * 50 MiB — the bucket's `file_size_limit`, which is the global `file_size_limit` in
 * supabase/config.toml. A bucket cannot usefully exceed the project's global limit, so 100 MB
 * waits on raising both.
 */
export const PILOT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The visible size limit, worded once. */
export const PILOT_MAX_FILE_LABEL = '50 MB';

/** Bounds matching the table's CHECK constraints, so an over-long value is refused here first. */
export const PILOT_FIELD_LIMITS = {
  email: 320,
  name: 200,
  company: 200,
  note: 4000,
  fileName: 255,
} as const;

/**
 * The hidden field a person never fills and a form-filling script usually does. Named like a
 * real field on purpose, and kept out of autofill and the tab order by the form.
 */
export const PILOT_HONEYPOT_FIELD = 'website';

/** Format family — the `file_type` column and the analytics property of the same name. */
export type PilotFileType = 'step' | 'iges' | 'parasolid' | 'solidworks' | 'pdf';

/**
 * By EXTENSION, never by MIME type: a browser reports a STEP or Parasolid file as
 * `application/octet-stream`, as an empty string, or as something invented by the OS, so the
 * extension is the only signal that is the same everywhere.
 */
const EXTENSION_TYPES: Readonly<Record<string, PilotFileType>> = {
  step: 'step',
  stp: 'step',
  igs: 'iges',
  iges: 'iges',
  x_t: 'parasolid',
  x_b: 'parasolid',
  sldprt: 'solidworks',
  pdf: 'pdf',
};

/** For the file input's `accept` — a hint to the picker, not a check. */
export const PILOT_FILE_ACCEPT = Object.keys(EXTENSION_TYPES)
  .map((ext) => `.${ext}`)
  .join(',');

/** The formats, worded for a person. */
export const PILOT_FILE_FORMATS_LABEL =
  'STEP, IGES, Parasolid or SolidWorks part, or a PDF drawing';

function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

export function pilotFileType(fileName: string): PilotFileType | null {
  const ext = extensionOf(fileName);
  return ext ? (EXTENSION_TYPES[ext] ?? null) : null;
}

/**
 * A file's extension for analytics, and nothing else of its name: `step`, `dxf`, `stl`… — or
 * `none` when it has none, `other` when it is not a short run of letters and digits. The name is
 * the visitor's own business ("acme-bracket-rev3.step"); the extension says only which format
 * they reached for, which decides what the planning pipeline should learn to read next.
 */
export function pilotFileExtension(fileName: string): string {
  const ext = extensionOf(fileName);
  if (!ext) return 'none';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'other';
}

/**
 * The Content-Type the browser sends with the upload. Chosen by us, not read off the File, and
 * the bucket's `allowed_mime_types` holds exactly these two.
 */
export function pilotContentType(type: PilotFileType): 'application/pdf' | 'application/octet-stream' {
  return type === 'pdf' ? 'application/pdf' : 'application/octet-stream';
}

/** Why a chosen file cannot be sent, in words for the visitor — or null when it can. */
export function pilotFileProblem(file: { name: string; size: number }): string | null {
  if (!pilotFileType(file.name)) return `Choose a ${PILOT_FILE_FORMATS_LABEL}.`;
  if (file.name.length > PILOT_FIELD_LIMITS.fileName) return 'Rename the file to something shorter.';
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > PILOT_MAX_FILE_BYTES) return `That file is over ${PILOT_MAX_FILE_LABEL}.`;
  return null;
}

/**
 * The object key: `<request id>/<file name made safe for a key>`. Minted by the server only. The
 * name is kept, not replaced by the id, so the file downloads from the dashboard under a name the
 * team will recognise; the extension is kept whole, because truncating the stem must never cut
 * `.x_t` down to `.x_`.
 */
export function pilotStoragePath(requestId: string, fileName: string): string {
  const ext = extensionOf(fileName);
  const stem = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  const safeStem =
    stem
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 80) || 'part';
  return `${requestId}/${safeStem}${ext ? `.${ext}` : ''}`;
}

export interface PilotRequestInput {
  email: string;
  name: string | null;
  company_name: string | null;
  note: string | null;
  file_name: string;
  file_size: number;
  file_type: PilotFileType;
}

export type PilotRequestParse =
  | { ok: true; value: PilotRequestInput; honeypot: boolean }
  | { ok: false; error: string };

/** Trimmed, empty → null, and refused (not truncated) when over the limit. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : undefined;
}

/**
 * Validates the body of POST /pilot-requests. Exported for the route and its test.
 *
 * Note what is NOT here: no storage path, no IP, no content type. The server derives all three,
 * so a caller has nowhere to put one.
 */
export function parsePilotRequestBody(input: unknown): PilotRequestParse {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'Invalid request.' };
  const body = input as Record<string, unknown>;

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > PILOT_FIELD_LIMITS.email || !isValidEmail(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }

  const name = optionalText(body.name, PILOT_FIELD_LIMITS.name);
  const company = optionalText(body.company_name, PILOT_FIELD_LIMITS.company);
  const note = optionalText(body.note, PILOT_FIELD_LIMITS.note);
  if (name === undefined || company === undefined || note === undefined) {
    return { ok: false, error: 'One of the fields is too long.' };
  }

  const fileName = typeof body.file_name === 'string' ? body.file_name.trim() : '';
  const fileSize = typeof body.file_size === 'number' && Number.isInteger(body.file_size) ? body.file_size : 0;
  const fileProblem = pilotFileProblem({ name: fileName, size: fileSize });
  if (fileProblem) return { ok: false, error: fileProblem };

  const honeypot = body[PILOT_HONEYPOT_FIELD];

  return {
    ok: true,
    honeypot: typeof honeypot === 'string' && honeypot.trim() !== '',
    value: {
      email,
      name,
      company_name: company,
      note,
      file_name: fileName,
      file_size: fileSize,
      file_type: pilotFileType(fileName)!,
    },
  };
}

/** The 429 copy. No turnaround promise, no address to email — just when to try again. */
export const PILOT_RATE_LIMITED_MESSAGE =
  "We've already had several requests from you today. Please try again tomorrow.";
