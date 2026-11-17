// app.js — Token Radar dashboard.
//
// Renders the board from window.RADAR_DATA (written by main.ts) and lets a
// reader search, filter, sort, and open a protocol's detail view.
//
// Data shape (compact arrays, to keep the dashboard source under the
// dossier's 64 KiB text):
//   rows: [slug, name, category, tvl, implied, readiness, chains, chg, listed, watchlist]
//   live: [slug, name, category, tvl, mcap, multiple]
//   cats: [category, comparables, raw_median, multiple]
// The factors are NOT stored per row. The page recomputes them from the raw
// inputs with the same arithmetic the model uses — growth from the 7-day
// change, maturity from the listing date, the multiple from the category
// table — so the detail view's implied value lands on the board's figure
// to the dollar. The farm plan is built from the same per-category
// templates the board's farm_steps use, filled with the row's own numbers.

(function () {
  "use strict";

  var RAW = window.RADAR_DATA || { rows: [], live: [], cats: [] };

  // Expand the compact arrays into named rows once, so the rest of the
  // page reads plainly.
  var ROWS = RAW.rows.map(function (a) {
    return {
      slug: a[0], name: a[1], cat: a[2], tvl: a[3], imp: a[4],
      rdy: a[5], chn: a[6], chg: a[7], lst: a[8], wl: a[9],
    };
  });
  var LIVE = RAW.live.map(function (a) {
    return { slug: a[0], name: a[1], cat: a[2], tvl: a[3], mcap: a[4], mult: a[5] };
  });
  var CATS = RAW.cats.map(function (a) {
    return { cat: a[0], n: a[1], raw: a[2], mult: a[3] };
  });

  // ---------- the model, recomputed from the raw inputs ----------

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function growthOf(chg) {
    if (chg === null || chg === undefined) return 1;
    return 1 + 0.5 * (clamp(chg, -30, 60) / 100);
  }

  function ageDays(listed) {
    if (!listed) return null;
    var a = Date.parse(listed + "T00:00:00Z");
    var b = Date.parse(RAW.asOf + "T00:00:00Z");
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.round((b - a) / 86400000));
  }

  function maturityOf(listed) {
    var age = ageDays(listed);
    if (age === null) return 0.95;
    return 0.9 + 0.1 * (Math.min(age, 730) / 730);
  }

  function catStat(cat) {
    for (var i = 0; i < CATS.length; i++) {
      if (CATS[i].cat === cat) return CATS[i];
    }
    return null;
  }

  // The multiple a row carries: its category's shrunk median, or the
  // global median when the category has fewer than three sane comparables.
  function multipleOf(cat) {
    var stat = catStat(cat);
    if (!stat || stat.n < 3) return RAW.globalMult;
    return stat.mult;
  }

  function rederive(row) {
    return Math.round(row.tvl * multipleOf(row.cat) * growthOf(row.chg) * maturityOf(row.lst));
  }

  function bandOf(score) {
    if (score >= 60) return "Hot";
    if (score >= 35) return "Warming";
    return "Early";
  }

  // ---------- formatting ----------

  function money(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + Math.round(n);
  }

  function moneyFull(n) {
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function pct(x) {
    if (x === null || x === undefined) return "—";
    var s = x > 0 ? "+" : "";
    return s + x.toFixed(1) + "%";
  }

  function pctText(x) {
    if (x === null || x === undefined) return "an unreported amount";
    var s = x > 0 ? "+" : "";
    return s + x.toFixed(1) + "%";
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- farm plans (same templates as the board's farm_steps) ----------

  var CHEAP_GAS = {};
  [
    "Base", "Arbitrum", "Optimism", "Unichain", "Polygon", "Katana", "Ink",
    "Scroll", "BOB", "Berachain", "Sonic", "Corn", "Arc", "Tempo", "Stable",
    "Morph", "Monad", "Plasma",
  ].forEach(function (c) { CHEAP_GAS[c] = true; });

  function gasFor(chain) {
    if (chain === "Ethereum") return "$4";
    if (chain === "Solana") return "$0.02";
    if (chain === "Binance") return "$0.10";
    if (chain === "Hyperliquid L1") return "$0.05";
    if (CHEAP_GAS[chain]) return "$0.30";
    return "$1";
  }

  function depositFor(tvl) {
    if (tvl >= 1e9) return "$2,000";
    if (tvl >= 2e8) return "$1,000";
    if (tvl >= 5e7) return "$500";
    return "$250";
  }

  function fill(t, v) {
    return t
      .split("{name}").join(v.name)
      .split("{chain}").join(v.chain)
      .split("{dep}").join(v.dep)
      .split("{gas}").join(v.gas)
      .split("{chg}").join(v.chg);
  }

  var PLAN_GROUPS = {
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

  var GROUP_OF = {
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

  function farmSteps(row) {
    var group = GROUP_OF[row.cat] || "generic";
    var templates = PLAN_GROUPS[group] || PLAN_GROUPS.generic;
    var chain = (row.chn && row.chn.length > 0 ? row.chn[0] : "Ethereum");
    var vars = {
      name: row.name,
      chain: chain,
      dep: depositFor(row.tvl),
      gas: gasFor(chain),
      chg: pctText(row.chg),
    };
    return templates.map(function (t) { return fill(t, vars); });
  }

  // ---------- element helpers ----------

  function $(id) { return document.getElementById(id); }

  function badge(band) {
    var cls = band === "Hot" ? "badge-hot" : band === "Warming" ? "badge-warming" : "badge-early";
    return '<span class="badge ' + cls + '">' + band + "</span>";
  }

  // ---------- rendering ----------

  function renderStats() {
    var hot = ROWS.filter(function (r) { return bandOf(r.rdy) === "Hot"; }).length;
    var wl = ROWS.filter(function (r) { return r.wl === 1; }).length;
    $("stats").innerHTML =
      '<div class="stat"><div class="k">Ranked</div><div class="v">' + ROWS.length +
      '</div><div class="s">pre-token protocols</div></div>' +
      '<div class="stat"><div class="k">Watchlist</div><div class="v">' + wl +
      '</div><div class="s">at or above ' + money(RAW.floor) + " TVL</div></div>" +
      '<div class="stat"><div class="k">Hot</div><div class="v">' + hot +
      '</div><div class="s">readiness 60 or more</div></div>' +
      '<div class="stat"><div class="k">Global multiple</div><div class="v">' + RAW.globalMult.toFixed(4) +
      '</div><div class="s">median mcap / TVL, ' + RAW.globalN + " comparables</div></div>";
    $("asof").textContent = "Snapshot " + RAW.asOf + " · " + ROWS.length + " ranked · " + LIVE.length + " live";
    $("board-note").textContent =
      "Implied value = TVL × category multiple × growth × maturity. " +
      "The top row is the board's most valuable protocol; click any row for its full derivation and farm plan.";
  }

  function renderCats() {
    var sel = $("cat");
    var cats = {};
    ROWS.forEach(function (r) { cats[r.cat] = true; });
    Object.keys(cats).sort().forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
  }

  function visibleRows() {
    var q = ($("q").value || "").trim().toLowerCase();
    var cat = $("cat").value;
    var band = $("band").value;
    var src = $("src").value;
    var sort = $("sort").value;
    var rows = ROWS.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (cat && r.cat !== cat) return false;
      if (band && bandOf(r.rdy) !== band) return false;
      if (src === "watchlist" && r.wl !== 1) return false;
      if (src === "early" && r.wl === 1) return false;
      return true;
    });
    var rankOf = {};
    ROWS.forEach(function (r, i) { rankOf[r.slug] = i + 1; });
    if (sort === "tvl") rows.sort(function (a, b) { return b.tvl - a.tvl; });
    else if (sort === "ready") rows.sort(function (a, b) { return b.rdy - a.rdy || (a.slug < b.slug ? -1 : 1); });
    else if (sort === "growth") rows.sort(function (a, b) { return (b.chg || 0) - (a.chg || 0); });
    else rows.sort(function (a, b) { return rankOf[a.slug] - rankOf[b.slug]; });
    return { rows: rows, rankOf: rankOf };
  }

  function renderBoard() {
    var view = visibleRows();
    var html = "";
    view.rows.forEach(function (r) {
      var b = bandOf(r.rdy);
      var chgCls = r.chg === null || r.chg === undefined ? "flat" : r.chg > 0 ? "up" : r.chg < 0 ? "down" : "flat";
      html += '<tr class="clickable" data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + view.rankOf[r.slug] + "</td>" +
        '<td><strong>' + esc(r.name) + "</strong>" +
        (r.wl === 1 ? '<span class="badge badge-wl">watchlist</span>' : "") +
        '<br><span class="slug">' + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.cat) + "</td>" +
        '<td class="num">' + money(r.tvl) + "</td>" +
        '<td class="num imp">' + money(r.imp) + "</td>" +
        '<td class="num">' + multipleOf(r.cat).toFixed(4) + "</td>" +
        '<td class="num ' + chgCls + '">' + pct(r.chg) + "</td>" +
        '<td class="num">' + r.rdy + " " + badge(b) + "</td>" +
        "<td>›</td></tr>";
    });
    $("rows").innerHTML = html || '<tr><td colspan="9">No protocols match this filter.</td></tr>';
    $("count").textContent = view.rows.length + " of " + ROWS.length + " rows";
    Array.prototype.forEach.call(document.querySelectorAll("#rows tr.clickable"), function (tr) {
      tr.addEventListener("click", function () { showDetail(tr.getAttribute("data-slug")); });
    });
  }

  function renderLive() {
    var html = "";
    LIVE.forEach(function (l) {
      html += "<tr>" +
        "<td><strong>" + esc(l.name) + '</strong><br><span class="slug">' + esc(l.slug) + "</span></td>" +
        "<td>" + esc(l.cat) + "</td>" +
        '<td class="num">' + money(l.tvl) + "</td>" +
        '<td class="num">' + money(l.mcap) + "</td>" +
        '<td class="num">' + l.mult.toFixed(4) + "</td></tr>";
    });
    $("live-rows").innerHTML = html;
  }

  // ---------- detail view ----------

  function showDetail(slug) {
    var row = null;
    for (var i = 0; i < ROWS.length; i++) {
      if (ROWS[i].slug === slug) { row = ROWS[i]; break; }
    }
    if (!row) return;
    var rank = ROWS.indexOf(row) + 1;
    var b = bandOf(row.rdy);
    var age = ageDays(row.lst);
    var mult = multipleOf(row.cat);
    var gro = growthOf(row.chg);
    var mat = maturityOf(row.lst);
    var rederived = Math.round(row.tvl * mult * gro * mat);
    var stat = catStat(row.cat);
    var multNote;
    if (!stat || stat.n < 3) {
      multNote = "Global median " + RAW.globalMult.toFixed(4) +
        " — fewer than three sane comparables in " + row.cat +
        ", so the global median is used outright (" + RAW.globalN + " comparables in all).";
    } else {
      multNote = "Category median " + (stat.raw === null ? "—" : stat.raw.toFixed(4)) +
        " from " + stat.n + " comparables, shrunk toward the global " +
        RAW.globalMult.toFixed(4) + " to " + mult.toFixed(4) + ".";
    }
    var steps = farmSteps(row);
    var stepsHtml = steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
    var el = $("detail");
    el.hidden = false;
    el.innerHTML =
      '<button class="close" type="button" id="detail-close">Close ✕</button>' +
      "<h3>" + esc(row.name) + "</h3>" +
      '<p class="sub">Rank ' + rank + " · " + esc(row.cat) + " · " +
      (row.chn || []).join(", ") + " · " +
      (row.wl === 1 ? "watchlist" : "early") + " · listed " + (row.lst || "unknown") +
      (age === null ? "" : " (" + age + " days ago)") + " · readiness " + row.rdy + " " + badge(b) + "</p>" +
      '<div class="derive">' +
      '<div class="cell"><div class="k">TVL</div><div class="v">' + money(row.tvl) + '</div><div class="d">value locked</div></div>' +
      '<div class="cell"><div class="k">Category multiple</div><div class="v">' + mult.toFixed(4) + '</div><div class="d">' + esc(multNote) + "</div></div>" +
      '<div class="cell"><div class="k">Growth × maturity</div><div class="v">' + gro.toFixed(3) + " × " + mat.toFixed(3) +
      '</div><div class="d">7-day ' + pct(row.chg) + " · age factor</div></div>" +
      '<div class="cell"><div class="k">Implied value</div><div class="v">' + money(row.imp) + '</div><div class="d">recomputed ' + moneyFull(rederived) + "</div></div>" +
      '<div class="cell formula"><div class="k">Derivation</div><div class="v">' +
      moneyFull(row.tvl) + " × " + mult.toFixed(4) + " × " + gro.toFixed(4) + " × " + mat.toFixed(4) +
      " = " + moneyFull(rederived) + "</div></div>" +
      "</div>" +
      "<h4>Farm plan</h4>" +
      '<ol class="farm">' + stepsHtml + "</ol>";
    $("detail-close").addEventListener("click", hideDetail);
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (history.replaceState) {
      history.replaceState(null, "", "#/detail/" + row.slug);
    }
  }

  function hideDetail() {
    $("detail").hidden = true;
    $("detail").innerHTML = "";
    if (history.replaceState) history.replaceState(null, "", "#/");
  }

  // ---------- hash routing (board / detail / filtered views) ----------

  function readHash() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    if (h.indexOf("detail/") === 0) return { view: "detail", slug: decodeURIComponent(h.slice(7)) };
    if (h.indexOf("cat/") === 0) return { view: "cat", cat: decodeURIComponent(h.slice(4)) };
    if (h.indexOf("band/") === 0) return { view: "band", band: decodeURIComponent(h.slice(5)) };
    return { view: "board" };
  }

  function applyHash() {
    var state = readHash();
    if (state.view === "detail") {
      showDetail(state.slug);
    } else if (state.view === "cat") {
      $("cat").value = state.cat;
      renderBoard();
    } else if (state.view === "band") {
      $("band").value = state.band;
      renderBoard();
    }
  }

  // ---------- wiring ----------

  ["q", "cat", "band", "src", "sort"].forEach(function (id) {
    $(id).addEventListener("input", renderBoard);
    $(id).addEventListener("change", renderBoard);
  });

  $("reset").addEventListener("click", function () {
    $("q").value = "";
    $("cat").value = "";
    $("band").value = "";
    $("src").value = "";
    $("sort").value = "rank";
    hideDetail();
    renderBoard();
  });

  window.addEventListener("hashchange", applyHash);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hideDetail();
  });

  renderStats();
  renderCats();
  renderBoard();
  renderLive();
  applyHash();
})();
