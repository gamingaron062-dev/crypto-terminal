"use strict";
const express = require("express");
const path = require("path");
const { SYMBOLS, DRIFT_ATR_MULT, finite, cycleFetcher, getServerTime, getCoin, validForLock, buildLevels } = require("./analysis");
const { load, save } = require("./store");
const { notifyLock, notifyClose } = require("./telegram");

const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MS = 60000;      // full re-scan of all coins, matches the original tool
const LOCK_MONITOR_MS = 10000;       // mark-price check for OPEN locks only (cheap, frequent)

// ---------------- persistent state ----------------
let coins = {};                                  // latest analysis per symbol (in-memory, rebuilt every scan)
let locks = load("locks", {});                   // symbol -> open lock
let history = load("history", []);               // closed locks, newest first
let logs = load("logs", []);                     // analysis log, newest first
let baselines = load("baselines", {});           // symbol -> signal baseline for late-entry protection
let autoEnabled = load("auto", { on: true }).on; // Auto-Lock is ON by default on the server — that is the whole point
let running = false;
let lastScan = null;
let lastError = null;

function persistLocks() { save("locks", locks); }
function persistHistory() { save("history", history); }
function persistBaselines() { save("baselines", baselines); }
function persistLogs() { save("logs", logs.slice(0, 500)); }

// ---------------- baseline / lock logic (same rules as the browser tool) ----------------
function baselineKey(a) { return `${a.symbol}:${a.side}:${a.signalCandleTime}`; }
function updateBaseline(a) {
  if (!a || a.error || a.side === "WAIT" || !a.complete || a.mtf.trend === "MIXED") return;
  const key = baselineKey(a), old = baselines[a.symbol];
  if (!old || old.key !== key) {
    baselines[a.symbol] = { key, side: a.side, price: a.mark, atr: a.atr, signalTime: a.signalCandleTime };
    persistBaselines();
  }
}

async function maybeLock(a) {
  if (!autoEnabled || !validForLock(a) || locks[a.symbol]) return;
  const base = baselines[a.symbol];
  if (!base || base.side !== a.side || !finite(base.price) || !finite(base.atr)) return;
  const drift = Math.abs(a.mark - base.price);
  if (drift > DRIFT_ATR_MULT * base.atr) return; // TOO EXTENDED / LATE ENTRY
  const side = a.side.includes("BUY") ? "BUY" : "SELL";
  const levels = buildLevels(side, base.price, a.tf["1h"]);
  if ((side === "BUY" && (a.mark <= levels.sl || a.mark >= levels.tp2)) || (side === "SELL" && (a.mark >= levels.sl || a.mark <= levels.tp2))) return;
  const freshLock = {
    id: `${a.symbol}-${base.signalTime}-${Date.now()}`, symbol: a.symbol, side,
    entry: base.price, sl: levels.sl, tp1: levels.tp1, tp2: levels.tp2,
    confidence: a.confidence, score: a.score, lockTime: Date.now(), signalTime: base.signalTime,
    baselinePrice: base.price, baselineATR: base.atr, drift, driftATR: drift / base.atr,
    status: "OPEN", tp1Hit: false,
  };
  locks[a.symbol] = freshLock;
  persistLocks();
  console.log(`LOCK: ${a.symbol} ${side} @ ${base.price}`);
  await notifyLock(freshLock);
}

async function closeLock(sym, status, price) {
  const l = locks[sym];
  if (!l) return;
  const closed = { ...l, status, closePrice: price, closeTime: Date.now() };
  history.unshift(closed);
  history = history.slice(0, 500);
  delete locks[sym];
  persistHistory();
  persistLocks();
  console.log(`CLOSE: ${sym} ${status} @ ${price}`);
  await notifyClose(closed);
}

async function evaluateLock(sym, p) {
  const l = locks[sym];
  if (!l || l.status !== "OPEN" || !finite(p)) return;
  let hit = null;
  if (l.side === "BUY") {
    if (p <= l.sl) hit = "STOP LOSS HIT";
    else if (p >= l.tp2) hit = "TARGET 2 HIT";
    else if (p >= l.tp1 && !l.tp1Hit) { l.tp1Hit = true; persistLocks(); }
  } else {
    if (p >= l.sl) hit = "STOP LOSS HIT";
    else if (p <= l.tp2) hit = "TARGET 2 HIT";
    else if (p <= l.tp1 && !l.tp1Hit) { l.tp1Hit = true; persistLocks(); }
  }
  if (hit) await closeLock(sym, hit, p);
}

// Cheap, frequent mark-price poll for symbols that currently have an OPEN lock —
// this is what lets TP/SL be caught quickly without re-running the full 18-coin
// analysis every few seconds.
async function monitorLocks() {
  const syms = Object.keys(locks);
  if (!syms.length) return;
  await Promise.all(syms.map(async (s) => {
    try {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}`);
      const d = await r.json();
      await evaluateLock(s, +d.markPrice);
    } catch { /* transient network error — next tick will retry */ }
  }));
}

// ---------------- full scan ----------------
async function scan() {
  if (running) return;
  running = true;
  try {
    const cf = cycleFetcher();
    const serverTime = await getServerTime(cf);
    const out = {};
    let idx = 0;
    const workers = Array.from({ length: 6 }, async () => {
      while (true) {
        const i = idx++;
        if (i >= SYMBOLS.length) break;
        const s = SYMBOLS[i];
        try {
          out[s] = await getCoin(s, cf, serverTime);
          updateBaseline(out[s]);
        } catch (e) {
          out[s] = { symbol: s, error: e?.message || "API error", lastUpdated: Date.now() };
        }
      }
    });
    await Promise.all(workers);
    coins = out;
    for (const a of Object.values(out)) {
      if (a && !a.error) {
        await maybeLock(a);
        logs.unshift({ time: new Date().toISOString(), sym: a.symbol, side: a.side, score: +a.score.toFixed(2), mark: a.mark, rsi: a.tf["15m"].rsi });
      }
    }
    logs = logs.slice(0, 500);
    persistLogs();
    lastScan = Date.now();
    lastError = null;
    const bad = Object.values(out).filter(x => x.error).length;
    console.log(`Scan complete — ${SYMBOLS.length - bad}/${SYMBOLS.length} coins OK`);
  } catch (e) {
    lastError = e?.message || String(e);
    console.error("Scan failed:", lastError);
  } finally {
    running = false;
  }
}

// ---------------- HTTP API ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({ running, lastScan, lastError, auto: autoEnabled, coinCount: SYMBOLS.length });
});
app.get("/api/coins", (req, res) => res.json(coins));
app.get("/api/locks", (req, res) => res.json(locks));
app.get("/api/history", (req, res) => res.json(history.slice(0, 200)));
app.get("/api/logs", (req, res) => res.json(logs.slice(0, 200)));
app.post("/api/auto", (req, res) => {
  autoEnabled = !!req.body.on;
  save("auto", { on: autoEnabled });
  res.json({ auto: autoEnabled });
});

app.listen(PORT, () => {
  console.log(`Crypto Futures Intelligence backend listening on :${PORT}`);
  scan();                                          // run immediately on boot
  setInterval(scan, SCAN_INTERVAL_MS);             // then every 60s, forever — no browser needed
  setInterval(monitorLocks, LOCK_MONITOR_MS);      // fast TP/SL polling for open locks
});
