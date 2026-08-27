const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ใช้ค่านี้จาก .env ในโปรดักชันเสมอ (ที่นี่มีค่า default ไว้ให้รันตอน dev ได้ทันที)
const JWT_SECRET = process.env.JWT_SECRET || "tripmate-dev-secret-change-me";
const TOKEN_EXPIRES_IN = "30d";

async function hashPassword(plain) {
    return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

function signToken(user) {
    return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
        expiresIn: TOKEN_EXPIRES_IN,
    });
}

function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}

// Express middleware: ต้องแนบ "Authorization: Bearer <token>" มาด้วยเสมอ
function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบก่อนใช้งาน" });

    try {
        const payload = verifyToken(token);
        req.userId = payload.sub;
        req.username = payload.username;
        next();
    } catch (err) {
        res.status(401).json({ error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
    }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth };
