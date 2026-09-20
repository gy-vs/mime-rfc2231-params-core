/**
 * RFC 2231 MIME parameter parsing and serialization.
 *
 * Supports the four shapes a single logical parameter may take in a media
 * type header value such as `text/plain; filename="x.txt"`:
 *
 *   name=value            plain
 *   name*=charset'lang'%65 extended (single section, RFC 2231 section 4)
 *   name*0=value ...      plain continuation (RFC 2231 section 3)
 *   name*0*=... name*1*=  extended continuation (sections 3 + 4)
 *
 * Raw bytes are collected first (per name / section / encoding flag);
 * percent-decoding happens on the assembled byte sequence before any
 * charset decoding, so multi-byte UTF-8 characters split across sections
 * survive intact.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single resolved logical parameter. */
export interface MimeParam {
  /** Attribute name with any section number / asterisk stripped. */
  name: string;
  /** Decoded logical value. */
  value: string;
  /** Charset declared by the winning shape, when it was extended. */
  charset?: string;
  /** Language tag declared on the first extended section, when present. */
  language?: string;
  /**
   * Winning shape precedence:
   * 3 = extended continuation (`name*0*` …),
   * 2 = extended single (`name*`),
   * 1 = plain continuation (`name*0` …),
   * 0 = plain (`name`).
   */
  precedence: 0 | 1 | 2 | 3;
}

export type MimeDiagnosticCode =
  | 'malformed-param'
  | 'bad-attribute'
  | 'duplicate-param'
  | 'duplicate-section'
  | 'missing-section'
  | 'first-section-charset-required'
  | 'continuation-mixed'
  | 'bad-percent-escape'
  | 'unknown-charset'
  | 'invalid-byte-for-charset'
  | 'unclosed-quoted-string';

/** A locatable problem found while parsing. */
export interface MimeDiagnostic {
  code: MimeDiagnosticCode;
  message: string;
  /** Param name the diagnostic belongs to, when attributable. */
  param?: string;
  /** Zero-based offset into the header value. */
  offset: number;
  /** Length of the offending span in the header value. */
  length: number;
}

export interface MimeParamsResult {
  /** Value before the first unquoted `;` (e.g. `text/plain`). */
  value: string;
  /** Resolved params ordered by first appearance. */
  params: MimeParam[];
  /** All diagnostics, including those for shapes that lost precedence. */
  diagnostics: MimeDiagnostic[];
}

export interface SerializeOptions {
  /** Fold encoded values into sections of at most this many wire chars. */
  maxSectionLength?: number;
  /** Declared charset used for non-ASCII values (default UTF-8). */
  charset?: string;
  /** Optional language tag emitted in the first extended section. */
  language?: string;
}

// ---------------------------------------------------------------------------
// Raw collection (tokenizer — operates on raw text, no decoding yet)
// ---------------------------------------------------------------------------

interface RawParam {
  name: string;
  /** Raw (still percent-encoded) value text, quoted-string unescaped. */
  raw: string;
  /**
   * Map from each `raw` character index to its offset in the header value.
   * Undefined for unquoted values, where the mapping is valuePos + i.
   */
  map?: number[];
  /** Start of the value inside the header value. */
  valuePos: number;
  /** Start of the attribute inside the header value. */
  attrPos: number;
  /** End offset (exclusive) of the attribute. */
  attrEnd: number;
  /** First appearance order key. */
  order: number;
}

interface RawGroups {
  plain?: RawParam;
  plainSections: Map<number, RawParam>;
  ext?: RawParam;
  extSections: Map<number, RawParam>;
  /** A section/attribute of the plain continuation series was repeated. */
  plainDup: boolean;
  /** A section/attribute of the extended continuation series was repeated. */
  extDup: boolean;
}

/**
 * RFC 2231 attribute: 1*attribute-char, optionally `*section` and a
 * trailing `*` marking the extended encoding.
 */
function parseAttribute(
  attr: string,
): { name: string; section: number | null; ext: boolean } | null {
  let end = attr.length;
  let ext = false;
  if (end > 0 && attr.charCodeAt(end - 1) === 0x2a /* * */) {
    ext = true;
    end--;
  }
  let star = -1;
  for (let i = 0; i < end; i++) {
    if (attr.charCodeAt(i) === 0x2a) {
      star = i;
      break;
    }
  }
  if (star === 0) return null;
  let section: number | null = null;
  if (star >= 0) {
    const digits = attr.slice(star + 1, end);
    if (!/^[0-9]+$/.test(digits)) return null;
    section = parseInt(digits, 10);
    end = star;
  }
  const name = attr.slice(0, end);
  // RFC 2231 attribute-char: a-z A-Z 0-9 !#$&+-.^_`|~
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const ok =
      (c >= 0x61 && c <= 0x7a) || // a-z
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x30 && c <= 0x39) || // 0-9
      c === 0x21 || c === 0x23 || c === 0x24 || c === 0x26 ||
      c === 0x2b || c === 0x2d || c === 0x2e || c === 0x5e ||
      c === 0x5f || c === 0x60 || c === 0x7c || c === 0x7e;
    if (!ok) return null;
  }
  if (name.length === 0) return null;
  return { name, section, ext };
}

/** Read the value after `=`: quoted-string or bare token-ish chars. */
function readValue(
  input: string,
  start: number,
  diagnostics: MimeDiagnostic[],
): { raw: string; map?: number[]; valuePos: number; next: number } {
  let i = start;
  while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
  if (i < input.length && input[i] === '"') {
    const valuePos = i + 1;
    let raw = '';
    const map: number[] = [];
    i++;
    let closed = false;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\\') {
        // quoted-pair: the next single character is taken literally
        if (i + 1 < input.length) {
          raw += input[i + 1];
          map.push(i + 1);
          i += 2;
        } else {
          i++;
        }
      } else if (ch === '"') {
        i++;
        closed = true;
        break;
      } else {
        raw += ch;
        map.push(i);
        i++;
      }
    }
    if (!closed) {
      diagnostics.push({
        code: 'unclosed-quoted-string',
        message: 'quoted-string value is missing its closing quote',
        offset: start,
        length: input.length - start,
      });
    }
    // Skip trailing token text / whitespace up to the next `;`.
    while (i < input.length && input[i] !== ';') i++;
    return { raw, map, valuePos, next: i };
  }
  const valuePos = i;
  let end = i;
  while (end < input.length && input[end] !== ';') end++;
  const raw = input.slice(i, end).replace(/[ \t]+$/, '');
  return { raw, valuePos, next: i + raw.length < end ? i + raw.length : end };
}

// ---------------------------------------------------------------------------
// Entry: parse the parameter list of a media-type header value
// ---------------------------------------------------------------------------

