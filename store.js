"use strict";
/* Minimal persistent JSON-file store. Good enough for a single always-on backend
   instance. NOTE: on some free hosting tiers the filesystem is wiped on redeploy
   (not on normal restarts) — see README "Persistence" section if you need
   guaranteed durability across redeploys, which would mean swapping this for a
   real database (e.g. Postgres/SQLite on a persistent volume). */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) { return path.join(DATA_DIR, name + ".json"); }

function load(name, fallback) {
  try {
    const raw = fs.readFileSync(file(name), "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(name, value) {
  try {
    fs.writeFileSync(file(name), JSON.stringify(value));
  } catch (e) {
    console.error(`Failed to save ${name}:`, e.message);
  }
}

module.exports = { load, save };
