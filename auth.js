const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

function signToken(payload, expiresIn = "30d") {
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// req.headers.cookie'yi elle ayrıştırır (cookie-parser paketi gerekmiyor,
// tek satırlık bir iş).
function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    const parts = header.split(";");
    for (const part of parts) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return null;
}

function setCookie(res, name, value, maxAgeMs) {
    const isProd = process.env.NODE_ENV === "production";
    let cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
    if (isProd) cookie += "; Secure";
    res.append("Set-Cookie", cookie);
}

function clearCookie(res, name) {
    res.append("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function setPlatformSession(res) {
    setCookie(res, "platform_session", signToken({ platformAdmin: true }), THIRTY_DAYS_MS);
}

function setTenantSession(res, tenantSlug) {
    setCookie(res, "tenant_session", signToken({ tenantSlug }), THIRTY_DAYS_MS);
}

// Bir route handler'ı platform-admin oturumu şartıyla sarmalar.
function requirePlatformAuth(req, res, next) {
    const token = readCookie(req, "platform_session");
    const payload = token && verifyToken(token);
    if (!payload || !payload.platformAdmin) {
        return res.status(401).json({ error: "unauthorized" });
    }
    next();
}

// Bir route handler'ı kiracı oturumu şartıyla sarmalar; başarılıysa
// req.tenantSlug'ı doldurur.
function requireTenantAuth(req, res, next) {
    const token = readCookie(req, "tenant_session");
    const payload = token && verifyToken(token);
    if (!payload || !payload.tenantSlug) {
        return res.status(401).json({ error: "unauthorized" });
    }
    req.tenantSlug = payload.tenantSlug;
    next();
}

// Basit bellek-içi sabit pencereli rate limit — yeni paket gerektirmiyor.
// Login uçları için: aynı IP'den kısa sürede çok fazla denemeyi engeller.
const attempts = new Map();
function rateLimit({ windowMs = 60000, max = 10 } = {}) {
    return (req, res, next) => {
        const key = req.ip || "unknown";
        const now = Date.now();
        const entry = attempts.get(key);
        if (!entry || now - entry.start > windowMs) {
            attempts.set(key, { start: now, count: 1 });
            return next();
        }
        entry.count++;
        if (entry.count > max) {
            return res.status(429).json({ error: "too_many_requests", message: "Çok fazla deneme yaptın, biraz sonra tekrar dener misin?" });
        }
        next();
    };
}

module.exports = {
    signToken,
    verifyToken,
    readCookie,
    setCookie,
    clearCookie,
    setPlatformSession,
    setTenantSession,
    requirePlatformAuth,
    requireTenantAuth,
    rateLimit
};
