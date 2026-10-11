// Enduroverse forms API
// Handles: Gym Partner Information form + Deadly Dozen "Notify Me" signups.
// Talks to a Render Postgres database (connection string comes from the
// DATABASE_URL environment variable, which Render sets automatically when
// you link this service to the database in the dashboard).

const express = require("express");
const { Pool } = require("pg");

const app = express();
// Raised from 2mb to comfortably fit uploaded rule book / program PDFs,
// which are sent as base64 JSON (base64 runs ~33% larger than the file).
app.use(express.json({ limit: "20mb" }));

// Basic CORS so the form (hosted elsewhere, e.g. Wix) can call this API.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "DD_gyminfo";
// Separate organiser password for the Mini Challenge registrations list.
const MINI_ADMIN_PASSWORD = process.env.MINI_ADMIN_PASSWORD || "DD_mini";

// ---- Schema: created automatically on boot, no manual SQL needed ----
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gym_submissions (
      id SERIAL PRIMARY KEY,
      gym_name TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      type TEXT NOT NULL,
      specialised JSONB DEFAULT '[]',
      association JSONB DEFAULT '[]',
      track_host JSONB DEFAULT '[]',
      equipment JSONB DEFAULT '[]',
      submitted_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Added after the table already existed in some deployments, so these use
  // ADD COLUMN IF NOT EXISTS — safe to run every time the service boots.
  await pool.query(`ALTER TABLE gym_submissions ADD COLUMN IF NOT EXISTS pincode TEXT;`);
  await pool.query(`ALTER TABLE gym_submissions ADD COLUMN IF NOT EXISTS city TEXT;`);
  await pool.query(`ALTER TABLE gym_submissions ADD COLUMN IF NOT EXISTS state TEXT;`);
  await pool.query(`ALTER TABLE gym_submissions ADD COLUMN IF NOT EXISTS country TEXT;`);
  await pool.query(`ALTER TABLE gym_submissions ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE gym_submissions ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notify_signups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      division TEXT NOT NULL,
      submitted_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Mini Challenge (31 Oct 2026) registrations.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mini_challenge_signups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      participation TEXT NOT NULL,
      partner_name TEXT,
      partner_phone TEXT,
      partner_email TEXT,
      amount INTEGER NOT NULL,
      medical_issue TEXT NOT NULL,
      medical_details TEXT,
      waiver_accepted BOOLEAN NOT NULL DEFAULT false,
      waiver_signed_name TEXT,
      submitted_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Razorpay payment tracking for Mini Challenge (safe to re-run).
  await pool.query(`
    ALTER TABLE mini_challenge_signups
      ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT,
      ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT,
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
  `);

  // Relay team fields for Mini Challenge (safe to re-run).
  await pool.query(`
    ALTER TABLE mini_challenge_signups
      ADD COLUMN IF NOT EXISTS relay_category TEXT,
      ADD COLUMN IF NOT EXISTS team_name TEXT,
      ADD COLUMN IF NOT EXISTS team_members TEXT;
  `);

  // Gender, address and emergency contact for Mini Challenge (safe to re-run).
  await pool.query(`
    ALTER TABLE mini_challenge_signups
      ADD COLUMN IF NOT EXISTS gender TEXT,
      ADD COLUMN IF NOT EXISTS address TEXT,
      ADD COLUMN IF NOT EXISTS emergency_name TEXT,
      ADD COLUMN IF NOT EXISTS emergency_phone TEXT;
  `);

  // Coupon codes for the Mini Challenge (codes must start with DDM).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mini_challenge_coupons (
      code TEXT PRIMARY KEY,
      percent INTEGER NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    ALTER TABLE mini_challenge_signups
      ADD COLUMN IF NOT EXISTS coupon_code TEXT,
      ADD COLUMN IF NOT EXISTS discount_percent INTEGER;
  `);

  // Admin-uploaded files for the Race Prep page: the rule book and the
  // 30/60/90-day training programs. Stored directly in Postgres (as bytes)
  // rather than on disk, since Render's free web service disk is wiped on
  // every deploy — a file saved to disk would vanish on the next code push.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS race_resources (
      key TEXT PRIMARY KEY,
      file_name TEXT,
      mime_type TEXT,
      file_data BYTEA,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Small generic key/value store for simple admin-editable text settings,
  // e.g. the YouTube training video link.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Geocoding: turns a gym's address into lat/lng so it can show up in
// the "Find a Labour Camp Near You" search on the main page. Uses the free
// OpenStreetMap Nominatim API. Runs in the background after a save so it
// never slows down or blocks the person submitting the form — if it fails
// (bad address, rate limit, etc.) the submission itself is unaffected, the
// gym just won't appear in nearby-search results until it succeeds.
async function tryGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "EnduroverseGymLocator/1.0" },
  });
  if (!resp.ok) return null;
  const results = await resp.json();
  if (!results || !results[0]) return null;
  const lat = parseFloat(results[0].lat);
  const lng = parseFloat(results[0].lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

// Nominatim (free OpenStreetMap geocoding) often can't resolve a precise
// street address — house number, cross street, layout name, etc. If the
// full address doesn't match, progressively drop the most specific leading
// part and retry (e.g. "28, 4th cross, KEB Layout, Bengaluru, Karnataka
// 560094" -> "4th cross, KEB Layout, Bengaluru, Karnataka 560094" -> ... ->
// "Bengaluru, Karnataka 560094"), and fall back to a bare pincode if one is
// present. This trades precision for actually getting a usable pin.
async function geocodeAddress(b) {
  const full = [b.address, b.city, b.state, b.pincode, b.country].filter(Boolean).join(", ");
  if (!full) return null;

  let loc = await tryGeocode(full);
  if (loc) return loc;

  const parts = full.split(",").map(p => p.trim()).filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    loc = await tryGeocode(parts.slice(i).join(", "));
    if (loc) return loc;
  }

  const pinMatch = full.match(/\b\d{6}\b/);
  if (pinMatch) {
    loc = await tryGeocode(pinMatch[0]);
    if (loc) return loc;
  }

  return null;
}

