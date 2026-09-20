export type Header={name:string;value:string};
export function parseHeaders(input:string):Header[]{const out:Record<string,string>={};for(const line of input.split(/\r?\n/)){const at=line.indexOf(':');if(at>0)out[line.slice(0,at).toLowerCase()]=line.slice(at+1).trim()}return Object.entries(out).map(([name,value])=>({name,value}))}
export class MimeStream{#buffer='';feed(chunk:string){this.#buffer+=chunk;const at=this.#buffer.indexOf('\r\n\r\n');if(at<0)return [];const head=this.#buffer.slice(0,at);this.#buffer=this.#buffer.slice(at+4);return [{headers:parseHeaders(head),body:this.#buffer}]}}

export type MimeParameterSource = 'regular' | 'extended';

export interface MimeParameter {
  /** Lower-cased parameter name. */
  name: string;
  /** Parameter name as it appeared in the header. */
  rawName: string;
  /** Decoded, logically assembled parameter value. */
  value: string;
  source: MimeParameterSource;
  continuation: boolean;
  charset?: string;
  language?: string;
}

export type MimeParameterDiagnosticCode =
  | 'MISSING_PARAMETER_NAME'
  | 'INVALID_PARAMETER_NAME'
  | 'MISSING_EQUALS_SIGN'
  | 'MISSING_PARAMETER_VALUE'
  | 'INVALID_PARAMETER_VALUE'
  | 'UNTERMINATED_QUOTED_STRING'
  | 'INVALID_ESCAPE'
  | 'MALFORMED_EXTENDED_VALUE'
  | 'MISSING_CHARSET'
  | 'UNKNOWN_CHARSET'
  | 'INVALID_PERCENT_SEQUENCE'
  | 'INVALID_CHARACTER_ENCODING'
  | 'DUPLICATE_PARAMETER'
  | 'DUPLICATE_SEGMENT'
  | 'MISSING_SEGMENT'
  | 'INVALID_SECTION_NUMBER';

export interface MimeParameterDiagnostic {
  code: MimeParameterDiagnosticCode;
  message: string;
  offset: number;
  length: number;
  line: number;
  column: number;
}

export interface ParsedMimeParameters {
  /** The media/disposition value before the first semicolon. */
  value: string;
  parameters: MimeParameter[];
  /** Lower-cased parameter name to decoded value. */
  params: Record<string, string>;
  diagnostics: MimeParameterDiagnostic[];
}

export interface SerializeMimeParametersOptions {
  /**
   * Maximum number of payload bytes placed in one RFC 2231 continuation
   * segment. The payload is split before UTF-8 percent-encoding, so multibyte
   * characters can cross a segment boundary.
   */
  maxSegmentBytes?: number;
}

interface Position {
  offset: number;
  length: number;
}

interface RawValue {
  value: string;
  start: number;
  end: number;
  valid: boolean;
  quoted: boolean;
}

interface RegularOccurrence {
  order: number;
  name: string;
  rawName: string;
  fullRawName: string;
  section: number | null;
  value: string;
  namePosition: Position;
  valuePosition: Position;
  valid: boolean;
}

interface ExtendedOccurrence {
  order: number;
  name: string;
  rawName: string;
  fullRawName: string;
  section: number | null;
  bytes: Uint8Array;
  sourceAt: number[];
  charset?: string;
  charsetRaw?: string;
  language?: string;
  namePosition: Position;
  valuePosition: Position;
  valid: boolean;
}

type SegmentOccurrence = RegularSegmentOccurrence | ExtendedSegmentOccurrence;

interface RegularSegmentOccurrence extends RegularOccurrence {
  kind: 'regular';
  section: number;
}

interface ExtendedSegmentOccurrence extends Omit<ExtendedOccurrence, 'section'> {
  kind: 'extended';
  section: number;
}

interface AttributeName {
  name: string;
  rawName: string;
  baseName: string;
  section: number | null;
  extended: boolean;
  namePosition: Position;
}

interface DecodedExtendedValue {
  bytes: Uint8Array;
  sourceAt: number[];
  valid: boolean;
}

interface InitialDecodedExtendedValue extends DecodedExtendedValue {
  charset?: string;
  charsetRaw?: string;
  language?: string;
}

interface Candidate {
  parameter: MimeParameter;
  valid: boolean;
}

interface ParameterGroup {
  order: number;
  plain?: RegularOccurrence;
  singleton?: ExtendedOccurrence;
  segments: Map<number, SegmentOccurrence>;
}

const MAX_SECTION_NUMBER = 10_000;

/**
 * Parses a MIME header value such as `attachment; filename*0*=utf-8''a%20b`
 * or a complete header line such as `Content-Disposition: attachment; ...`.
 *
 * Bytes from RFC 2231 segments are collected before decoding. This permits
 * UTF-8 multibyte sequences to span continuation segments.
 */
export function parseMimeParameters(input: string): ParsedMimeParameters {
  return new MimeParameterParser(input).parse();
}

/** Parse a header value when the field name is already known. */
export function parseMimeHeaderValue(fieldValue: string): ParsedMimeParameters {
  return parseMimeParameters(fieldValue);
}

/** Parse a complete `Field-Name: value; parameter=...` header line. */
export function parseMimeHeader(headerLine: string): ParsedMimeParameters {
  return parseMimeParameters(headerLine);
}

class MimeParameterParser {
  readonly #input: string;
  readonly #diagnostics: MimeParameterDiagnostic[] = [];
  readonly #groups = new Map<string, ParameterGroup>();
  #i = 0;
  #order = 0;

