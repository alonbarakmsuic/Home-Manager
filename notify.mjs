#!/usr/bin/env node
/**
 * Home Manager — daily notification check.
 *
 * Runs on a GitHub Actions schedule. Reads Firestore over the REST API,
 * decides whether anything needs attention, and sends one push per phone.
 *
 * Design notes:
 *  - Sends ONLY when something is wrong. A quiet day means nothing is due.
 *  - One combined notification, never three separate buzzes.
 *  - A cooldown stops the same news repeating every morning.
 *  - Exits quietly if it isn't the target local hour in Israel, so the
 *    twice-yearly clock change doesn't shift the delivery time.
 *
 * Env:
 *   VAPID_PRIVATE  (required, GitHub secret)
 *   FIREBASE_KEY   (required, the public web API key)
 *   SEND_HOUR      (optional, Israel local hour, default 8)
 *   COOLDOWN_DAYS  (optional, default 3)
 *   FORCE          (optional, "1" ignores the hour + cooldown — for testing)
 */

import webpush from "web-push";

const PROJECT   = "home-manager-29a1a";
const BASE      = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const KEY       = process.env.FIREBASE_KEY;
const VAPID_PUB = "BK5MvBEiAD_ckPpkZEz_piCJmFjCzdZZAK9gEjWVjXEQWc5YbqvOAn-DMdiNTxLF7m4PojGBwpgsXACmI8QG1es";
const SEND_HOUR = +(process.env.SEND_HOUR || 8);
const COOLDOWN  = +(process.env.COOLDOWN_DAYS || 3);
const FORCE     = process.env.FORCE === "1";

const BILLS = [
  { key: "electricity", he: "חשמל" },
  { key: "gas",         he: "גז" },
  { key: "water",       he: "מים" },
  { key: "arnona",      he: "ארנונה" },
  { key: "wifi",        he: "אינטרנט" }
];

/* ── Firestore REST helpers ─────────────────────────────── */
const V = f => {
  if (f == null) return null;
  if ("stringValue"  in f) return f.stringValue;
  if ("integerValue" in f) return +f.integerValue;
  if ("doubleValue"  in f) return f.doubleValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("timestampValue" in f) return f.timestampValue;
  if ("nullValue"    in f) return null;
  if ("mapValue"     in f) return Object.fromEntries(
    Object.entries(f.mapValue.fields || {}).map(([k, v]) => [k, V(v)]));
  if ("arrayValue"   in f) return (f.arrayValue.values || []).map(V);
  return null;
};
const fields = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, V(v)]));

async function getDocOne(path) {
  const r = await fetch(`${BASE}/${path}?key=${KEY}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.fields ? fields(j) : null;
}
async function getCollection(name) {
  const out = [];
  let token = "";
  do {
    const url = `${BASE}/${name}?pageSize=300&key=${KEY}` + (token ? `&pageToken=${token}` : "");
    const r = await fetch(url);
    if (!r.ok) break;
    const j = await r.json();
    (j.documents || []).forEach(d => out.push({ id: d.name.split("/").pop(), ...fields(d) }));
    token = j.nextPageToken || "";
  } while (token);
  return out;
}
async function patchDoc(path, obj) {
  const toVal = v =>
    typeof v === "number"  ? { integerValue: String(Math.round(v)) } :
    typeof v === "boolean" ? { booleanValue: v } :
    v == null              ? { nullValue: null } : { stringValue: String(v) };
  const mask = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const r = await fetch(`${BASE}/${path}?key=${KEY}&${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toVal(v)])) })
  });
  if (!r.ok) console.warn("patch failed", path, r.status, (await r.text()).slice(0, 200));
}

/* ── Time ───────────────────────────────────────────────── */
const israelNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));