async function geocodeAndStore(id, b) {
  try {
    const loc = await geocodeAddress(b);
    if (loc) {
      await pool.query(`UPDATE gym_submissions SET lat=$1, lng=$2 WHERE id=$3`, [loc.lat, loc.lng, id]);
    }
  } catch (err) {
    console.error("geocode error for gym", id, err.message);
  }
}

// ---- Gym form ----
app.post("/api/gym", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.gymName || !b.address || !b.phone || !b.type) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    const { rows } = await pool.query(
      `INSERT INTO gym_submissions
        (gym_name, address, pincode, city, state, country, phone, type, specialised, association, track_host, equipment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        b.gymName,
        b.address,
        b.pincode || null,
        b.city || null,
        b.state || null,
        b.country || null,
        b.phone,
        b.type,
        JSON.stringify(b.specialised || []),
        JSON.stringify(b.association || []),
        JSON.stringify(b.trackHost || []),
        JSON.stringify(b.equipment || []),
      ]
    );
    res.json({ success: true, id: rows[0].id });
    geocodeAndStore(rows[0].id, b); // fire-and-forget, doesn't block the response
  } catch (err) {
    console.error("gym insert error:", err);
    res.status(500).json({ success: false, error: "Server error saving submission" });
  }
});

// Public, unauthenticated: powers the "Find a Labour Camp Near You" search
// on the main race page. Only returns fields safe to show publicly.
app.get("/api/gym/public-nearby", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, gym_name, address, city, state, country, phone, lat, lng
       FROM gym_submissions
       WHERE lat IS NOT NULL AND lng IS NOT NULL`
    );
    res.json(rows);
  } catch (err) {
    console.error("public-nearby error:", err);
    res.status(500).json({ success: false, error: "Server error fetching nearby gyms" });
  }
});

// Edit an existing submission (used by the form's "Edit Submission" button).
// NOTE: not password-protected — anyone with a submission's id can edit it.
// That's fine for this page's simple login-gate model, but don't expose
// ids/this endpoint anywhere you need stronger guarantees.
app.put("/api/gym/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    if (!b.gymName || !b.address || !b.phone || !b.type) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    const { rowCount } = await pool.query(
      `UPDATE gym_submissions
       SET gym_name=$1, address=$2, pincode=$3, city=$4, state=$5, country=$6,
           phone=$7, type=$8, specialised=$9, association=$10, track_host=$11, equipment=$12
       WHERE id=$13`,
      [
        b.gymName,
        b.address,
        b.pincode || null,
        b.city || null,
        b.state || null,
        b.country || null,
        b.phone,
        b.type,
        JSON.stringify(b.specialised || []),
        JSON.stringify(b.association || []),
        JSON.stringify(b.trackHost || []),
        JSON.stringify(b.equipment || []),
        id,
      ]
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }
    res.json({ success: true });
    geocodeAndStore(id, b); // fire-and-forget, re-geocode in case the address changed
  } catch (err) {
    console.error("gym update error:", err);
    res.status(500).json({ success: false, error: "Server error updating submission" });
  }
});

app.get("/api/gym", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, gym_name, address, pincode, city, state, country, phone, type,
              specialised, association, track_host, equipment, submitted_at, lat, lng
       FROM gym_submissions ORDER BY submitted_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("gym list error:", err);
    res.status(500).json({ success: false, error: "Server error fetching submissions" });
  }
});

app.delete("/api/gym/:id", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { rowCount } = await pool.query(`DELETE FROM gym_submissions WHERE id=$1`, [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("gym delete error:", err);
    res.status(500).json({ success: false, error: "Server error deleting submission" });
  }
});

// Admin-only: retry geocoding for one submission (e.g. its address failed to
// resolve to a pin the first time). Reads the current row so it re-geocodes
// whatever address is stored now, then reports back whether a location was
// found so the admin UI can show a result immediately.
app.post("/api/gym/:id/regeocode", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT address, city, state, pincode, country FROM gym_submissions WHERE id=$1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }
    const loc = await geocodeAddress(rows[0]);
    if (!loc) {
      return res.json({ success: false, error: "Couldn't find that address — try adding a pincode or checking spelling." });
    }
    await pool.query(`UPDATE gym_submissions SET lat=$1, lng=$2 WHERE id=$3`, [loc.lat, loc.lng, req.params.id]);
    res.json({ success: true, lat: loc.lat, lng: loc.lng });
  } catch (err) {
    console.error("regeocode error:", err);
    res.status(500).json({ success: false, error: "Server error re-geocoding submission" });
  }
});

// ---- Notify Me form ----
app.post("/api/notify", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.email || !b.phone || !b.division) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    await pool.query(
      `INSERT INTO notify_signups (name, email, phone, division) VALUES ($1,$2,$3,$4)`,
      [b.name, b.email, b.phone, b.division]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("notify insert error:", err);
    res.status(500).json({ success: false, error: "Server error saving signup" });
  }
});

app.get("/api/notify", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, division, submitted_at
       FROM notify_signups ORDER BY submitted_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("notify list error:", err);
    res.status(500).json({ success: false, error: "Server error fetching signups" });
  }
});

// ---- Mini Challenge registrations (31 Oct 2026) ----
const MINI_PRICES = { solo: 1499, pair: 2499, relay: 3499 };
const RELAY_CATS = ["4 men", "2 men + 2 women", "4 women"];
// Secret ₹1 payment test: set MINI_TEST_CODE in Render, then register with an email like name+CODE@gmail.com.
const MINI_TEST_CODE = (process.env.MINI_TEST_CODE || "").toLowerCase();
const miniAmount = (type, email) =>
  MINI_TEST_CODE && String(email || "").toLowerCase().includes("+" + MINI_TEST_CODE + "@") ? 1 : MINI_PRICES[type];

// ---- Coupons: code must start with DDM, then is cross-checked in mini_challenge_coupons ----
const COUPON_RE = /^DDM[A-Z0-9]{1,17}$/;
const cleanCode = c => String(c || "").trim().toUpperCase();
// Returns { ok:true, coupon } or { ok:false, error }.
async function lookupCoupon(raw) {
  const code = cleanCode(raw);
  if (!COUPON_RE.test(code)) return { ok: false, error: "Invalid coupon code" };
  const { rows } = await pool.query(`SELECT * FROM mini_challenge_coupons WHERE code = $1`, [code]);
  const c = rows[0];
  if (!c || !c.active) return { ok: false, error: "Invalid coupon code" };
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { ok: false, error: "This coupon has expired" };
  if (c.max_uses != null && c.used_count >= c.max_uses) return { ok: false, error: "This coupon has been fully used" };
  return { ok: true, coupon: c };
}
const discounted = (base, percent) => Math.max(0, Math.round(base * (100 - percent) / 100));
// Light brute-force guard: 12 coupon checks per minute per IP.
const couponHits = new Map();
function couponLimited(ip) {
  const now = Date.now(), arr = (couponHits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); couponHits.set(ip, arr);
  return arr.length > 12;
}

app.post("/api/mini-challenge/coupon", async (req, res) => {
  try {
    if (couponLimited(req.ip)) return res.status(429).json({ success: false, error: "Too many attempts. Please wait a minute." });
    const b = req.body || {};
    const type = ["solo", "pair", "relay"].includes(b.participation) ? b.participation : null;
    const r = await lookupCoupon(b.code);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    const base = type ? MINI_PRICES[type] : null;
    res.json({ success: true, code: r.coupon.code, percent: r.coupon.percent,
               base, final: base == null ? null : discounted(base, r.coupon.percent) });
  } catch (err) {
    console.error("coupon check error:", err);
    res.status(500).json({ success: false, error: "Could not check the coupon right now" });
  }
});