  constructor(input: string) {
    this.#input = input;
  }

  parse(): ParsedMimeParameters {
    let valueStart = 0;
    let value = '';

    const firstColon = this.#input.indexOf(':');
    if (firstColon >= 0) {
      valueStart = firstColon + 1;
    }

    const parameterStart = this.#input.indexOf(';', valueStart);
    const valueEnd = parameterStart < 0 ? this.#input.length : parameterStart;
    value = this.#input.slice(valueStart, valueEnd).trim();
    this.#i = parameterStart < 0 ? this.#input.length : parameterStart + 1;

    while (this.#i < this.#input.length) {
      this.#skipHorizontalWhitespace();
      if (this.#input[this.#i] === ';') {
        this.#i++;
        continue;
      }

      const nameStart = this.#i;
      const attribute = this.#parseAttributeName();
      if (!attribute) {
        this.#skipToNextParameter();
        continue;
      }

      this.#skipHorizontalWhitespace();
      if (this.#input[this.#i] !== '=') {
        this.#diagnostic(
          'MISSING_EQUALS_SIGN',
          `Missing "=" after parameter "${attribute.rawName}".`,
          nameStart,
          Math.max(1, this.#i - nameStart),
        );
        this.#skipToNextParameter();
        continue;
      }
      this.#i++;
      this.#skipHorizontalWhitespace();

      if (attribute.extended) {
        this.#readExtendedParameter(attribute);
      } else {
        this.#readRegularParameter(attribute);
      }

      if (this.#input[this.#i] === ';') this.#i++;
    }

    const parameters = this.#buildParameters();
    const params: Record<string, string> = {};
    for (const parameter of parameters) params[parameter.name] = parameter.value;

    this.#diagnostics.sort((a, b) => a.offset - b.offset || a.length - b.length);
    return {value, parameters, params, diagnostics: this.#diagnostics};
  }

  #parseAttributeName(): AttributeName | null {
    const start = this.#i;
    while (this.#i < this.#input.length && this.#isAttributeChar(this.#input[this.#i])) {
      this.#i++;
    }

    if (start === this.#i) {
      this.#diagnostic('MISSING_PARAMETER_NAME', 'Missing parameter name.', start, 1);
      return null;
    }

    const baseName = this.#input.slice(start, this.#i);
    const name = baseName.toLowerCase();
    let section: number | null = null;
    let extended = false;

    if (this.#input[this.#i] === '*') {
      this.#i++;
      if (this.#isAsciiDigit(this.#input[this.#i])) {
        const digitsStart = this.#i;
        const firstDigit = this.#input[this.#i];
        this.#i++;
        while (this.#isAsciiDigit(this.#input[this.#i])) this.#i++;

        const digits = this.#input.slice(digitsStart, this.#i);
        if ((firstDigit === '0' && digits.length > 1) || Number(digits) > MAX_SECTION_NUMBER) {
          this.#diagnostic(
            'INVALID_SECTION_NUMBER',
            `Invalid continuation section number "${digits}".`,
            digitsStart - 1,
            digits.length + 1,
          );
          this.#skipInvalidNameSuffix(start);
          return null;
        }
        section = Number(digits);

        if (this.#input[this.#i] === '*') {
          this.#i++;
          extended = true;
        }
      } else {
        // name* is an extended single value. name*0 is an ordinary continuation.
        extended = true;
      }
    }

    const ch = this.#input[this.#i];
    if (ch !== undefined && ch !== ';' && ch !== '=' && !this.#isHorizontalWhitespace(ch)) {
      this.#consumeInvalidNameSuffix(start);
      return null;
    }

    return {
      name,
      rawName: this.#input.slice(start, this.#i),
      baseName,
      section,
      extended,
      namePosition: {offset: start, length: this.#i - start},
    };
  }

  #skipInvalidNameSuffix(nameStart: number): void {
    while (this.#i < this.#input.length && this.#input[this.#i] !== ';' && this.#input[this.#i] !== '=') {
      this.#i++;
    }
    void nameStart;
  }

  #consumeInvalidNameSuffix(nameStart: number): void {
    this.#skipInvalidNameSuffix(nameStart);
    this.#diagnostic(
      'INVALID_PARAMETER_NAME',
      'Invalid RFC 2231 parameter name.',
      nameStart,
      Math.max(1, this.#i - nameStart),
    );
  }

