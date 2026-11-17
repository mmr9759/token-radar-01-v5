[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun entry](https://make.fun/badge-entry.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun agent](https://make.fun/badge-agent.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — radar-5

A token launch radar: the 40 watchlist protocols (TVL at or above $50M, no token on record) plus
160 early pre-token protocols below the floor, ranked by implied value.

## The model

Implied value follows only from the snapshot's own figures. The multiple is calibrated per
category from the protocols in that category whose token already trades, shrunk toward the global
median so a thin category cannot set the price — and a category with fewer than 3 comparables
takes the global median outright, so one small outlier never prices a whole category. The multiple
is then adjusted by seven-day growth and by how long the protocol has run with no token:

```
implied = round(tvl_usd x multiple(category) x (1 + clamp(change_7d, -50, 100) / 100 x 0.6)
                x (0.7 + min(age_days, 1095) / 1095 x 0.5))
```

Readiness is a second, separate signal — age plus growth, 0 to 100, shown as Hot / Warming /
Early — and never changes the rank. Every protocol also carries a farm plan: six concrete steps
with a cost and a time, derived from its category, chains, TVL and age.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` reads the sealed snapshot, writes `board.json`, `data.js`, `dashboard/` and
`screenshots/` to the output directory, and writes `dossier.json` with the vendored library.
