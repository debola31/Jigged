import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import { mapReactions } from '@/utils/operatorAccess';
import type { ReactionRel } from '@/utils/operatorAccess';
import { addNoteMedia, uploadNoteMediaFile } from '@/utils/jobNoteMediaAccess';
import type { JobNoteMedia } from '@/types/operator';
import type {
  MachineDetails,
  MachineLog,
  MachineNote,
  MaintenanceKind,
} from '@/types/machineMaintenance';

/**
 * Machine Maintenance — reading and writing one machine's logbook.
 * See docs/modules/machine-maintenance.md.
 *
 * An entry is a `notes` row with subject_kind='work_center', so everything the
 * notes system already does comes along unchanged: attribution resolved
 * server-side, photos in note_media, `helpful` reactions, view logging, the
 * billing gate. Nothing here re-implements any of that.
 *
 * WHAT THIS FILE IS ACTUALLY FOR is the one thing the notes system does not
 * already do: deriving open state. There is no `is_open` column and there must
 * never be one — see getMachineLog.
 */

// usage_count is DELIBERATELY ABSENT from this select. It counts distinct JOBS a
// note was consulted on, and a machine read carries no job, so it is permanently
// zero here; §8 says it must never be displayed on this surface. Not fetching it
// is a stronger guarantee than remembering not to render it.
const MACHINE_NOTE_SELECT =
  'id, work_center_id, body, maintenance_kind, resolves_note_id, ' +
  'created_at, edited_at, viewer_count, author_id, ' +
  'author:user_company_access(name), ' +
  'reactions:note_reactions(kind, reactor_id, reactor:user_company_access(name)), ' +
  'media:note_media(id, note_id, storage_path, thumbnail_path, kind, mime_type, width, height)';

const MACHINE_DETAIL_COLUMNS = 'make, model, serial_number, year_built, purchased_on';

type MachineNoteRow = {
  id: string;
  work_center_id: string;
  body: string | null;
  maintenance_kind: string | null;
  resolves_note_id: string | null;
  created_at: string;
  edited_at: string | null;
  viewer_count: number;
  author_id: string | null;
  author: { name: string | null } | { name: string | null }[] | null;
  reactions: ReactionRel[] | null;
  media: Array<{
    id: string;
    note_id: string;
    storage_path: string;
    thumbnail_path: string | null;
    kind: string;
    mime_type: string | null;
    width: number | null;
    height: number | null;
  }> | null;
};

const KINDS = new Set<string>(['cleaned', 'repaired', 'replaced', 'adjusted', 'noticed']);

function narrowKind(value: string | null): MaintenanceKind | null {
  return value != null && KINDS.has(value) ? (value as MaintenanceKind) : null;
}

function rowToNote(row: MachineNoteRow): MachineNote {
  const author = Array.isArray(row.author) ? row.author[0] : row.author;
  const media: JobNoteMedia[] = (row.media ?? []).map((m) => ({
    id: m.id,
    note_id: m.note_id,
    storage_path: m.storage_path,
    thumbnail_path: m.thumbnail_path,
    kind: m.kind === 'video' ? 'video' : 'photo',
    mime_type: m.mime_type,
    width: m.width,
    height: m.height,
  }));

  return {
    id: row.id,
    work_center_id: row.work_center_id,
    body: row.body,
    maintenance_kind: narrowKind(row.maintenance_kind),
    resolves_note_id: row.resolves_note_id,
    created_at: row.created_at,
    edited_at: row.edited_at,
    author_name: author?.name ?? null,
    author_id: row.author_id,
    viewer_count: row.viewer_count,
    media,
    reactions: mapReactions(row.reactions),
  };
}

/**
 * Split a machine's timeline into the whole log and the still-open observations.
 *
 * Exported for its own test: this is the module's only real piece of logic, and
 * it is the reason there is no stored state to go stale.
 *
 * OPEN = a 'noticed' entry that nothing in this same array resolves. Two
 * properties make that trustworthy rather than approximate:
 *
 *   - It is COMPLETE. A resolver is required by the database to sit on the same
 *     work center as its target, so every resolver of anything in `entries` is
 *     itself in `entries`. There is no second query that could miss one.
 *   - It CANNOT DISAGREE with the timeline, because it is the timeline. The
 *     alternative — a stored resolved flag — is two sources of truth for one
 *     fact, and would also have required an UPDATE grant on an append-only table.
 */