app.post("/api/mini-challenge", async (req, res) => {
  try {
    const b = req.body || {};
    const type = ["solo", "pair", "relay"].includes(b.participation) ? b.participation : null;
    if (!b.name || !b.phone || !b.email || !type) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    if (type === "pair" && (!b.partner_name || !b.partner_phone)) {
      return res.status(400).json({ success: false, error: "Partner details required for pairs" });
    }
    if (b.gender !== "Male" && b.gender !== "Female") {
      return res.status(400).json({ success: false, error: "Please select Male or Female" });
    }
    if (!b.address || !b.emergency_name || !b.emergency_phone) {
      return res.status(400).json({ success: false, error: "Address and emergency contact are required" });
    }
    if (type === "relay") {
      if (!RELAY_CATS.includes(b.relay_category)) {
        return res.status(400).json({ success: false, error: "Choose a relay team category" });
      }
      if (!b.team_name || !b.team_members) {
        return res.status(400).json({ success: false, error: "Team name and members required for relay" });
      }
    }
    if (b.medical_issue !== "yes" && b.medical_issue !== "no") {
      return res.status(400).json({ success: false, error: "Medical declaration required" });
    }
    if (b.waiver_accepted !== true || !b.waiver_signed_name) {
      return res.status(400).json({ success: false, error: "Waiver must be accepted and signed" });
    }
    let amount = miniAmount(type, b.email), couponCode = null, couponPct = null;
    if (b.coupon_code && String(b.coupon_code).trim()) {
      const cr = await lookupCoupon(b.coupon_code);
      if (!cr.ok) return res.status(400).json({ success: false, error: cr.error });
      if (amount > 1) {   // the secret Rs 1 test amount ignores coupons
        couponCode = cr.coupon.code; couponPct = cr.coupon.percent;
        amount = discounted(MINI_PRICES[type], couponPct);
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO mini_challenge_signups
        (name, phone, email, participation, partner_name, partner_phone, partner_email,
         amount, medical_issue, medical_details, waiver_accepted, waiver_signed_name,
         relay_category, team_name, team_members, gender, address, emergency_name, emergency_phone,
         coupon_code, discount_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [b.name, b.phone, b.email, type,
       type === "pair" ? b.partner_name : null,
       type === "pair" ? b.partner_phone : null,
       type === "pair" ? (b.partner_email || null) : null,
       amount, b.medical_issue, b.medical_details || null, b.waiver_signed_name,
       type === "relay" ? b.relay_category : null,
       type === "relay" ? String(b.team_name).slice(0, 120) : null,
       type === "relay" ? String(b.team_members).slice(0, 1500) : null,
       b.gender, String(b.address).slice(0, 500), String(b.emergency_name).slice(0, 120), String(b.emergency_phone).slice(0, 20),
       couponCode, couponPct]
    );
    res.json({ success: true, id: rows[0].id, amount, coupon_code: couponCode, discount_percent: couponPct });
  } catch (err) {
    console.error("mini-challenge insert error:", err);
    res.status(500).json({ success: false, error: "Server error saving registration" });
  }
});

// ---- Razorpay payment for Mini Challenge ----
// Needs env vars RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (set in Render).
const crypto = require("crypto");
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

app.post("/api/mini-challenge/order", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, amount, payment_status, coupon_code FROM mini_challenge_signups WHERE id = $1`,
      [req.body && req.body.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Registration not found" });
    const r = rows[0];
    if (r.payment_status === "paid") return res.status(409).json({ success: false, error: "Already paid" });
    if (r.amount === 0) {   // 100% coupon: nothing to charge, confirm the spot directly
      await pool.query(
        `UPDATE mini_challenge_signups SET payment_status = 'paid', razorpay_payment_id = 'FREE-COUPON', paid_at = now() WHERE id = $1`,
        [r.id]
      );
      if (r.coupon_code) await pool.query(`UPDATE mini_challenge_coupons SET used_count = used_count + 1 WHERE code = $1`, [r.coupon_code]);
      sendMiniConfirmation(r.id).catch(e => console.error("confirmation email error:", e));
      return res.json({ success: true, free: true });
    }
    if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
      return res.status(503).json({ success: false, error: "payments_not_configured" });
    }
    const auth = Buffer.from(RZP_KEY_ID + ":" + RZP_KEY_SECRET).toString("base64");
    const rz = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + auth },
      body: JSON.stringify({ amount: r.amount * 100, currency: "INR", receipt: "mini_" + r.id })
    });
    const order = await rz.json();
    if (!rz.ok) {
      console.error("razorpay order error:", order);
      return res.status(502).json({ success: false, error: "Could not start payment" });
    }
    await pool.query(`UPDATE mini_challenge_signups SET razorpay_order_id = $1 WHERE id = $2`, [order.id, r.id]);
    res.json({ success: true, key_id: RZP_KEY_ID, order_id: order.id, amount: order.amount,
               name: r.name, email: r.email, phone: r.phone });
  } catch (err) {
    console.error("mini-challenge order error:", err);
    res.status(500).json({ success: false, error: "Server error starting payment" });
  }
});

// ---- Confirmation email (Resend). Env: RESEND_API_KEY, MAIL_FROM, MAIL_NOTIFY (optional organiser copy) ----
const esc = v => String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
async function sendMiniConfirmation(id) {
  const useSmtp = !!(process.env.SMTP_HOST || process.env.EMAIL_USER);
  const key = process.env.RESEND_API_KEY;
  if (!useSmtp && !key) { console.log("confirmation email skipped: no SMTP_HOST or RESEND_API_KEY set"); return; }
  const { rows } = await pool.query(`SELECT * FROM mini_challenge_signups WHERE id = $1`, [id]);
  if (!rows.length) return;
  const r = rows[0];
  const kind = { solo: "Solo", pair: "Pairs", relay: "Relay (team of 4)" }[r.participation] || r.participation;
  const line = (k, v) => v ? `<tr><td style="padding:6px 12px;color:#666">${k}</td><td style="padding:6px 12px"><b>${esc(v)}</b></td></tr>` : "";
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111">
    <h2 style="margin:0 0 4px">You're in! 🏃</h2>
    <p style="margin:0 0 16px">Hi ${esc(r.name)}, your registration for the <b>Deadly Dozen Mini Challenge – 31 Oct 2026</b> is confirmed and payment received.</p>
    <table style="border-collapse:collapse;background:#f6f6f6;width:100%">
      ${line("Registration #", r.id)}${line("Category", kind)}${line("Team name", r.team_name)}
      ${line("Partner", r.partner_name)}${line("Team members", r.team_members)}
      ${line("Coupon", r.coupon_code ? r.coupon_code + " (" + r.discount_percent + "% off)" : "")}${line("Amount paid", "₹" + r.amount)}${line("Payment ID", r.razorpay_payment_id)}
    </table>
    <h3 style="margin:20px 0 6px">Venue</h3>
    <p style="margin:0 0 8px"><b>South United Football Club (SUFC)</b><br>
    Gate No. 3, RBANM's Ground, Gangadhar Chetty Road, Near Ulsoor Lake, Rukmani Colony, Bengaluru, Karnataka 560042</p>
    <p style="margin:0 0 16px"><a href="https://www.google.com/maps?cid=14863531940966096613" style="background:#e63946;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px;display:inline-block">📍 Open in Google Maps</a></p>
    <p>Your wave time will be shared closer to the event. Please keep this email for your records.</p>
    <p>For any query, contact us at <a href="mailto:india@deadlydozen.in">india@deadlydozen.in</a>.</p>
    <p style="color:#666;font-size:13px">– Team Deadly Dozen · deadlydozen.in</p></div>`;
  const subject = "Registration confirmed – Deadly Dozen Mini Challenge (31 Oct 2026)";
  if (useSmtp) {
    const nodemailer = require("nodemailer");
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
    const tx = nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined });
    await tx.sendMail({
      from: process.env.MAIL_FROM || process.env.EMAIL_FROM || user,
      to: r.email, bcc: process.env.MAIL_NOTIFY || undefined,
      replyTo: "india@deadlydozen.in", subject, html
    });
    console.log("confirmation email sent (smtp) to", r.email);
    return;
  }
  const body = { reply_to: "india@deadlydozen.in", from: process.env.MAIL_FROM || "Deadly Dozen <onboarding@resend.dev>",
                 to: [r.email], subject, html };
  if (process.env.MAIL_NOTIFY) body.bcc = [process.env.MAIL_NOTIFY];
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) console.error("confirmation email failed:", resp.status, await resp.text());
}

