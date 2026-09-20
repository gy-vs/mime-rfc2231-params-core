import {expect, it} from 'vitest';
import {parseHeaders, parseMimeParameters, serializeMimeParameters} from '../src/index.js';

it('parses fields', () => expect(parseHeaders('A: one\r\nB: two')).toHaveLength(2));

it('parses a complete header line with a field name', () => {
  const parsed = parseMimeParameters(
    "Content-Disposition: attachment; filename*0*=utf-8''Hello; filename*1*=%20World",
  );

  expect(parsed.value).toBe('attachment');
  expect(parsed.params.filename).toBe('Hello World');
});

it('diagnoses non-canonical continuation section numbers', () => {
  const input = "attachment; filename*01*=utf-8''bad";
  const parsed = parseMimeParameters(input);

  expect(parsed.params.filename).toBeUndefined();
  expect(parsed.diagnostics).toMatchObject([{
    code: 'INVALID_SECTION_NUMBER',
    offset: input.indexOf('*01*'),
  }]);
});

it('assembles RFC 2231 segments supplied out of order', () => {
  const parsed = parseMimeParameters(
    "attachment; filename*1*=%20World; filename*0*=utf-8'en'Hello",
  );

  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.params.filename).toBe('Hello World');
  expect(parsed.parameters[0]).toMatchObject({
    name: 'filename',
    rawName: 'filename*0*',
    source: 'extended',
    continuation: true,
    charset: 'UTF-8',
    language: 'en',
  });
});

it('retains a plain fallback when a segment is missing and locates the gap', () => {
  const input = 'attachment; filename="fallback.txt"; filename*0*=utf-8\'\'one; filename*2*=three';
  const parsed = parseMimeParameters(input);
  const filenameAt = input.indexOf('filename*0*');

  expect(parsed.params.filename).toBe('fallback.txt');
  expect(parsed.diagnostics).toMatchObject([
    {code: 'MISSING_SEGMENT', offset: filenameAt, line: 1, column: filenameAt + 1},
  ]);
});

it('prefers extended continuation, single extended, and plain values in that order', () => {
  expect(parseMimeParameters(
    "attachment; filename=plain; filename*=utf-8''single; filename*0*=utf-8''split",
  ).params.filename).toBe('split');
  expect(parseMimeParameters(
    "attachment; filename=plain; filename*=utf-8''single; filename*0*=utf-8''split",
  ).diagnostics).toEqual([]);

  expect(parseMimeParameters(
    "attachment; filename=plain; filename*1*=x",
  ).params.filename).toBe('plain');

  expect(parseMimeParameters(
    "attachment; filename=plain; filename*=utf-8''single; filename*1*=x",
  ).params.filename).toBe('singlex');

  expect(parseMimeParameters(
    "attachment; filename=plain; filename*=utf-8''single",
  ).params.filename).toBe('single');
});

it('allows RFC 2231 continuation segments to mix extended tokens with quoted strings', () => {
  const parsed = parseMimeParameters(
    "attachment; filename=plain.txt; filename*1*=%20World; filename*2=\"!\"; filename*0*=utf-8'en'Hello",
  );

  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.params.filename).toBe('Hello World!');
  expect(parsed.parameters[0]).toMatchObject({source: 'extended', continuation: true});
});

it('assembles ordinary non-extended continuations with quoted and unquoted segments', () => {
  const parsed = parseMimeParameters('attachment; filename=plain; filename*1="b.txt"; filename*0=a%20');

  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.params.filename).toBe('a%20b.txt');
  expect(parsed.parameters[0]).toMatchObject({source: 'regular', continuation: true});
});


it('diagnoses an initial segment without a character set', () => {
  const input = "attachment; filename*0*=''hello; filename*1*=world";
  const parsed = parseMimeParameters(input);

  expect(parsed.params.filename).toBeUndefined();
  expect(parsed.diagnostics).toMatchObject([{
    code: 'MISSING_CHARSET',
    offset: input.indexOf("''hello"),
  }]);
});

it('falls back when a later starred segment follows a regular initial segment', () => {
  const input = 'attachment; filename=plain.txt; filename*0="start"; filename*1*=%20end';
  const parsed = parseMimeParameters(input);

  expect(parsed.params.filename).toBe('plain.txt');
  expect(parsed.diagnostics).toMatchObject([{
    code: 'MISSING_CHARSET',
    offset: input.indexOf('filename*0'),
  }]);
});

