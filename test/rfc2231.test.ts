import { describe, expect, it } from 'vitest';
import {
  parseMimeParams,
  serializeMimeParam,
  serializeMimeParams,
} from '../src/rfc2231.js';
import type { MimeDiagnostic } from '../src/rfc2231.js';

/** Extract the source span a diagnostic points at. */
function span(input: string, d: MimeDiagnostic): string {
  return input.slice(d.offset, d.offset + d.length);
}

function codes(input: string) {
  return parseMimeParams(input).diagnostics.map((d) => d.code);
}

describe('plain parameters', () => {
  it('parses the media type and bare tokens', () => {
    const r = parseMimeParams('text/plain; charset=utf-8; filename=report.pdf');
    expect(r.value).toBe('text/plain');
    expect(r.params).toHaveLength(2);
    expect(r.params[1]).toMatchObject({
      name: 'filename',
      value: 'report.pdf',
      precedence: 0,
    });
  });

  it('parses quoted strings with quoted-pair escapes', () => {
    const r = parseMimeParams('attachment; filename="my \\"quote\\"; file.txt"');
    expect(r.params[0].value).toBe('my "quote"; file.txt');
  });

  it('does not percent-decode plain values', () => {
    const r = parseMimeParams('attachment; filename=50%2Etxt');
    expect(r.params[0].value).toBe('50%2Etxt');
  });

  it('diagnoses an unclosed quoted string but keeps the value', () => {
    const r = parseMimeParams('attachment; filename="abc');
    expect(r.params[0].value).toBe('abc');
    expect(codes('attachment; filename="abc')).toContain('unclosed-quoted-string');
  });

  it('rejects malformed and bad-attribute segments', () => {
    expect(codes('text/plain; bogus')).toContain('malformed-param');
    expect(codes('text/plain; bad@attr=1')).toContain('bad-attribute');
  });
});

describe('RFC 2231 extended single values', () => {
  it('decodes UTF-8 with language', () => {
    const r = parseMimeParams(
      "attachment; filename*=UTF-8'en'%E2%82%AC%20rates.txt",
    );
    expect(r.params[0]).toMatchObject({
      value: '€ rates.txt',
      precedence: 2,
      charset: 'UTF-8',
      language: 'en',
    });
  });

  it('decodes ISO-8859-1 where each byte is one code point', () => {
    const r = parseMimeParams("attachment; filename*=iso-8859-1'en'r%E9ponse%20%DF");
    expect(r.params[0].value).toBe('réponse ß');
    expect(r.params[0].charset).toBe('ISO-8859-1');
  });

  it('diagnoses missing charset declaration and falls back', () => {
    const input = 'attachment; filename*=nope; filename="plain.txt"';
    const r = parseMimeParams(input);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      'first-section-charset-required',
    );
    expect(r.params[0].value).toBe('plain.txt');
    expect(r.params[0].precedence).toBe(0);
  });

  it('diagnoses unknown charsets at the declaring token, retaining fallback', () => {
    const input = "attachment; filename*=bogus''a%62; filename=fb.txt";
    const r = parseMimeParams(input);
    const d = r.diagnostics.find((d) => d.code === 'unknown-charset')!;
    expect(d).toBeTruthy();
    expect(span(input, d)).toBe('bogus');
    expect(r.params[0]).toMatchObject({ value: 'fb.txt', precedence: 0 });
  });

  it('diagnoses invalid byte sequences for the declared charset', () => {
    const input = "attachment; filename*=UTF-8''%FF%FE; filename=fb.txt";
    const r = parseMimeParams(input);
    expect(codes(input)).toContain('invalid-byte-for-charset');
    expect(r.params[0].value).toBe('fb.txt');
  });
});

