const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const store = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// REST API — จัดการทริป / สมาชิก / สวิตช์แชร์ตำแหน่ง
// (คนหนึ่งคนมี userId ถาวรที่เก็บไว้ในเบราว์เซอร์ เพื่อให้เข้าได้หลายทริปพร้อมกัน)
// ---------------------------------------------------------------------

// สร้าง/อัปเดตผู้ใช้ แล้วคืนรายการทริปทั้งหมดที่ผู้ใช้อยู่ (ทั้งเปิดและปิด)
app.post("/api/whoami", (req, res) => {
    const { userId, name } = req.body || {};
    if (!userId || !name) return res.status(400).json({ error: "ต้องระบุ userId และ name" });

    store.upsertUser(userId, String(name).trim().slice(0, 24) || "Guest");
    const trips = store.getUserTrips(userId);
    res.json({ trips });
});

// สร้างทริปใหม่
app.post("/api/trips", (req, res) => {
    const { userId, name, tripName } = req.body || {};
    if (!userId || !tripName) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

    store.upsertUser(userId, name);
    const trip = store.createTrip(String(tripName).trim().slice(0, 40) || "ทริปใหม่", userId);
    res.json({ trip });
});

// เข้าร่วมทริปด้วยรหัสเชิญ (คนเดิมเข้าได้หลายทริปพร้อมกัน)
app.post("/api/trips/join", (req, res) => {
    const { userId, name, code } = req.body || {};
    if (!userId || !code) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

    store.upsertUser(userId, name);
    const trip = store.getTripByCode(code);
    if (!trip) return res.status(404).json({ error: "ไม่พบทริปนี้ ตรวจสอบรหัสอีกครั้ง" });

    store.addMember(trip.id, userId);
    res.json({ trip: store.getTrip(trip.id) });
});

// รายชื่อสมาชิก + พิกัดล่าสุดในทริป (ใช้ตอนเปิดแผนที่ครั้งแรก)
app.get("/api/trips/:tripId/members", (req, res) => {
    const { tripId } = req.params;
    const trip = store.getTrip(tripId);
    if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
    res.json({ trip, members: store.getTripMembers(tripId) });
});

// เปิด/ปิดทริป (ทริปเก่า/ปิดแล้ว = ไม่รับ-ไม่ส่ง GPS อีกต่อไป)
app.patch("/api/trips/:tripId/active", (req, res) => {
    const { tripId } = req.params;
    const { userId, isActive } = req.body || {};
    const trip = store.getTrip(tripId);
    if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
    if (!store.isMember(tripId, userId)) return res.status(403).json({ error: "ไม่ใช่สมาชิกทริปนี้" });

    const updated = store.setTripActive(tripId, !!isActive);
    io.to(`trip:${tripId}`).emit("trip-active-changed", { tripId, isActive: !!updated.is_active });
    res.json({ trip: updated });
});

// เปิด/ปิดสวิตช์แชร์ตำแหน่งของ "ฉัน" เฉพาะในทริปนี้ (แยกอิสระต่อทริป)
app.patch("/api/trips/:tripId/share", (req, res) => {
    const { tripId } = req.params;
    const { userId, enabled } = req.body || {};
    const trip = store.getTrip(tripId);
    if (!trip) return res.status(404).json({ error: "ไม่พบทริป" });
    if (!store.isMember(tripId, userId)) return res.status(403).json({ error: "ไม่ใช่สมาชิกทริปนี้" });

    store.setMemberShare(tripId, userId, !!enabled);
    io.to(`trip:${tripId}`).emit("users-location", { trip, members: store.getTripMembers(tripId) });
    res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Socket.io — แยกห้องตามทริป (trip:<id>) เพื่อไม่ให้ตำแหน่งรั่วข้ามทริป
// ---------------------------------------------------------------------
io.on("connection", (socket) => {
    let currentTripId = null;
    let currentUserId = null;

    // เข้าห้องของทริปที่กำลังดู (ออกจากห้องเดิมก่อนถ้ามี) — ทำให้สลับดูหลายทริปได้
    socket.on("join-trip", ({ tripId, userId }) => {
        if (!tripId || !userId || !store.isMember(tripId, userId)) return;

        if (currentTripId) socket.leave(`trip:${currentTripId}`);
        currentTripId = tripId;
        currentUserId = userId;
        socket.join(`trip:${tripId}`);

        const trip = store.getTrip(tripId);
        socket.emit("users-location", { trip, members: store.getTripMembers(tripId) });
    });

    socket.on("leave-trip", () => {
        if (currentTripId) socket.leave(`trip:${currentTripId}`);
        currentTripId = null;
        currentUserId = null;
    });

    // รับพิกัด GPS — บันทึกและกระจายเฉพาะเมื่อ "ทริปเปิดอยู่" และ "ผู้ใช้เปิดแชร์ในทริปนี้"
    socket.on("send-location", ({ tripId, lat, lng }) => {
        if (!tripId || !currentUserId || tripId !== currentTripId) return;

        const trip = store.getTrip(tripId);
        if (!trip || !trip.is_active) return; // ทริปเก่า/ปิดแล้ว -> ไม่รับ GPS อีก

        const members = store.getTripMembers(tripId);
        const me = members.find((m) => m.id === currentUserId);
        if (!me || !me.share_enabled) return; // ผู้ใช้ปิดสวิตช์แชร์ในทริปนี้เอง

        store.updateLocation(tripId, currentUserId, lat, lng);
        io.to(`trip:${tripId}`).emit("users-location", {
            trip,
            members: store.getTripMembers(tripId),
        });
    });

    socket.on("disconnect", () => {
        if (currentTripId) socket.leave(`trip:${currentTripId}`);
    });
});

server.listen(PORT, () => {
    console.log(`Server running : http://localhost:${PORT}`);
});
