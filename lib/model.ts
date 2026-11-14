// The token radar's model, version radar-2: one sealed snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never the ceiling) and adds
// every rankable pre-token protocol below the watchlist floor: the early rows the radar exists to
// find. A protocol is pre-token when its record carries no token (no market cap, no CoinGecko id,
// no symbol). Live-token protocols are kept apart and shown with the market's own values, never
// mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures, through a base multiple calibrated
// from the snapshot itself:
//
//   calibrate  for each category, the median mcap_usd / tvl_usd of the live-token protocols in
//              that category with tvl > 0 and mcap > 0; clamped to [0.05, 3.0]. A category with
//              no usable live comps falls back to the global median over all live-token protocols.
//   base       = tvl_usd x base_multiple(category)
//   growth     = 1 + clamp(change_7d, -60, 120) / 100 x 0.5          (null change counts as 0)
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4              (unknown age counts as 365 days)
//   breadth    = 1 + 0.02 x min(chains.length, 5)
//   implied    = max(1, round(base x growth x maturity x breadth))
//
// Every factor is rounded to four decimals before it enters the product, so the dashboard's page
// recomputes exactly the number board.json carries. No protocol name is ever special-cased: the
// same function scores every row, and the farm plan for a row comes from its category, chains,
// TVL tier and age alone.

/** One protocol entry of the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's named constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  chain_step: number;
  chain_max: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 3.0,
  chain_step: 0.02,
  chain_max: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live tab carries, by market cap. */
export const LIVE_ROWS = 24;

/** One multiple a category calibrated to, with the count of live comps behind it. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  comps: number;
}

/** The calibration of the whole snapshot: one multiple per category plus the global fallback. */
export interface Calibration {
  global_multiple: number;
  global_comps: number;
  categories: CategoryMultiple[];
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The model's own breakdown for one row, carried in board.json and data.js alike. */
export interface ModelBreakdown {
  base_multiple: number;
  base_comps: number;
  base_fallback: boolean;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_factor: number;
  age_days: number | null;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

/** A board row's compact form for data.js, with the farm plan carried verbatim. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Four decimals, so every factor the page recomputes with is the one the board used. */
export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a sorted list of numbers. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Calibrate the base multiple from the snapshot's own live-token protocols: for each category,
 * the median mcap/tvl of its live protocols with tvl > 0 and mcap > 0, clamped to the model's
 * band; the global median over all live protocols is the fallback for categories with no comps.
 * The result is a pure function of the snapshot: the same bytes always calibrate the same way.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio)) continue;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  all.sort((a, b) => a - b);
  const global = all.length > 0 ? round4(Math.min(model.multiple_cap, Math.max(model.multiple_floor, median(all)))) : 0.25;
  const categories: CategoryMultiple[] = [];
  for (const [category, ratios] of byCategory) {
    ratios.sort((a, b) => a - b);
    categories.push({
      category,
      multiple: round4(Math.min(model.multiple_cap, Math.max(model.multiple_floor, median(ratios)))),
      comps: ratios.length,
    });
  }
  categories.sort((a, b) => b.multiple - a.multiple || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { global_multiple: global, global_comps: all.length, categories };
}

/** A category's calibrated multiple: its own median, or the global fallback when it has no comps. */
export function multipleFor(category: string | null, calibration: Calibration): { multiple: number; comps: number; fallback: boolean } {
  const hit = calibration.categories.find((c) => c.category === (category ?? 'Other'));
  if (hit !== undefined) return { multiple: hit.multiple, comps: hit.comps, fallback: false };
  return { multiple: calibration.global_multiple, comps: calibration.global_comps, fallback: true };
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Every factor of one protocol's implied value, and the value itself. */
export interface Scored {
  implied: number;
  breakdown: ModelBreakdown;
}

/** Score one protocol: the calibrated base multiple, growth, maturity and chain breadth. */
export function impliedValue(p: SnapshotProtocol, asOf: string, calibration: Calibration, model: ModelConstants = MODEL): Scored {
  const age = ageDays(asOf, p.listed_at);
  const { multiple, comps, fallback } = multipleFor(p.category, calibration);
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = round4(1 + (growthPct / 100) * model.growth_weight);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = round4(model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range);
  const chainFactor = round4(1 + model.chain_step * Math.min(p.chains.length, model.chain_max));
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult * chainFactor));
  return {
    implied,
    breakdown: {
      base_multiple: multiple,
      base_comps: comps,
      base_fallback: fallback,
      growth_pct: growthPct,
      growth_multiplier: growthMult,
      maturity_multiplier: maturityMult,
      chain_factor: chainFactor,
      age_days: age,
    },
  };
}

