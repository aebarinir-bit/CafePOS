require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { initDb, saveState, pool } = require("./db");

async function main() {
    const filePath = path.join(__dirname, "cafepos-data.json");

    if (!fs.existsSync(filePath)) {
        console.error("cafepos-data.json bulunamadı — aktarılacak veri yok.");
        process.exit(1);
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);

    await initDb();
    await saveState(data);

    console.log("cafepos-data.json içeriği Postgres'e aktarıldı:");
    console.log(`  - ${data.users?.length || 0} kullanıcı`);
    console.log(`  - ${data.tables?.length || 0} masa`);
    console.log(`  - ${data.orders?.length || 0} sipariş`);
    console.log(`  - ${data.audit?.length || 0} audit kaydı`);

    await pool.end();
}

main().catch((err) => {
    console.error("Aktarım hatası:", err);
    process.exit(1);
});
