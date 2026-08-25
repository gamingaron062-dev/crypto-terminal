"use strict";
/* Crypto Futures Intelligence Terminal — analysis engine.
   Ported from the browser tool. Same indicators, same scoring, same
   closed-candle / stale-data / MTF rules. This file has NO knowledge of
   HTTP, storage, or Telegram — it is pure market-data-in, signal-out logic,
   so it can be unit-tested and reused independently of server.js.
*/

const SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT","BCHUSDT","SUIUSDT","TRXUSDT","TONUSDT","XLMUSDT","ETCUSDT","XAUUSDT"];
const API = "https://fapi.binance.com";

const TF_CONFIG = {
  "1d": { ms: 86400000, weight: 4.0 },
  "4h": { ms: 14400000, weight: 3.0 },
  "1h": { ms: 3600000, weight: 2.0 },
  "15m": { ms: 900000, weight: 1.5 },
  "5m": { ms: 300000, weight: 1.0 },
};
const TFS = Object.keys(TF_CONFIG);

// See tool.html for the full history of why these three constants are calibrated
// this way. mtf.score is a WEIGHTED AVERAGE (not a sum) across timeframes, realistic
// range roughly -6..+6. TREND_THRESHOLD, MIN_SCORE and STRONG_SCORE must all sit on
// that same scale or a confirmed trend can silently fail to ever produce a signal.
const TREND_THRESHOLD = 2.15;
const MIN_SCORE = 3.0;
const STRONG_SCORE = 5.5;
// A "trend confirmed" signal (MIN_SCORE) is not the same bar as a "safe enough to actually
// auto-lock real money against" signal. Real trade history showed most locks closing at SL
// with confidence sitting around 50-60% — i.e. the tool was locking setups it was itself only
// mildly sure about. MIN_LOCK_CONFIDENCE adds a second, stricter gate specifically for
// Auto-Lock (not for what the Signal Desk displays), so only higher-conviction setups get
// locked and given real Entry/SL/TP — matching the spec's "quality over quantity" rule.
const MIN_LOCK_CONFIDENCE = 66;
const MIN_LOCK_DOMINANCE = 0.78;

const STALE_MULTIPLIER = 2;
const DRIFT_ATR_MULT = 1.5;
const MAX_CONCURRENT = 6;

function finite(n) { return Number.isFinite(n); }

// ---------- indicators ----------
function ema(v, p) { if (v.length < p) return null; let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p, k = 2 / (p + 1); for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
function sma(v, p) { return v.length < p ? null : v.slice(-p).reduce((a, b) => a + b, 0) / p; }
function rsi(v, p = 14) { if (v.length < p + 1) return null; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } let ag = g / p, al = l / p; for (let i = p + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; } return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
function atr(c, p = 14) { if (c.length < p + 1) return null; const tr = []; for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c))); return sma(tr, p); }
function macdSeries(v) { if (v.length < 35) return null; let e12 = ema(v.slice(0, 12), 12), e26 = ema(v.slice(0, 26), 26), series = []; for (let i = 26; i < v.length; i++) { if (i > 26) { e12 = v[i] * (2 / 13) + e12 * (11 / 13); e26 = v[i] * (2 / 27) + e26 * (25 / 27); } series.push(e12 - e26); } if (series.length < 9) return { line: series.at(-1), signal: null, hist: null }; const signal = ema(series, 9); return { line: series.at(-1), signal, hist: signal == null ? null : series.at(-1) - signal }; }
function bb(v, p = 20, m = 2) { if (v.length < p) return null; const z = v.slice(-p), mid = sma(z, p), sd = Math.sqrt(z.reduce((s, x) => s + (x - mid) ** 2, 0) / p); return { mid, up: mid + m * sd, lo: mid - m * sd }; }
function pivots(c, left = 2, right = 2) { const hi = [], lo = []; for (let i = left; i < c.length - right; i++) { let isH = true, isL = true; for (let j = 1; j <= left; j++) { if (c[i].h <= c[i - j].h) isH = false; if (c[i].l >= c[i - j].l) isL = false; } for (let j = 1; j <= right; j++) { if (c[i].h <= c[i + j].h) isH = false; if (c[i].l >= c[i + j].l) isL = false; } if (isH) hi.push({ price: c[i].h, t: c[i].t }); if (isL) lo.push({ price: c[i].l, t: c[i].t }); } return { highs: hi, lows: lo }; }
function structure(c) { const p = pivots(c), hs = p.highs.slice(-6), ls = p.lows.slice(-6); let trend = "NEUTRAL"; if (hs.length >= 2 && ls.length >= 2) { const hh = hs.at(-1).price > hs.at(-2).price, hl = ls.at(-1).price > ls.at(-2).price, lh = hs.at(-1).price < hs.at(-2).price, ll = ls.at(-1).price < ls.at(-2).price; if (hh && hl) trend = "BULLISH"; else if (lh && ll) trend = "BEARISH"; } return { pivots: p, trend }; }

