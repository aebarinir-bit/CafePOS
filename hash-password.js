// Tek seferlik yardımcı: platform admin şifresinin bcrypt hash'ini üretir.
// Kullanım: node hash-password.js "şifren"
// Çıkan değeri Render'daki PLATFORM_ADMIN_PASSWORD_HASH env değişkenine yapıştır.
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
    console.error('Kullanım: node hash-password.js "şifren"');
    process.exit(1);
}

console.log(bcrypt.hashSync(password, 10));
