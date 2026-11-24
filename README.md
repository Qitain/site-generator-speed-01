# Static Site Generator

Fast drop-in replacement for makefun-site 1.0.0.

## Files

- `solve.js` - ES module exporting `run(input)` function
- `main.ts` - Driver program reading `/input/cases.json`, writing `/output/answers.json`

## Usage

```bash
# Run with Node 22
node main.ts
```

Requires `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` environment variables or defaults to `/input` and `/output`.
