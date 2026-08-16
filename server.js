const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));

const DATA_FILE = path.join(__dirname, "cafepos-data.json");

// Veri dosyası yoksa oluştur
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify({ initialized: false }, null, 2),
        "utf8"
    );
}

// CafePOS dosyalarını yayınla
app.use(express.static(__dirname));app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "CafePOS-Demo-v12.html"));
});


// =====================================================
// ORTAK VERİYİ GETİR
// =====================================================

app.get("/api/state", (req, res) => {
    try {
        const data = fs.readFileSync(DATA_FILE, "utf8");
        const state = JSON.parse(data);

        /*
         * Server henüz gerçek CafePOS verisi almamışsa
         * initialized:false gönderiyoruz.
         *
         * CafePOS HTML'i null aldığında kendi içindeki
         * başlangıç/default verilerini kullanmaya devam edecek.
         *
         * Böylece kullanıcılar, ürünler, masalar vb.
         * ilk açılışta kaybolmayacak.
         */
        if (!state || state.initialized === false) {
            return res.json(null);
        }

        res.json(state);

    } catch (error) {
        console.error("Veri okuma hatası:", error);

        res.status(500).json({
            error: "Veri okunamadı."
        });
    }
});


// =====================================================
// ORTAK VERİYİ KAYDET
// =====================================================

app.post("/api/state", (req, res) => {
    try {
        const state = req.body;

        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(state, null, 2),
            "utf8"
        );

        console.log("CafePOS verisi kaydedildi.");

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


// =====================================================
// BARISTA FİŞİ
// =====================================================

app.post("/api/print/barista", (req, res) => {

    console.log("");
    console.log("=================================");
    console.log("        BARISTA FİŞİ");
    console.log("=================================");

    console.log(
        JSON.stringify(req.body, null, 2)
    );

    console.log("=================================");
    console.log("");

    res.json({
        ok: true
    });
});


// =====================================================
// SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {

    console.log("");
    console.log("=================================");
    console.log("         CafePOS SERVER");
    console.log("=================================");
    console.log("");

    console.log(
        `Local:   http://localhost:${PORT}`
    );

    console.log(
        `Network: http://192.168.1.33:${PORT}`
    );

    console.log("");

    console.log("Server çalışıyor...");
    console.log("");
});