// ---------- fetch helpers (concurrency-limited, per-cycle cached) ----------
let activeRequests = 0, queue = [];
function withLimit(task) { return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); }); }
function pump() { while (activeRequests < MAX_CONCURRENT && queue.length) { const job = queue.shift(); activeRequests++; Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { activeRequests--; pump(); }); } }
async function fetchJSON(url, timeout = 10000) {
  return withLimit(async () => {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      return { data, receivedAt: Date.now() };
    } finally { clearTimeout(tm); }
  });
}
function cycleFetcher() { const cache = new Map(); return async (key, url, timeout = 10000) => { if (cache.has(key)) return cache.get(key); const p = fetchJSON(url, timeout); cache.set(key, p); try { return await p; } catch (e) { cache.delete(key); throw e; } }; }

async function getServerTime(cf) { const r = await cf("serverTime", API + "/fapi/v1/time", 7000); const t = +r.data.serverTime; if (!finite(t)) throw new Error("Binance server time unavailable"); return t; }
function parseClosedKlines(raw, serverTime, interval) {
  if (!Array.isArray(raw)) throw new Error("Invalid kline response");
  const closed = raw.filter(k => Array.isArray(k) && +k[6] <= serverTime);
  if (closed.length < 80) throw new Error("Insufficient closed " + interval + " candles");
  const c = closed.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: +k[6] }));
  const last = c.at(-1), age = Math.max(0, serverTime - last.ct), stale = age > STALE_MULTIPLIER * TF_CONFIG[interval].ms;
  return { c, age, stale, lastClose: last.ct, interval };
}
async function getCandles(cf, symbol, interval, serverTime) {
  const raw = (await cf(`k:${symbol}:${interval}`, `${API}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=260`)).data;
  return parseClosedKlines(raw, serverTime, interval);
}

