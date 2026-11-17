// lib/model.ts — the token launch radar's model.
//
// The radar reads a sealed DefiLlama snapshot (protocols with TVL, a 7-day
// change, a listing date, and whether a token is recorded) and turns it into
// a ranked board of protocols whose token does not exist yet, each with an
// implied value and a farm plan. Nothing here is hardcoded by name: every
// number comes from the snapshot itself.
//
// The value model, in one line:
//   implied = TVL x category multiple x growth x maturity
//
// - category multiple: the median market-cap-per-TVL of the tokenised
//   protocols in the same category, shrunk toward the global median when
//   the category has few comparables (fewer than three means the global
//   median is used outright). A multiple is only sane between 0.005 and 5;
//   a token worth nothing, or one worth hundreds of times its TVL, is not
//   a comparable for a launch.
// - growth: the protocol's 7-day TVL change, dampened by half and clamped,
//   so a hot week lifts the value and a cold week trims it, neither by much.
// - maturity: how long the protocol has run. A protocol that has held TVL
//   for two years without a token is a steadier launch candidate than one
//   listed last month, so the factor rises from 0.90 (new) to 1.00 (2y+).
//
// Readiness is a separate 0-100 score from the same two signals, age and
// growth: up to 60 points for age (two years is full marks) and up to 40
// for the 7-day change. Hot is 60+, Warming 35-59, Early under 35.

import { readFileSync } from "node:fs";

// ---------- snapshot shapes ----------

export interface SnapProto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface SnapFile {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProto[];
  watchlist: string[];
}

// ---------- board shapes ----------

