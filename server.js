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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "DD_gyminfo";

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
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Geocoding: turns a gym's address into lat/lng so it can show up in
// the "Find a Labour Camp Near You" search on the main page. Uses the free
// OpenStreetMap Nominatim API. Runs in the background after a save so it
// never slows down or blocks the person submitting the form — if it fails
// (bad address, rate limit, etc.) the submission itself is unaffected, the
// gym just won't appear in nearby-search results until it succeeds.
async function geocodeAndStore(id, b) {
  try {
    const q = [b.address, b.city, b.state, b.pincode, b.country].filter(Boolean).join(", ");
    if (!q) return;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "EnduroverseGymLocator/1.0" },
    });
    if (!resp.ok) return;
    const results = await resp.json();
    if (results && results[0]) {
      const lat = parseFloat(results[0].lat);
      const lng = parseFloat(results[0].lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        await pool.query(`UPDATE gym_submissions SET lat=$1, lng=$2 WHERE id=$3`, [lat, lng, id]);
      }
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
              specialised, association, track_host, equipment, submitted_at
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