export function parseMimeParams(input: string): MimeParamsResult {
  const diagnostics: MimeDiagnostic[] = [];
  const groups = new Map<string, RawGroups>();
  const order: string[] = [];

  const firstSemi = input.indexOf(';');
  const value = (firstSemi < 0 ? input : input.slice(0, firstSemi)).trim();
  let i = firstSemi < 0 ? input.length : firstSemi + 1;
  let orderCounter = 0;

  while (i < input.length) {
    while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
    if (input[i] === ';') { i++; continue; }
    if (i >= input.length) break;

    const segmentStart = i;
    let eq = i;
    while (eq < input.length && input[eq] !== '=' && input[eq] !== ';') eq++;

    if (eq >= input.length || input[eq] === ';') {
      diagnostics.push({
        code: 'malformed-param',
        message: `parameter "${input
          .slice(segmentStart, eq)
          .trim()}" is missing "=value"`,
        offset: segmentStart,
        length: Math.max(1, eq - segmentStart),
      });
      i = eq < input.length ? eq + 1 : input.length;
      continue;
    }

    const attrText = input.slice(i, eq).replace(/[ \t]+$/, '');
    const parsedAttr = parseAttribute(attrText);
    if (!parsedAttr) {
      let end = eq;
      while (end < input.length && input[end] !== ';') end++;
      diagnostics.push({
        code: 'bad-attribute',
        message: `invalid parameter attribute "${attrText}"`,
        offset: i,
        length: attrText.length || 1,
      });
      i = end < input.length ? end + 1 : input.length;
      continue;
    }

    const { raw, map, valuePos, next } = readValue(input, eq + 1, diagnostics);
    const rp: RawParam = {
      name: parsedAttr.name,
      raw,
      map,
      valuePos,
      attrPos: i,
      attrEnd: i + attrText.length,
      order: orderCounter++,
    };

    let g = groups.get(parsedAttr.name);
    if (!g) {
      g = {
        plainSections: new Map(),
        extSections: new Map(),
        plainDup: false,
        extDup: false,
      };
      groups.set(parsedAttr.name, g);
      order.push(parsedAttr.name);
    }

    if (parsedAttr.section === null) {
      const existing = parsedAttr.ext ? g.ext : g.plain;
      if (existing) {
        diagnostics.push({
          code: 'duplicate-param',
          message: `parameter "${parsedAttr.name}${parsedAttr.ext ? '*' : ''}" is repeated`,
          param: parsedAttr.name,
          offset: rp.attrPos,
          length: rp.attrEnd - rp.attrPos,
        });
        if (parsedAttr.ext) g.extDup = true;
        else g.plainDup = true;
      } else if (parsedAttr.ext) {
        g.ext = rp;
      } else {
        g.plain = rp;
      }
    } else {
      const bucket = parsedAttr.ext ? g.extSections : g.plainSections;
      if (bucket.has(parsedAttr.section)) {
        diagnostics.push({
          code: 'duplicate-section',
          message: `section ${parsedAttr.section} of parameter "${parsedAttr.name}" is repeated`,
          param: parsedAttr.name,
          offset: rp.attrPos,
          length: rp.attrEnd - rp.attrPos,
        });
        if (parsedAttr.ext) g.extDup = true;
        else g.plainDup = true;
      } else {
        bucket.set(parsedAttr.section, rp);
      }
    }

    i = next < input.length && input[next] === ';' ? next + 1 : next;
  }

  const params: MimeParam[] = [];
  for (const name of order) {
    const param = resolveParam(name, groups.get(name)!, diagnostics);
    if (param) params.push(param);
  }

  return { value, params, diagnostics };
}

// ---------------------------------------------------------------------------
// Percent decoding — operates BEFORE charset decoding, on raw bytes
// ---------------------------------------------------------------------------

const HEX = /^[0-9A-Fa-f]$/;

/**
 * Percent-decode raw extended-value text into bytes. Returns null after
 * emitting a locatable diagnostic for the first malformed escape.
 * Plain (non-extended) values never reach here, so literal `%` is legal
 * there and is preserved verbatim.
 */
function percentDecode(
  rp: RawParam,
  raw: string,
  base: number,
  param: string,
  diagnostics: MimeDiagnostic[],
): Uint8Array | null {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x25 /* % */) {
      if (i + 2 >= raw.length || !HEX.test(raw[i + 1]) || !HEX.test(raw[i + 2])) {
        const len = Math.min(3, raw.length - i);
        diagnostics.push({
          code: 'bad-percent-escape',
          message: `malformed percent escape "${raw.slice(i, i + len)}" in parameter "${param}"`,
          param,
          offset: (rp.map ? rp.map[base + i] : rp.valuePos + base + i),
          length: len,
        });
        return null;
      }
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c <= 0xff) {
      bytes.push(c);
    } else {
      // Non-Latin1 literal in an extended value: cannot map to a single
      // byte. Encode its UTF-8 representation instead so data is not lost.
      for (const b of new TextEncoder().encode(raw[i])) bytes.push(b);
    }
  }
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// Charset handling
// ---------------------------------------------------------------------------

const CHARSET_ALIASES: Record<string, string> = {
  'utf-8': 'UTF-8',
  utf8: 'UTF-8',
  'iso-8859-1': 'ISO-8859-1',
  iso88591: 'ISO-8859-1',
  latin1: 'ISO-8859-1',
  l1: 'ISO-8859-1',
  'us-ascii': 'US-ASCII',
  ascii: 'US-ASCII',
};