app.post("/api/mini-challenge/verify", async (req, res) => {
  if (!RZP_KEY_SECRET) return res.status(503).json({ success: false, error: "payments_not_configured" });
  try {
    const b = req.body || {};
    const expected = crypto.createHmac("sha256", RZP_KEY_SECRET)
      .update(b.razorpay_order_id + "|" + b.razorpay_payment_id).digest("hex");
    if (!b.razorpay_signature || expected !== b.razorpay_signature) {
      return res.status(400).json({ success: false, error: "Payment verification failed" });
    }
    const up = await pool.query(
      `UPDATE mini_challenge_signups SET payment_status = 'paid', razorpay_payment_id = $1, paid_at = now()
       WHERE id = $2 AND razorpay_order_id = $3
       RETURNING id, coupon_code, (SELECT payment_status FROM mini_challenge_signups WHERE id = $2) AS prev_status`,
      [b.razorpay_payment_id, b.id, b.razorpay_order_id]
    );
    if (!up.rowCount) return res.status(404).json({ success: false, error: "Registration not found" });
    if (up.rows[0].coupon_code && up.rows[0].prev_status !== "paid") {
      await pool.query(`UPDATE mini_challenge_coupons SET used_count = used_count + 1 WHERE code = $1`, [up.rows[0].coupon_code]);
    }
    sendMiniConfirmation(b.id).catch(e => console.error("confirmation email error:", e));
    res.json({ success: true });
  } catch (err) {
    console.error("mini-challenge verify error:", err);
    res.status(500).json({ success: false, error: "Server error verifying payment" });
  }
});

