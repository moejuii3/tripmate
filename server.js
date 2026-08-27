require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const dbConn = require("./db");
const store = require("./db/store");
const { hashPassword, verifyPassword, signToken, verifyToken, requireAuth } = require("./auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ครอบ route handler แบบ async ให้ error หลุดไปที่ Express error handler แทนที่จะทำให้เซิร์ฟเวอร์ค้าง
function ah(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function validUsername(u) {
    return typeof u === "string" && /^[a-zA-Z0-9_.]{3,20}$/.test(u);
}

// ---------------------------------------------------------------------
// Auth — สมัครสมาชิก / เข้าสู่ระบบ (username + password, เก็บรหัสผ่านแบบ bcrypt hash)
// ---------------------------------------------------------------------
app.post(
    "/api/auth/register",
    ah(async (req, res) => {
        const { username, password } = req.body || {};
        if (!validUsername(username)) {
            return res.status(400).json({
                error: "ชื่อผู้ใช้ต้องมี 3-20 ตัวอักษร (a-z, 0-9, _ , .)",
            });
        }
        if (typeof password !== "string" || password.length < 6) {
            return res.status(400).json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
        }

        const passwordHash = await hashPassword(password);
        const user = await store.createUser(username, passwordHash);
        const token = signToken(user);
        res.json({ token, user });
    })
);

app.post(
    "/api/auth/login",
    ah(async (req, res) => {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: "กรอกชื่อผู้ใช้และรหัสผ่าน" });

        const user = await store.findUserByUsername(username);
        if (!user) return res.status(401).json({ error: "ไม่พบชื่อผู้ใช้นี้ หรือรหัสผ่านไม่ถูกต้อง" });

        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: "ไม่พบชื่อผู้ใช้นี้ หรือรหัสผ่านไม่ถูกต้อง" });

        const token = signToken(user);
        res.json({ token, user: { id: user.id, username: user.username } });
    })
);

app.get(
    "/api/auth/me",
    requireAuth,
    ah(async (req, res) => {
        const user = await store.findUserById(req.userId);
        if (!user) return res.status(401).json({ error: "ไม่พบบัญชีนี้แล้ว" });
        res.json({ user });
    })
);

// ---------------------------------------------------------------------
// REST API — จัดการทริป / สมาชิก / สวิตช์แชร์ตำแหน่ง (ต้องล็อกอินก่อนทุก endpoint)
// ผู้ใช้หนึ่งบัญชีเข้าได้หลายทริปพร้อมกัน — ตัวตนอ้างอิงจาก JWT เสมอ ไม่รับ userId จาก client
// ---------------------------------------------------------------------
app.use("/api/trips", requireAuth);
app.use("/api/whoami", requireAuth);

// คืนรายการทริปทั้งหมดที่บัญชีนี้เข้าร่วม (ทั้งเปิดและปิด)
app.post(
    "/api/whoami",
    ah(async (req, res) => {
        const trips = await store.getUserTrips(req.userId);
        res.json({ trips });
    })
);

// สร้างทริปใหม่
app.post(
    "/api/trips",
    ah(async (req, res) => {
        const { tripName } = req.body || {};
        if (!tripName) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

        const trip = await store.createTrip(
            String(tripName).trim().slice(0, 40) || "ทริปใหม่",
            req.userId,
            req.username
        );
        res.json({ trip });
    })
);

// เข้าร่วมทริปด้วยรหัสเชิญ (คนเดิมเข้าได้หลายทริปพร้อมกัน)
app.post(
    "/api/trips/join",
    ah(async (req, res) => {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

        const tripId = String(code).trim().toUpperCase();
        const trip = await store.getTrip(tripId);
        if (!trip) return res.status(404).json({ error: "ไม่พบทริปนี้ ตรวจสอบรหัสอีกครั้ง" });

        await store.addMember(tripId, req.userId, req.username);
        res.json({ trip: await store.getTrip(tripId) });
    })
);

// รายชื่อสมาชิก + พิกัดล่าสุดในทริป (ใช้ตอนเปิดแผนที่ครั้งแรก)
app.get(
    "/api/trips/:tripId/members",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        const trip = await store.getTrip(tripId);
        if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
        if (!(await store.isMember(tripId, req.userId)))
            return res.status(403).json({ error: "ไม่ใช่สมาชิกทริปนี้" });
        res.json({ trip, members: await store.getTripMembers(tripId) });
    })
);