describe('RFC 2231 continuations', () => {
  it('assembles extended sections in order', () => {
    const r = parseMimeParams(
      "attachment; filename*0*=UTF-8'en'%E2%82%AC; filename*1*=%20rates.txt",
    );
    expect(r.params[0]).toMatchObject({
      value: '€ rates.txt',
      precedence: 3,
      charset: 'UTF-8',
      language: 'en',
    });
  });

  it('accepts sections appearing out of order', () => {
    const r = parseMimeParams(
      "attachment; filename*1*=%20world; filename*0*=UTF-8''hello",
    );
    expect(r.params[0].value).toBe('hello world');
    expect(r.diagnostics).toHaveLength(0);
  });

  it('keeps a multi-byte UTF-8 character split across sections', () => {
    // € = E2 82 AC is deliberately cut between the three sections.
    const r = parseMimeParams(
      "attachment; filename*0*=UTF-8''a%E2; filename*1*=%82%AC; filename*2*=b",
    );
    expect(r.params[0].value).toBe('a€b');
  });

  it('decodes ISO-8859-1 continuations', () => {
    const r = parseMimeParams(
      "attachment; filename*0*=iso-8859-1''r%E9; filename*1*=ponse",
    );
    expect(r.params[0].value).toBe('réponse');
    expect(r.params[0].charset).toBe('ISO-8859-1');
  });

  it('assembles plain continuations (quoted strings included)', () => {
    const r = parseMimeParams(
      'attachment; filename*0="part one"; filename*1=" part two"',
    );
    expect(r.params[0]).toMatchObject({
      value: 'part one part two',
      precedence: 1,
    });
  });

  it('diagnoses a missing section and keeps the plain fallback', () => {
    const input =
      "attachment; filename*0*=UTF-8''ab; filename*2*=cd; filename=fb.txt";
    const r = parseMimeParams(input);
    const d = r.diagnostics.find((d) => d.code === 'missing-section')!;
    expect(d.message).toContain('section 1');
    expect(r.params[0]).toMatchObject({ value: 'fb.txt', precedence: 0 });
  });

  it('requires the series to start at section 0', () => {
    const input = "attachment; filename*1*=UTF-8''ab; filename=fb.txt";
    const r = parseMimeParams(input);
    expect(codes(input)).toContain('missing-section');
    expect(r.params[0].value).toBe('fb.txt');
  });

  it('requires charset on the first section only', () => {
    const input =
      "attachment; filename*0*=ab; filename*1*=cd; filename=fb.txt";
    const r = parseMimeParams(input);
    expect(codes(input)).toContain('first-section-charset-required');
    expect(r.params[0].value).toBe('fb.txt');
  });

  it('rejects charset/language markers on later sections', () => {
    const input =
      "attachment; filename*0*=UTF-8''ab; filename*1*=UTF-8''cd; filename=fb.txt";
    const r = parseMimeParams(input);
    const d = r.diagnostics.find((d) => d.code === 'continuation-mixed')!;
    expect(d).toBeTruthy();
    expect(span(input, d)).toContain("UTF-8''cd");
    expect(r.params[0].value).toBe('fb.txt');
  });

  it('diagnoses mixing starred and unstarred sections, retaining fallback', () => {
    const input =
      "attachment; filename*0=utf-8''a; filename*1*=b; filename=fb.txt";
    const r = parseMimeParams(input);
    expect(codes(input)).toContain('continuation-mixed');
    // The anchor points at the offending `filename*1*` attribute.
    const d = r.diagnostics.find((d) => d.code === 'continuation-mixed')!;
    expect(span(input, d)).toBe('filename*1*');
    expect(r.params[0].value).toBe('fb.txt');
  });

  it('invalidates a continuation containing a repeated section', () => {
    const input =
      "attachment; filename*0*=UTF-8''a; filename*0*=x; filename*1*=b; filename=fb.txt";
    const r = parseMimeParams(input);
    expect(codes(input)).toContain('duplicate-section');
    expect(r.params[0]).toMatchObject({ value: 'fb.txt', precedence: 0 });
  });

  it('locates bad percent escapes precisely, even inside quoted strings', () => {
    const input = "attachment; filename*=UTF-8''100%%2Etxt; filename=fb.txt";
    const r = parseMimeParams(input);
    const d = r.diagnostics.find((d) => d.code === 'bad-percent-escape')!;
    expect(span(input, d)).toBe('%%2');
    expect(r.params[0].value).toBe('fb.txt');

    const truncated = parseMimeParams("attachment; filename*=UTF-8''abc%4");
    const t = truncated.diagnostics.find((d) => d.code === 'bad-percent-escape')!;
    expect(t).toBeTruthy();
    expect(t.length).toBe(2);

    const badHex = parseMimeParams('attachment; filename*=UTF-8\'\'%ZZ');
    expect(badHex.diagnostics.map((d) => d.code)).toContain('bad-percent-escape');
  });
});