  #readRegularParameter(attribute: AttributeName): void {
    const raw = this.#input[this.#i] === '"'
      ? this.#readQuotedValue()
      : this.#readTokenValue();

    if (!raw.valid) return;
    if (!raw.quoted) {
      for (let offset = 0; offset < raw.value.length; offset++) {
        if (!this.#isTokenChar(raw.value[offset])) {
          this.#diagnostic(
            'INVALID_PARAMETER_VALUE',
            'Unquoted parameter value contains a character outside the RFC token grammar.',
            raw.start + offset,
            1,
          );
          return;
        }
      }
    }

    const occurrence: RegularOccurrence = {
      order: this.#order++,
      name: attribute.name,
      rawName: attribute.baseName,
      fullRawName: attribute.rawName,
      section: attribute.section,
      value: raw.value,
      namePosition: attribute.namePosition,
      valuePosition: {offset: raw.start, length: raw.end - raw.start},
      valid: true,
    };

    let group = this.#groups.get(attribute.name);
    if (!group) {
      group = {order: occurrence.order, segments: new Map()};
      this.#groups.set(attribute.name, group);
    }
    group.order = Math.min(group.order, occurrence.order);

    if (attribute.section === null) {
      if (group.plain) {
        this.#duplicateDiagnostic(attribute.rawName, attribute.namePosition, group.plain.namePosition);
      } else {
        group.plain = occurrence;
      }
      return;
    }

