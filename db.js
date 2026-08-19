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

    // Çok kiracılı yapı: her kafe hesabı (kiracı) burada bir satır.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tenants (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // Masa QR token'ından hangi kiracıya ait olduğunu hızlıca bulmak için
    // (müşteri self-servis ucu, tüm kiracıların verisini taramak zorunda kalmasın diye).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS qr_tokens (
            token TEXT PRIMARY KEY,
            tenant_slug TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // Satır hiç yoksa (ilk kurulum), boş bir state ile oluştur.
    await pool.query(
        `INSERT INTO cafe_state (cafe_slug, data, version)
         VALUES ($1, $2, 1)
         ON CONFLICT (cafe_slug) DO NOTHING`,
        [DEFAULT_CAFE_SLUG, { initialized: false }]
    );
}

// Bir kiracı için cafe_state satırı yoksa oluşturur; VARSA DOKUNMAZ.
// forceSaveState'in aksine burada "DO UPDATE" yok — bilerek. Bu fonksiyon
// hem sunucu açılışında (mevcut kafe için) hem yeni kiracı oluştururken
// çağrılıyor; ikinci durumda slug'ın rastlantıyla zaten var olan (canlı,
// dolu) bir satırla çakışması hâlinde o satırın üzerine asla yazılmamalı.
async function ensureCafeStateRow(slug, initialData = { initialized: false }) {
    await pool.query(
        `INSERT INTO cafe_state (cafe_slug, data, version)
         VALUES ($1, $2, 1)
         ON CONFLICT (cafe_slug) DO NOTHING`,
        [slug, initialData]
    );
}

// --- Kiracı (tenant) yönetimi ---

async function createTenant({ slug, name, username, passwordHash }) {
    const { rows } = await pool.query(
        `INSERT INTO tenants (slug, name, username, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING slug, name, username, active, created_at`,
        [slug, name, username, passwordHash]
    );
    return rows[0];
}

async function getTenantByUsername(username) {
    const { rows } = await pool.query(
        `SELECT slug, name, username, password_hash, active FROM tenants WHERE username = $1`,
        [username]
    );
    return rows[0] || null;
}

async function getTenantBySlug(slug) {
    const { rows } = await pool.query(
        `SELECT slug, name, username, active FROM tenants WHERE slug = $1`,
        [slug]
    );
    return rows[0] || null;
}

async function listTenants() {
    const { rows } = await pool.query(
        `SELECT slug, name, username, active, created_at FROM tenants ORDER BY created_at DESC`
    );
    return rows;
}

async function updateTenant(slug, fields) {
    const sets = [];
    const values = [];
    let i = 1;
    if (fields.name !== undefined) { sets.push(`name = $${i++}`); values.push(fields.name); }
    if (fields.username !== undefined) { sets.push(`username = $${i++}`); values.push(fields.username); }
    if (fields.passwordHash !== undefined) { sets.push(`password_hash = $${i++}`); values.push(fields.passwordHash); }
    if (fields.active !== undefined) { sets.push(`active = $${i++}`); values.push(fields.active); }
    if (!sets.length) return getTenantBySlug(slug);
    values.push(slug);
    const { rows } = await pool.query(
        `UPDATE tenants SET ${sets.join(", ")} WHERE slug = $${i} RETURNING slug, name, username, active, created_at`,
        values
    );
    return rows[0] || null;
}

// --- Masa QR token -> kiracı eşlemesi ---

async function upsertQrToken(token, tenantSlug) {
    await pool.query(
        `INSERT INTO qr_tokens (token, tenant_slug) VALUES ($1, $2)
         ON CONFLICT (token) DO NOTHING`,
        [token, tenantSlug]
    );
}

async function getTenantSlugForToken(token) {
    const { rows } = await pool.query(
        `SELECT tenant_slug FROM qr_tokens WHERE token = $1`,
        [token]
    );
    return rows[0] ? rows[0].tenant_slug : null;
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
    DEFAULT_CAFE_SLUG,
    ensureCafeStateRow,
    createTenant,
    getTenantByUsername,
    getTenantBySlug,
    listTenants,
    updateTenant,
    upsertQrToken,
    getTenantSlugForToken
};
