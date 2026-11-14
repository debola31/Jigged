import { describe, it, expect } from 'vitest';
import path from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { blankComments } from '../../scripts/analyticsEventsCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = [path.join(REPO_ROOT, 'app'), path.join(REPO_ROOT, 'components')];

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
 * CODE ONLY — comments blanked first, the same way officeNoteSurfaces does it
 * and for the same reason: the docblocks that EXPLAIN this rule name `onVoided`
 * repeatedly, and a scanner that cannot tell prose from code would pass on the
 * explanation while the code beneath it was wrong. That is the exact failure
 * mode this guard exists to catch.
 */
const SOURCES = SCAN_DIRS.flatMap(sourceFilesUnder).map((file) => ({
  rel: path.relative(REPO_ROOT, file),
  text: blankComments(readFileSync(file, 'utf8')),
}));

/** Every self-closing use of `<Name … />`, as written. */
function mountsOf(component: string): { rel: string; jsx: string }[] {
  const re = new RegExp(`<${component}\\b[\\s\\S]*?/>`, 'g');
  return SOURCES.flatMap(({ rel, text }) =>
    (text.match(re) ?? []).map((jsx) => ({ rel, jsx })),
  );
}

/**
 * A DOCUMENT MUST NOT CHANGE ITS ACTIONS DEPENDING ON WHICH CONTROL OPENED IT.
 *
 * Both preview dialogs gate Void on a prop — `canVoid = !!onVoided && !voidedAt`
 * — so a mount that omits `onVoided` silently renders a read-only copy of the
 * same document. That is not a theoretical risk: the packing slip shipped with
 * two mounts, one inside ShipmentsMenu with the handler and one on the job page
 * without it, and when the activity rail grew a slip row it reused the page's
 * copy. The slip offered Void from the toolbar and not from the feed, and
 * nothing failed — no type error, no test, no console warning. Prose did not
 * prevent it; this does.
 *
 * If a surface ever genuinely needs a read-only preview, give the dialog an
 * explicit `readOnly` prop and assert on that instead of quietly dropping the
 * handler — "no void here" should be a thing someone wrote, not a thing someone
 * forgot.
 */
/**
 * Each preview, and the action prop every one of its mounts must pass.
 *
 * The slip previews gate Void on `onVoided` (above). The purchase order and RFQ previews gate their
 * send on `onMarkedSent` the same way: "Mark as sent & download" stamps the send, and a mount that
 * forgot the handler would render the document with its main action quietly gone — or worse, stamp
 * the send and leave the page behind it showing "Draft". A closed or archived copy says
 * `readOnly` explicitly; it never drops the handler.
 */
const REQUIRED_ACTION_PROP: Record<string, string> = {
  PackingSlipPreviewDialog: 'onVoided',
  OutsideShipmentPreviewDialog: 'onVoided',
  VendorPoPreviewDialog: 'onMarkedSent',
  RfqPreviewDialog: 'onMarkedSent',
};

describe('a document preview offers the same actions wherever it is opened', () => {
  for (const [component, prop] of Object.entries(REQUIRED_ACTION_PROP)) {
    it(`every <${component}> passes ${prop}`, () => {
      const mounts = mountsOf(component);

      // Guards the guard: a renamed component would make the loop above vacuous
      // and this file would pass while checking nothing.
      expect(mounts.length).toBeGreaterThan(0);

      const missing = mounts
        .filter(({ jsx }) => !new RegExp(`\\b${prop}=`).test(jsx))
        .map(({ rel }) => rel);

      expect(missing).toEqual([]);
    });
  }
});
