# Token Radar

A token launch radar for make.fun's `token-radar-01` bounty: it ranks the pre-token
protocols of a sealed DefiLlama snapshot by an implied value, and shows a reader how to
farm each one.

## The model (radar-2)

The base multiple is calibrated from the snapshot itself: for each category, the median
market-cap-to-TVL ratio of its live-token protocols (clamped to 0.05–3.00), falling back
to the global median for categories with no live comps. Implied value is then
`TVL × base multiple × growth × maturity × chain breadth`, where growth follows the
seven-day TVL change (clamped −60% to +120%), maturity follows the protocol's age with
no token, and breadth counts the chains it runs on. No protocol name is ever
special-cased. The board covers all 40 watchlist protocols plus every rankable
pre-token protocol below the $50M floor; the live-token protocols are set aside in
their own tab with their market caps shown.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

That writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json`. The program runs on Node 22 or later, standard library only,
with no network.

## Layout

- `main.ts` — the entrypoint: read the snapshot, score the board, write the outputs.
- `lib/model.ts` — the model, the calibration, the farm plans and the board checks.
- `dashboard/` — the static page (index.html, app.css, app.js), no network.
- `screenshots/` — the board, a detail view and a filtered view.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit.

Built for the make.fun bounty — referral code `6t2bz3kn`.
