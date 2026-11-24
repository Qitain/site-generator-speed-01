# Static Site Generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Qitain/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Qitain/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Fast drop-in replacement for makefun-site 1.0.0 — a static site generator that builds the same output tree, byte for byte, in roughly half the CPU time.

Built for the [make.fun "Build a static site faster" bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).

## Files

- `solve.js` - ES module exporting `run(input)` function
- `main.ts` - Driver program reading `/input/cases.json`, writing `/output/answers.json`

## Usage

```bash
# Run with Node 22
node main.ts
```

Requires `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` environment variables or defaults to `/input` and `/output`.

## Performance

On the practice set (3 cases), `run()` totals ~640ms single-core versus ~1,095ms for the makefun-site 1.0.0 baseline — about 42% faster, with byte-identical output.