    const segment: RegularSegmentOccurrence = {...occurrence, kind: 'regular', section: attribute.section};
    const existing = group.segments.get(attribute.section);
    if (existing) {
      this.#duplicateDiagnostic(
        `${attribute.rawName} segment ${attribute.section}`,
        attribute.namePosition,
        existing.namePosition,
        true,
      );
    } else {
      group.segments.set(attribute.section, segment);
    }
  }

  #readExtendedParameter(attribute: AttributeName): void {
    let raw: RawValue;
    if (this.#input[this.#i] === '"') {
      raw = this.#readQuotedValue();
      this.#diagnostic(
        'INVALID_PARAMETER_VALUE',
        'RFC 2231 extended values cannot use quoted-string syntax.',
        raw.start,
        Math.max(1, raw.end - raw.start),
      );
      return;
    }

    raw = this.#readTokenValue();
    if (!raw.valid) return;

    const initial = attribute.section === null || attribute.section === 0;
    let bytes: Uint8Array;
    let sourceAt: number[];
    let valid: boolean;
    let charset: string | undefined;
    let charsetRaw: string | undefined;
    let language: string | undefined;

    if (initial) {
      const parsed = this.#parseInitialExtendedValue(raw);
      bytes = parsed.bytes;
      sourceAt = parsed.sourceAt;
      valid = parsed.valid;
      charset = parsed.charset;
      charsetRaw = parsed.charsetRaw;
      language = parsed.language;
    } else {
      const parsed = this.#parseContinuationExtendedValue(raw);
      bytes = parsed.bytes;
      sourceAt = parsed.sourceAt;
      valid = parsed.valid;
    }

    const occurrence: ExtendedOccurrence = {
      order: this.#order++,
      name: attribute.name,
      rawName: attribute.baseName,
      fullRawName: attribute.rawName,
      section: attribute.section,
      bytes,
      sourceAt,
      charset,
      charsetRaw,
      language,
      namePosition: attribute.namePosition,
      valuePosition: {offset: raw.start, length: raw.end - raw.start},
      valid,
    };

    let group = this.#groups.get(attribute.name);
    if (!group) {
      group = {order: occurrence.order, segments: new Map()};
      this.#groups.set(attribute.name, group);
    }
    group.order = Math.min(group.order, occurrence.order);

    if (attribute.section === null) {
      if (group.singleton) {
        this.#duplicateDiagnostic(attribute.rawName, attribute.namePosition, group.singleton.namePosition);
      } else {
        group.singleton = occurrence;
      }
      return;
    }

    const segment: ExtendedSegmentOccurrence = {...occurrence, kind: 'extended', section: attribute.section};
    const existing = group.segments.get(attribute.section);
    if (existing) {
      this.#duplicateDiagnostic(
        `${attribute.rawName} segment ${attribute.section}`,
        attribute.namePosition,
        existing.namePosition,
        true,
      );
    } else {
      group.segments.set(attribute.section, segment);
    }
  }

  #readTokenValue(): RawValue {
    const start = this.#i;
    while (this.#i < this.#input.length && this.#input[this.#i] !== ';') this.#i++;

    let end = this.#i;
    while (end > start && this.#isHorizontalWhitespace(this.#input[end - 1])) end--;

    if (start === end) {
      this.#diagnostic('MISSING_PARAMETER_VALUE', 'Missing parameter value.', start, 1);
      return {value: '', start, end: this.#i, valid: false, quoted: false};
    }

    for (let p = start; p < end; p++) {
      const code = this.#input.charCodeAt(p);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
        this.#diagnostic('INVALID_PARAMETER_VALUE', 'Invalid control character in parameter value.', p, 1);
        return {value: '', start, end: this.#i, valid: false, quoted: false};
      }
    }

    return {
      value: this.#input.slice(start, end),
      start,
      end,
      valid: true,
      quoted: false,
    };
  }

  #readQuotedValue(): RawValue {
    const start = this.#i;
    this.#i++;
    let value = '';
    let valid = true;
    let quoted = true;

    while (this.#i < this.#input.length) {
      const ch = this.#input[this.#i];
      if (!quoted) {
        if (ch === ';') break;
        this.#diagnostic('INVALID_PARAMETER_VALUE', 'Unexpected text after quoted string.', this.#i, 1);
        valid = false;
        this.#i++;
        continue;
      }

      if (ch === '"') {
        this.#i++;
        quoted = false;
        this.#skipHorizontalWhitespace();
        continue;
      }

      if (ch === '\\') {
        const escapedPosition = this.#i;
        const next = this.#input[this.#i + 1];
        if (
          next === undefined
          || (next === '\r' && !(this.#input[this.#i + 2] === '\n' && this.#isHorizontalWhitespace(this.#input[this.#i + 3])))
          || this.#isControl(next)
        ) {
          this.#diagnostic('INVALID_ESCAPE', 'Invalid quoted-pair escape.', escapedPosition, this.#i + 1 < this.#input.length ? 2 : 1);
          valid = false;
          this.#i++;
          continue;
        }
        value += next;
        this.#i += 2;
        continue;
      }

      if (ch === '\r' && this.#input[this.#i + 1] === '\n' && this.#isHorizontalWhitespace(this.#input[this.#i + 2])) {
        value += ' ';
        this.#i += 3;
        continue;
      }

      if (this.#isControl(ch) && ch !== '\t') {
        this.#diagnostic('INVALID_PARAMETER_VALUE', 'Invalid control character in quoted string.', this.#i, 1);
        valid = false;
      }

      value += ch;
      this.#i++;
    }

    if (quoted) {
      this.#diagnostic('UNTERMINATED_QUOTED_STRING', 'Quoted string is not terminated.', start, Math.max(1, this.#input.length - start));
      valid = false;
    }

    return {value, start, end: this.#i, valid, quoted: true};
  }

  #parseInitialExtendedValue(raw: RawValue): InitialDecodedExtendedValue {
    const text = raw.value;
    const first = text.indexOf("'");
    if (first < 0) {
      this.#diagnostic(
        'MISSING_CHARSET',
        'Extended initial value must begin with charset\'language\'payload.',
        raw.start,
        Math.max(1, raw.end - raw.start),
      );
      return {bytes: new Uint8Array(0), sourceAt: [], valid: false};
    }

    const second = text.indexOf("'", first + 1);
    if (second < 0) {
      this.#diagnostic(
        'MALFORMED_EXTENDED_VALUE',
        'Extended initial value must contain two apostrophe delimiters.',
        raw.start + first,
        1,
      );
      return {bytes: new Uint8Array(0), sourceAt: [], valid: false};
    }

    const charsetRaw = text.slice(0, first);
    const language = text.slice(first + 1, second);
    const payloadStart = raw.start + second + 1;
    let valid = true;

    if (charsetRaw.trim() === '') {
      this.#diagnostic(
        'MISSING_CHARSET',
        'RFC 2231 initial segment does not declare a character set.',
        raw.start,
        Math.max(1, second + 1),
      );
      valid = false;
    } else {
      const charset = normalizeCharset(charsetRaw);
      if (!charset) {
        this.#diagnostic(
          'UNKNOWN_CHARSET',
          `Unknown or unsupported character set "${charsetRaw}".`,
          raw.start,
          charsetRaw.length,
        );
      }
      const decoded = this.#decodeExtendedBytes(
        text.slice(second + 1),
        payloadStart,
        charset ?? undefined,
      );
      return {
        bytes: decoded.bytes,
        sourceAt: decoded.sourceAt,
        charset: charset ?? undefined,
        charsetRaw,
        language,
        valid: decoded.valid && charset !== null,
      };
    }

    const decoded = this.#decodeExtendedBytes(text.slice(second + 1), payloadStart, undefined);
    return {bytes: decoded.bytes, sourceAt: decoded.sourceAt, charsetRaw, language, valid: false};
  }

  #parseContinuationExtendedValue(raw: RawValue): DecodedExtendedValue {
    const apostrophe = raw.value.indexOf("'");
    if (apostrophe >= 0) {
      this.#diagnostic(
        'MALFORMED_EXTENDED_VALUE',
        'Continuation segments must not contain charset or language delimiters.',
        raw.start + apostrophe,
        1,
      );
      return {bytes: new Uint8Array(0), sourceAt: [], valid: false};
    }
    return this.#decodeExtendedBytes(raw.value, raw.start, undefined);
  }

  #decodeExtendedBytes(text: string, offset: number, _charset: string | undefined): DecodedExtendedValue {
    const bytes: number[] = [];
    const sourceAt: number[] = [];
    let valid = true;

    for (let p = 0; p < text.length;) {
      const ch = text[p]!;
      const code = ch.charCodeAt(0);

      if (ch === '%') {
        const available = Math.min(3, text.length - p);
        const hex = available === 3 ? text.slice(p + 1, p + 3) : '';
        if (available < 3 || !/^[0-9A-Fa-f]{2}$/.test(hex)) {
          this.#diagnostic(
            'INVALID_PERCENT_SEQUENCE',
            'Malformed percent-encoded octet.',
            offset + p,
            available,
          );
          valid = false;
          // Do not rescan a '%' belonging to the rejected escape.
          p += available === 1 ? 1 : 3;
          continue;
        }
        bytes.push(Number.parseInt(hex, 16));
        sourceAt.push(offset + p);
        p += 3;
        continue;
      }

      if (code > 0x7f || !this.#isExtendedValueChar(ch)) {
        this.#diagnostic(
          'INVALID_PARAMETER_VALUE',
          'Unencoded character is not permitted in an extended value.',
          offset + p,
          1,
        );
        valid = false;
        p++;
        continue;
      }

      bytes.push(code);
      sourceAt.push(offset + p);
      p++;
    }

    return {bytes: Uint8Array.from(bytes), sourceAt, valid};
  }

  #buildParameters(): MimeParameter[] {
    return [...this.#groups.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .flatMap(([name, group]) => {
        const candidates = [...this.#continuationCandidates(name, group), ...this.#singletonCandidate(group), ...this.#plainCandidate(group)];
        const selected = candidates.find((candidate) => candidate.valid);
        return selected ? [selected.parameter] : [];
      });
  }

  #continuationCandidates(name: string, group: ParameterGroup): Candidate[] {
    if (group.segments.size === 0) return [];

    const combinedSegments = new Map(group.segments);
    if (group.segments.size > 0 && group.singleton && !combinedSegments.has(0)) {
      combinedSegments.set(0, {
        ...group.singleton,
        kind: 'extended' as const,
        section: 0,
      });
    }

    const ordered = [...combinedSegments.values()].sort((a, b) => a.section - b.section);
    const first = ordered[0]!;
    const max = Math.max(...ordered.map((occurrence) => occurrence.section));
    let valid = true;

    for (let section = 0; section <= max; section++) {
      if (!combinedSegments.has(section)) {
        valid = false;
        this.#missingSegmentDiagnostic(first, name, section);
      }
    }

    const invalidCandidate = (): Candidate[] => [{
      valid: false,
      parameter: {
        name,
        rawName: first.fullRawName,
        value: '',
        source: 'extended',
        continuation: true,
      },
    }];

    const initial = combinedSegments.get(0);
    if (!initial || !initial.valid) {
      return invalidCandidate();
    }

    if (initial.kind === 'regular') {
      if (ordered.some((occurrence) => occurrence.kind === 'extended')) {
        this.#diagnostic(
          'MISSING_CHARSET',
          `Continuation initial segment "${initial.rawName}*0" must be extended before later encoded segments.`,
          initial.namePosition.offset,
          initial.namePosition.length,
        );
        return invalidCandidate();
      }
      return [{
        valid: ordered.every((occurrence) => occurrence.valid),
        parameter: {
          name,
          rawName: initial.fullRawName,
          value: ordered.map((occurrence) => occurrence.kind === 'regular' ? occurrence.value : '').join(''),
          source: 'regular',
          continuation: true,
        },
      }];
    }

    if (!initial.charset) {
      valid = false;
    }

    const charset = initial.charset;
    const assembled: number[] = [];
    const sourceAt: number[] = [];
    for (const occurrence of ordered) {
      if (!occurrence.valid) {
        valid = false;
        continue;
      }
      if (occurrence.kind === 'extended') {
        if (occurrence !== initial && occurrence.charset) {
          valid = false;
          this.#diagnostic(
            'MALFORMED_EXTENDED_VALUE',
            'Character set may only be declared in continuation segment 0.',
            occurrence.valuePosition.offset,
            occurrence.valuePosition.length,
          );
        }
        assembled.push(...occurrence.bytes);
        sourceAt.push(...occurrence.sourceAt);
      } else if (charset) {
        const encoded = encodeForCharset(occurrence.value, charset);
        if (encoded.error) {
          valid = false;
          this.#diagnostic(
            'INVALID_CHARACTER_ENCODING',
            `Regular continuation segment cannot represent its value in ${charset}.`,
            occurrence.valuePosition.offset + encoded.error.offset,
            encoded.error.length,
          );
          continue;
        }
        assembled.push(...encoded.bytes);
        for (let offset = 0; offset < encoded.bytes.length; offset++) {
          sourceAt.push(occurrence.valuePosition.offset + Math.min(offset, Math.max(0, occurrence.valuePosition.length - 1)));
        }
      }
    }

    if (!valid || !charset) return invalidCandidate();

    const decoded = decodeBytes(Uint8Array.from(assembled), charset);
    if (decoded.error) {
      const source = sourceAt[decoded.error.offset] ?? first.valuePosition.offset;
      this.#diagnostic(
        'INVALID_CHARACTER_ENCODING',
        `Input is not valid ${charset}.`,
        source,
        decoded.error.length,
      );
      return [{
        valid: false,
        parameter: {name, rawName: first.fullRawName, value: '', source: 'extended', continuation: true},
      }];
    }

    return [{
      valid: true,
      parameter: {
        name,
        rawName: initial.fullRawName,
        value: decoded.value,
        source: 'extended',
        continuation: true,
        charset,
        language: initial.kind === 'extended' ? initial.language : undefined,
      },
    }];
  }

  #singletonCandidate(group: ParameterGroup): Candidate[] {
    if (group.segments.size > 0 || !group.singleton) return [];
    const singleton = group.singleton;
    if (!singleton.valid || !singleton.charset) return [];

    const decoded = decodeBytes(singleton.bytes, singleton.charset);
    if (decoded.error) {
      const source = singleton.sourceAt[decoded.error.offset] ?? singleton.valuePosition.offset;
      this.#diagnostic(
        'INVALID_CHARACTER_ENCODING',
        `Input is not valid ${singleton.charset}.`,
        source,
        decoded.error.length,
      );
      return [];
    }

    return [{
      valid: true,
      parameter: {
        name: group.singleton.name,
        rawName: singleton.rawName,
        value: decoded.value,
        source: 'extended',
        continuation: false,
        charset: singleton.charset,
        language: singleton.language,
      },
    }];
  }

  #plainCandidate(group: ParameterGroup): Candidate[] {
    if (!group.plain) return [];
    return [{
      valid: group.plain.valid,
      parameter: {
        name: group.plain.name,
        rawName: group.plain.rawName,
        value: group.plain.value,
        source: 'regular',
        continuation: false,
      },
    }];
  }

  #missingSegmentDiagnostic(occurrence: SegmentOccurrence, name: string, section: number): void {
    this.#diagnostic(
      'MISSING_SEGMENT',
      `Parameter "${name}" is missing continuation segment ${section}.`,
      occurrence.namePosition.offset,
      occurrence.namePosition.length,
    );
  }

  #duplicateDiagnostic(description: string, later: Position, earlier: Position, segment = false): void {
    void earlier;
    this.#diagnostic(
      segment ? 'DUPLICATE_SEGMENT' : 'DUPLICATE_PARAMETER',
      `Duplicate ${segment ? 'continuation segment' : 'parameter'}: ${description}.`,
      later.offset,
      later.length,
    );
  }

  #diagnostic(code: MimeParameterDiagnosticCode, message: string, offset: number, length: number): void {
    const boundedOffset = Math.max(0, Math.min(offset, this.#input.length));
    const before = this.#input.slice(0, boundedOffset);
    const line = before.split('\n').length;
    const lastLineStart = before.lastIndexOf('\n') + 1;
    this.#diagnostics.push({
      code,
      message,
      offset: boundedOffset,
      length: Math.max(1, length),
      line,
      column: boundedOffset - lastLineStart + 1,
    });
  }

  #skipToNextParameter(): void {
    while (this.#i < this.#input.length && this.#input[this.#i] !== ';') this.#i++;
  }

  #skipHorizontalWhitespace(): void {
    while (this.#isHorizontalWhitespace(this.#input[this.#i])) this.#i++;
  }

  #isTokenChar(ch: string | undefined): boolean {
    if (!ch) return false;
    if (this.#isControl(ch) || this.#isHorizontalWhitespace(ch)) return false;
    return !'()<>@,;:\\"/[]?='.includes(ch);
  }

  #isAttributeChar(ch: string | undefined): boolean {
    if (!ch) return false;
    if (ch === '*' || ch === "'" || ch === '%') return false;
    if (this.#isControl(ch) || this.#isHorizontalWhitespace(ch)) return false;
    return !'()<>@,;:\\"/[]?='.includes(ch);
  }

  #isExtendedValueChar(ch: string): boolean {
    if (ch === '*' || ch === "'" || ch === '%') return false;
    return this.#isAttributeChar(ch);
  }

  #isHorizontalWhitespace(ch: string | undefined): boolean {
    return ch === ' ' || ch === '\t';
  }

  #isControl(ch: string | undefined): boolean {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  }

  #isAsciiDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= '0' && ch <= '9';
  }
}

