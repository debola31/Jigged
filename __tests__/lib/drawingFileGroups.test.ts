import { describe, expect, it } from 'vitest';
import { classifyFile, groupDrawingFiles } from '@/lib/drawingFileGroups';

/**
 * The case that decides the shape of this module is customer #2's package: every
 * part ships as three files sharing one long stem. Getting that wrong turns a
 * 31-part folder into 93 rows.
 */

/** A file with content, so it survives the zero-byte filter. */
const f = (name: string) => new File(['drawing'], name);
const empty = (name: string) => new File([], name);

const namesOf = (files: { name: string }[]) => files.map((x) => x.name);

const CUSTOMER_STEM = '1011770-_314-092-60082-10-0000';

describe('classifyFile', () => {
  it('reads the extension, whatever its case', () => {
    expect(classifyFile('a.pdf')).toBe('pdf');
    expect(classifyFile('a.PDF')).toBe('pdf');
    expect(classifyFile('a.dxf')).toBe('dxf');
    expect(classifyFile('a.DXF')).toBe('dxf');
  });

  it('treats step and stp as the same kind', () => {
    expect(classifyFile('a.step')).toBe('step');
    expect(classifyFile('a.stp')).toBe('step');
    expect(classifyFile('a.STP')).toBe('step');
  });

  it('calls anything else other', () => {
    expect(classifyFile('notes.txt')).toBe('other');
    expect(classifyFile('bundle.zip')).toBe('other');
    expect(classifyFile('README')).toBe('other');
    expect(classifyFile('.DS_Store')).toBe('other');
  });

  it('reads only the last extension', () => {
    expect(classifyFile('drawing.pdf.bak')).toBe('other');
    expect(classifyFile('rev.a.pdf')).toBe('pdf');
  });
});

