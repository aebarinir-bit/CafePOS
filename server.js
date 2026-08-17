require("dotenv").config();

const express = require("express");
const path = require("path");
const { initDb, getState, saveState } = require("./db");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "10mb" }));

// CafePOS dosyalarını yayınla
app.use(express.static(__dirname));

// Ana sayfa isteğini CafePOS dosyasına yönlendir
app.get("/", (req, res) => {
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