it('accepts later star segments and ignores a quoted extended attempt', () => {
  const parsed = parseMimeParameters(
    'attachment; filename*0*="utf-8\'\'bad"; filename*=utf-8\'\'good%20name',
  );

  expect(parsed.params.filename).toBe('good name');
  expect(parsed.diagnostics).toMatchObject([{code: 'INVALID_PARAMETER_VALUE'}]);
});

it('decodes ISO-8859-1 values and regular continuation segments', () => {
  expect(parseMimeParameters("attachment; filename*=iso-8859-1''caf%e9").params.filename).toBe('café');

  const parsed = parseMimeParameters(
    "attachment; filename*0*=iso-8859-1''caf; filename*1=\"é; done\"",
  );
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.params.filename).toBe('café; done');
  expect(parsed.parameters[0]).toMatchObject({charset: 'ISO-8859-1', continuation: true});
});

it('rejects unknown character sets with a location and keeps the plain fallback', () => {
  const input = "attachment; filename=fallback; filename*=made-up''caf%e9";
  const parsed = parseMimeParameters(input);
  expect(parsed.params.filename).toBe('fallback');
  expect(parsed.diagnostics).toMatchObject([{
    code: 'UNKNOWN_CHARSET',
    offset: input.indexOf('made-up'),
  }]);
});

it('decodes a UTF-8 multibyte character split across segments', () => {
  // U+2603 SNOWMAN is E2 98 83; one byte lands in each of three segments.
  const parsed = parseMimeParameters(
    "attachment; filename*2*=%83x; filename*1*=%98; filename*0*=utf-8''a%E2",
  );

  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.params.filename).toBe('a☃x');
});

it('reports duplicate plain parameters and duplicate segments while retaining a usable value', () => {
  const parsed = parseMimeParameters(
    "attachment; filename=first; filename=second; filename*0*=utf-8''a; "
    + "filename*0*=utf-8''b; filename*1*=c",
  );

  expect(parsed.params.filename).toBe('ac');
  expect(parsed.diagnostics.map(({code}) => code)).toEqual([
    'DUPLICATE_PARAMETER',
    'DUPLICATE_SEGMENT',
  ]);
});

it('decodes quoted-string values and quoted pairs without percent decoding', () => {
  const parsed = parseMimeParameters('attachment; filename="100%25 done; copy.txt"');

  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.params.filename).toBe('100%25 done; copy.txt');
});

it('locates malformed percent escapes and keeps a fallback value', () => {
  const input = 'attachment; filename="safe.txt"; filename*0*=utf-8\'\'bad%ZZ; filename*2*=%2';
  const parsed = parseMimeParameters(input);

  expect(parsed.params.filename).toBe('safe.txt');
  expect(parsed.diagnostics).toMatchObject([
    {code: 'MISSING_SEGMENT', offset: input.indexOf('filename*0*')},
    {code: 'INVALID_PERCENT_SEQUENCE', offset: input.indexOf('%ZZ'), length: 3},
    {code: 'INVALID_PERCENT_SEQUENCE', offset: input.indexOf('%2'), length: 2},
  ]);
});

it('round-trips an extended value without double-encoding a percent sign', () => {
  const value = '100% snowman ☃';
  const serialized = serializeMimeParameters('attachment', {filename: value});

  expect(serialized).toContain('100%25');
  expect(serialized).not.toContain('%2525');
  expect(parseMimeParameters(serialized).params.filename).toBe(value);
});

it('serializes continuations and reassembles a UTF-8 character split over a segment', () => {
  const value = '☃';
  const serialized = serializeMimeParameters('attachment', {filename: value}, {maxSegmentBytes: 1});

  expect(serialized).toContain("filename*0*=utf-8''%E2");
  expect(serialized).toContain('filename*1*=%98');
  expect(serialized).toContain('filename*2*=%83');
  expect(parseMimeParameters(serialized).params.filename).toBe(value);
});

it('uses regular quoted-string form for ASCII values that are not tokens', () => {
  const serialized = serializeMimeParameters('attachment', {filename: 'a b.txt'});
  expect(serialized).toBe('attachment; filename="a b.txt"');
  expect(parseMimeParameters(serialized).params.filename).toBe('a b.txt');
});
