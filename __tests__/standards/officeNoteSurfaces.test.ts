import { describe, it, expect } from 'vitest';
import path from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { blankComments } from '../../scripts/analyticsEventsCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');
const OFFICE_DIR = path.join(REPO_ROOT, 'components/jobs');

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFilesUnder(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * CODE ONLY — comments are blanked first, reusing the same helper the analytics
 * check uses. Without it this guard fails on the docblocks that EXPLAIN the
 * rule: JobActivityNoteRow names `useNoteDwell` and `NoteReactions` precisely to
 * say why it does not use them, and a scanner that cannot tell prose from code
 * would force that reasoning to be deleted to stay green.
 */
const OFFICE_SOURCES = sourceFilesUnder(OFFICE_DIR).map((file) => ({
  rel: path.relative(REPO_ROOT, file),
  text: blankComments(readFileSync(file, 'utf8')),
}));

/**
 * THREE THINGS THE OFFICE SURFACES MUST NOT REACH FOR, each silent if wrong.
 *
 * The job activity rail renders notes and completions the operator feed also
 * renders, which makes it permanently tempting to reuse the operator machinery
 * around them. Two of these would corrupt data nobody would think to check for
 * months, and the third would quietly empty the rail. Comments and prose are
 * not enough; this is the structural version.
 */
describe('the office job surfaces stay out of the operator-only machinery', () => {
  /**
   * `useNoteDwell` calls `log_note_views()`, which excludes only the AUTHOR and
   * metrics-excluded accounts — it resolves the viewer through
   * `get_operator_access_id`, which is role-agnostic. Wiring it into an office
   * surface would make an admin scrolling the rail increment `viewer_count` on
   * operator notes, and the author's "N people used this" would start counting
   * the office. That number's governing rule is that it must never overstate.
   */
  it('never tracks note reads — viewer_count belongs to the floor', () => {
    const offenders = OFFICE_SOURCES.filter((f) => f.text.includes('useNoteDwell')).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  /**
   * Reactions are the operator endorsement loop, and operator-view.md is
   * explicit that they must never become a per-person total. Putting the
   * control on an office surface is not obviously wrong — which is exactly why
   * it needs to be a decision somebody makes on purpose rather than something
   * that arrives with a copied row component.
   */
  it('never renders NoteReactions', () => {
    const offenders = OFFICE_SOURCES.filter((f) => f.text.includes('NoteReactions')).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  /**
   * `getFeedCompletionsForJob` is the OPERATOR reader: own rows plus office
   * ones, the surveillance guardrail in query form. The office rail wants every
   * completion on the job and uses `getJobCompletionsForOffice` instead. Using
   * the operator reader here would silently show the office only the
   * completions it recorded itself.
   */
  it('reads completions through the office reader, not the operator one', () => {
    const offenders = OFFICE_SOURCES.filter((f) =>
      f.text.includes('getFeedCompletionsForJob'),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

/**
 * The mirror of the rule above. `getJobCompletionsForOffice` has no actor
 * filter, so it must never be reachable from a surface an operator sees.
 */
describe('the operator surfaces never reach the unfiltered completion reader', () => {
  const OPERATOR_DIRS = ['components/operator', 'app/operator'];

  it('keeps getJobCompletionsForOffice out of every operator surface', () => {
    const offenders: string[] = [];
    for (const dir of OPERATOR_DIRS) {
      for (const file of sourceFilesUnder(path.join(REPO_ROOT, dir))) {
        if (blankComments(readFileSync(file, 'utf8')).includes('getJobCompletionsForOffice')) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
