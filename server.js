require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const {
    initDb,
    getState,
    saveState,
    ensureCafeStateRow,
    createTenant,
    getTenantByUsername,
    getTenantBySlug,
    listTenants,
    updateTenant,
    upsertQrToken,
    getTenantSlugForToken
} = require("./db");
const {
    readCookie,
    clearCookie,
    setPlatformSession,
    setTenantSession,
    requirePlatformAuth,
    requireTenantAuth,
    rateLimit
} = require("./auth");

// Gerekli env değişkenleri eksikse hemen dur — çalışma zamanında belirsiz
// bir şekilde bozulmak yerine net bir hata basıp çıkalım.
const REQUIRED_ENV = ["DATABASE_URL", "JWT_SECRET", "PLATFORM_ADMIN_USERNAME", "PLATFORM_ADMIN_PASSWORD_HASH"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
    console.error("Eksik ortam değişkenleri: " + missingEnv.join(", "));
    console.error(".env.example dosyasına bak. Platform admin şifre hash'i için: node hash-password.js \"sifren\"");
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 8080;

// Render gibi ters proxy arkasında gerçek istemci IP'sini X-Forwarded-For'dan
// okuyabilmek için gerekli.
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb" }));

function clientIp(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
}

// Admin, Ayarlar'dan "izin verilen IP" alanını doldururken kendi anlık IP'sini
// kolayca öğrenebilsin diye.
app.get("/api/my-ip", (req, res) => {
    res.json({ ip: clientIp(req) });
});

// Ana sayfa isteği. Müşteri QR'ından (?t=...) geliyorsa ve o masanın ait
// olduğu kafe "sadece kendi WiFi'si" kilidini açtıysa, istek izinli
// IP'den gelmiyorsa siparişe kapalı bir uyarı sayfası döner.
app.get("/", async (req, res) => {
    if (req.query.t) {
        try {
            const tenantSlug = await getTenantSlugForToken(req.query.t);
            if (tenantSlug) {
                const state = await getState(tenantSlug);
                const settings = (state && state.data && state.data.settings) || {};
                if (settings.customerOrderIpLock && settings.allowedIp) {
                    const ip = clientIp(req);
                    if (ip !== settings.allowedIp) {
                        return res
                            .status(403)
                            .send(
                                '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CafePOS</title></head>' +
                                '<body style="font-family:system-ui,sans-serif;background:#f3f6fa;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;text-align:center">' +
                                '<div style="max-width:420px"><div style="font-size:40px">📶</div><h2>Sadece Kafe WiFi\'sinden Sipariş</h2>' +
                                "<p style=\"color:#64748b\">Bu sipariş sayfasına yalnızca kafenin kendi WiFi ağına bağlıyken erişilebiliyor. Lütfen kafenin WiFi'sine bağlanıp tekrar dener misin?</p></div></body></html>"
                            );
                    }
                }
            }
        } catch (error) {
            console.error("IP kontrolü sırasında hata (izin veriliyor):", error);
        }
    }
    res.sendFile(path.join(__dirname, "CafePOS-Demo-v12.html"));
});

// ---------------------------------------------------------------------
// Platform (uygulama sahibi) girişi ve kiracı yönetimi
// ---------------------------------------------------------------------

app.post("/api/platform-login", rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: "missing_fields" });
        if (username !== process.env.PLATFORM_ADMIN_USERNAME) {
            return res.status(401).json({ error: "invalid_credentials" });
        }
        const ok = await bcrypt.compare(password, process.env.PLATFORM_ADMIN_PASSWORD_HASH);
        if (!ok) return res.status(401).json({ error: "invalid_credentials" });
        setPlatformSession(res);
        res.json({ ok: true });
    } catch (error) {
        console.error("Platform girişi hatası:", error);
        res.status(500).json({ error: "server_error" });
    }
});

app.post("/api/platform-logout", (req, res) => {
    clearCookie(res, "platform_session");
    res.json({ ok: true });
});

app.get("/api/platform/tenants", requirePlatformAuth, async (req, res) => {
    try {
        const tenants = await listTenants();
        res.json({ tenants });
    } catch (error) {
        console.error("Kiracı listesi hatası:", error);
        res.status(500).json({ error: "server_error" });
    }
});