app.get("/api/mini-challenge", async (req, res) => {
  if (req.query.password !== MINI_ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query(`SELECT * FROM mini_challenge_signups ORDER BY submitted_at DESC`);
    res.json(rows);
  } catch (err) {
    console.error("mini-challenge list error:", err);
    res.status(500).json({ success: false, error: "Server error fetching registrations" });
  }
});

// Organiser: list / create-or-update / switch off coupons. Protected by the organiser password.
app.get("/api/mini-challenge-coupons", async (req, res) => {
  if (req.query.password !== MINI_ADMIN_PASSWORD) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`SELECT * FROM mini_challenge_coupons ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) {
    console.error("coupon list error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/api/mini-challenge-coupons", async (req, res) => {
  if (req.query.password !== MINI_ADMIN_PASSWORD) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const b = req.body || {};
    const code = cleanCode(b.code);
    if (!COUPON_RE.test(code)) return res.status(400).json({ success: false, error: "Code must start with DDM (letters/numbers only, max 20 characters)" });
    if (b.delete === true) {
      await pool.query(`DELETE FROM mini_challenge_coupons WHERE code = $1`, [code]);
      return res.json({ success: true });
    }
    const percent = parseInt(b.percent, 10);
    if (!(percent >= 1 && percent <= 100)) return res.status(400).json({ success: false, error: "Percent must be 1 to 100" });
    const maxUses = b.max_uses === "" || b.max_uses == null ? null : parseInt(b.max_uses, 10);
    if (maxUses != null && !(maxUses >= 1)) return res.status(400).json({ success: false, error: "Max uses must be 1 or more" });
    const exp = b.expires_at ? new Date(b.expires_at) : null;
    if (exp && isNaN(exp)) return res.status(400).json({ success: false, error: "Bad expiry date" });
    await pool.query(
      `INSERT INTO mini_challenge_coupons (code, percent, active, max_uses, expires_at, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET percent = $2, active = $3, max_uses = $4, expires_at = $5, note = $6`,
      [code, percent, b.active === false ? false : true, maxUses, exp, b.note ? String(b.note).slice(0, 200) : null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("coupon save error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.delete("/api/mini-challenge/:id", async (req, res) => {
  if (req.query.password !== MINI_ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    await pool.query(`DELETE FROM mini_challenge_signups WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("mini-challenge delete error:", err);
    res.status(500).json({ success: false, error: "Server error deleting registration" });
  }
});

// ---- Race Prep resources: Rule Book + 30/60/90-day programs ----
// Valid resource keys. Keeping an explicit list avoids the admin page
// accidentally creating arbitrary rows.
const RESOURCE_KEYS = ["rulebook", "program_30", "program_60", "program_90"];