/** A name ending in a release marker is a versioned pool of another protocol, not a launch of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the board never ranks: exchanges and wrapped, staked or bridged products. */
export const EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Whether a protocol's record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an excluded category, not versioned. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !EXCLUDED_CATEGORIES.has(p.category ?? '') && !VERSIONED.test(p.name);
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, calibration: Calibration, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, whatever the protocol's own record says.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor. No cap, no
  // hand-picking: the floor is never the whole board, and the early rows are the radar's point.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, calibration, model) }));
  // Total order: implied value down, slug up, so two runs always rank the same way.
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(s.p.slug),
    age_days: s.breakdown.age_days,
    implied_value_usd: s.implied,
    model: s.breakdown,
    farm_steps: farmSteps(s.p, s.breakdown.age_days).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live tab. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js: the same farm plan, verbatim, so page and board agree. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    watchlist: row.watchlist,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    model: row.model,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot, model);
  const board = buildBoard(snapshot, calibration, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * One farm plan per category family: six steps, each a concrete action with a cost and a time.
 * Placeholders: {N} the protocol's name, {C} its first chain, {K} the capital, {H} the hold in
 * days, {G} the gas estimate. A plan is derived from the protocol's own record, never from a
 * hand-written list of names.
 */
type PlanTemplate = [text: string, cost: string, time: string][];

const SETUP: [string, string, string] = [
  'Open {N} on {C} in a fresh wallet and fund it with ${K} of USDC plus ${G} for gas, keeping the seed phrase offline.',
  '${K} of capital and about ${G} of gas',
  '10 minutes to fund',
];
const POINTS: [string, string, string] = [
  "Check {N}'s own points or rewards page weekly and claim only from the link the protocol itself publishes.",
  'no fee to check, and never pay to claim',
  '10 minutes a week',
];
const LOG: [string, string, string] = [
  'Record the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
  'nothing but the log',
  '5 minutes',
];

const PLANS: Record<string, PlanTemplate> = {
  dexs: [
    SETUP,
    ["Swap half the USDC for the pool's second asset, then add ${K} of liquidity to {N}'s deepest pool on {C}.", '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Route one swap a week through {N} instead of another exchange, putting at least $25 of volume through it each time.', 'about $2 of gas a week', '10 minutes a week'],
    ['Keep the liquidity in the pool for at least {H} days so the position is counted in more than one snapshot.', 'the ${K} stays in the pool', '{H} days'],
    POINTS,
    ['Record the wallet, the pool, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  lending: [
    SETUP,
    ['Supply ${K} of USDC to {N} on {C} and leave it earning; do not borrow against it in the first week.', '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Borrow $20 against the supply once, repay it within the week, and repeat the borrow-repay cycle monthly.', 'about $2 of gas a month plus borrow interest', '10 minutes a month'],
    ['Keep the supply open for at least {H} days so the position is counted in more than one snapshot.', 'the ${K} stays supplied', '{H} days'],
    POINTS,
    ['Record the wallet, the market, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  yield: [
    SETUP,
    ["Deposit ${K} of USDC into {N}'s highest-TVL vault on {C} and keep the vault shares in the same wallet.", '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ["Harvest or compound the vault's rewards once a week instead of letting them sit unclaimed.", 'about $2 of gas a week', '10 minutes a week'],
    ['Hold the vault shares for at least {H} days so the deposit is counted in more than one snapshot.', 'the ${K} stays in the vault', '{H} days'],
    POINTS,
    ['Record the wallet, the vault, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  derivatives: [
    SETUP,
    ['Deposit ${K} of USDC as margin on {N} and open one small position worth no more than $25, then close it the same day.', '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Place one small trade a week on {N}, alternating long and short, and never hold leverage overnight.', 'about $2 of gas a week plus trading fees', '10 minutes a week'],
    ['Keep the margin account funded for at least {H} days so the activity is counted in more than one snapshot.', 'the ${K} stays as margin', '{H} days'],
    ["Before you close the account, check {N}'s own points or rewards page and claim only from the link it publishes.", 'no fee to check, and never pay to claim', '10 minutes'],
    ['Record the wallet, the trades, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  bridge: [
    SETUP,
    ['Bridge ${K} of USDC to {C} through {N} and use the bridged funds inside the destination app.', '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Bridge at least $25 back or onward once a week so the wallet shows repeat crossings.', 'about $2 of gas a week plus bridge fees', '10 minutes a week'],
    ['Keep using {N} for crossings for at least {H} days so the activity is counted in more than one snapshot.', 'the ${K} keeps moving', '{H} days'],
    POINTS,
    ['Record the wallet, the routes, the dates and every transaction in a farm log so you can repeat the crossings or unwind them.', 'nothing but the log', '5 minutes'],
  ],
  staking: [
    SETUP,
    ["Stake ${K} of the chain's staking asset through {N} on {C} and keep the receipt token in the same wallet.", '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Restake or compound the staking rewards once a week instead of letting them sit unclaimed.', 'about $2 of gas a week', '10 minutes a week'],
    ['Keep the stake locked for at least {H} days so the position is counted in more than one snapshot.', 'the ${K} stays staked', '{H} days'],
    POINTS,
    ['Record the wallet, the stake, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  rwa: [
    SETUP,
    ["Mint ${K} of {N}'s yield-bearing asset on {C} and hold it in the farming wallet.", '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ["Claim or reinvest the asset's yield once a week and keep the position above ${K}.", 'about $2 of gas a week', '10 minutes a week'],
    ['Hold the asset for at least {H} days so the position is counted in more than one snapshot.', 'the ${K} stays in the asset', '{H} days'],
    POINTS,
    ['Record the wallet, the asset, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  stablecoin: [
    SETUP,
    ["Mint or buy ${K} of {N}'s stable asset on {C} and hold it in the farming wallet.", '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ["Put the stable asset to work in one of {N}'s own pools or vaults once a week.", 'about $2 of gas a week', '10 minutes a week'],
    ['Keep at least ${K} of the stable asset for at least {H} days so the balance is counted in more than one snapshot.', 'the ${K} stays in the asset', '{H} days'],
    POINTS,
    ['Record the wallet, the asset, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  prediction: [
    SETUP,
    ['Fund the wallet with ${K} and place one market position on {N}, staking no more than $25 on a single outcome.', '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Place one new market position each week, on a different market, and let each resolve before reusing the funds.', 'about $2 of gas a week plus the stakes', '10 minutes a week'],
    ['Keep trading on {N} for at least {H} days so the activity is counted in more than one snapshot.', 'the ${K} stays in play', '{H} days'],
    POINTS,
    ['Record the wallet, the markets, the dates and every transaction in a farm log so you can repeat the positions or unwind them.', 'nothing but the log', '5 minutes'],
  ],
  insurance: [
    SETUP,
    ['Buy ${K} of cover from {N} on {C} for a protocol you actually use, and keep the policy active.', '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Renew or extend the cover before it lapses, and file no claim unless a covered event really happens.', 'the renewal premium, about $5', '10 minutes a month'],
    ['Keep cover active for at least {H} days so the policy is counted in more than one snapshot.', 'the ${K} stays as cover', '{H} days'],
    POINTS,
    ['Record the wallet, the policy, the dates and every transaction in a farm log so you can renew the cover or let it lapse.', 'nothing but the log', '5 minutes'],
  ],
  curators: [
    SETUP,
    ['Deposit ${K} into a {N} vault on {C} and keep the vault shares in the same wallet.', '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ["Check the vault's allocation weekly and move the deposit only if the curator's strategy changes.", 'about $2 of gas a week', '10 minutes a week'],
    ['Hold the vault shares for at least {H} days so the deposit is counted in more than one snapshot.', 'the ${K} stays in the vault', '{H} days'],
    POINTS,
    ['Record the wallet, the vault, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
  ],
  generic: [
    SETUP,
    ['Deposit ${K} of USDC into {N} on {C} and keep the position open.', '${K} of capital and about ${G} of gas', '15 minutes to set up'],
    ['Make one qualifying action each week, such as a deposit, a swap, a vote or a claim.', 'about $2 of gas a week', '10 minutes a week'],
    ['Hold the position for at least {H} days so the activity is counted in more than one snapshot.', 'the ${K} stays in the position', '{H} days'],
    POINTS,
    LOG,
  ],
};

/** A category's plan family, from its name alone: no protocol is ever named here. */
export function familyOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('dex')) return 'dexs';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity manager')) return 'yield';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('basis')) return 'derivatives';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restak') || c.includes('btc')) return 'staking';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('stable')) return 'stablecoin';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('curator') || c.includes('allocator')) return 'curators';
  return 'generic';
}

/** Fill a plan template's placeholders from one protocol's own figures. */
function fill(template: string, p: SnapshotProtocol, capital: number, hold: number, gas: number): string {
  return template
    .replaceAll('{N}', p.name)
    .replaceAll('{C}', chainOf(p))
    .replaceAll('{K}', String(capital))
    .replaceAll('{H}', String(hold))
    .replaceAll('{G}', String(gas));
}

/** A protocol's farm plan: six steps, each an action with a cost and a time. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const plan = PLANS[familyOf(p.category)] ?? PLANS.generic!;
  return plan.map(([text, cost, time]) => ({
    text: fill(text, p, capital, hold, gas),
    cost: fill(cost, p, capital, hold, gas),
    time: fill(time, p, capital, hold, gas),
  }));
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside the gate's 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board names a slug twice';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