app.post("/api/platform/tenants", requirePlatformAuth, async (req, res) => {
    try {
        const { name, slug, username, password, adminName, adminUsername, adminPassword } = req.body || {};
        if (!name || !slug || !username || !password || !adminName || !adminUsername || !adminPassword) {
            return res.status(400).json({ error: "missing_fields", message: "Tüm alanları doldurman gerekiyor." });
        }
        const cleanSlug = String(slug).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!cleanSlug) return res.status(400).json({ error: "invalid_slug", message: "Geçerli bir slug gir." });

        const passwordHash = await bcrypt.hash(password, 10);
        let tenant;
        try {
            tenant = await createTenant({ slug: cleanSlug, name, username, passwordHash });
        } catch (e) {
            if (e && e.code === "23505") {
                return res.status(409).json({ error: "already_exists", message: "Bu slug veya kullanıcı adı zaten kullanılıyor." });
            }
            throw e;
        }

        // Yeni kiracı TAMAMEN BOŞ başlar: tek admin kullanıcı, boş menü/masa.
        // ensureCafeStateRow satır zaten varsa DOKUNMAZ — nare-kafe gibi
        // mevcut, dolu bir kafenin geçişinde bu satırın hiç değişmemesi şart.
        await ensureCafeStateRow(cleanSlug, {
            users: [{ id: 1, name: adminName, username: adminUsername, password: adminPassword, role: "ADMIN", active: true }],
            tables: [],
            cats: [],
            modifiers: [],
            stock: [],
            orders: [],
            nextOrder: 1,
            nextProduct: 1000,
            nextModifier: 1,
            nextStock: 1,
            audit: [],
            settings: {},
            staffV6: true
        });

        res.json({ ok: true, tenant });
    } catch (error) {
        console.error("Kiracı oluşturma hatası:", error);
        res.status(500).json({ error: "server_error" });
    }
});

app.patch("/api/platform/tenants/:slug", requirePlatformAuth, async (req, res) => {
    try {
        const { name, username, password, active } = req.body || {};
        const fields = {};
        if (name !== undefined) fields.name = name;
        if (username !== undefined) fields.username = username;
        if (active !== undefined) fields.active = !!active;
        if (password) fields.passwordHash = await bcrypt.hash(password, 10);
        const updated = await updateTenant(req.params.slug, fields);
        if (!updated) return res.status(404).json({ error: "not_found" });
        res.json({ ok: true, tenant: updated });
    } catch (error) {
        console.error("Kiracı güncelleme hatası:", error);
        res.status(500).json({ error: "server_error" });
    }
});

// Bir kafenin personel listesine admin ekler ya da (kullanıcı adı zaten
// varsa) mevcut hesabı admin yapıp şifresini değiştirir. "Kilitli kalmış"
// bir kafeye (örn. kurulurken admin bilgileri unutulmuş/yanlış girilmiş)
// platform sahibinin müdahale edebilmesi için — kurtarma amaçlı.
app.post("/api/platform/tenants/:slug/reset-admin", requirePlatformAuth, async (req, res) => {
    try {
        const { name, username, password } = req.body || {};
        if (!name || !username || !password) return res.status(400).json({ error: "missing_fields" });
        const slug = req.params.slug;
        const state = await getState(slug);
        if (!state) return res.status(404).json({ error: "not_found" });
        const data = state.data;
        if (!Array.isArray(data.users)) data.users = [];
        const existing = data.users.find((u) => u.username === username);
        if (existing) {
            existing.name = name;
            existing.password = password;
            existing.role = "ADMIN";
            existing.active = true;
        } else {
            const nextId = Math.max(0, ...data.users.map((u) => Number(u.id) || 0)) + 1;
            data.users.push({ id: nextId, name, username, password, role: "ADMIN", active: true });
        }
        const newVersion = await saveState(data, state.version, slug);
        if (newVersion === null) {
            return res.status(409).json({ error: "conflict", message: "Az önce başka bir işlem oldu, tekrar dener misin?" });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error("Admin sıfırlama hatası:", error);
        res.status(500).json({ error: "server_error" });
    }
});

// ---------------------------------------------------------------------
// Kafe (kiracı) girişi
// ---------------------------------------------------------------------

app.post("/api/tenant-login", rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: "missing_fields" });
        const tenant = await getTenantByUsername(username);
        if (!tenant || !tenant.active) return res.status(401).json({ error: "invalid_credentials" });
        const ok = await bcrypt.compare(password, tenant.password_hash);
        if (!ok) return res.status(401).json({ error: "invalid_credentials" });
        setTenantSession(res, tenant.slug);
        res.json({ ok: true, name: tenant.name });
    } catch (error) {
        console.error("Kafe girişi hatası:", error);
        res.status(500).json({ error: "server_error" });
    }
});