// ---------- scoring ----------
function analyzeTF(c) {
  const close = c.map(x => x.c), piv = structure(c), price = close.at(-1), prev = c.at(-2);
  const e9 = ema(close, 9), e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200), ma50 = sma(close, 50), ma200 = sma(close, 200), R = rsi(close), A = atr(c), M = macdSeries(close), B = bb(close), vma = sma(c.map(x => x.v), 20), vr = vma ? c.at(-1).v / vma : null;
  let score = 0, layers = [];
  const add = (name, val, weight = 1) => { if (!finite(val) || val === 0) return; score += val * weight; layers.push([name, val > 0]); };
  if (e9 != null && e20 != null) add("EMA 9/20", e9 > e20 ? 1 : -1, .7);
  if (e20 != null && e50 != null) add("EMA 20/50", e20 > e50 ? 1 : -1, .9);
  if (e50 != null && e200 != null) add("EMA 50/200", e50 > e200 ? 1 : -1, 1.1);
  if (ma50 != null && ma200 != null) add("MA 50/200", ma50 > ma200 ? 1 : -1, .7);
  if (M?.hist != null) add("MACD", M.hist > 0 ? 1 : -1, .9);
  if (R != null) { const rv = R >= 55 && R <= 68 ? 1 : R <= 38 ? -1 : R >= 78 ? -1 : R <= 45 ? -0.4 : R >= 72 ? 0.2 : 0; add("RSI", rv, .7); }
  if (B) { const width = (B.up - B.lo) / (B.mid || price); const loc = (price - B.mid) / (B.up - B.lo || 1); if (loc > 0.35) add("BB position", 1, .35); else if (loc < -0.35) add("BB position", -1, .35); if (width < .012) add("BB squeeze", 0, .2); }
  if (vr != null) { if (vr >= 1.2) add("Volume", price > prev.c ? 1 : -1, 1.0); else if (vr >= 1.05) add("Volume", price > prev.c ? 0.5 : -0.5, .45); }
  if (piv.trend !== "NEUTRAL") add("Structure", piv.trend === "BULLISH" ? 1 : -1, 1.35);
  if (prev) { const body = Math.abs(prev.c - prev.o), range = Math.max(prev.h - prev.l, 1e-12), bodyRatio = body / range; const bullClose = (prev.c - prev.l) / range > 0.7 && prev.c > prev.o; const bearClose = (prev.h - prev.c) / range > 0.7 && prev.c < prev.o; if (bodyRatio > .55) { if (bullClose) add("Candle impulse", 1, .45); else if (bearClose) add("Candle impulse", -1, .45); } }
  const highs = piv.pivots.highs, lows = piv.pivots.lows, lastHigh = highs.at(-1)?.price, lastLow = lows.at(-1)?.price;
  if (finite(lastHigh) && price > lastHigh) add("Breakout", 1, .55);
  if (finite(lastLow) && price < lastLow) add("Breakdown", -1, .55);
  return { price, atr: A, macd: M, bb: B, volRatio: vr, structure: piv.trend, pivots: piv.pivots, rsi: R, score, trend: score >= 3.0 ? "BULLISH" : score <= -3.0 ? "BEARISH" : "NEUTRAL", layers, lastTime: c.at(-1).t, high30: Math.max(...c.slice(-30).map(x => x.h)), low30: Math.min(...c.slice(-30).map(x => x.l)) };
}
function weightedMTF(tf) {
  let total = 0, weight = 0, bullW = 0, bearW = 0, used = [];
  for (const [name, cfg] of Object.entries(TF_CONFIG)) { const a = tf[name]; if (!a || a.stale) continue; const w = cfg.weight; total += a.score * w; weight += w; used.push(name); if (a.trend === "BULLISH") bullW += w; else if (a.trend === "BEARISH") bearW += w; }
  const norm = weight ? total / weight : 0, dominance = weight ? Math.max(bullW, bearW) / weight : 0;
  const trend = norm >= TREND_THRESHOLD ? "BULLISH" : norm <= -TREND_THRESHOLD ? "BEARISH" : "MIXED";
  return { score: norm, raw: total, weight, trend, bullW, bearW, dominance, used };
}
function safeRatioScore(ls) { if (!finite(ls) || ls <= 0) return 0; return ls > 1.15 ? -0.7 : ls > 1.05 ? -0.3 : ls < 0.87 ? 0.7 : ls < 0.95 ? 0.3 : 0; }
function takerScore(r) { if (!finite(r) || r <= 0) return 0; return r > 1.12 ? 0.8 : r > 1.04 ? 0.35 : r < 0.88 ? -0.8 : r < 0.96 ? -0.35 : 0; }
function oiScore(oiPct, priceDelta) { if (!finite(oiPct) || !finite(priceDelta)) return 0; if (oiPct > .002 && priceDelta > 0) return .8; if (oiPct > .002 && priceDelta < 0) return -.8; if (oiPct < -.002 && priceDelta > 0) return -.4; if (oiPct < -.002 && priceDelta < 0) return .4; return 0; }
function fundingScore(f) { if (!finite(f)) return 0; return f > .0008 ? -0.7 : f > .0004 ? -0.25 : f < -.0008 ? 0.7 : f < -.0004 ? 0.25 : 0; }
function basisScore(b) { if (!finite(b)) return 0; return b > .002 ? -0.25 : b > .001 ? 0.12 : b < -.002 ? 0.25 : b < -.001 ? -0.12 : 0; }
function buildLevels(side, entry, oneHour) {
  const A = oneHour.atr || entry * .003, piv = oneHour.pivots;
  const lows = piv.lows.filter(x => x.price < entry).map(x => x.price), highs = piv.highs.filter(x => x.price > entry).map(x => x.price);
  const structural = side === "BUY" ? lows.at(-1) : highs.at(-1);
  const minRisk = Math.max(A * .8, entry * .0015), maxRisk = Math.max(A * 2.8, entry * .01);
  let sl;
  if (side === "BUY") { sl = finite(structural) ? structural - A * .18 : entry - A * 1.25; if (entry - sl < minRisk) sl = entry - minRisk; if (entry - sl > maxRisk) sl = entry - maxRisk; }
  else { sl = finite(structural) ? structural + A * .18 : entry + A * 1.25; if (sl - entry < minRisk) sl = entry + minRisk; if (sl - entry > maxRisk) sl = entry + maxRisk; }
  const risk = Math.abs(entry - sl), tp1 = side === "BUY" ? entry + risk * 2 : entry - risk * 2;
  let tp2 = side === "BUY" ? entry + risk * 3 : entry - risk * 3;
  const structureTarget = side === "BUY" ? highs.find(x => x > tp1) : lows.slice().reverse().find(x => x < tp1);
  if (finite(structureTarget) && Math.abs(structureTarget - entry) >= risk * 2) tp2 = side === "BUY" ? Math.max(tp1, structureTarget) : Math.min(tp1, structureTarget);
  return { entry, sl, tp1, tp2, risk, rr2: Math.abs(tp2 - entry) / risk };
}