// เปิด/ปิดทริป (ทริปเก่า/ปิดแล้ว = ไม่รับ-ไม่ส่ง GPS อีกต่อไป)
app.patch(
    "/api/trips/:tripId/active",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        const { isActive } = req.body || {};
        const trip = await store.getTrip(tripId);
        if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
        if (!(await store.isMember(tripId, req.userId)))
            return res.status(403).json({ error: "ไม่ใช่สมาชิกทริปนี้" });

        const updated = await store.setTripActive(tripId, !!isActive);
        io.to(`trip:${tripId}`).emit("trip-active-changed", { tripId, isActive: !!updated.is_active });
        res.json({ trip: updated });
    })
);

// เปิด/ปิดสวิตช์แชร์ตำแหน่งของ "ฉัน" เฉพาะในทริปนี้ (แยกอิสระต่อทริป)
app.patch(
    "/api/trips/:tripId/share",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        const { enabled } = req.body || {};
        const trip = await store.getTrip(tripId);
        if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
        if (!(await store.isMember(tripId, req.userId)))
            return res.status(403).json({ error: "ไม่ใช่สมาชิกทริปนี้" });

        await store.setMemberShare(tripId, req.userId, !!enabled);
        io.to(`trip:${tripId}`).emit("users-location", {
            trip,
            members: await store.getTripMembers(tripId),
        });
        res.json({ ok: true });
    })
);

// Error handler กลาง — กันเซิร์ฟเวอร์ล่ม และตอบข้อความที่เข้าใจง่ายกลับไปแทน stack trace
app.use((err, req, res, next) => {
    console.error("[api] Error:", err.message);
    res.status(err.status || 500).json({ error: err.message || "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
});

// ---------------------------------------------------------------------
// Socket.io — ยืนยันตัวตนด้วย JWT ตอนเชื่อมต่อ + แยกห้องตามทริป (trip:<id>)
// ---------------------------------------------------------------------
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error("unauthorized"));
        const payload = verifyToken(token);
        socket.userId = payload.sub;
        socket.username = payload.username;
        next();
    } catch (err) {
        next(new Error("unauthorized"));
    }
});

io.on("connection", (socket) => {
    let currentTripId = null;

    // เข้าห้องของทริปที่กำลังดู (ออกจากห้องเดิมก่อนถ้ามี) — ทำให้สลับดูหลายทริปได้
    socket.on("join-trip", async ({ tripId }) => {
        try {
            if (!tripId || !(await store.isMember(tripId, socket.userId))) return;

            if (currentTripId) socket.leave(`trip:${currentTripId}`);
            currentTripId = tripId;
            socket.join(`trip:${tripId}`);

            const trip = await store.getTrip(tripId);
            socket.emit("users-location", { trip, members: await store.getTripMembers(tripId) });
        } catch (err) {
            console.error("[socket] join-trip error:", err.message);
        }
    });

    socket.on("leave-trip", () => {
        if (currentTripId) socket.leave(`trip:${currentTripId}`);
        currentTripId = null;
    });

    // รับพิกัด GPS — บันทึกและกระจายเฉพาะเมื่อ "ทริปเปิดอยู่" และ "ผู้ใช้เปิดแชร์ในทริปนี้"
    socket.on("send-location", async ({ tripId, lat, lng }) => {
        try {
            if (!tripId || tripId !== currentTripId) return;

            const trip = await store.getTrip(tripId);
            if (!trip || !trip.is_active) return; // ทริปเก่า/ปิดแล้ว -> ไม่รับ GPS อีก

            const members = await store.getTripMembers(tripId);
            const me = members.find((m) => m.id === socket.userId);
            if (!me || !me.share_enabled) return; // ผู้ใช้ปิดสวิตช์แชร์ในทริปนี้เอง

            await store.updateLocation(tripId, socket.userId, lat, lng);
            io.to(`trip:${tripId}`).emit("users-location", {
                trip,
                members: await store.getTripMembers(tripId),
            });
        } catch (err) {
            console.error("[socket] send-location error:", err.message);
        }
    });

    socket.on("disconnect", () => {
        if (currentTripId) socket.leave(`trip:${currentTripId}`);
    });
});

// ---------------------------------------------------------------------
// เริ่มระบบ: เชื่อมต่อ + สร้างตารางใน PostgreSQL ก่อน แล้วค่อยเปิดพอร์ต
// ---------------------------------------------------------------------
dbConn
    .init()
    .catch((err) => {
        console.error("[db] เชื่อมต่อฐานข้อมูลไม่สำเร็จ:", err.message);
    })
    .finally(() => {
        server.listen(PORT, () => {
            console.log(`Server running : http://localhost:${PORT}`);
            if (!dbConn.isEnabled()) {
                console.warn(
                    "[db] DATABASE_URL ยังไม่ถูกตั้งค่า — ฟีเจอร์สมัคร/เข้าสู่ระบบและทริปจะใช้งานไม่ได้ จนกว่าจะตั้งค่าใน .env แล้วรีสตาร์ท"
                );
            }
        });
    });
