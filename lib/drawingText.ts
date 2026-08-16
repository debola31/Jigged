/**
 * Title-block text → part fields.
 *
 * A pure function of `(text, x, y, height)[] → fields`. DXF and vector PDF are
 * two front-ends to this same matcher, so it is written once and knows about
 * neither.
 *
 * THE SHAPE OF THE PROBLEM. A title block prints a caption ("Werkstoff/Material")
 * and its value ("6061-T6") as two entirely independent pieces of text. Nothing
 * in the file links them — not in DXF, where the block is usually exploded into
 * loose text, and not in a PDF. The only thing relating them is where they sit
 * on the page. So this is an assignment problem over geometry, and the standards
 * do not rescue it: ISO 7200 calls its own layout figures "examples", defers
 * position to ISO 5457 (which defers back), and puts scale, tolerance and surface
 * texture OUTSIDE the block entirely. Material, weight and article number appear
 * in none of its three tables.
 *
 * THE ONE ESCAPE HATCH is a title block authored as a real block with meaningful
 * attribute tags, where the pairing is already done for us. Always check that
 * first — it is free, exact, and template-independent.
 *
 * THE GOVERNING RULE, everywhere below: an unmatched field stays EMPTY. A wrong
 * value is worse than a blank, because every downstream screen is built on
 * "empty rather than wrong" — a blank prompts the owner to look, a plausible
 * wrong number does not.
 */

export type FieldRole =
  | 'part_number'
  | 'drawing_number'
  | 'description'
  | 'description_alt'
  | 'material'
  | 'finish'
  | 'revision'
  | 'weight'
  | 'scale'
  | 'sheet';

export interface TextItem {
  text: string;
  x: number;
  y: number;
  height: number;
  layer?: string;
  kind?: string;
  tag?: string;
}

export interface ExtractedField {
  value: string;
  /** How we got it — an attribute lookup is far stronger evidence than geometry. */
  source: 'attribute' | 'geometry';
  /** The caption this was read against, so a reviewer can see the reasoning. */
  caption?: string;
}

export type ExtractedFields = Partial<Record<FieldRole, ExtractedField>>;

/* ------------------------------------------------------------------ *
 * Dictionaries
 * ------------------------------------------------------------------ */

interface CaptionEntry {
  role: FieldRole;
  /**
   * False when this caption is ambiguous within a single block and must not act
   * as an anchor. Customer #2's template prints "Item No." TWICE — once under
   * "A-Nr." (an order number) and once under "Art-Nr." (the article number). The
   * German half is authoritative; the English half rides along.
   */
  anchor: boolean;
}

/** Caption → role. The one artefact that grows per customer template. */
const CAPTIONS: Record<string, CaptionEntry> = {
  // Customer #2 / German industrial (post-2004 EN ISO 7200 wording)
  'art-nr.': { role: 'part_number', anchor: true },
  'artikelnummer': { role: 'part_number', anchor: true },
  'item no.': { role: 'part_number', anchor: false },
  'z-nr.': { role: 'drawing_number', anchor: true },
  'zeichnungsnummer': { role: 'drawing_number', anchor: true },
  'drw no.': { role: 'drawing_number', anchor: false },
  'beschreibung': { role: 'description_alt', anchor: true },
  'werkstoff/material': { role: 'material', anchor: true },
  'werkstoff': { role: 'material', anchor: true },
  'oberfläche': { role: 'finish', anchor: true },
  'gewicht (kg)': { role: 'weight', anchor: true },
  'gewicht': { role: 'weight', anchor: true },
  'maßstab/scale': { role: 'scale', anchor: true },
  'maßstab': { role: 'scale', anchor: true },
  'blatt/sheet': { role: 'sheet', anchor: true },
  // "Index" heads a COLUMN of the revision-history table, it does not caption a
  // value. Anchoring on it reached past its own empty cell and captured sheet
  // border digits on 22 of 31 drawings that have no revision at all. Kept in the
  // dictionary so it is never mistaken for a value, but it anchors nothing.
  index: { role: 'revision', anchor: false },

  // SolidWorks default sheet format — identical in two unrelated projects, so
  // worth carrying even though its geometry differs sharply from the above.
  'title:': { role: 'description', anchor: true },
  'dwg no.': { role: 'drawing_number', anchor: true },
  'dwg. no.': { role: 'drawing_number', anchor: true },
  'material:': { role: 'material', anchor: true },
  'finish:': { role: 'finish', anchor: true },
  'weight:': { role: 'weight', anchor: true },
  'revision': { role: 'revision', anchor: true },
  'rev.': { role: 'revision', anchor: true },
  'rev': { role: 'revision', anchor: true },
  'scale:': { role: 'scale', anchor: true },
  'sheet': { role: 'sheet', anchor: true },

  // Generic English
  'description': { role: 'description', anchor: true },
  'part no.': { role: 'part_number', anchor: true },
  'part number': { role: 'part_number', anchor: true },
  'drawing no.': { role: 'drawing_number', anchor: true },
  'drawing number': { role: 'drawing_number', anchor: true },
};