async function getCoin(symbol, cf, serverTime) {
  const [ticker, mark, oi, ls, tk, ba, oiHist, ...klines] = await Promise.all([
    cf(`ticker:${symbol}`, `${API}/fapi/v1/ticker/price?symbol=${symbol}`),
    cf(`premium:${symbol}`, `${API}/fapi/v1/premiumIndex?symbol=${symbol}`),
    cf(`oi:${symbol}`, `${API}/fapi/v1/openInterest?symbol=${symbol}`),
    cf(`ls:${symbol}`, `${API}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=15m&limit=2`).catch(() => ({ data: [] })),
    cf(`taker:${symbol}`, `${API}/futures/data/takerlongshortRatio?symbol=${symbol}&contractType=PERPETUAL&period=15m&limit=2`).catch(() => ({ data: [] })),
    cf(`basis:${symbol}`, `${API}/futures/data/basis?pair=${symbol}&contractType=PERPETUAL&period=15m&limit=2`).catch(() => ({ data: [] })),
    cf(`oih:${symbol}`, `${API}/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`).catch(() => ({ data: [] })),
    ...TFS.map(tf => getCandles(cf, symbol, tf, serverTime)),
  ]);
  const tf = {}; TFS.forEach((x, i) => { tf[x] = klines[i]; });
  const staleTF = TFS.filter(x => tf[x].stale);
  const last = +ticker.data.price, markPrice = +mark.data.markPrice, indexPrice = +mark.data.indexPrice;
  if (!finite(last) || !finite(markPrice) || markPrice <= 0) throw new Error("Invalid live price");
  const a = {}; for (const x of TFS) a[x] = analyzeTF(tf[x].c);
  const mtf = weightedMTF(a);
  const coreFresh = ["1d", "4h", "1h", "15m"].every(x => !tf[x].stale);
  const usableWeight = mtf.weight;
  const lsNow = ls.data?.at(-1) ? +ls.data.at(-1).longShortRatio : null;
  const takerNow = tk.data?.at(-1) ? +(+tk.data.at(-1).buyVol / +tk.data.at(-1).sellVol) : null;
  const basisNow = ba.data?.at(-1) ? +ba.data.at(-1).basis : null;
  const funding = +mark.data.lastFundingRate;
  const oiPct = oiHist.data?.length > 1 ? (+oiHist.data.at(-1).sumOpenInterestValue / +oiHist.data.at(-2).sumOpenInterestValue - 1) : null;
  const priceDelta = markPrice - a["15m"].price;
  let score = mtf.score + safeRatioScore(lsNow) + takerScore(takerNow) + oiScore(oiPct, priceDelta) + fundingScore(funding) + basisScore(basisNow);
  const complete = coreFresh && usableWeight >= TF_CONFIG["1d"].weight + TF_CONFIG["4h"].weight + TF_CONFIG["1h"].weight + TF_CONFIG["15m"].weight;
  const alignmentBonus = mtf.dominance >= 0.72 ? (score >= 0 ? 0.8 : -0.8) : 0;
  const finalScore = score + alignmentBonus;
  const provisionalSide = finalScore >= MIN_SCORE ? (mtf.trend === "BULLISH" ? "BUY" : "WAIT") : finalScore <= -MIN_SCORE ? (mtf.trend === "BEARISH" ? "SELL" : "WAIT") : "WAIT";
  const atrVal = a["1h"].atr || a["15m"].atr || a["4h"].atr;
  const provisionalLevels = (provisionalSide !== "WAIT" && complete) ? buildLevels(provisionalSide, markPrice, a["1h"]) : { risk: null };
  const oppositePivots = provisionalSide === "BUY" ? a["1h"].pivots.highs.filter(x => x.price > markPrice).map(x => x.price) : provisionalSide === "SELL" ? a["1h"].pivots.lows.filter(x => x.price < markPrice).map(x => x.price) : [];
  const nearestOpp = provisionalSide === "BUY" ? oppositePivots[0] : oppositePivots.at(-1);
  const roomOK = provisionalSide === "WAIT" || !finite(nearestOpp) || !finite(provisionalLevels.risk) || Math.abs(nearestOpp - markPrice) >= provisionalLevels.risk * 1.25;
  const finalDirection = roomOK ? provisionalSide : "WAIT";
  const strong = Math.abs(finalScore) >= STRONG_SCORE && mtf.dominance >= 0.72 && roomOK;
  const side = finalDirection === "BUY" ? (strong ? "STRONG BUY" : "BUY") : finalDirection === "SELL" ? (strong ? "STRONG SELL" : "SELL") : "WAIT";
  const agreement = Math.min(1, Math.abs(finalScore) / 10) * 0.50 + Math.min(1, mtf.dominance) * 0.28 + (coreFresh ? 0.10 : 0) + (finite(oiPct) ? 0.03 : 0) + (finite(lsNow) ? 0.03 : 0) + (finite(takerNow) ? 0.03 : 0) + (roomOK ? 0.03 : 0);
  const confidence = Math.max(0, Math.min(100, Math.round(agreement * 100)));
  const levels = (side !== "WAIT" && complete && mtf.trend === (side.includes("BUY") ? "BULLISH" : "BEARISH")) ? buildLevels(side.includes("BUY") ? "BUY" : "SELL", markPrice, a["1h"]) : { entry: markPrice, sl: null, tp1: null, tp2: null, risk: null, rr2: null };
  const dayCandles = tf["1d"].c;
  const prevDay = dayCandles.length >= 2 ? dayCandles.at(-2) : null;
  const age = Math.max(...TFS.map(x => tf[x].age));
  return {
    symbol, last, mark: markPrice, indexPrice, side, score: finalScore, confidence, mtf, complete, coreFresh, staleTF,
    funding, oi: +oi.data.openInterest, oiPct, ls: lsNow, taker: takerNow, basis: basisNow, tf: a,
    atr: atrVal, entry: levels.entry, sl: levels.sl, tp1: levels.tp1, tp2: levels.tp2, rr2: levels.rr2,
    pdh: prevDay?.h, pdl: prevDay?.l, swh: a["1h"].high30, swl: a["1h"].low30,
    invalid: side.includes("BUY") ? (levels.sl != null && markPrice <= levels.sl) : (side.includes("SELL") ? (levels.sl != null && markPrice >= levels.sl) : false),
    age, lastUpdated: Date.now(), signalCandleTime: a["15m"].lastTime, serverTime,
  };
}

function validForLock(a) { return a && !a.error && a.complete && a.side !== "WAIT" && a.mtf.trend !== "MIXED" && Math.abs(a.score) >= MIN_SCORE && a.confidence >= MIN_LOCK_CONFIDENCE && a.mtf.dominance >= MIN_LOCK_DOMINANCE && finite(a.entry) && finite(a.sl) && finite(a.tp2) && !a.invalid; }

module.exports = { SYMBOLS, TFS, TF_CONFIG, DRIFT_ATR_MULT, finite, cycleFetcher, getServerTime, getCoin, validForLock, buildLevels };
   
