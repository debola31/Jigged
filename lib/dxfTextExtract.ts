/**
 * DXF → text entities, for reading a drawing's title block.
 *
 * A DXF is a flat list of (group code, value) line pairs. We want three things
 * out of it and nothing else:
 *
 *   1. Every piece of visible text, with its position, height and layer.
 *   2. Block attributes (ATTDEF/ATTRIB) WITH their tags — because when a title
 *      block was authored as a real block with meaningful tags (`DRAWING_NUMBER`,
 *      `GEN-TITLE-NR`), extraction collapses to a dictionary lookup and no
 *      geometry is needed at all. Two of five real-world drawings sampled were
 *      like this.
 *   3. Enough to tell those two cases apart (see `classifyTitleBlock`).
 *
 * WHY HAND-ROLLED. The same reasoning as utils/csvParser.ts: the format we need
 * is a small, stable subset, this runs in the browser on a file the user just
 * dropped, and the mature library (ezdxf) is Python. What we do NOT do is invent
 * the tricky parts — see the MTEXT notes below, which is where hand-rolled DXF
 * parsers reliably go wrong.
 */

/** One piece of visible text on the sheet, in drawing units. */
export interface TextEntity {
  /** Decoded plain text — MTEXT formatting codes already stripped. */
  text: string;
  x: number;
  y: number;
  /**
   * Text height in drawing units. Load-bearing: it is the ONLY reliable local
   * scale on a sheet. A title block is a fixed physical size (ISO 7200 fixes it
   * at 180 mm so it fits A4) no matter how big the paper is, so a search window
   * sized as a fraction of the sheet is 14x too wide on a 14x sheet. Sizing by
   * the label's own height is what took the pilot from 29/31 to 31/31.
   */
  height: number;
  layer: string;
  /** MTEXT | TEXT | ATTDEF | ATTRIB — kept so callers can prefer real attributes. */
  kind: 'MTEXT' | 'TEXT' | 'ATTDEF' | 'ATTRIB';
  /**
   * Attribute tag, for ATTDEF/ATTRIB only. Meaningful tags are the jackpot;
   * SolidWorks emits `AUTOATTR0`, `AUTOATTR1`… because its title blocks are
   * notes linked to custom properties, and a note has no name, so the DXF
   * translator invents one. Found in the wild, not a single customer's quirk.
   */
  tag?: string;
  /**
   * ATTDEF prompt (group 3) — the human-readable label the template shows when
   * the block is filled in, e.g. "3rd Title", "Drawing Number", "タイトル". It is a
   * CAPTION, never a value, and is kept separate for exactly that reason: folded
   * into the text it silently prefixes the template's own label onto the value.
   */
  prompt?: string;
}

/** How a drawing's title block is structured. Decides which strategy can work. */
export type TitleBlockStructure =
  /** Attributes with meaningful tags → a lookup, no geometry needed. */
  | 'named_tags'
  /** Attributes present but auto-named (`AUTOATTR0`) → values without meaning. */
  | 'auto_tags'
  /** No attributes; the block was exploded into loose text → geometry only. */
  | 'exploded';

/** Binary DXF sentinel. We only read ASCII DXF; binary is a different format. */
const BINARY_SENTINEL = 'AutoCAD Binary DXF';

export class BinaryDxfError extends Error {
  constructor() {
    super('This is a binary DXF. Save it as an ASCII DXF and try again.');
    this.name = 'BinaryDxfError';
  }
}

/**
 * Bytes → string, choosing the encoding the way DXF actually works.
 *
 * DXF R2007 (AC1021) and later are UTF-8; everything earlier uses the codepage
 * named in `$DWGCODEPAGE`, which is Windows-1252 in practice for Western files.
 * Getting this wrong is not cosmetic: a Japanese vendor's AutoCAD 2010 drawings
 * carry perfectly good attribute tags like `部品番号_001` (part number), and
 * reading them as Latin-1 turns every one into mojibake that matches nothing —
 * eleven drawings that should have been a free exact lookup scored zero.
 *
 * Rather than trust the version header (files lie, and exporters disagree), try
 * strict UTF-8 and fall back. Latin-1 can decode any byte sequence, so the order
 * matters: UTF-8 first, because it is the one that can fail informatively.
 */
export function decodeDxfBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Decode MTEXT inline formatting to plain text.
 *
 * MTEXT carries its own markup language, so the raw group-1 string for a
 * left-aligned "TOLERANCES:" is literally `\LTOLERANCES:`. Left undecoded, every
 * label in the dictionary silently fails to match.
 */
