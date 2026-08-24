require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const dbConn = require("./db");
const store = require("./db/store");

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

// ---------------------------------------------------------------------
// REST API — จัดการทริป / สมาชิก / สวิตช์แชร์ตำแหน่ง (เก็บลง PostgreSQL จริง)
// (คนหนึ่งคนมี deviceId ถาวรที่เก็บไว้ในเบราว์เซอร์ เพื่อให้เข้าได้หลายทริปพร้อมกัน)
// ---------------------------------------------------------------------

// คืนรายการทริปทั้งหมดที่ device นี้เข้าร่วม (ทั้งเปิดและปิด)
app.post(
    "/api/whoami",
    ah(async (req, res) => {
        const { userId, name } = req.body || {};
        if (!userId || !name) return res.status(400).json({ error: "ต้องระบุ userId และ name" });
        const trips = await store.getDeviceTrips(userId);
        res.json({ trips });
    })
);

// สร้างทริปใหม่
app.post(
    "/api/trips",
    ah(async (req, res) => {
        const { userId, name, tripName } = req.body || {};
        if (!userId || !tripName) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

        const trip = await store.createTrip(
            String(tripName).trim().slice(0, 40) || "ทริปใหม่",
            userId,
            String(name || "Guest").trim().slice(0, 24) || "Guest"
        );
        res.json({ trip });
    })
);

// เข้าร่วมทริปด้วยรหัสเชิญ (คนเดิมเข้าได้หลายทริปพร้อมกัน)
app.post(
    "/api/trips/join",
    ah(async (req, res) => {
        const { userId, name, code } = req.body || {};
        if (!userId || !code) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

        const tripId = String(code).trim().toUpperCase();
        const trip = await store.getTrip(tripId);
        if (!trip) return res.status(404).json({ error: "ไม่พบทริปนี้ ตรวจสอบรหัสอีกครั้ง" });

        await store.addMember(tripId, userId, String(name || "Guest").trim().slice(0, 24) || "Guest");
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
        res.json({ trip, members: await store.getTripMembers(tripId) });
    })
);

// เปิด/ปิดทริป (ทริปเก่า/ปิดแล้ว = ไม่รับ-ไม่ส่ง GPS อีกต่อไป)
app.patch(
    "/api/trips/:tripId/active",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        const { userId, isActive } = req.body || {};
        const trip = await store.getTrip(tripId);
        if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
        if (!(await store.isMember(tripId, userId)))
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
        const { userId, enabled } = req.body || {};
        const trip = await store.getTrip(tripId);
        if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
        if (!(await store.isMember(tripId, userId)))
            return res.status(403).json({ error: "ไม่ใช่สมาชิกทริปนี้" });

        await store.setMemberShare(tripId, userId, !!enabled);
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
// Socket.io — แยกห้องตามทริป (trip:<id>) เพื่อไม่ให้ตำแหน่งรั่วข้ามทริป
// ---------------------------------------------------------------------
io.on("connection", (socket) => {
    let currentTripId = null;
    let currentUserId = null;

    // เข้าห้องของทริปที่กำลังดู (ออกจากห้องเดิมก่อนถ้ามี) — ทำให้สลับดูหลายทริปได้
    socket.on("join-trip", async ({ tripId, userId }) => {
        try {
            if (!tripId || !userId || !(await store.isMember(tripId, userId))) return;

            if (currentTripId) socket.leave(`trip:${currentTripId}`);
            currentTripId = tripId;
            currentUserId = userId;
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
        currentUserId = null;
    });

    // รับพิกัด GPS — บันทึกและกระจายเฉพาะเมื่อ "ทริปเปิดอยู่" และ "ผู้ใช้เปิดแชร์ในทริปนี้"
    socket.on("send-location", async ({ tripId, lat, lng }) => {
        try {
            if (!tripId || !currentUserId || tripId !== currentTripId) return;

            const trip = await store.getTrip(tripId);
            if (!trip || !trip.is_active) return; // ทริปเก่า/ปิดแล้ว -> ไม่รับ GPS อีก

            const members = await store.getTripMembers(tripId);
            const me = members.find((m) => m.id === currentUserId);
            if (!me || !me.share_enabled) return; // ผู้ใช้ปิดสวิตช์แชร์ในทริปนี้เอง

            await store.updateLocation(tripId, currentUserId, lat, lng);
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
                    "[db] DATABASE_URL ยังไม่ถูกตั้งค่า — ฟีเจอร์ทริป/DB จะใช้งานไม่ได้ จนกว่าจะตั้งค่าใน .env แล้วรีสตาร์ท"
                );
            }
        });
    });