/**
 * Attribute tag → role, for title blocks authored as real blocks. `GEN-TITLE-*`
 * is AutoCAD Mechanical's documented namespace; the bare names were observed in
 * real drawings in the wild.
 */
const TAGS: Record<string, FieldRole> = {
  'gen-title-nr': 'drawing_number',
  'gen-title-rev': 'revision',
  'gen-title-sca': 'scale',
  'gen-title-mat1': 'material',
  'gen-title-mat2': 'material',
  'gen-title-wt': 'weight',
  'gen-title-sheet': 'sheet',
  'gen-title-name': 'description',
  drawing_number: 'drawing_number',
  dwg_no: 'drawing_number',
  title: 'description',
  title_1: 'description',
  rev: 'revision',
  revision: 'revision',
  sheet: 'sheet',
  material: 'material',
  finish: 'finish',
  weight: 'weight',
  part_number: 'part_number',
  // Japanese — observed on AutoCAD 2010 exports from a Japanese robotics vendor.
  部品番号: 'part_number',
  タイトル: 'description',
};

/**
 * Captions that are printed FUSED to their value in one text entity — the
 * SolidWorks default block emits "SCALE:20:1" and "SHEET 1 OF 1" as single
 * strings, not caption/value pairs, so no geometry can ever pair them.
 */
const FUSED: Array<{ prefix: string; role: FieldRole }> = [
  { prefix: 'scale:', role: 'scale' },
  { prefix: 'sheet ', role: 'sheet' },
  { prefix: 'weight:', role: 'weight' },
  // Japanese drawing-number captions, fused to their value inside the attribute.
  // Two AutoCAD 2010 sets in the corpus put the DRAWING NUMBER inside the title
  // attribute as "図番：RT-CRANE-X7-8-2" — caption and value in one string. Without
  // the split that lands in `description`, which is both wrong and unusable.
  // 図番 / 図版 / 図面 all appear; the colon is full-width (：) on most and ASCII on one.
  { prefix: '図番：', role: 'drawing_number' },
  { prefix: '図番:', role: 'drawing_number' },
  { prefix: '図版：', role: 'drawing_number' },
  { prefix: '図版:', role: 'drawing_number' },
  { prefix: '図面：', role: 'drawing_number' },
  { prefix: '図面:', role: 'drawing_number' },
];

/** Captions that must never be taken as a VALUE for some other caption. */
const NOISE = new Set(
  [
    'name', 'date', 'drawn', 'checked', 'eng appr.', 'mfg appr.', 'q.a.', 'q.a',
    'comments:', 'size', 'unless otherwise specified:', 'do not scale drawing',
    'application', 'used on', 'next assy', 'proprietary and confidential',
    'datum/date', 'urspr.', 'erstel.', 'geneh.', 'a-nr.', 'änd.nr./mod.no.',
    'tolerances:', 'notes:', 'angles', 'general', 'tolerances', 'surfaces',
    'customer:', 'auftraggeber', 'cad: solidworks', 'finish', 'material',
  ].map((s) => s.toLowerCase()),
);