describe('groupDrawingFiles', () => {
  it('returns nothing for an empty drop', () => {
    expect(groupDrawingFiles([])).toEqual([]);
  });

  it('makes ONE group from the customer package pdf/dxf/stp', () => {
    const groups = groupDrawingFiles([
      f(`${CUSTOMER_STEM}.pdf`),
      f(`${CUSTOMER_STEM}.dxf`),
      f(`${CUSTOMER_STEM}.stp`),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stem).toBe(CUSTOMER_STEM);
    expect(groups[0].files.map((x) => x.kind).sort()).toEqual(['dxf', 'pdf', 'step']);
  });

  it('hands back the original File objects for the caller to upload', () => {
    const pdf = f(`${CUSTOMER_STEM}.pdf`);
    const dxf = f(`${CUSTOMER_STEM}.dxf`);
    const [group] = groupDrawingFiles([pdf, dxf]);
    // REFERENCE identity, via toBe. `toEqual` on a File compares nothing at all —
    // two Files with different names AND different bytes pass it — so the previous
    // assertion here was vacuous and a mutant returning a completely different
    // File survived the whole suite.
    const carried = group.files.map((x) => x.file);
    expect(carried).toHaveLength(2);
    expect(carried.some((c) => c === pdf)).toBe(true);
    expect(carried.some((c) => c === dxf)).toBe(true);
  });

  it('accepts a pdf-only part', () => {
    const groups = groupDrawingFiles([f('Backplate.pdf')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ stem: 'Backplate' });
    expect(groups[0].files[0].kind).toBe('pdf');
  });

  it('accepts a dxf-only part', () => {
    const groups = groupDrawingFiles([f('Backplate.dxf')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].files[0].kind).toBe('dxf');
  });

  it('ignores dotfiles, Thumbs.db and zero-byte files', () => {
    const groups = groupDrawingFiles([
      f('Backplate.pdf'),
      f('.DS_Store'),
      f('._Backplate.pdf'),
      f('Thumbs.db'),
      f('thumbs.db'),
      empty('Bracket.dxf'),
    ]);
    expect(groups).toHaveLength(1);
    expect(namesOf(groups[0].files)).toEqual(['Backplate.pdf']);
  });

  it('drops a group with no readable file in it', () => {
    const groups = groupDrawingFiles([f('packing-list.xlsx'), f('readme.txt')]);
    expect(groups).toEqual([]);
  });

  it('keeps an unreadable file that belongs to a real part', () => {
    // The group has a drawing, so the stray file rides along for upload.
    const [group] = groupDrawingFiles([f('Backplate.pdf'), f('Backplate.txt')]);
    expect(namesOf(group.files)).toEqual(['Backplate.pdf', 'Backplate.txt']);
  });

  it('strips a leading NN_ when that is what makes two files agree', () => {
    const groups = groupDrawingFiles([f('00_Backplate.dxf'), f('01_Backplate.pdf')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stem).toBe('Backplate');
    expect(namesOf(groups[0].files)).toEqual(['00_Backplate.dxf', '01_Backplate.pdf']);
  });

  it('merges an indexed file onto the un-indexed stem it matches', () => {
    const groups = groupDrawingFiles([f('Backplate.pdf'), f('01_Backplate.dxf')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stem).toBe('Backplate');
    expect(groups[0].files).toHaveLength(2);
  });

  it('NEVER strips blindly — two indexed stems that differ stay two parts', () => {
    const groups = groupDrawingFiles([f('00_Axis1part2.dxf'), f('01_Axis2part1.pdf')]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.stem)).toEqual(['00_Axis1part2', '01_Axis2part1']);
  });

  it('keeps the index on a lone indexed part, since dropping it joins nothing', () => {
    const groups = groupDrawingFiles([f('00_Backplate.dxf'), f('00_Backplate.pdf')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stem).toBe('00_Backplate');
  });

  it('does not mistake a digit-heavy part number for an index', () => {
    const groups = groupDrawingFiles([f('1011770_314-092.pdf'), f('2011770_314-092.dxf')]);
    expect(groups.map((g) => g.stem)).toEqual(['1011770_314-092', '2011770_314-092']);
  });

  it('sorts groups by stem, so a re-drop reviews in the same order', () => {
    const forward = groupDrawingFiles([f('Cover.pdf'), f('Arm.dxf'), f('Base.stp'), f('Arm.pdf')]);
    const reversed = groupDrawingFiles([f('Arm.pdf'), f('Base.stp'), f('Arm.dxf'), f('Cover.pdf')]);
    expect(forward.map((g) => g.stem)).toEqual(['Arm', 'Base', 'Cover']);
    expect(reversed.map((g) => g.stem)).toEqual(forward.map((g) => g.stem));
    // File order within a group is stable too — the grid shows a first drawing.
    expect(namesOf(reversed[0].files)).toEqual(namesOf(forward[0].files));
  });

  it('handles a whole folder: 3 parts, junk, and one non-part folder of notes', () => {
    const groups = groupDrawingFiles([
      f(`${CUSTOMER_STEM}.stp`),
      f('Thumbs.db'),
      f(`${CUSTOMER_STEM}.pdf`),
      f('00_Backplate.dxf'),
      f('quote-notes.docx'),
      f(`${CUSTOMER_STEM}.dxf`),
      f('01_Backplate.pdf'),
      empty('Gusset.pdf'),
      f('Weldment.dxf'),
    ]);
    expect(groups.map((g) => g.stem)).toEqual([CUSTOMER_STEM, 'Backplate', 'Weldment']);
    expect(groups.map((g) => g.files.length)).toEqual([3, 2, 1]);
  });
});

describe('groupDrawingFiles — cases mutation testing showed were unenforced', () => {
  /** A file that reports a folder, the way a `webkitdirectory` drop does. */
  const inDir = (dir: string, name: string) => {
    const file = new File(['drawing'], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: `${dir}/${name}` });
    return file;
  };

  /**
   * THE FAILURE THIS MODULE EXISTS TO PREVENT, arriving through the door nobody
   * watched. `File.name` is a basename, so folder-per-part exports look like one
   * repeated filename and two parts land in one row.
   */
  it('keeps same-named files in different folders as different parts', () => {
    const groups = groupDrawingFiles([
      inDir('pkg/PartA', 'drawing.pdf'),
      inDir('pkg/PartA', 'drawing.dxf'),
      inDir('pkg/PartB', 'drawing.pdf'),
      inDir('pkg/PartB', 'drawing.dxf'),
    ]);
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.files).toHaveLength(2);
    // Names must differ too, or the grid's row keys collide.
    expect(groups[0].stem).not.toBe(groups[1].stem);
  });

  it('still groups a flat drop, where no folder is reported', () => {
    expect(groupDrawingFiles([f('X.pdf'), f('X.dxf')])).toHaveLength(1);
  });

  /** Two rows sharing a stem collide silently in a grid keyed by it. */
  it('never emits two groups with the same stem', () => {
    const groups = groupDrawingFiles([
      f('00_Backplate.pdf'),
      f('01_00_Backplate.dxf'),
      f('02_00_Backplate.stp'),
    ]);
    expect(new Set(groups.map((g) => g.stem)).size).toBe(groups.length);
  });

  /**
   * An all-'other' group "is not a part" by this module's own rule, so it must not
   * be the thing that decides a real part's name — the stem is the name fallback.
   */
  it('does not let a stray .txt rename a real part', () => {
    const groups = groupDrawingFiles([
      f('00_Backplate.dxf'),
      f('00_Backplate.pdf'),
      f('Backplate.txt'),
    ]);
    expect(groups.map((g) => g.stem)).toEqual(['00_Backplate']);
  });

  /**
   * On a case-insensitive filesystem these two cannot be separate parts in one
   * folder, so splitting them is wrong wherever it happens.
   */
  it('folds stem case within a folder', () => {
    const groups = groupDrawingFiles([f('BRACKET.DXF'), f('Bracket.pdf')]);
    expect(groups).toHaveLength(1);
    expect(namesOf(groups[0].files).sort()).toEqual(['BRACKET.DXF', 'Bracket.pdf']);
  });

  /** Removing the `(?=.)` lookahead makes this stem empty, and empty becomes the part name. */
  it('never strips an index down to an empty stem', () => {
    const groups = groupDrawingFiles([f('00_.pdf'), f('01_.dxf')]);
    for (const g of groups) expect(g.stem).not.toBe('');
  });

  /** Thumbs.db must be dropped by the junk filter, not incidentally by another rule. */
  it('drops Thumbs.db even when a real part shares its stem', () => {
    const groups = groupDrawingFiles([f('Thumbs.pdf'), f('Thumbs.db'), f('THUMBS.DB')]);
    expect(groups).toHaveLength(1);
    expect(namesOf(groups[0].files)).toEqual(['Thumbs.pdf']);
  });

  /**
   * Row order must not depend on the machine's locale. `localeCompare` orders
   * these differently from code-unit order, so a locale-sensitive sort fails here.
   */
  it('orders stems by code unit, not by locale', () => {
    const groups = groupDrawingFiles([f('a.pdf'), f('B.pdf'), f('C.pdf')]);
    expect(groups.map((g) => g.stem)).toEqual(['B', 'C', 'a']);
  });
});

/**
 * Measured on the real customer package: the drawing and the 3D model do not share
 * a stem, only the part number. Grouping on the stem alone turned 93 files into 62
 * rows and the models never reached the parts they describe.
 */
describe('groupDrawingFiles — models joining their drawing', () => {
  const DRAWING = '1011770-_314-092-60082-10-0000';
  const MODEL = '1011770-_314-092-60078-02-0000';

  it('adopts a STEP model into the drawing group that shares its part number', () => {
    const groups = groupDrawingFiles([
      f(`${DRAWING}.dxf`),
      f(`${DRAWING}.pdf`),
      f(`${MODEL}.step`),
    ]);

    expect(groups).toHaveLength(1);
    expect(namesOf(groups[0].files).sort()).toEqual(
      [`${DRAWING}.dxf`, `${DRAWING}.pdf`, `${MODEL}.step`].sort(),
    );
    // The row is named after the DRAWING, not the model.
    expect(groups[0].stem).toBe(DRAWING);
  });

  /** A wrong attachment is worse than an extra row someone can see and dismiss. */
  it('leaves a model alone when two drawings could claim it', () => {
    const groups = groupDrawingFiles([
      f('1011770-A.dxf'),
      f('1011770-B.dxf'),
      f('1011770-model.step'),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('never adopts on a token too short to be a part number', () => {
    // `00` would otherwise match every 00_-prefixed stem in the folder.
    const groups = groupDrawingFiles([f('00_Plate.dxf'), f('00_Other.step')]);
    expect(groups).toHaveLength(2);
  });

  it('does not reach across folders', () => {
    const inDir = (dir: string, name: string) => {
      const file = new File(['drawing'], name);
      Object.defineProperty(file, 'webkitRelativePath', { value: `${dir}/${name}` });
      return file;
    };
    const groups = groupDrawingFiles([
      inDir('pkg/A', `${DRAWING}.dxf`),
      inDir('pkg/B', `${MODEL}.step`),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps a model-only group as its own row when nothing matches', () => {
    const groups = groupDrawingFiles([f('9999999-lonely.step')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(1);
  });
});
