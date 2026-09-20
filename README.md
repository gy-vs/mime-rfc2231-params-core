# MIME stream core

TypeScript library for multipart message parsing.

Run `npm install`, then `npm test` and `npm run build`.

## RFC 2231 parameters

`parseMimeParams(headerValue)` parses the parameter list of a media-type
header value and understands all four RFC 2231 shapes:

| Shape | Example |
| --- | --- |
| plain | `filename="report.txt"` |
| extended single | `filename*=UTF-8'en'report%20%C3%A4.txt` |
| plain continuation | `filename*0=...; filename*1=...` |
| extended continuation | `filename*0*=UTF-8''...; filename*1*=...` |

Raw bytes are collected per parameter name/section/star flag first; section
continuity (`0…N`, possibly out of order) is verified, then the assembled
bytes are percent-decoded **before** being decoded as the declared charset,
so a multi-byte UTF-8 character split across sections survives.

Precedence when several shapes coexist: extended continuation > extended
single > plain continuation > plain. Invalid extended/continuation shapes
produce a locatable entry in `diagnostics` (offset + length into the header)
— `duplicate-section`, `missing-section`, `first-section-charset-required`,
`continuation-mixed`, `bad-percent-escape`, `unknown-charset`,
`invalid-byte-for-charset` — while a usable plain `filename` remains
available as the resolved value.

`serializeMimeParam(name, value, {charset, language, maxSectionLength})`
emits plain quoted-string form for ASCII and extended/sectioned form for
non-ASCII values; re-parsing its output yields the same logical value and a
literal `%` is encoded exactly once (`%25`).