describe('precedence', () => {
  it('prefers extended continuation over extended single over plain', () => {
    const input =
      "attachment; filename=plain.txt; filename*=UTF-8''single.txt; " +
      "filename*0*=UTF-8''cont; filename*1*=inued.txt";
    const r = parseMimeParams(input);
    expect(r.params[0]).toMatchObject({ value: 'continued.txt', precedence: 3 });
    expect(r.diagnostics).toHaveLength(0);
  });

  it('prefers extended single over plain', () => {
    const r = parseMimeParams(
      "attachment; filename=plain.txt; filename*=UTF-8''ext.txt",
    );
    expect(r.params[0]).toMatchObject({ value: 'ext.txt', precedence: 2 });
  });

  it('prefers plain continuation over plain single', () => {
    const r = parseMimeParams(
      'attachment; filename=plain.txt; filename*0=a; filename*1=b',
    );
    expect(r.params[0]).toMatchObject({ value: 'ab', precedence: 1 });
  });

  it('flags repeated plain parameters but keeps the first value', () => {
    const r = parseMimeParams('attachment; filename=a; filename=b');
    expect(codes('attachment; filename=a; filename=b')).toContain(
      'duplicate-param',
    );
    expect(r.params[0].value).toBe('a');
  });
});

describe('serialization', () => {
  it('uses plain quoted-string form for ASCII values', () => {
    expect(serializeMimeParam('filename', 'my report.txt')).toBe(
      'filename="my report.txt"',
    );
    expect(serializeMimeParam('x', 'simple.txt')).toBe('x=simple.txt');
    expect(serializeMimeParam('x', 'a"b\\c')).toBe('x="a\\"b\\\\c"');
  });

  it('uses extended form for non-ASCII values and parses back identically', () => {
    const wire = serializeMimeParam('filename', '€ rates.txt');
    expect(wire).toBe("filename*=UTF-8''%E2%82%AC%20rates.txt");
    const r = parseMimeParams(`attachment; ${wire}`);
    expect(r.params[0].value).toBe('€ rates.txt');
  });

  it('folds long values into sections and re-parses to the same value', () => {
    const value = 'abc€defghijklmnop';
    const wire = serializeMimeParam('filename', value, {
      maxSectionLength: 6,
    });
    expect(wire).toContain('filename*0*=');
    expect(wire).toContain('filename*1*=');
    // The € triplet must be split across a section boundary.
    expect(wire).toContain('%E2;');
    const r = parseMimeParams(`attachment; ${wire}`);
    expect(r.params[0].value).toBe(value);
  });

  it('round-trips ISO-8859-1 encoding', () => {
    const value = 'réponse.ß';
    const wire = serializeMimeParam('filename', value, {
      charset: 'iso-8859-1',
      language: 'fr',
    });
    const r = parseMimeParams(`attachment; ${wire}`);
    expect(r.params[0]).toMatchObject({
      value,
      charset: 'ISO-8859-1',
      language: 'fr',
    });
  });

  it('encodes a literal percent exactly once, never double-encoding', () => {
    const value = '100% done ✓';
    const wire1 = serializeMimeParam('filename', value);
    expect(wire1).toContain('100%25%20done');
    expect(wire1).not.toContain('%2525');

    const once = parseMimeParams(`attachment; ${wire1}`).params[0].value;
    expect(once).toBe(value);

    const wire2 = serializeMimeParam('filename', once);
    expect(wire2).toBe(wire1);
    const twice = parseMimeParams(`attachment; ${wire2}`).params[0].value;
    expect(twice).toBe(value);
  });

  it('round-trips a full header with mixed parameters', () => {
    const wire = serializeMimeParams('attachment', [
      { name: 'filename', value: 'long naïve fïle name.txt', maxSectionLength: 12 },
      { name: 'size', value: '42' },
    ]);
    const r = parseMimeParams(wire);
    expect(r.value).toBe('attachment');
    expect(r.params[0].value).toBe('long naïve fïle name.txt');
    expect(r.params[1]).toMatchObject({ name: 'size', value: '42' });
    expect(r.diagnostics).toHaveLength(0);
  });
});