export function decodeMText(raw: string): string {
  // Escaped literals are parked behind sentinels FIRST. Unescaping them last
  // would be too late: `\{` becomes `{`, and the very next rule strips grouping
  // braces, silently eating a brace the drawing meant to print.
  const ESC: Record<string, string> = { '\\\\': '', '\\{': '', '\\}': '' };
  let s = raw.replace(/\\[\\{}]/g, (m) => ESC[m] ?? m);

  // Codes that take a parameter terminated by ';' — font, colour, height, width,
  // oblique, tracking, alignment, column break. Dropped entirely.
  s = s.replace(/\\[fFcCHWQTApP]\d*[^;\\]*;/g, '');

  // Stacked fractions \S1^2; or \S1/2; — keep both sides, drop the stacking.
  s = s.replace(/\\S([^;]*?)[\^/#]([^;]*?);/g, '$1/$2');

  // Paragraph break is a real line break; \~ is a non-breaking space.
  s = s.replace(/\\P/g, '\n').replace(/\\~/g, ' ');

  // Toggles with no argument: underline, overline, strike, and their off forms.
  s = s.replace(/\\[LlOoKk]/g, '');

  // Grouping braces carry no text.
  s = s.replace(/[{}]/g, '');

  // Restore the literals now that no brace rule can reach them.
  s = s.replace(/[]/g, (c) => ({ '': '\\', '': '{', '': '}' })[c] ?? c);

  // %%-codes predate MTEXT markup and appear in both TEXT and MTEXT.
  s = s
    .replace(/%%[dD]/g, '°')
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%[pP]/g, '±')
    .replace(/%%%/g, '%');

  return s.trim();
}

interface Pair {
  code: string;
  value: string;
}

/** Split the file into (group code, value) pairs. Handles CRLF and bare CR. */
function toPairs(source: string): Pair[] {
  const lines = source.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  // A trailing odd line is a truncated file; ignore it rather than throw, so a
  // slightly damaged drawing still yields the text it does have.
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push({ code: lines[i].trim(), value: lines[i + 1] });
  }
  return pairs;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseFloat(value.trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Extract every text entity from an ASCII DXF.
 *
 * @throws {BinaryDxfError} if handed a binary DXF.
 */
export function extractDxfText(source: string): TextEntity[] {
  if (source.slice(0, 200).includes(BINARY_SENTINEL)) throw new BinaryDxfError();

  const pairs = toPairs(source);
  const out: TextEntity[] = [];

  let kind: TextEntity['kind'] | null = null;
  // MTEXT over ~250 chars is split across MULTIPLE group-3 chunks followed by a
  // final group-1 remainder. Reading only group 1 truncates every long string
  // and is the classic hand-rolled-DXF bug, so continuations accumulate here.
  let continuation: string[] = [];
  let primary: string | undefined;
  let tag: string | undefined;
  let prompt: string | undefined;
  const num: Record<string, string> = {};

  const flush = () => {
    if (kind && (continuation.length > 0 || primary !== undefined)) {
      const raw = continuation.join('') + (primary ?? '');
      const text = decodeMText(raw);
      if (text) {
        out.push({
          text,
          x: toNumber(num['10'], 0),
          y: toNumber(num['20'], 0),
          // Group 40 is height for TEXT/ATTDEF/ATTRIB and nominal height for
          // MTEXT. 2.5 is the AutoCAD default when a file omits it.
          height: toNumber(num['40'], 2.5),
          layer: (num['8'] ?? '').trim(),
          kind,
          ...(tag ? { tag } : {}),
          ...(prompt ? { prompt } : {}),
        });
      }
    }
    kind = null;
    continuation = [];
    primary = undefined;
    tag = undefined;
    prompt = undefined;
    for (const k of Object.keys(num)) delete num[k];
  };

  for (const { code, value } of pairs) {
    if (code === '0') {
      flush();
      const t = value.trim().toUpperCase();
      if (t === 'MTEXT' || t === 'TEXT' || t === 'ATTDEF' || t === 'ATTRIB') {
        kind = t;
      }
      continue;
    }
    if (!kind) continue;

    if (code === '1') {
      primary = value;
    } else if (code === '3') {
      // Group 3 means TWO different things, and conflating them corrupts every
      // attribute-based title block:
      //   - on MTEXT it is a continuation chunk of a string over ~250 chars;
      //   - on ATTDEF it is the PROMPT the user sees when filling the block in.
      // Treating an ATTDEF prompt as continuation prepends the template's own
      // label to its value. Measured: TITLE_3's prompt is the literal string
      // "3rd Title", so seven drawings with an EMPTY title reported their
      // description as "3rd Title"; and a Japanese block reported
      // "タイトル" + "図番：RT-CRANE-X7-8-2" as one description.
      if (kind === 'MTEXT') continuation.push(value);
      else prompt = value;
    } else if (code === '2') {
      // Group 2 is the attribute TAG on ATTDEF/ATTRIB. On other entities it is a
      // name we do not want, but we only reach here inside a text entity.
      tag = value.trim();
    } else if (num[code] === undefined) {
      // First occurrence wins: an entity's own 10/20/40/8 precede any nested
      // values, so this avoids a trailing group overwriting the real position.
      num[code] = value;
    }
  }
  flush();

  return out;
}

/**
 * Classify how the title block is structured, which decides whether a lookup can
 * work at all or whether we are down to geometry.
 */
export function classifyTitleBlock(entities: TextEntity[]): TitleBlockStructure {
  const tags = entities
    .filter((e) => (e.kind === 'ATTDEF' || e.kind === 'ATTRIB') && e.tag)
    .map((e) => e.tag as string);
  if (tags.length === 0) return 'exploded';
  return tags.every((t) => /^AUTOATTR/i.test(t)) ? 'auto_tags' : 'named_tags';
}
