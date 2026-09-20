# MIME stream core

TypeScript library for multipart message parsing and RFC 2231 parameter handling.

Run `npm install`, then `npm test` and `npm run build`.

## RFC 2231 parameters

```ts
import {parseMimeParameters, serializeMimeParameters} from './dist/index.js';

const parsed = parseMimeParameters(
  "attachment; filename*1*=%20txt; filename*0*=utf-8'en'hello%20world",
);

parsed.params.filename; // "hello world txt"
serializeMimeParameters('attachment', {filename: '100% café ☃'});
// attachment; filename*=utf-8''100%25%20caf%C3%A9%20%E2%98%83
```

Out-of-order segments are accepted as long as section numbers start at zero and
have no gaps. Byte segments are concatenated before charset decoding, so a
UTF-8 multibyte sequence may span segments. Invalid extended values are reported
in `diagnostics` with offset/line/column while a usable plain `filename` value
remains available as fallback.
