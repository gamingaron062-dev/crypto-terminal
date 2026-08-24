"use strict";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) return; // silently no-op if not configured
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("Telegram send failed:", e.message);
  }
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function notifyLock(lock) {
  const text = `🔒 <b>NEW AUTO-LOCK: ${lock.symbol} ${lock.side}</b>\n` +
    `Entry: ${fmtNum(lock.entry)}\nSL: ${fmtNum(lock.sl)}\nTP1: ${fmtNum(lock.tp1)}\nTP2: ${fmtNum(lock.tp2)}\n` +
    `Confidence: ${lock.confidence}%\nSignal time: ${new Date(lock.signalTime).toLocaleString()}`;
  return sendTelegram(text);
}

function notifyClose(closed) {
  const icon = closed.status.includes("TARGET") ? "✅" : closed.status.includes("STOP") ? "🛑" : "⚠️";
  const text = `${icon} <b>${closed.symbol} ${closed.side} — ${closed.status}</b>\n` +
    `Entry: ${fmtNum(closed.entry)} → Close: ${fmtNum(closed.closePrice)}\n` +
    `Locked: ${new Date(closed.lockTime).toLocaleString()}`;
  return sendTelegram(text);
}

module.exports = { sendTelegram, notifyLock, notifyClose };