function normalizeCharset(raw: string): string | null {
  const normalized = raw.trim().toUpperCase().replace(/_/g, '-');
  if (normalized === 'UTF-8' || normalized === 'UTF8') return 'UTF-8';
  if (
    normalized === 'ISO-8859-1'
    || normalized === 'ISO8859-1'
    || normalized === 'LATIN-1'
    || normalized === 'LATIN1'
    || normalized === 'ISO-8859-1:1987'
    || normalized === 'ISO-IR-100'
  ) {
    return 'ISO-8859-1';
  }
  if (normalized === 'US-ASCII' || normalized === 'ASCII' || normalized === 'ANSI-X3.4-1968') {
    return 'US-ASCII';
  }
  return null;
}

function encodeForCharset(value: string, charset: string): {bytes: number[]; error?: {offset: number; length: number}} {
  if (charset === 'ISO-8859-1') {
    const bytes: number[] = [];
    for (let offset = 0; offset < value.length; offset++) {
      const code = value.charCodeAt(offset);
      if (code > 0xff) return {bytes: [], error: {offset, length: 1}};
      bytes.push(code);
    }
    return {bytes};
  }
  if (charset === 'US-ASCII') {
    const bytes: number[] = [];
    for (let offset = 0; offset < value.length; offset++) {
      const code = value.charCodeAt(offset);
      if (code > 0x7f) return {bytes: [], error: {offset, length: 1}};
      bytes.push(code);
    }
    return {bytes};
  }
  return {bytes: [...new TextEncoder().encode(value)]};
}

