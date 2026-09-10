// Enduroverse forms API
// Handles: Gym Partner Information form + Deadly Dozen "Notify Me" signups.
// Talks to a Render Postgres database (connection string comes from the
// DATABASE_URL environment variable, which Render sets automatically when
// you link this service to the database in the dashboard).

const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Basic CORS so the form (hosted elsewhere, e.g. Wix) can call this API.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "DDadmin";

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
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Gym form ----
app.post("/api/gym", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.gymName || !b.address || !b.phone || !b.type) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    await pool.query(
      `INSERT INTO gym_submissions
        (gym_name, address, phone, type, specialised, association, track_host, equipment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        b.gymName,
        b.address,
        b.phone,
        b.type,
        JSON.stringify(b.specialised || []),
        JSON.stringify(b.association || []),
        JSON.stringify(b.trackHost || []),
        JSON.stringify(b.equipment || []),
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("gym insert error:", err);
    res.status(500).json({ success: false, error: "Server error saving submission" });
  }
});

app.get("/api/gym", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, gym_name, address, phone, type, specialised, association,
              track_host, equipment, submitted_at
       FROM gym_submissions ORDER BY submitted_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("gym list error:", err);
    res.status(500).json({ success: false, error: "Server error fetching submissions" });
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

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Enduroverse API listening on ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize schema:", err);
    process.exit(1);
  });
