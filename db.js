const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Neon ve çoğu bulut Postgres SSL ister
});

// Şu an tek kafe var (Nare Kafe). İleride admin panelinden birden fazla
// kafe eklenince, bu sabit yerine URL/route'tan gelen cafe_slug kullanılacak
// (örn. /api/state/:cafeSlug). Şimdilik tek satırlık state bu sabitle tutuluyor.
const DEFAULT_CAFE_SLUG = "nare-kafe";

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cafe_state (
            cafe_slug TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

async function getState(slug = DEFAULT_CAFE_SLUG) {
    const { rows } = await pool.query(
        "SELECT data FROM cafe_state WHERE cafe_slug = $1",
        [slug]
    );
    return rows[0] ? rows[0].data : null;
}

async function saveState(data, slug = DEFAULT_CAFE_SLUG) {
    await pool.query(
        `INSERT INTO cafe_state (cafe_slug, data, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (cafe_slug)
         DO UPDATE SET data = $2, updated_at = now()`,
        [slug, data]
    );
}

module.exports = { pool, initDb, getState, saveState, DEFAULT_CAFE_SLUG };
