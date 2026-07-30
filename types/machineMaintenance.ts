import type { JobNoteMedia, NoteReaction } from '@/types/operator';

/**
 * Machine Maintenance — the logbook for one machine.
 * See docs/modules/machine-maintenance.md.
 *
 * A machine IS a `work_centers` row with kind='internal'; there is no separate
 * machine entity, and an entry is a `notes` row with subject_kind='work_center'.
 * So this file describes a READ SHAPE, not a new domain.
 *
 * MachineNote is deliberately NOT `JobNote`. Two fields are the reason, and both
 * would be lies rather than merely unused:
 *
 *   job_id — JobNote types it as a non-nullable string and the mapper coerces
 *     the machine case to ''. A machine entry has no job at all. An empty string
 *     standing in for "there is no such thing" is exactly the sort of value that
 *     later gets passed to a route builder.
 *   usage_count — counts DISTINCT JOBS a note was consulted on, so it is
 *     permanently zero here and must never be displayed (§8). The strongest way
 *     to enforce that is for the field not to exist; the access layer does not
 *     even select the column.
 */

/**
 * Mirrors the notes_maintenance_kind_valid CHECK, which still accepts all five
 * verbs. **Only 'noticed' has a UI**, and only 'noticed' does anything: it is
 * what deriveOpenItems filters on, and therefore what pins an entry to the top
 * of a machine until somebody logs a fix.
 *
 * The other four are deliberately unused rather than pending. They had no reader
 * anywhere — nothing filtered, grouped, ranked or counted by them — so they were
 * four extra choices in a container whose whole risk is that nobody writes in
 * it. They are left in the CHECK because widening a constraint later is a
 * migration and narrowing it buys nothing; re-introducing them, if a real corpus
 * ever argues for it, is a UI change with no schema work.
 */
export type MaintenanceKind = 'cleaned' | 'repaired' | 'replaced' | 'adjusted' | 'noticed';

/** One entry on a machine's timeline. */
export interface MachineNote {
  id: string;
  work_center_id: string;
  /** Free text. Null when the entry is photos only. */
  body: string | null;
  /** Null when the author didn't classify it, which is a legal and common state. */
  maintenance_kind: MaintenanceKind | null;
  /** Set when this entry is the fix for an earlier 'noticed' one on this machine. */
  resolves_note_id: string | null;
  created_at: string;
  author_name: string | null;
  /**
   * Author's user_company_access id. Needed because reacting to your own note is
   * refused by RLS, so the control has to be hidden there rather than fail on tap.
   */
  author_id: string | null;
  /**
   * Distinct PEOPLE who have read this entry. Saturates near shop size — that is
   * what it means. Note the read-log dedupes per (note, person, job) with the
   * absent job equal to itself, so a person's repeat consultation of the same
   * entry months later is recorded once, ever (§8). That reread is precisely the
   * event a logbook would most want to see, and it is invisible.
   */
  viewer_count: number;
  media: JobNoteMedia[];
  reactions: NoteReaction[];
}

/**
 * A machine's whole log, read in one query.
 *
 * `open` is DERIVED from `entries` — the same array, filtered — and is never
 * stored anywhere. That is what makes it impossible for the open list to
 * disagree with the timeline it is drawn from (§4.4). It is complete because the
 * database guarantees a resolver always sits on the same machine as its target,
 * so every resolver is already in `entries`.
 */
export interface MachineLog {
  /** Newest first, every entry, not grouped by kind (§4.2). */
  entries: MachineNote[];
  /** Unresolved 'noticed' entries, newest first. A subset of `entries`. */
  open: MachineNote[];
}

/** A manual or reference image filed against a machine. */
export interface WorkCenterAttachment {
  id: string;
  company_id: string;
  work_center_id: string;
  storage_path: string;
  file_name: string;
  kind: 'pdf' | 'image' | 'other';
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: string;
}

/**
 * Optional machine attributes. Every field is nullable and NOTHING EVER PROMPTS
 * FOR THEM — no empty-state nudge, no completeness meter, no surface that renders
 * one machine as less ready than another because somebody typed a serial number
 * into it (§4.5).
 */
export interface MachineDetails {
  make: string | null;
  model: string | null;
  serial_number: string | null;
  year_built: number | null;
  purchased_on: string | null;
}