export function deriveOpenItems(entries: MachineNote[]): MachineNote[] {
  const resolved = new Set<string>();
  for (const e of entries) {
    if (e.resolves_note_id) resolved.add(e.resolves_note_id);
  }
  return entries.filter((e) => e.maintenance_kind === 'noticed' && !resolved.has(e.id));
}

/**
 * One machine's whole log, newest first, in a single query.
 *
 * Not paginated, and that is a decision rather than an omission: a shop this
 * size will not accumulate a timeline worth paging for years, and paging would
 * break the open-items derivation above by letting a resolver fall off the page
 * its target is on — reopening an item that was in fact fixed.
 */
export async function getMachineLog(
  workCenterId: string,
  companyId: string,
): Promise<MachineLog> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('notes')
    .select(MACHINE_NOTE_SELECT)
    .eq('company_id', companyId)
    .eq('work_center_id', workCenterId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  const entries = ((data ?? []) as unknown as MachineNoteRow[]).map(rowToNote);
  return { entries, open: deriveOpenItems(entries) };
}

/**
 * Append an entry to a machine's log.
 *
 * `authorId` is the writer's user_company_access id. RLS re-derives it
 * server-side, so an entry is always written as the person writing it and cannot
 * be attributed to anyone else — including by an admin, deliberately.
 *
 * `body` may be null for a photos-only entry; callers must guarantee
 * body-or-photo, since an entirely empty entry says nothing.
 */
export async function addMachineNote(
  workCenterId: string,
  companyId: string,
  authorId: string,
  body: string | null,
  opts?: {
    maintenanceKind?: MaintenanceKind | null;
    /** The 'noticed' entry this one fixes. Must be on this same machine. */
    resolvesNoteId?: string | null;
  },
): Promise<MachineNote> {
  const supabase = getSupabase();
  const trimmed = body?.trim() || null;

  const { data, error } = await supabase
    .from('notes')
    .insert({
      company_id: companyId,
      subject_kind: 'work_center',
      work_center_id: workCenterId,
      author_id: authorId,
      body: trimmed,
      note_type: 'user',
      maintenance_kind: opts?.maintenanceKind ?? null,
      resolves_note_id: opts?.resolvesNoteId ?? null,
    })
    .select(MACHINE_NOTE_SELECT)
    .single();

  if (error) {
    throw new Error(
      friendlyErrorMessage(error, { entity: 'entry', fallback: 'Could not save that.' }),
    );
  }

  return rowToNote(data as unknown as MachineNoteRow);
}

/**
 * Upload half of `addMachineNoteMedia`, for the composer's upload-then-commit order. A machine
 * photo files beside the machine rather than under a job — that folder choice is the only thing
 * that differs from the job path, which is why it is all the split covers.
 */
export function uploadMachineNoteMediaFile(
  companyId: string,
  workCenterId: string,
  file: File,
): Promise<string> {
  return uploadNoteMediaFile(companyId, file, {
    entityType: 'work-centers',
    entityId: workCenterId,
  });
}

/** Attach one already-compressed photo to a machine entry. */
export function addMachineNoteMedia(
  companyId: string,
  workCenterId: string,
  noteId: string,
  file: File,
  opts?: { dims?: { width: number; height: number } },
): Promise<JobNoteMedia> {
  return addNoteMedia(companyId, noteId, file, {
    folder: { entityType: 'work-centers', entityId: workCenterId },
    dims: opts?.dims,
  });
}

/**
 * A machine's optional attributes.
 *
 * A by-id read, so it does NOT filter deleted_at: an archived machine's page
 * stays reachable by direct link and its knowledge stays readable — archiving
 * hides a machine from pickers, not its history (§9).
 *
 * `companyId` is a DIFFERENT axis from archival and is required. RLS lets a user
 * read work centers in every company they belong to, so without this filter a
 * machine id from another company resolves and its make/model/serial render as
 * though they belonged to the company on screen. That is not hypothetical: a
 * stale cross-company station selection did exactly that, and in demo mode —
 * where the demo tenant is seeded from a real shop — it put a real customer's
 * machine serial inside the demo. Matches `getMachineLog` below.
 */
export async function getMachineDetails(
  workCenterId: string,
  companyId: string,
): Promise<MachineDetails | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .select(MACHINE_DETAIL_COLUMNS)
    .eq('id', workCenterId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    make: data.make,
    model: data.model,
    serial_number: data.serial_number,
    year_built: data.year_built,
    purchased_on: data.purchased_on,
  };
}
