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

// Ortak veriyi getir
app.get("/api/state", async (req, res) => {
    try {
        const data = await getState();
        res.json(data || { initialized: false });
    } catch (error) {
        console.error("Veri okuma hatası:", error);
        res.status(500).json({
            error: "Veri okunamadı."
        });
    }
});

// Ortak veriyi kaydet
app.post("/api/state", async (req, res) => {
    try {
        await saveState(req.body);
        res.json({
            ok: true
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
            console.log("Veritabanı: PostgreSQL bağlantısı hazır");
            console.log("");
            console.log("Server çalışıyor...");
            console.log("");
        });
    })
    .catch((err) => {
        console.error("Veritabanına bağlanılamadı:", err);
        process.exit(1);
    });
