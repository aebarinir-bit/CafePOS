require("dotenv").config();

const express = require("express");
const path = require("path");
const { initDb, getState, saveState } = require("./db");

const app = express();
const PORT = process.env.PORT || 8080;

// Render gibi ters proxy arkasında gerçek istemci IP'sini X-Forwarded-For'dan
// okuyabilmek için gerekli.
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb" }));

// CafePOS dosyalarını yayınla
app.use(express.static(__dirname));

function clientIp(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
}

// Admin, Ayarlar'dan "izin verilen IP" alanını doldururken kendi anlık IP'sini
// kolayca öğrenebilsin diye.
app.get("/api/my-ip", (req, res) => {
    res.json({ ip: clientIp(req) });
});

// Ana sayfa isteği. Müşteri QR'ından (?t=...) geliyorsa ve admin "sadece
// kafenin WiFi'si" kilidini açtıysa, istek kafenin izinli IP'sinden
// gelmiyorsa siparişe kapalı bir uyarı sayfası döner.
app.get("/", async (req, res) => {
    if (req.query.t) {
        try {
            const state = await getState();
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
        } catch (error) {
            console.error("IP kontrolü sırasında hata (izin veriliyor):", error);
        }
    }
    res.sendFile(path.join(__dirname, "CafePOS-Demo-v12.html"));
});

// Ortak veriyi getir — veriyle birlikte __v (sürüm numarası) da gönderilir
app.get("/api/state", async (req, res) => {
    try {
        const state = await getState();
        if (!state) return res.json({ initialized: false, __v: 0 });
        res.json({ ...state.data, __v: state.version });
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
app.post("/api/state", async (req, res) => {
    try {
        const { __v, ...data } = req.body;
        const expectedVersion = Number(__v) || 0;
        const newVersion = await saveState(data, expectedVersion);

        if (newVersion === null) {
            return res.status(409).json({
                error: "conflict",
                message: "Veri başka biri tarafından güncellendi."
            });
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
app.post("/api/print/barista", (req, res) => {
    console.log(
        "BARISTA FİŞİ:",
        JSON.stringify(req.body, null, 2)
    );

    res.json({
        ok: true
    });
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
            console.log("");
            console.log("Server çalışıyor...");
            console.log("");
        });
    })
    .catch((err) => {
        console.error("Veritabanına bağlanılamadı:", err);
        process.exit(1);
    });
