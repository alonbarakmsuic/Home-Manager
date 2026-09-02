#!/usr/bin/env node
/**
 * Home Manager — daily notification check.
 *
 * Runs on a GitHub Actions schedule. Reads Firestore over the REST API,
 * decides whether anything needs attention, and sends one push per phone.
 *
 * Design notes:
 *  - Sends ONLY when something is wrong. A quiet day means nothing is due.
 *  - ONE combined notification, never nine separate buzzes.
 *  - At most 4 lines, highest priority first, then "ועוד N".
 *  - Cooldown is PER CHECK, not global. With this many checks a single
 *    global signature would change almost daily (one more plant, one fewer
 *    task) and defeat itself — each alert now goes quiet on its own clock.
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

const MAX_LINES        = 4;
const BALANCE_ALERT    = 300;   // ₪ before the balance is worth settling
const BUDGET_WARN_PCT  = 80;    // % of the grocery target
const SHOPLIST_ALERT   = 10;    // items before it's worth a trip
const TASK_STALE_DAYS  = 14;

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

/* ── Time helpers ───────────────────────────────────────── */
const israelNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
const nis = n => `₪${Math.round(n).toLocaleString("en-US")}`;

// Mirrors the app's own checklist document keys
const weekKey = d => {
  const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
  return `week_${sun.getFullYear()}_${sun.getMonth() + 1}_${sun.getDate()}`;
};
const monthKeyOf = d => `month_${d.getFullYear()}_${d.getMonth() + 1}`;

/* ── The checks ─────────────────────────────────────────────
   Each returns {key, prio, line} or null. Lower prio = more urgent. */
