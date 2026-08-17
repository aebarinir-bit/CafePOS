const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Neon ve çoğu bulut Postgres SSL ister
});

// Şu an tek kafe var (Nare Kafe). İleride admin panelinden birden fazla
// kafe eklenince, bu sabit yerine URL/route'tan gelen cafe_slug kullanılacak.
const DEFAULT_CAFE_SLUG = "nare-kafe";

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cafe_state (
            cafe_slug TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // Daha önce oluşturulmuş tabloda "version" kolonu yoksa ekle
    // (küçük yama öncesi kurulan veritabanları için geriye dönük uyumluluk).
    await pool.query(`
        ALTER TABLE cafe_state
        ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
    `);

    // Satır hiç yoksa (ilk kurulum), boş bir state ile oluştur.
    await pool.query(
        `INSERT INTO cafe_state (cafe_slug, data, version)
         VALUES ($1, $2, 1)
         ON CONFLICT (cafe_slug) DO NOTHING`,
        [DEFAULT_CAFE_SLUG, { initialized: false }]
    );
}

// Mevcut veriyi + sürüm numarasını birlikte döndürür
async function getState(slug = DEFAULT_CAFE_SLUG) {
    const { rows } = await pool.query(
        "SELECT data, version FROM cafe_state WHERE cafe_slug = $1",
        [slug]
    );
    if (!rows[0]) return null;
    return { data: rows[0].data, version: rows[0].version };
}

// Normal kayıt: yalnızca gönderdiğin sürüm, veritabanındaki güncel sürümle
// eşleşiyorsa kaydeder ve sürümü bir artırır. Eşleşmiyorsa null döner
// (arada başka biri güncelledi demektir) — hiçbir şey üzerine yazılmaz.
async function saveState(data, expectedVersion, slug = DEFAULT_CAFE_SLUG) {
    const { rows } = await pool.query(
        `UPDATE cafe_state
         SET data = $2, version = version + 1, updated_at = now()
         WHERE cafe_slug = $1 AND version = $3
         RETURNING version`,
        [slug, data, expectedVersion]
    );
    if (rows.length === 0) return null;
    return rows[0].version;
}

// Sürüm kontrolü yapmadan doğrudan yazar. Yalnızca tek seferlik
// içe aktarma / bakım script'leri için (migrate-to-postgres.js gibi).
async function forceSaveState(data, slug = DEFAULT_CAFE_SLUG) {
    const { rows } = await pool.query(
        `INSERT INTO cafe_state (cafe_slug, data, version, updated_at)
         VALUES ($1, $2, 1, now())
         ON CONFLICT (cafe_slug)
         DO UPDATE SET data = $2, version = cafe_state.version + 1, updated_at = now()
         RETURNING version`,
        [slug, data]
    );
    return rows[0].version;
}

module.exports = {
    pool,
    initDb,
    getState,
    saveState,
    forceSaveState,
    DEFAULT_CAFE_SLUG
};