/* ------------------------------------------------------------------ *
 * Plausibility
 * ------------------------------------------------------------------ */

/**
 * Per-role sanity check, applied before a value is ever accepted.
 *
 * This exists because of a specific failure: on an untuned SolidWorks template
 * the matcher missed the only real value on the sheet AND returned
 * `weight = '3'`, scavenged from a border grid number. A bare digit is not a
 * weight. These predicates convert that whole failure class from *wrong* to
 * *empty*, which is the only property the review screen actually needs.
 */
export function isPlausible(role: FieldRole, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  // A single stray character is never a field value — except a revision, where
  // "B" is exactly what a revision looks like. Border grid labels ("1".."16",
  // "A".."F") are the commonest false positive, and every other role is safe to
  // reject outright.
  if (role !== 'revision' && /^[A-Za-z0-9]$/.test(v)) return false;
  if (role !== 'revision' && v.length < 2) return false;

  // A CAPTION IS NEVER A VALUE. When a field's own cell is empty, the nearest
  // string is very often the *next caption along*, and returning it looks like a
  // successful extraction while being pure noise. This was the single largest
  // false-positive class measured: `material` came back as the literal string
  // "HEAT TREAT:" on 31 of 31 customer drawings, because MATERIAL:'s value sits
  // outside the window and HEAT TREAT: is the next thing in it.
  //
  // A trailing colon is the universal tell — no legitimate value ends in one
  // ("1:1" and the fused "SCALE:20:1" both end in a digit). The dictionary
  // catches the colon-less captions.
  if (/:\s*$/.test(v)) return false;
  // hasOwnProperty, not a bare index — `CAPTIONS['constructor']` is truthy on a
  // plain object literal and would reject a legitimate value named after one of
  // Object.prototype's members.
  if (Object.prototype.hasOwnProperty.call(CAPTIONS, v.toLowerCase().replace(/\s+/g, ' '))) {
    return false;
  }

  switch (role) {
    case 'weight':
      // A weight is either a well-formed number on its own (optionally united),
      // or a phrase carrying an explicit unit — "APPROX. WEIGHT = 3.26 KG" is
      // how these drawings actually state it. The old loose form (any digit plus
      // any dot) admitted the fragment "1." on 11 drawings.
      //
      // This does NOT rescue every case, and the limit is worth stating: "5.0",
      // scavenged from the chamfer note `4X 5.0 X 45°`, is shaped exactly like a
      // real weight and no predicate can tell them apart. That one is a
      // reach-too-far in the geometry matcher, not an implausible value.
      return (
        /^\d+(?:[.,]\d+)?\s*(?:kg|kgs|g|lb|lbs|oz|t)?$/i.test(v) ||
        /\d(?:[.,]\d+)?\s*(?:kg|kgs|lb|lbs|oz)\b/i.test(v)
      );
    case 'revision':
      // Y14.35 §5.2 sequences A..Y skipping I, O, Q, S, X, Z, then AA.. — max
      // three characters. A lone "O" or "I" is a misread 0 or 1.
      if (/^[A-Za-z]{1,3}$/.test(v)) return !/[IOQSXZ]/i.test(v);
      // A bare one- or two-digit number is rejected even though some shops do
      // revise numerically: on a real sheet it is indistinguishable from a
      // border grid label, and that is exactly what it turned out to be —
      // "Index" (a revision-history COLUMN HEADER, its cell empty) pulled the
      // border digits in on 22 of 31 drawings that carry no revision at all.
      if (/^\d{1,2}$/.test(v)) return false;
      return v.length <= 8;
    case 'material':
    case 'finish':
    case 'description':
    case 'description_alt':
      // Must carry a letter — a pure number is a dimension, not a name.
      return /[A-Za-zÀ-ɏ　-鿿]/.test(v) && v.length <= 120;
    case 'part_number':
    case 'drawing_number':
      // CJK counts. `/[A-Za-z0-9]/` rejected the pure-katakana part name
      // "アルミフレーム", so the matcher silently fell through to the NEXT segment of
      // the same field and reported the part number as "(6812ZZ+XM540)".
      return /[A-Za-z0-9À-ɏ　-鿿]/.test(v) && v.length <= 60;
    case 'scale':
      return /\d/.test(v) && v.length <= 20;
    case 'sheet':
      return v.length <= 20;
    default:
      return true;
  }
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

/** Strategy 1 — attribute tags. Exact, geometry-free, template-independent. */
function fromTags(items: TextItem[]): ExtractedFields {
  const out: ExtractedFields = {};
  // One field is often SPLIT across numbered segments of the same tag — a title
  // laid out over three lines is TITLE_1/_2/_3, and a part name too long for its
  // cell becomes 部品番号_001 + 部品番号_002. Reading only the first segment truncates
  // the value; reading only the last (which is what happened while the CJK
  // predicate was rejecting the first) reports a fragment as the whole answer.
  const segments = new Map<string, string[]>();
  /** base -> the tag as actually written, so the caption keeps its own casing. */
  const asPrinted = new Map<string, string>();
  for (const it of items) {
    if (!it.tag || (it.kind !== 'ATTRIB' && it.kind !== 'ATTDEF')) continue;
    const base = it.tag.trim().toLowerCase().replace(/_\d+$/, '');
    if (!TAGS[base]) continue;
    const v = it.text.trim();
    if (!v) continue;
    if (!asPrinted.has(base)) asPrinted.set(base, it.tag.trim().replace(/_\d+$/, ''));
    const list = segments.get(base) ?? [];
    // ATTDEF (the template definition) and ATTRIB (the filled instance) repeat
    // the same tag with the same text; keep one copy.
    if (!list.includes(v)) list.push(v);
    segments.set(base, list);
  }

  for (const [base, parts] of segments) {
    const role = TAGS[base];
    if (!role || out[role]) continue;
    // No space before a bracketed or hyphenated continuation — "アルミフレーム" +
    // "(6812ZZ+XM540)" is one name, but a two-line title needs its space back.
    const value = parts
      .reduce((acc, p) => (!acc ? p : /^[([{\-–—/]/.test(p) ? acc + p : `${acc} ${p}`), '')
      .trim();

    // An attribute's VALUE can itself be a caption fused to a value for a
    // DIFFERENT role. Two AutoCAD sets here store "図番：RT-CRANE-X7-8-2" — a
    // drawing number — inside the タイトル (title) attribute. The tag says title;
    // the ink says drawing number, and the ink is what the shop reads. Trust the
    // printed caption over the tag name, and do not also file it as a title.
    const fused = FUSED.find((f) => value.toLowerCase().startsWith(f.prefix));
    if (fused) {
      const inner = value.slice(fused.prefix.length).trim();
      if (!out[fused.role] && isPlausible(fused.role, inner)) {
        out[fused.role] = {
          value: inner,
          source: 'attribute',
          caption: value.slice(0, fused.prefix.length),
        };
      }
      continue;
    }

    if (isPlausible(role, value)) {
      out[role] = { value, source: 'attribute', caption: asPrinted.get(base) ?? base };
    }
  }
  return out;
}

/** Strategy 2 — captions fused to their value inside one string. */
function fromFused(items: TextItem[], into: ExtractedFields): void {
  for (const it of items) {
    const lower = it.text.trim().toLowerCase();
    for (const { prefix, role } of FUSED) {
      if (into[role] || !lower.startsWith(prefix)) continue;
      const value = it.text.trim().slice(prefix.length).trim();
      if (isPlausible(role, value)) {
        into[role] = { value, source: 'geometry', caption: it.text.trim().slice(0, prefix.length) };
      }
    }
  }
}

interface Candidate {
  score: number;
  labelIdx: number;
  valueIdx: number;
  role: FieldRole;
  caption: string;
  value: string;
}

/** Strategy 3 — caption/value pairing by geometry. */
function fromGeometry(items: TextItem[], into: ExtractedFields): void {
  const labels: Array<{ i: number; entry: CaptionEntry; item: TextItem }> = [];
  const valueIdx: number[] = [];

  items.forEach((it, i) => {
    const entry = CAPTIONS[norm(it.text)];
    if (entry) {
      if (entry.anchor) labels.push({ i, entry, item: it });
      return; // a caption is never also a value
    }
    if (NOISE.has(norm(it.text))) return;
    valueIdx.push(i);
  });

  const cands: Candidate[] = [];
  for (const { i, entry, item: L } of labels) {
    if (into[entry.role]) continue;
    const u = Math.max(L.height, 1e-6);
    for (const j of valueIdx) {
      const V = items[j];
      const dx = (V.x - L.x) / u;
      const dy = (V.y - L.y) / u;

      // The value sits to the right of, or directly below, its caption.
      const near = dx >= -0.8 && dx <= 14 && dy >= -3.5 && dy <= 0.9;

      // "Small caption, large value in a big cell" is a real and common layout:
      // in the SolidWorks default block TITLE: is 1.5 units tall and its value
      // is 6.3, sixteen CAPTION-heights below — but only ~4 of its own. When the
      // value dwarfs the caption, the value's height is the cell's true scale,
      // so measure against that instead of widening the caption-scaled window.
      // Gating on "visibly larger" is what keeps this from becoming the generic
      // widening that produced the border-grid false positive.
      const u2 = Math.max(V.height, 1e-6);
      const dx2 = (V.x - L.x) / u2;
      const dy2 = (V.y - L.y) / u2;
      const bigValueBelow =
        V.height > L.height * 1.8 && dx2 >= -1.5 && dx2 <= 8 && dy2 >= -6 && dy2 <= 1;

      if (!near && !bigValueBelow) continue;
      if (!isPlausible(entry.role, V.text)) continue;

      cands.push({
        score: Math.abs(dx) + Math.abs(dy) * 1.5 + (near ? 0 : 6),
        labelIdx: i,
        valueIdx: j,
        role: entry.role,
        caption: items[i].text.trim(),
        value: V.text.trim(),
      });
    }
  }

  // Claim-once, nearest first. Each caption takes at most one value, each value
  // serves at most one caption, each role fills once. This is what stops an
  // EMPTY field from stealing its neighbour's value — the bug that silently put
  // the material code into the Scale box on customer #2's drawings.
  cands.sort((a, b) => a.score - b.score);
  const usedLabel = new Set<number>();
  const usedValue = new Set<number>();
  for (const c of cands) {
    if (usedLabel.has(c.labelIdx) || usedValue.has(c.valueIdx) || into[c.role]) continue;
    usedLabel.add(c.labelIdx);
    usedValue.add(c.valueIdx);
    into[c.role] = { value: c.value, source: 'geometry', caption: c.caption };
  }
}

export interface ExtractOptions {
  /**
   * Filename stem, used only to sanity-check an extracted part number. A part
   * number that appears nowhere in the filename is suspicious on packages that
   * name files after parts; it is a WARNING input, never a source of truth.
   */
  filenameStem?: string;
}

/**
 * Extract title-block fields. Order matters: attributes beat fused strings beat
 * geometry, because that is the order of decreasing evidence.
 */
export function extractDrawingFields(
  items: TextItem[],
  _options: ExtractOptions = {},
): ExtractedFields {
  const fields = fromTags(items);
  fromFused(items, fields);
  fromGeometry(items, fields);
  return fields;
}