export async function collectAlerts(deps = {}) {
  const _doc = deps.getDocOne     || getDocOne;
  const _col = deps.getCollection || getCollection;
  const now  = deps.now           || israelNow();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const alerts = [];
  const add = (key, prio, line) => alerts.push({ key, prio, line });

  const [bills, budget, expenses, sw, plants, waterLog,
         tasks, pantry, groceries, tpls, ckWeek, reports] = await Promise.all([
    _doc(`bills/${month}`), _doc("settings/budget"), _col("expenses"),
    _col("splitwise_expenses"), _col("plants"), _doc("watering/log"),
    _col("maintenance"), _col("pantry"), _col("grocery_queue"),
    _col("cleaning_templates"), _doc(`checklists/${weekKey(now)}`), _col("reports")
  ]);

  /* 1. Bills not entered. Too early before the 3rd for them to have arrived. */
  if (now.getDate() >= 3) {
    const b = bills || {};
    const missing = [];
    if (!(b.rentAlon ?? b.rent ?? 0) && !(b.rentTali ?? 0)) missing.push("שכ״ד");
    BILLS.forEach(d => { if (!(b[d.key] || 0)) missing.push(d.he); });
    if (missing.length)
      add("bills", 1, `💳 ${missing.length} חשבונות לא הוזנו: ${missing.join(", ")}`);
  }

  /* 2. Grocery budget — flags overspend, and also a pace that will overshoot. */
  const target = budget?.groceries || 0;
  if (target > 0) {
    let spent = 0;
    expenses.forEach(e => {
      if (e.type === "groceries" && (e.date || "").startsWith(month)) spent += e.amount || 0;
    });
    const pct    = (spent / target) * 100;
    const dayPct = (now.getDate() / daysInMonth) * 100;
    if (pct >= 100)
      add("budget", 2, `🛒 חריגה מתקציב הקניות — ${nis(spent - target)} מעל ${nis(target)}`);
    else if (pct >= BUDGET_WARN_PCT)
      add("budget", 2, `🛒 ${Math.round(pct)}% מתקציב הקניות נוצל — נשארו ${nis(target - spent)}`);
    else if (pct - dayPct >= 25)
      add("budget", 2, `🛒 קצב הקניות מהיר — ${Math.round(pct)}% מהתקציב ביום ${now.getDate()} בחודש`);
  }

  /* 3. Balance worth settling. Same formula the app uses, rent excluded. */
  let paidAlon = 0, paidTali = 0, settled = 0;
  sw.forEach(e => {
    const amt = e.amount || 0;
    if (e.kind === "settlement") settled += (e.from === "Tali") ? -amt : amt;
    else if (e.paidBy === "Alon") paidAlon += amt;
    else if (e.paidBy === "Tali") paidTali += amt;
  });
  const net = (paidAlon - paidTali) / 2 + settled;
  if (Math.abs(net) >= BALANCE_ALERT)
    add("balance", 3, `🤝 ${net > 0 ? "טלי חייבת" : "אתה חייב"} ${nis(Math.abs(net))} — אולי זמן לסגור`);

  /* 4. Month end — only if this month's report hasn't been saved. */
  if (daysInMonth - now.getDate() <= 2) {
    const saved = reports.some(r => (r.id || "").includes(month) || (r.month || "") === month);
    if (!saved) add("monthend", 4, `📊 החודש נגמר — כדאי לשמור דוח חודשי`);
  }

  /* 5. Cleaning — checked on Thursday, while there's still a weekend to do it. */
  if (now.getDay() === 4) {
    const weekly = tpls.filter(t => t.frequency === "weekly");
    const done   = ckWeek || {};
    const undone = weekly.filter(t => !done[t.id]);
    if (undone.length)
      add("cleaning", 5, `🧼 ${undone.length} משימות ניקיון שבועיות לא בוצעו`);
  }

  /* 6. Tasks open a long time. No due-date field exists, so age is the signal. */
  const CLOSED = new Set(["resolved", "done", "closed"]);
  const stale = tasks.filter(t => {
    if (CLOSED.has((t.status || "").toLowerCase())) return false;
    const d = t.dateReported || (t.createdAt || "").slice(0, 10);
    return d && (Date.now() - new Date(d).getTime()) / 864e5 > TASK_STALE_DAYS;
  });
  if (stale.length)
    add("tasks", 6, `📋 ${stale.length} משימות פתוחות מעל שבועיים`);

  /* 7. Plants past their watering interval. */
  const log = waterLog || {};
  const thirsty = plants.filter(p => {
    const last = log[p.id];
    if (!last) return true;
    return (Date.now() - Number(last)) / 864e5 > (p.intervalDays || 3);
  });
  if (thirsty.length) {
    const names = thirsty.slice(0, 3).map(p => p.name).filter(Boolean).join(", ");
    add("plants", 7, `🪴 ${thirsty.length} צמחים צריכים השקיה${names ? ": " + names : ""}${thirsty.length > 3 ? "…" : ""}`);
  }

  /* 8. Run out of something that isn't on the shopping list yet — the gap
        that actually causes a second trip to the shop. */
  const onList = new Set(groceries.map(g => (g.name || "").trim()).filter(Boolean));
  const forgotten = pantry.filter(p =>
    (p.status || "").toLowerCase() === "out" && !onList.has((p.name || "").trim()));
  if (forgotten.length) {
    const names = forgotten.slice(0, 3).map(p => p.name).join(", ");
    add("restock", 8, `🧺 ${forgotten.length} מוצרים נגמרו ולא ברשימה: ${names}${forgotten.length > 3 ? "…" : ""}`);
  }

  /* 9. Shopping list worth a trip. */
  if (groceries.length >= SHOPLIST_ALERT)
    add("shoplist", 9, `🛍️ ${groceries.length} פריטים ברשימת הקניות`);

  return alerts.sort((a, b) => a.prio - b.prio);
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

  const all = await collectAlerts({ now });
  if (!all.length) { console.log("All clear — no notification sent."); return; }
  console.log(`${all.length} condition(s) true: ${all.map(a => a.key).join(", ")}`);

  /* Per-check cooldown */
  const stateDoc = (await getDocOne("push_state/last")) || {};
  let seen = {};
  try { seen = JSON.parse(stateDoc.seen || "{}"); } catch {}
  const fresh = FORCE ? all : all.filter(a => {
    const last = Number(seen[a.key] || 0);
    return (Date.now() - last) / 864e5 >= COOLDOWN;
  });
  if (!fresh.length) {
    console.log(`Everything true is still inside its ${COOLDOWN}-day cooldown — staying quiet.`);
    return;
  }

  const shown = fresh.slice(0, MAX_LINES);
  const extra = fresh.length - shown.length;
  const body  = shown.map(a => a.line).join("\n") + (extra ? `\n…ועוד ${extra}` : "");

  const subs = await getCollection("push_subs");
  if (!subs.length) { console.log("No devices subscribed yet.\n" + body); return; }

  webpush.setVapidDetails("mailto:alon7barak@gmail.com", VAPID_PUB, process.env.VAPID_PRIVATE);
  const payload = JSON.stringify({ title: "Home Manager", body, tag: "hm-daily" });

  let ok = 0, gone = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        gone++;
        await fetch(`${BASE}/push_subs/${s.id}?key=${KEY}`, { method: "DELETE" });
      } else {
        console.warn("send failed:", s.who, err.statusCode, String(err.body || err.message).slice(0, 120));
      }
    }
  }

  // Only the checks we actually mentioned go quiet
  if (ok) {
    shown.forEach(a => { seen[a.key] = Date.now(); });
    await patchDoc("push_state/last", { seen: JSON.stringify(seen), at: Date.now() });
  }
  console.log(`Sent to ${ok} device(s), removed ${gone} dead.\n${body}`);
}

if (process.env.NODE_ENV !== "test") {
  main().catch(e => { console.error(e); process.exit(1); });
}