app.post("/api/tenant-logout", (req, res) => {
    clearCookie(res, "tenant_session");
    res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Personel/işletme verisi — artık kiracı oturumu şart
// ---------------------------------------------------------------------

// Ortak veriyi getir — veriyle birlikte __v (sürüm numarası) da gönderilir
app.get("/api/state", requireTenantAuth, async (req, res) => {
    try {
        const state = await getState(req.tenantSlug);
        const tenant = await getTenantBySlug(req.tenantSlug);
        const tenantName = tenant ? tenant.name : "";
        if (!state) return res.json({ initialized: false, __v: 0, __tenantName: tenantName });
        res.json({ ...state.data, __v: state.version, __tenantName: tenantName });
    } catch (error) {
        console.error("Veri okuma hatası:", error);
        res.status(500).json({
            error: "Veri okunamadı."
        });
    }
});

// Ortak veriyi kaydet — istekle birlikte gelen __v, veritabanındaki güncel
// sürümle eşleşmiyorsa (arada başka biri güncellemişse) 409 döner ve
// hiçbir şeyin üzerine yazılmaz.
app.post("/api/state", requireTenantAuth, async (req, res) => {
    try {
        const { __v, __tenantName, ...data } = req.body;
        const expectedVersion = Number(__v) || 0;
        const newVersion = await saveState(data, expectedVersion, req.tenantSlug);

        if (newVersion === null) {
            return res.status(409).json({
                error: "conflict",
                message: "Veri başka biri tarafından güncellendi."
            });
        }

        if (Array.isArray(data.tables)) {
            for (const t of data.tables) {
                if (t && t.qrToken) await upsertQrToken(t.qrToken, req.tenantSlug);
            }
        }

        res.json({
            ok: true,
            __v: newVersion
        });
    } catch (error) {
        console.error("Veri kaydetme hatası:", error);
        res.status(500).json({
            error: "Veri kaydedilemedi."
        });
    }
});

// Barista fişi
app.post("/api/print/barista", requireTenantAuth, (req, res) => {
    console.log(
        `BARISTA FİŞİ [${req.tenantSlug}]:`,
        JSON.stringify(req.body, null, 2)
    );

    res.json({
        ok: true
    });
});

// ---------------------------------------------------------------------
// Müşteri self-servis (QR) — kimlik doğrulama yok, sadece masa token'ı.
// Personel tarafındaki /api/state'ten tamamen ayrı: token'dan kiracıyı
// bulup sadece o kiracının verisiyle konuşur.
// ---------------------------------------------------------------------

app.get("/api/customer/state", async (req, res) => {
    try {
        const t = req.query.t;
        if (!t) return res.status(400).json({ error: "missing_token" });
        const tenantSlug = await getTenantSlugForToken(t);
        if (!tenantSlug) return res.status(404).json({ error: "not_found" });
        const state = await getState(tenantSlug);
        if (!state) return res.status(404).json({ error: "not_found" });
        res.json({ ...state.data, __v: state.version });
    } catch (error) {
        console.error("Müşteri veri okuma hatası:", error);
        res.status(500).json({ error: "Veri okunamadı." });
    }
});

app.post("/api/customer/order", async (req, res) => {
    try {
        const { t, __v, ...data } = req.body || {};
        if (!t) return res.status(400).json({ error: "missing_token" });
        const tenantSlug = await getTenantSlugForToken(t);
        if (!tenantSlug) return res.status(404).json({ error: "not_found" });

        // Gönderilen veri hâlâ bu token'ı bir masada taşımalı — başka bir
        // kiracının verisini kaydetmeye çalışan sahte bir istek olmadığını
        // ucuz bir şekilde doğrular.
        const stillValid = Array.isArray(data.tables) && data.tables.some((tb) => tb && tb.qrToken === t);
        if (!stillValid) return res.status(403).json({ error: "invalid_token" });

        const expectedVersion = Number(__v) || 0;
        const newVersion = await saveState(data, expectedVersion, tenantSlug);
        if (newVersion === null) {
            return res.status(409).json({
                error: "conflict",
                message: "Veri başka biri tarafından güncellendi."
            });
        }

        for (const tb of data.tables) {
            if (tb && tb.qrToken) await upsertQrToken(tb.qrToken, tenantSlug);
        }

        res.json({ ok: true, __v: newVersion });
    } catch (error) {
        console.error("Müşteri sipariş kaydetme hatası:", error);
        res.status(500).json({ error: "Veri kaydedilemedi." });
    }
});

// Server — önce veritabanı bağlantısını/tabloyu hazırla, sonra dinlemeye başla
initDb()
    .then(() => {
        app.listen(PORT, "0.0.0.0", () => {
            console.log("");
            console.log("=================================");
            console.log("         CafePOS SERVER");
            console.log("=================================");
            console.log("");
            console.log(`Port: ${PORT}`);
            console.log("Veritabanı: PostgreSQL bağlantısı hazır (sürüm kontrollü kayıt aktif)");
            console.log("Çok kiracılı: aktif (platform/kafe girişi gerekiyor)");
            console.log("");
            console.log("Server çalışıyor...");
            console.log("");
        });
    })
    .catch((err) => {
        console.error("Veritabanına bağlanılamadı:", err);
        process.exit(1);
    });
