// main.ts — token launch radar entrypoint.
//
// Reads the sealed snapshot, builds the ranked board, and writes the whole
// output bundle: board.json, the dashboard with its data, the screenshots,
// and the dossier the judge reads.
//
//   node main.ts [--input snapshot.json] [--output out]
//   MAKEFUN_INPUT_DIR=... MAKEFUN_OUTPUT_DIR=... node main.ts
//
// No network, standard library only, deterministic: two runs write the
// same bytes. The grader runs it with the snapshot at /input/snapshot.json
// and writes to /output.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, fmtMoney, readSnap, rederive } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function resolveInput(argv: string[]): string {
  const fromFlag = flagValue(argv, "--input");
  if (fromFlag) return fromFlag;
  if (process.env.MAKEFUN_INPUT_DIR) {
    return join(process.env.MAKEFUN_INPUT_DIR, "snapshot.json");
  }
  return "/input/snapshot.json";
}

function resolveOutput(argv: string[]): string {
  const fromFlag = flagValue(argv, "--output");
  if (fromFlag) return fromFlag;
  return process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src).sort()) {
    const from = join(src, entry);
    const to = join(dst, entry);
    if (statSync(from).isDirectory()) {
      copyTree(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const inputPath = resolveInput(argv);
  const outDir = resolveOutput(argv);
  const dashOut = join(outDir, "dashboard");
  const shotsOut = join(outDir, "screenshots");

  const snap = readSnap(inputPath);
  const radar = buildBoard(snap);

  // The board: one row per ranked protocol, rank 1 first. Extra fields are
  // allowed, and the detail view reads them, so the numbers it shows are
  // the board's numbers, not a second computation.
  const boardRows = radar.rows.map((row, i) => ({
    slug: row.slug,
    name: row.name,
    rank: i + 1,
    implied_value_usd: row.implied_value_usd,
    farm_steps: row.farm_steps,
    category: row.category,
    tvl_usd: row.tvl_usd,
    readiness: row.readiness,
    band: row.band,
    multiple: row.multiple,
    multiple_n: row.multiple_n,
    multiple_source: row.multiple_source,
    growth: row.growth,
    maturity: row.maturity,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    chains: row.chains,
    watchlist: row.watchlist,
  }));
  const board = {
    as_of: radar.as_of,
    floor_usd: radar.floor_usd,
    global_multiple: radar.global_multiple,
    rows: boardRows,
  };

  // The dashboard's data, kept compact so the whole dashboard source fits
  // the dossier's 64 KiB text: rows are arrays, not objects, and the
  // factors are NOT stored per row. The page recomputes them from the raw
  // inputs (change_7d, listed_at, category) with the same arithmetic the
  // model uses, so the detail view's implied value lands on the board's
  // figure to the dollar.
  // Row: [slug, name, category, tvl, implied, readiness, chains, chg, listed, watchlist]
  // Live: [slug, name, category, tvl, mcap, multiple]
  // Cat: [category, comparables, raw_median, multiple]
  const dataRows = radar.rows.map((row) => [
    row.slug,
    row.name,
    row.category,
    row.tvl_usd,
    row.implied_value_usd,
    row.readiness,
    row.chains.slice(0, 2),
    row.change_7d,
    row.listed_at,
    row.watchlist ? 1 : 0,
  ]);
  const data = {
    asOf: radar.as_of,
    floor: radar.floor_usd,
    globalMult: radar.global_multiple,
    globalN: radar.global_n,
    cats: radar.categories.map((c) => [
      c.category,
      c.comparables,
      c.raw_median,
      c.multiple,
    ]),
    rows: dataRows,
    live: radar.live.map((l) => [
      l.slug,
      l.name,
      l.category,
      l.tvl_usd,
      l.mcap_usd,
      l.multiple,
    ]),
  };

  mkdirSync(outDir, { recursive: true });
  mkdirSync(dashOut, { recursive: true });
  mkdirSync(shotsOut, { recursive: true });

  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n");
  copyTree(join(ROOT, "dashboard"), dashOut);
  // data.js is generated, not part of the repository's dashboard/, so it is
  // written after the copy and can never be clobbered by it.
  writeFileSync(
    join(dashOut, "data.js"),
    "window.RADAR_DATA = " + JSON.stringify(data) + ";\n",
  );
  const shotsSrc = join(ROOT, "screenshots");
  if (existsSync(shotsSrc)) {
    copyTree(shotsSrc, shotsOut);
  }

  // The dossier is built last, from the finished dashboard and screenshots.
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);

  // Sanity: every row's stored factors must rederive its board number.
  let bad = 0;
  for (const row of radar.rows) {
    if (rederive(row) !== row.implied_value_usd) bad++;
  }
  const top = radar.rows[0];
  console.log(
    `radar: ${radar.rows.length} rows, ${radar.rows.filter((r) => r.watchlist).length} watchlist, ` +
    `${radar.live.length} live, global multiple ${radar.global_multiple.toFixed(4)}, ` +
    `top ${top?.name ?? "?"} ${top ? fmtMoney(top.implied_value_usd) : ""}, ` +
    `rederive mismatches ${bad}`,
  );
}

main();