/* ── The three checks ───────────────────────────────────── */
export async function collectAlerts(deps = {}) {
  const _getDoc = deps.getDocOne     || getDocOne;
  const _getCol = deps.getCollection || getCollection;
  const now     = deps.now           || israelNow();
  const month   = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lines = [];
  const keys  = [];

  // 1. Bills not entered this month. Only nags from the 3rd onward — before
  //    that it's simply too early for them to have arrived.
  if (now.getDate() >= 3) {
    const b = (await _getDoc(`bills/${month}`)) || {};
    const missing = [];
    if (!(b.rentAlon ?? b.rent ?? 0) && !(b.rentTali ?? 0)) missing.push("שכ״ד");
    BILLS.forEach(d => { if (!(b[d.key] || 0)) missing.push(d.he); });
    if (missing.length) {
      lines.push(`💳 ${missing.length} חשבונות לא הוזנו: ${missing.join(", ")}`);
      keys.push(`bills:${month}:${missing.length}`);
    }
  }

  // 2. Plants past their watering interval.
  const [plants, waterLog] = await Promise.all([
    _getCol("plants"),
    _getDoc("watering/log")
  ]);
  const log = waterLog || {};
  const thirsty = plants.filter(p => {
    const last = log[p.id];
    const days = p.intervalDays || 3;
    if (!last) return true;
    return (Date.now() - Number(last)) / 864e5 > days;
  });
  if (thirsty.length) {
    const names = thirsty.slice(0, 3).map(p => p.name).join(", ");
    lines.push(`🪴 ${thirsty.length} צמחים צריכים השקיה: ${names}${thirsty.length > 3 ? "…" : ""}`);
    keys.push(`plants:${thirsty.length}`);
  }

  // 3. Tasks left open a long time. There's no due-date field on tasks, so
  //    "overdue" means reported more than 14 days ago and still open.
  const CLOSED = new Set(["resolved", "done", "closed"]);
  const tasks  = await _getCol("maintenance");
  const stale  = tasks.filter(t => {
    if (CLOSED.has((t.status || "").toLowerCase())) return false;
    const d = t.dateReported || (t.createdAt || "").slice(0, 10);
    if (!d) return false;
    return (Date.now() - new Date(d).getTime()) / 864e5 > 14;
  });
  if (stale.length) {
    lines.push(`📋 ${stale.length} משימות פתוחות מעל שבועיים`);
    keys.push(`tasks:${stale.length}`);
  }

  return { lines, signature: keys.join("|") };
}

/* ── Main ───────────────────────────────────────────────── */
async function main() {
  if (!KEY)                       { console.error("FIREBASE_KEY missing");  process.exit(1); }
  if (!process.env.VAPID_PRIVATE) { console.error("VAPID_PRIVATE missing"); process.exit(1); }

  const now = israelNow();
  if (!FORCE && now.getHours() !== SEND_HOUR) {
    console.log(`Israel time ${now.getHours()}:00, target ${SEND_HOUR}:00 — nothing to do.`);
    return;
  }

  const { lines, signature } = await collectAlerts({ now });
  if (!lines.length) { console.log("All clear — no notification sent."); return; }

  // Cooldown: same situation, recently told → stay quiet.
  const state = (await getDocOne("push_state/last")) || {};
  const ageDays = state.at ? (Date.now() - Number(state.at)) / 864e5 : 999;
  if (!FORCE && state.signature === signature && ageDays < COOLDOWN) {
    console.log(`Same alerts as ${ageDays.toFixed(1)}d ago — within ${COOLDOWN}d cooldown, staying quiet.`);
    return;
  }

  const subs = await getCollection("push_subs");
  if (!subs.length) { console.log("No devices subscribed yet."); return; }

  webpush.setVapidDetails("mailto:alon7barak@gmail.com", VAPID_PUB, process.env.VAPID_PRIVATE);
  const payload = JSON.stringify({
    title: "Home Manager",
    body:  lines.join("\n"),
    tag:   "hm-daily"
  });

  let ok = 0, gone = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      ok++;
    } catch (err) {
      // 404/410 = the phone uninstalled or the subscription expired
      if (err.statusCode === 404 || err.statusCode === 410) {
        gone++;
        await fetch(`${BASE}/push_subs/${s.id}?key=${KEY}`, { method: "DELETE" });
      } else {
        console.warn("send failed:", s.who, err.statusCode, String(err.body || err.message).slice(0, 120));
      }
    }
  }

  await patchDoc("push_state/last", { signature, at: Date.now() });
  console.log(`Sent to ${ok} device(s), removed ${gone} dead. Content:\n${lines.join("\n")}`);
}

if (process.env.NODE_ENV !== "test") {
  main().catch(e => { console.error(e); process.exit(1); });
}