export interface Scored {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  multiple: number;
  multiple_n: number;
  multiple_source: "category" | "global";
  growth: number;
  maturity: number;
  implied_value_usd: number;
  readiness: number;
  band: "Hot" | "Warming" | "Early";
  farm_steps: string[];
  watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export interface CatMult {
  category: string;
  comparables: number;
  raw_median: number | null;
  multiple: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  global_multiple: number;
  global_n: number;
  categories: CatMult[];
  rows: Scored[];
  live: LiveRow[];
}

// ---------- small helpers ----------

export function median(values: number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function fmtMoney(usd: number): string {
  if (usd >= 1e9) return "$" + (usd / 1e9).toFixed(2) + "B";
  if (usd >= 1e6) return "$" + (usd / 1e6).toFixed(1) + "M";
  if (usd >= 1e3) return "$" + (usd / 1e3).toFixed(1) + "K";
  return "$" + Math.round(usd);
}

function fmtPct(x: number | null): string {
  if (x === null || x === undefined) return "an unreported amount";
  const sign = x > 0 ? "+" : "";
  return sign + x.toFixed(1) + "%";
}

// ---------- snapshot ----------

export function readSnap(path: string): SnapFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as SnapFile;
  return raw;
}

export function recordsToken(p: SnapProto): boolean {
  return p.gecko_id !== null && p.gecko_id !== undefined
    || p.symbol !== null && p.symbol !== undefined;
}

// A protocol is a launch candidate for the early board when it records no
// token, is not a bridge or a centralised exchange (those move other
// people's tokens; they do not launch their own), and is not named after
// one. The watchlist itself is read from the snapshot, never recomputed.
const EXCHANGE_OPENERS = new Set([
  "binance", "coinbase", "bybit", "kraken", "bitget", "okx", "bitfinex", "gemini",
]);

export function hardExcluded(p: SnapProto): boolean {
  if (p.category === "Bridge" || p.category === "Canonical Bridge" || p.category === "CEX") {
    return true;
  }
  if (/\bbridge\b/i.test(p.name)) return true;
  const first = (p.name.split(/\s+/)[0] ?? "").toLowerCase();
  return EXCHANGE_OPENERS.has(first);
}

// ---------- multiples ----------

// A tokenised protocol is a comparable only when its market-cap-per-TVL is
// sane: at least 0.005 (a token worth something) and at most 5 (a token
// worth five times the value locked under it is an outlier, not a yardstick).
function saneMultiple(p: SnapProto): number | null {
  if (p.mcap_usd === null || p.mcap_usd === undefined) return null;
  if (!p.tvl_usd || p.tvl_usd <= 0) return null;
  const m = p.mcap_usd / p.tvl_usd;
  if (m < 0.005 || m > 5) return null;
  return m;
}

export interface Multiples {
  global: number;
  global_n: number;
  byCategory: Map<string, CatMult>;
}

export function buildMultiples(protos: SnapProto[]): Multiples {
  const sane: Array<{ cat: string; m: number }> = [];
  for (const p of protos) {
    const m = saneMultiple(p);
    if (m !== null && p.category) sane.push({ cat: p.category, m });
  }
  const global = median(sane.map((s) => s.m));
  const grouped = new Map<string, number[]>();
  for (const s of sane) {
    const list = grouped.get(s.cat) ?? [];
    list.push(s.m);
    grouped.set(s.cat, list);
  }
  // Shrink each category median toward the global one. Six is the weight of
  // the global median: a category with six comparables is trusted halfway,
  // one with many more mostly speaks for itself.
  const SHRINK = 6;
  const byCategory = new Map<string, CatMult>();
  for (const [cat, ms] of grouped) {
    const raw = median(ms);
    const mult = ms.length < 3
      ? global
      : (ms.length * raw + SHRINK * global) / (ms.length + SHRINK);
    byCategory.set(cat, {
      category: cat,
      comparables: ms.length,
      raw_median: ms.length < 3 ? null : raw,
      multiple: mult,
    });
  }
  return { global, global_n: sane.length, byCategory };
}

function multipleFor(
  cat: string | null,
  mults: Multiples,
): { multiple: number; n: number; source: "category" | "global" } {
  if (cat) {
    const hit = mults.byCategory.get(cat);
    if (hit) {
      return {
        multiple: hit.multiple,
        n: hit.comparables,
        source: hit.comparables < 3 ? "global" : "category",
      };
    }
  }
  return { multiple: mults.global, n: 0, source: "global" };
}

// ---------- growth, maturity, readiness ----------

export function growthOf(p: SnapProto): number {
  if (p.change_7d === null || p.change_7d === undefined) return 1;
  return 1 + 0.5 * (clamp(p.change_7d, -30, 60) / 100);
}

export function maturityOf(p: SnapProto, asOf: string): number {
  if (!p.listed_at) return 0.95;
  const age = daysBetween(p.listed_at, asOf);
  return 0.9 + 0.1 * (Math.min(age, 730) / 730);
}

export function readinessOf(p: SnapProto, asOf: string): number {
  const agePts = !p.listed_at
    ? 30
    : (Math.min(daysBetween(p.listed_at, asOf), 730) / 730) * 60;
  const ch = p.change_7d;
  const growthPts = ch === null || ch === undefined
    ? 20
    : ((clamp(ch, -20, 40) + 20) / 60) * 40;
  return Math.round(clamp(agePts + growthPts, 0, 100));
}

export function bandOf(score: number): "Hot" | "Warming" | "Early" {
  if (score >= 60) return "Hot";
  if (score >= 35) return "Warming";
  return "Early";
}

// ---------- farm plans ----------

// A farm plan is five concrete steps, chosen by the protocol's category and
// filled in with its own numbers: its name, its busiest chain, a deposit
// sized to its TVL, that chain's gas, and its 7-day move. No step is a
// slogan; each one says what to do, what it costs, and how often.

const CHEAP_GAS = new Set([
  "Base", "Arbitrum", "Optimism", "Unichain", "Polygon", "Katana", "Ink",
  "Scroll", "BOB", "Berachain", "Sonic", "Corn", "Arc", "Tempo", "Stable",
  "Morph", "Monad", "Plasma",
]);

function gasFor(chain: string): string {
  if (chain === "Ethereum") return "$4";
  if (chain === "Solana") return "$0.02";
  if (chain === "Binance") return "$0.10";
  if (chain === "Hyperliquid L1") return "$0.05";
  if (CHEAP_GAS.has(chain)) return "$0.30";
  return "$1";
}

function depositFor(tvl: number): string {
  if (tvl >= 1e9) return "$2,000";
  if (tvl >= 2e8) return "$1,000";
  if (tvl >= 5e7) return "$500";
  return "$250";
}

function fill(
  template: string,
  vars: { name: string; chain: string; dep: string; gas: string; chg: string },
): string {
  return template
    .replaceAll("{name}", vars.name)
    .replaceAll("{chain}", vars.chain)
    .replaceAll("{dep}", vars.dep)
    .replaceAll("{gas}", vars.gas)
    .replaceAll("{chg}", vars.chg);
}

const PLAN_GROUPS: Record<string, string[]> = {
  lending: [
    "Deposit {dep} of collateral (ETH or a stablecoin) into {name} on {chain}; a first deposit of {dep} keeps gas under 2% of the position.",
    "Borrow a stablecoin against the deposit at a loan-to-value near 60% and keep the health factor above 1.5, so a 10% dip does not liquidate you.",
    "Put the borrowed stablecoin to work once a week — supply it back, or loop it into the same market — each loop costs about {gas} in gas.",
    "Check the position every Sunday and top up collateral if the 7-day TVL falls more than 15%; {name} moved {chg} in the last 7 days.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the position open and the borrow active.",
  ],
  dexs: [
    "Provide {dep} of liquidity to the busiest {name} pool on {chain} (a stablecoin pair first); the deposit costs about {gas} in gas.",
    "Swap through {name} at least once a week instead of another DEX, so the volume is tied to your address.",
    "Hold the LP position for 30 days or more; withdrawing early usually forfeits points or fee tiers.",
    "Rebalance the range or pool when the pair drifts more than 5% from your entry; each rebalance costs about {gas}.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the liquidity in place.",
  ],
  rwa: [
    "Buy or mint {dep} of a tokenised real-world asset on {name} ({chain}); the mint costs about {gas} in gas.",
    "Hold the position for at least 30 days — RWA points and airdrops reward holders, not flippers.",
    "Reinvest the yield weekly into the same asset so the position compounds; each reinvestment costs about {gas}.",
    "Check the underlying asset's backing and the 7-day TVL each Sunday; {name} moved {chg} in the last 7 days.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the holding and stay active.",
  ],
  staking: [
    "Stake {dep} of the native asset through {name} on {chain}; the stake costs about {gas} in gas.",
    "Use the liquid staking token in a lending market or LP instead of leaving it idle, so the same capital earns twice.",
    "Restake or compound the staking rewards once a week; each claim costs about {gas}.",
    "Check the validator set and the 7-day TVL each Sunday; {name} moved {chg} in the last 7 days.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the stake and the DeFi position open.",
  ],
  yield: [
    "Deposit {dep} into the highest-TVL vault on {name} ({chain}); the deposit costs about {gas} in gas.",
    "Leave the deposit for at least 30 days; vault points and airdrops reward sticky capital, not deposits that leave in a week.",
    "Harvest and compound the yield once a week; each harvest costs about {gas}.",
    "Compare the vault's APY and the 7-day TVL each Sunday; {name} moved {chg} in the last 7 days — move if the APY halves.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the deposit in place.",
  ],
  cdp: [
    "Open a vault on {name} ({chain}) with {dep} of collateral and mint the stablecoin at a collateral ratio above 150%.",
    "Use the minted stablecoin in a lending market or LP so the position earns while it is open; each move costs about {gas}.",
    "Top up collateral if the ratio falls toward 130%; a liquidation costs far more than the top-up.",
    "Check the collateral ratio and the 7-day TVL every Sunday; {name} moved {chg} in the last 7 days.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the vault open.",
  ],
  basis: [
    "Deposit {dep} into the delta-neutral vault on {name} ({chain}); the deposit costs about {gas} in gas.",
    "Leave the deposit for at least 30 days; basis-trade points reward sticky capital.",
    "Harvest the funding yield once a week and reinvest it; each harvest costs about {gas}.",
    "Watch the funding rate and the 7-day TVL each Sunday; {name} moved {chg} in the last 7 days — exit if funding turns negative for two weeks.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the deposit in place.",
  ],
  curator: [
    "Deposit {dep} into a {name} vault or curator on {chain}; the deposit costs about {gas} in gas.",
    "Pick a vault whose curator has the longest track record and the most TVL, not the highest advertised APY.",
    "Leave the deposit for at least 30 days; curator points reward sticky capital.",
    "Review the curator's allocations and the 7-day TVL each Sunday; {name} moved {chg} in the last 7 days.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the deposit in place.",
  ],
  derivatives: [
    "Open a {dep} position on {name} ({chain}) — a small, defined-risk trade, not a leveraged gamble; the trade costs about {gas} in gas.",
    "Use the protocol at least once a week (open, close or hedge) so the volume is tied to your address.",
    "Keep total exposure under 5% of your portfolio; derivatives points reward activity, not size.",
    "Check open interest and the 7-day TVL each Sunday; {name} moved {chg} in the last 7 days.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so stay active weekly.",
  ],
  generic: [
    "Use {name} on {chain} with {dep} — deposit, swap or provide liquidity, whichever is the protocol's main action; the first transaction costs about {gas} in gas.",
    "Repeat the main action at least once a week so the activity is tied to your address.",
    "Leave the position for at least 30 days; points and airdrops reward sticky users, not one-off visitors.",
    "Check the 7-day TVL and the protocol's announcements each Sunday; {name} moved {chg} in the last 7 days.",
    "Watch for a points program or token announcement; snapshots are usually unannounced, so keep the position open.",
  ],
};

const GROUP_OF: Record<string, string> = {
  Lending: "lending",
  Dexs: "dexs",
  RWA: "rwa",
  "Liquid Staking": "staking",
  "Liquid Restaking": "staking",
  Restaking: "staking",
  "Staking Pool": "staking",
  Yield: "yield",
  "Yield Aggregator": "yield",
  CDP: "cdp",
  "CDP Manager": "cdp",
  "Basis Trading": "basis",
  "Risk Curators": "curator",
  "Onchain Capital Allocator": "curator",
  "Collateral Markets": "curator",
  Derivatives: "derivatives",
  "Interest Rate Derivatives": "derivatives",
  "Options Vault": "derivatives",
  "Leveraged Farming": "derivatives",
};

export function farmSteps(p: SnapProto): string[] {
  const group = GROUP_OF[p.category ?? ""] ?? "generic";
  const templates = PLAN_GROUPS[group] ?? PLAN_GROUPS.generic;
  const chain = p.chains && p.chains.length > 0 ? p.chains[0] : "Ethereum";
  const vars = {
    name: p.name,
    chain,
    dep: depositFor(p.tvl_usd),
    gas: gasFor(chain),
    chg: fmtPct(p.change_7d),
  };
  return templates.map((t) => fill(t, vars));
}

// ---------- scoring and board ----------

function scoreRow(
  p: SnapProto,
  mults: Multiples,
  asOf: string,
  onWatchlist: boolean,
): Scored {
  const found = multipleFor(p.category, mults);
  const growth = growthOf(p);
  const maturity = maturityOf(p, asOf);
  const implied = Math.round(p.tvl_usd * found.multiple * growth * maturity);
  const ready = readinessOf(p, asOf);
  return {
    slug: p.slug,
    name: p.name,
    category: p.category ?? "Uncategorised",
    chains: p.chains ?? [],
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    multiple: found.multiple,
    multiple_n: found.n,
    multiple_source: found.source,
    growth,
    maturity,
    implied_value_usd: implied,
    readiness: ready,
    band: bandOf(ready),
    farm_steps: farmSteps(p),
    watchlist: onWatchlist,
  };
}

// Recompute a row's implied value from its stored factors. The detail view
// runs this same arithmetic and must land on the board's number exactly.
export function rederive(row: Scored): number {
  return Math.round(row.tvl_usd * row.multiple * row.growth * row.maturity);
}

export function buildBoard(snap: SnapFile): Radar {
  const mults = buildMultiples(snap.protocols);
  const watch = new Set(snap.watchlist);
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));

  // The watchlist is the floor: every one of its 40 protocols is ranked.
  const watchRows: SnapProto[] = [];
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (p) watchRows.push(p);
  }

  // The early board is the pre-token protocols below the floor with the
  // most TVL — the ones the radar exists to find. Bridges and centralised
  // exchanges are left out: they move other tokens, they do not launch one.
  const early = snap.protocols
    .filter((p) => !watch.has(p.slug))
    .filter((p) => !recordsToken(p))
    .filter((p) => p.tvl_usd < snap.floor_usd)
    .filter((p) => !hardExcluded(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 160);

  const rows = [...watchRows, ...early]
    .map((p) => scoreRow(p, mults, snap.as_of, watch.has(p.slug)))
    .sort((a, b) => {
      if (b.implied_value_usd !== a.implied_value_usd) {
        return b.implied_value_usd - a.implied_value_usd;
      }
      return a.slug < b.slug ? -1 : 1;
    });

  // The live panel is separate: the 24 tokenised protocols with the most
  // TVL, whose market caps are the comparables the multiples come from.
  const live = snap.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd !== undefined && p.tvl_usd > 0)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p): LiveRow => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorised",
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      multiple: (p.mcap_usd as number) / p.tvl_usd,
    }));

  const categories = [...mults.byCategory.values()]
    .sort((a, b) => b.comparables - a.comparables);

  return {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    global_multiple: mults.global,
    global_n: mults.global_n,
    categories,
    rows,
    live,
  };
}