function canonicalCharset(charset: string): string | null {
  return CHARSET_ALIASES[charset.trim().toLowerCase()] ?? null;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeBytes(
  bytes: Uint8Array,
  charset: string,
  param: string,
  offset: number,
  length: number,
  diagnostics: MimeDiagnostic[],
): string | null {
  const canon = canonicalCharset(charset);
  if (!canon) {
    diagnostics.push({
      code: 'unknown-charset',
      message: `parameter "${param}" declares unsupported charset "${charset}"`,
      param,
      offset,
      length,
    });
    return null;
  }
  if (canon === 'ISO-8859-1') {
    // Every byte maps directly; Latin1 is a single-byte charset.
    let out = '';
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
  try {
    if (canon === 'US-ASCII') {
      for (const b of bytes) {
        if (b > 0x7f) throw new Error('non-ascii byte');
      }
    }
    return utf8Decoder.decode(bytes);
  } catch {
    diagnostics.push({
      code: 'invalid-byte-for-charset',
      message: `byte sequence in parameter "${param}" is not valid ${canon}`,
      param,
      offset,
      length,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shape assembly
// ---------------------------------------------------------------------------

/** Parse `charset'language'payload` of the first extended section. */
function splitInitial(
  raw: string,
): { charset: string; language: string; payload: string; base: number } | null {
  const q1 = raw.indexOf("'");
  if (q1 < 0) return null;
  const q2 = raw.indexOf("'", q1 + 1);
  if (q2 < 0) return null;
  return {
    charset: raw.slice(0, q1),
    language: raw.slice(q1 + 1, q2),
    payload: raw.slice(q2 + 1),
    base: q2 + 1,
  };
}

function sectionContinuity(sections: Map<number, RawParam>): {
  missing: number[];
  max: number;
} {
  let max = -1;
  for (const n of sections.keys()) if (n > max) max = n;
  const missing: number[] = [];
  for (let n = 0; n <= max; n++) {
    if (!sections.has(n)) missing.push(n);
  }
  return { missing, max };
}

function tryExtSections(
  name: string,
  g: RawGroups,
  sections: Map<number, RawParam>,
  diagnostics: MimeDiagnostic[],
): MimeParam | null {
  if (sections.size === 0) return null;
  const { missing, max } = sectionContinuity(sections);

  const zero = sections.get(0);
  if (!zero) {
    const first = sections.get(missing[0] ?? max) ?? [...sections.values()][0];
    diagnostics.push({
      code: 'missing-section',
      message: `extended continuation "${name}*0*" is missing; sections must start at 0`,
      param: name,
      offset: first.attrPos,
      length: first.attrEnd - first.attrPos,
    });
    return null;
  }

  for (const n of missing) {
    // Point at the section directly after the gap when possible.
    const after = sections.get(n + 1);
    diagnostics.push({
      code: 'missing-section',
      message: `section ${n} is missing from extended continuation of "${name}"`,
      param: name,
      offset: after ? after.attrPos : zero.attrPos,
      length: after ? after.attrEnd - after.attrPos : zero.attrEnd - zero.attrPos,
    });
  }
  if (missing.length || g.extDup) return null;

  const init = splitInitial(zero.raw);
  if (!init) {
    diagnostics.push({
      code: 'first-section-charset-required',
      message: `first extended section "${name}*0*" must be charset'language'percent-encoded`,
      param: name,
      offset: zero.valuePos,
      length: zero.raw.length || 1,
    });
    return null;
  }
  if (init.charset.length === 0) {
    diagnostics.push({
      code: 'first-section-charset-required',
      message: `first extended section "${name}*0*" declares no charset`,
      param: name,
      offset: zero.map ? zero.map[0] : zero.valuePos,
      length: Math.max(1, zero.raw.indexOf("'")),
    });
    return null;
  }

  // Validate shape of every later section before touching bytes.
  for (let n = 1; n <= max; n++) {
    const rp = sections.get(n)!;
    if (rp.raw.includes("'")) {
      diagnostics.push({
        code: 'continuation-mixed',
        message: `continuation section "${name}*${n}*" must not declare charset or language`,
        param: name,
        offset: rp.valuePos,
        length: rp.raw.length || 1,
      });
      return null;
    }
  }

  // Collect raw bytes in strict section order.
  const chunks: Uint8Array[] = [];
  const initial = percentDecode(zero, init.payload, init.base, name, diagnostics);
  if (!initial) return null;
  chunks.push(initial);
  for (let n = 1; n <= max; n++) {
    const rp = sections.get(n)!;
    const part = percentDecode(rp, rp.raw, 0, name, diagnostics);
    if (!part) return null;
    chunks.push(part);
  }

  const all = concatBytes(chunks);
  const value = decodeBytes(
    all,
    init.charset,
    name,
    zero.valuePos,
    init.charset.length,
    diagnostics,
  );
  if (value === null) return null;

  return {
    name,
    value,
    charset: canonicalCharset(init.charset) ?? init.charset,
    language: init.language || undefined,
    precedence: 3,
  };
}

function tryExtSingle(
  name: string,
  rp: RawParam | undefined,
  invalidated: boolean,
  diagnostics: MimeDiagnostic[],
): MimeParam | null {
  if (!rp || invalidated) return null;
  const init = splitInitial(rp.raw);
  if (!init || init.charset.length === 0) {
    diagnostics.push({
      code: 'first-section-charset-required',
      message: `extended parameter "${name}*" must be charset'language'percent-encoded`,
      param: name,
      offset: rp.valuePos,
      length: rp.raw.length || 1,
    });
    return null;
  }
  const bytes = percentDecode(rp, init.payload, init.base, name, diagnostics);
  if (!bytes) return null;
  const charsetOffset = rp.map ? rp.map[0] : rp.valuePos;
  const value = decodeBytes(
    bytes,
    init.charset,
    name,
    charsetOffset,
    init.charset.length,
    diagnostics,
  );
  if (value === null) return null;
  return {
    name,
    value,
    charset: canonicalCharset(init.charset) ?? init.charset,
    language: init.language || undefined,
    precedence: 2,
  };
}

function tryPlainSections(
  name: string,
  sections: Map<number, RawParam>,
  invalidated: boolean,
  diagnostics: MimeDiagnostic[],
): MimeParam | null {
  if (sections.size === 0) return null;
  const { missing, max } = sectionContinuity(sections);
  for (const n of missing) {
    const after = sections.get(n + 1);
    const anchor = after ?? sections.get(0);
    diagnostics.push({
      code: 'missing-section',
      message: `section ${n} is missing from continuation of "${name}"`,
      param: name,
      offset: anchor ? anchor.attrPos : 0,
      length: anchor ? anchor.attrEnd - anchor.attrPos : 1,
    });
  }
  if (missing.length || invalidated) return null;
  let value = '';
  for (let n = 0; n <= max; n++) value += sections.get(n)!.raw;
  return { name, value, precedence: 1 };
}

function resolveParam(
  name: string,
  g: RawGroups,
  diagnostics: MimeDiagnostic[],
): MimeParam | null {
  // Deterministic precedence (RFC 2231 §4.1 note): extended continuation
  // > extended single > plain continuation > plain. Every failed higher
  // shape is diagnosed but evaluation continues, so a usable plain value
  // survives an invalid extended one.

  // RFC 2231 §3: the regular and extended continuation notation must not
  // be mixed within one parameter. Anchor the diagnostic at the first
  // section that breaks with whichever notation appeared first, then mark
  // both series unusable so the plain fallback wins.
  let mixed = false;
  if (g.extSections.size > 0 && g.plainSections.size > 0) {
    const extZero = g.extSections.get(0);
    const plainZero = g.plainSections.get(0);
    const extFirst =
      extZero && (!plainZero || extZero.order < plainZero.order);
    const anchor = extFirst
      ? [...g.plainSections.values()].sort((a, b) => a.order - b.order)[0]
      : [...g.extSections.values()].sort((a, b) => a.order - b.order)[0];
    diagnostics.push({
      code: 'continuation-mixed',
      message: `continuation of "${name}" mixes starred and unstarred sections`,
      param: name,
      offset: anchor.attrPos,
      length: anchor.attrEnd - anchor.attrPos,
    });
    mixed = true;
  }

  return (
    (mixed ? null : tryExtSections(name, g, g.extSections, diagnostics)) ??
    tryExtSingle(name, g.ext, g.extDup, diagnostics) ??
    (mixed
      ? null
      : tryPlainSections(name, g.plainSections, g.plainDup, diagnostics)) ??
    (g.plain ? { name, value: g.plain.raw, precedence: 0 } : null)
  );
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c === 0x7f || ch === '"' || ch === '\\' || ch === ';') {
      return true;
    }
  }
  return false;
}

function quoteValue(value: string): string {
  return '"' + value.replace(/[\\"]/g, (m) => '\\' + m) + '"';
}

/** Percent-encode per RFC 2231: the attr-char-safe subset stays literal. */
function encodeByte(b: number): string {
  const safe =
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x21 || b === 0x23 || b === 0x24 || b === 0x26 || // !#$&
    b === 0x2b /* + */ || b === 0x2d /* - */ || b === 0x2e /* . */ ||
    b === 0x5e /* ^ */ || b === 0x5f /* _ */ || b === 0x60 /* ` */ ||
    b === 0x7c /* | */ || b === 0x7e; /* ~ */
  return safe
    ? String.fromCharCode(b)
    : '%' + b.toString(16).toUpperCase().padStart(2, '0');
}

/** Encode a logical value to bytes per the declared charset. */
function valueBytes(value: string, charset: string): Uint8Array {
  if (charset === 'ISO-8859-1') {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c > 0xff) {
        throw new Error(
          `cannot encode U+${c.toString(16).toUpperCase()} in ISO-8859-1`,
        );
      }
      out[i] = c;
    }
    return out;
  }
  if (charset === 'US-ASCII') {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c > 0x7f) {
        throw new Error(
          `cannot encode U+${c.toString(16).toUpperCase()} in US-ASCII`,
        );
      }
      out[i] = c;
    }
    return out;
  }
  return new TextEncoder().encode(value);
}

/**
 * Serialize one logical parameter. A plain (possibly quoted-string) form
 * is used for ASCII values; values outside ASCII/control range use RFC
 * 2231 extended encoding. `maxSectionLength` folds the encoded form into
 * `name*0*`, `name*1*`, … sections; boundaries never split a percent
 * triplet, so a multi-byte character may span sections.
 *
 * The input is a decoded logical value: a literal `%` is encoded once to
 * `%25`, never double-encoded.
 */
export function serializeMimeParam(
  name: string,
  value: string,
  options: SerializeOptions = {},
): string {
  const charset = canonicalCharset(options.charset ?? 'UTF-8') ?? 'UTF-8';
  const lang = options.language ?? '';
  const maxSectionLength = options.maxSectionLength ?? Infinity;

  const allAscii = [...value].every((ch) => ch.charCodeAt(0) <= 0x7e);
  const hasControl = [...value].some(
    (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f,
  );
  const usePlain =
    allAscii && !hasControl && charset === 'UTF-8' && !options.language;

  if (usePlain) {
    return `${name}=${needsQuoting(value) ? quoteValue(value) : value}`;
  }

  const bytes = valueBytes(value, charset);
  const pieces: string[] = [];
  for (const b of bytes) pieces.push(encodeByte(b));

  // Greedy packing where a safe byte costs 1 and a triplet costs 3.
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current.length > 0 && current.length + piece.length > maxSectionLength) {
      chunks.push(current);
      current = '';
    }
    current += piece;
  }
  if (chunks.length === 0 || current.length > 0) chunks.push(current);

  if (chunks.length === 1) {
    return `${name}*=${charset}'${lang}'${chunks[0]}`;
  }
  return chunks
    .map(
      (chunk, i) =>
        `${name}*${i}*=${i === 0 ? `${charset}'${lang}'` : ''}${chunk}`,
    )
    .join('; ');
}

/** Serialize a leading media type plus parameters. */
export function serializeMimeParams(
  value: string,
  params: ReadonlyArray<{ name: string; value: string } & SerializeOptions>,
  options: SerializeOptions = {},
): string {
  const parts = [value];
  for (const p of params) {
    parts.push(serializeMimeParam(p.name, p.value, { ...options, ...p }));
  }
  return parts.join('; ');
}