function decodeBytes(bytes: Uint8Array, charset: string): {value: string; error?: {offset: number; length: number}} {
  if (charset === 'ISO-8859-1') {
    let value = '';
    const chunkSize = 0x2000;
    for (let start = 0; start < bytes.length; start += chunkSize) {
      value += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
    }
    return {value};
  }
  if (charset === 'US-ASCII') {
    for (let offset = 0; offset < bytes.length; offset++) {
      if (bytes[offset]! > 0x7f) return {value: '', error: {offset, length: 1}};
    }
    return {value: new TextDecoder('us-ascii').decode(bytes)};
  }
  return decodeUtf8(bytes);
}

function decodeUtf8(bytes: Uint8Array): {value: string; error?: {offset: number; length: number}} {
  let value = '';
  let offset = 0;

  const invalid = (length = 1) => ({value: '', error: {offset, length}});

  while (offset < bytes.length) {
    const b1 = bytes[offset]!;
    if (b1 < 0x80) {
      value += String.fromCodePoint(b1);
      offset++;
      continue;
    }

    const sequenceLength = b1 >= 0xf0 ? 4 : b1 >= 0xe0 ? 3 : b1 >= 0xc0 ? 2 : 0;
    if (sequenceLength === 0 || b1 > 0xf4 || offset + sequenceLength > bytes.length) {
      return invalid(Math.min(4, bytes.length - offset));
    }

    const b2 = bytes[offset + 1]!;
    const b3 = sequenceLength >= 3 ? bytes[offset + 2]! : 0;
    const b4 = sequenceLength === 4 ? bytes[offset + 3]! : 0;
    const continuation = (byte: number) => byte >= 0x80 && byte <= 0xbf;

    let codePoint = 0;
    if (sequenceLength === 2) {
      if (b1 < 0xc2 || !continuation(b2)) return invalid(2);
      codePoint = ((b1 & 0x1f) << 6) | (b2 & 0x3f);
    } else if (sequenceLength === 3) {
      if (!continuation(b2) || !continuation(b3)) return invalid(3);
      if (b1 === 0xe0 && b2 < 0xa0) return invalid(3);
      if (b1 === 0xed && b2 > 0x9f) return invalid(3);
      codePoint = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
    } else {
      if (!continuation(b2) || !continuation(b3) || !continuation(b4)) return invalid(4);
      if (b1 === 0xf0 && b2 < 0x90) return invalid(4);
      if (b1 === 0xf4 && b2 > 0x8f) return invalid(4);
      codePoint = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
    }

    value += String.fromCodePoint(codePoint);
    offset += sequenceLength;
  }

  return {value};
}

/**
 * Serializes decoded parameter values. ASCII-only values use a token or
 * quoted-string. Non-ASCII and control-containing values use RFC 2231 UTF-8
 * extended encoding. Existing percent signs in the logical value are encoded
 * once as `%25`.
 */
export function serializeMimeParameters(
  mainValue: string,
  parameters: Record<string, string> = {},
  options: SerializeMimeParametersOptions = {},
): string {
  const maxSegmentBytes = options.maxSegmentBytes;
  if (maxSegmentBytes !== undefined && (!Number.isInteger(maxSegmentBytes) || maxSegmentBytes <= 0)) {
    throw new RangeError('maxSegmentBytes must be a positive integer');
  }

  const parts: string[] = [];
  if (mainValue !== '') parts.push(mainValue);

  for (const [name, value] of Object.entries(parameters)) {
    if (!isAttributeName(name)) throw new TypeError(`Invalid MIME parameter name: ${name}`);
    const bytes = new TextEncoder().encode(value);
    const needsExtended = !canUseRegularQuotedString(value)
      || value.includes('%')
      || (maxSegmentBytes !== undefined && bytes.length > maxSegmentBytes);

    if (!needsExtended) {
      parts.push(`${name}=${formatRegularValue(value)}`);
    } else if (maxSegmentBytes === undefined) {
      parts.push(`${name}*=utf-8''${percentEncode(bytes)}`);
    } else {
      let segment = 0;
      for (let start = 0; start < bytes.length; segment++) {
        const end = Math.min(bytes.length, start + maxSegmentBytes);
        const prefix = segment === 0 ? `utf-8''` : '';
        parts.push(`${name}*${segment}*=${prefix}${percentEncode(bytes.subarray(start, end))}`);
        start = end;
      }
    }
  }

  return parts.join('; ');
}

function isAttributeName(name: string): boolean {
  return name.length > 0 && [...name].every((ch) => isAttributeSerializationChar(ch));
}

function isAttributeSerializationChar(ch: string): boolean {
  if (ch === '*' || ch === "'" || ch === '%' || ch === ' ') return false;
  const code = ch.charCodeAt(0);
  if (code <= 0x20 || code === 0x7f || code > 0x7e) return false;
  return !'()<>@,;:\\"/[]?='.includes(ch);
}

function canUseRegularQuotedString(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code > 0x7e) return false;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
  }
  return true;
}

function formatRegularValue(value: string): string {
  if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function percentEncode(bytes: Uint8Array): string {
  const safe = "!#$&+-.^_`|~";
  let output = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if ((byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || safe.includes(ch)) {
      output += ch;
    } else {
      output += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return output;
}