// Public: lets a page check whether a file has been uploaded yet (and its
// name/date) without needing the admin password and without sending the
// file's bytes.
app.get("/api/resources/:key/meta", async (req, res) => {
  if (!RESOURCE_KEYS.includes(req.params.key)) {
    return res.status(404).json({ success: false, error: "Unknown resource" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT file_name, mime_type, updated_at, (file_data IS NOT NULL) AS exists
       FROM race_resources WHERE key=$1`,
      [req.params.key]
    );
    if (rows.length === 0 || !rows[0].exists) {
      return res.json({ exists: false });
    }
    res.json({ exists: true, fileName: rows[0].file_name, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error("resource meta error:", err);
    res.status(500).json({ success: false, error: "Server error checking resource" });
  }
});

// Public: streams the actual file for download.
app.get("/api/resources/:key/file", async (req, res) => {
  if (!RESOURCE_KEYS.includes(req.params.key)) {
    return res.status(404).send("Not found");
  }
  try {
    const { rows } = await pool.query(
      `SELECT file_name, mime_type, file_data FROM race_resources WHERE key=$1`,
      [req.params.key]
    );
    if (rows.length === 0 || !rows[0].file_data) {
      return res.status(404).send("Not uploaded yet");
    }
    res.setHeader("Content-Type", rows[0].mime_type || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${rows[0].file_name || req.params.key}"`);
    res.send(rows[0].file_data);
  } catch (err) {
    console.error("resource file error:", err);
    res.status(500).send("Server error fetching file");
  }
});

// Admin-only: upload or replace a resource. Body: { password, fileName,
// mimeType, dataBase64 }. The file is sent as base64 since it's going
// through the same JSON endpoint style as the rest of this API.
app.post("/api/resources/:key", async (req, res) => {
  if (!RESOURCE_KEYS.includes(req.params.key)) {
    return res.status(404).json({ success: false, error: "Unknown resource" });
  }
  const password = req.query.password || (req.body && req.body.password);
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { fileName, mimeType, dataBase64 } = req.body || {};
    if (!dataBase64) {
      return res.status(400).json({ success: false, error: "Missing file data" });
    }
    const buffer = Buffer.from(dataBase64, "base64");
    await pool.query(
      `INSERT INTO race_resources (key, file_name, mime_type, file_data, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET
         file_name = EXCLUDED.file_name,
         mime_type = EXCLUDED.mime_type,
         file_data = EXCLUDED.file_data,
         updated_at = now()`,
      [req.params.key, fileName || req.params.key, mimeType || "application/pdf", buffer]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("resource upload error:", err);
    res.status(500).json({ success: false, error: "Server error uploading file" });
  }
});

// Admin-only: remove an uploaded resource (reverts the page to "coming soon").
app.delete("/api/resources/:key", async (req, res) => {
  if (!RESOURCE_KEYS.includes(req.params.key)) {
    return res.status(404).json({ success: false, error: "Unknown resource" });
  }
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    await pool.query(`DELETE FROM race_resources WHERE key=$1`, [req.params.key]);
    res.json({ success: true });
  } catch (err) {
    console.error("resource delete error:", err);
    res.status(500).json({ success: false, error: "Server error removing file" });
  }
});

// ---- Site settings (small text values, e.g. the training video link) ----
const SETTINGS_KEYS = ["youtube_video_id"];

app.get("/api/settings/:key", async (req, res) => {
  if (!SETTINGS_KEYS.includes(req.params.key)) {
    return res.status(404).json({ success: false, error: "Unknown setting" });
  }
  try {
    const { rows } = await pool.query(`SELECT value FROM site_settings WHERE key=$1`, [req.params.key]);
    res.json({ value: rows.length ? rows[0].value : "" });
  } catch (err) {
    console.error("settings read error:", err);
    res.status(500).json({ success: false, error: "Server error reading setting" });
  }
});

app.post("/api/settings/:key", async (req, res) => {
  if (!SETTINGS_KEYS.includes(req.params.key)) {
    return res.status(404).json({ success: false, error: "Unknown setting" });
  }
  const password = req.query.password || (req.body && req.body.password);
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { value } = req.body || {};
    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.params.key, value || ""]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("settings write error:", err);
    res.status(500).json({ success: false, error: "Server error saving setting" });
  }
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Enduroverse API listening on ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize schema:", err);
    process.exit(1);
  });
