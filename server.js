require("dotenv").config();

const express = require("express");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ถ้าไม่มี GPS update เข้ามานานเกินนี้ (แม้ gps_enabled = true) ถือว่า "ขาดการเชื่อมต่อสัญญาณ"
const GPS_STALE_MS = 20_000;

// สีสำหรับ marker ของแต่ละคน วนใช้ตามลำดับผู้เข้าร่วม (ต่อทริป)
const COLORS = [
    "#ef4444", "#3b82f6", "#22c55e", "#f59e0b",
    "#a855f7", "#ec4899", "#14b8a6", "#eab308"
];

// ----------------------------------------------------------------
// สถานะเรียลไทม์ในหน่วยความจำ (ของจริงอยู่ใน Postgres เสมอ อันนี้ไว้ตอบเร็ว)
// tripsMemory[tripId] = { members: { [deviceId]: {...} }, colorIndex }
// socketIndex[socket.id] = { tripId, deviceId }  (ไว้จับตอน disconnect)
// ----------------------------------------------------------------
const tripsMemory = {};
const socketIndex = {};

function getTripMem(tripId) {
    if (!tripsMemory[tripId]) {
        tripsMemory[tripId] = { members: {}, colorIndex: 0 };
    }
    return tripsMemory[tripId];
}

function memberRowId(tripId, deviceId) {
    return `${tripId}:${deviceId}`;
}

// ข้อมูลสมาชิกที่จะส่งให้ client (คำนวณสถานะ online/gps ให้พร้อมใช้)
function serializeMember(m) {
    const now = Date.now();
    const isStale = !m.lastLocationAt || (now - m.lastLocationAt > GPS_STALE_MS);
    return {
        deviceId: m.deviceId,
        name: m.name,
        color: m.color,
        online: !!m.online,
        gpsEnabled: !!m.gpsEnabled,
        lat: m.lat,
        lng: m.lng,
        lastLocationAt: m.lastLocationAt,
        // gpsStale: ออนไลน์ + เปิด gps ไว้ แต่ไม่มีพิกัดใหม่เข้ามานาน -> "ขาดการเชื่อมต่อ"
        gpsStale: !!m.online && !!m.gpsEnabled && isStale,
    };
}

function broadcastMembers(tripId) {
    const mem = getTripMem(tripId);
    const list = Object.values(mem.members).map(serializeMember);
    io.to(tripId).emit("members-update", list);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function requireDb(req, res, next) {
    if (!db.isEnabled()) {
        return res.status(503).json({
            error: "Database not configured. Set DATABASE_URL to enable this feature.",
        });
    }
    next();
}

function makeTripCode() {
    // รหัสทริป 6 ตัวอักษร อ่านง่าย ไม่มีตัวที่สับสน (0/O, 1/I)
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += alphabet[crypto.randomInt(alphabet.length)];
    }
    return code;
}

/* =====================================================
   REST API: ทริป (Trips)
===================================================== */

// สร้างทริปใหม่ -> ได้รหัสทริปกลับมาไว้แชร์ให้เพื่อนกด join
app.post("/api/trips", requireDb, async (req, res) => {
    try {
        const name = (req.body?.name || "ทริปของฉัน").toString().trim().slice(0, 100) || "ทริปของฉัน";

        let id;
        for (let attempt = 0; attempt < 5; attempt++) {
            id = makeTripCode();
            const { rows } = await db.query(`SELECT 1 FROM trips WHERE id = $1`, [id]);
            if (rows.length === 0) break;
        }

        const { rows } = await db.query(
            `INSERT INTO trips (id, name) VALUES ($1, $2) RETURNING *`,
            [id, name]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error("[api] POST /api/trips failed:", err.message);
        res.status(500).json({ error: "Failed to create trip" });
    }
});

// ดูข้อมูลทริป (ไว้เช็คก่อน join ว่ารหัสมีจริงไหม / จบหรือยัง)
app.get("/api/trips/:id", requireDb, async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT * FROM trips WHERE id = $1`, [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: "Trip not found" });
        res.json(rows[0]);
    } catch (err) {
        console.error("[api] GET /api/trips/:id failed:", err.message);
        res.status(500).json({ error: "Failed to load trip" });
    }
});

// จบทริป -> ปิด GPS ของทุกคนในทริปนี้ "ถาวร" (แก้กลับไม่ได้)
app.post("/api/trips/:id/end", requireDb, async (req, res) => {
    try {
        const tripId = req.params.id;
        const { rows } = await db.query(
            `UPDATE trips SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING *`,
            [tripId]
        );
        if (!rows[0]) {
            const check = await db.query(`SELECT * FROM trips WHERE id = $1`, [tripId]);
            if (!check.rows[0]) return res.status(404).json({ error: "Trip not found" });
            return res.json(check.rows[0]); // จบไปแล้วก่อนหน้านี้ -> ตอบสถานะปัจจุบันเฉย ๆ
        }

        await db.query(`UPDATE members SET gps_enabled = false WHERE trip_id = $1`, [tripId]);

        const mem = getTripMem(tripId);
        Object.values(mem.members).forEach((m) => { m.gpsEnabled = false; });

        io.to(tripId).emit("trip-ended", rows[0]);
        broadcastMembers(tripId);

        res.json(rows[0]);
    } catch (err) {
        console.error("[api] POST /api/trips/:id/end failed:", err.message);
        res.status(500).json({ error: "Failed to end trip" });
    }
});

/* =====================================================
   REST API: กำหนดการเดินทาง (Itinerary) — ต่อทริป
===================================================== */
app.get("/api/trips/:tripId/itinerary", requireDb, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT * FROM itinerary_items WHERE trip_id = $1
             ORDER BY start_time ASC NULLS LAST, created_at ASC`,
            [req.params.tripId]
        );
        res.json(rows);
    } catch (err) {
        console.error("[api] GET itinerary failed:", err.message);
        res.status(500).json({ error: "Failed to load itinerary" });
    }
});

app.post("/api/trips/:tripId/itinerary", requireDb, async (req, res) => {
    try {
        const tripId = req.params.tripId;
        const { title, description, locationName, lat, lng, startTime, endTime, deviceId } = req.body || {};

        if (!title || !title.toString().trim()) {
            return res.status(400).json({ error: "title is required" });
        }

        const creatorId = deviceId ? memberRowId(tripId, deviceId) : null;
        const mem = getTripMem(tripId);
        const creator = deviceId ? mem.members[deviceId] : null;

        const { rows } = await db.query(
            `INSERT INTO itinerary_items
                (trip_id, title, description, location_name, lat, lng, start_time, end_time, created_by, created_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                tripId,
                title.toString().trim().slice(0, 200),
                description ? description.toString().slice(0, 2000) : null,
                locationName ? locationName.toString().slice(0, 200) : null,
                lat ?? null,
                lng ?? null,
                startTime || null,
                endTime || null,
                creatorId,
                creator ? creator.name : null,
            ]
        );

        const item = rows[0];
        io.to(tripId).emit("itinerary-created", item);
        res.status(201).json(item);
    } catch (err) {
        console.error("[api] POST itinerary failed:", err.message);
        res.status(500).json({ error: "Failed to create itinerary item" });
    }
});

app.put("/api/itinerary/:id", requireDb, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, locationName, lat, lng, startTime, endTime } = req.body || {};

        if (!title || !title.toString().trim()) {
            return res.status(400).json({ error: "title is required" });
        }

        const { rows } = await db.query(
            `UPDATE itinerary_items
             SET title = $1, description = $2, location_name = $3,
                 lat = $4, lng = $5, start_time = $6, end_time = $7
             WHERE id = $8
             RETURNING *`,
            [
                title.toString().trim().slice(0, 200),
                description ? description.toString().slice(0, 2000) : null,
                locationName ? locationName.toString().slice(0, 200) : null,
                lat ?? null,
                lng ?? null,
                startTime || null,
                endTime || null,
                id,
            ]
        );

        if (!rows[0]) return res.status(404).json({ error: "Item not found" });

        if (rows[0].trip_id) io.to(rows[0].trip_id).emit("itinerary-updated", rows[0]);
        res.json(rows[0]);
    } catch (err) {
        console.error("[api] PUT /api/itinerary/:id failed:", err.message);
        res.status(500).json({ error: "Failed to update itinerary item" });
    }
});

app.delete("/api/itinerary/:id", requireDb, async (req, res) => {
    try {
        const { id } = req.params;
        const { rows } = await db.query(`SELECT trip_id FROM itinerary_items WHERE id = $1`, [id]);
        const { rowCount } = await db.query(`DELETE FROM itinerary_items WHERE id = $1`, [id]);

        if (!rowCount) return res.status(404).json({ error: "Item not found" });

        if (rows[0]?.trip_id) io.to(rows[0].trip_id).emit("itinerary-deleted", { id });
        res.status(204).end();
    } catch (err) {
        console.error("[api] DELETE /api/itinerary/:id failed:", err.message);
        res.status(500).json({ error: "Failed to delete itinerary item" });
    }
});

/* =====================================================
   REST API: สมาชิก / ประวัติตำแหน่ง
===================================================== */
app.get("/api/trips/:tripId/members", requireDb, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, device_id, name, color, gps_enabled, current_lat, current_lng,
                    last_location_at, joined_at, last_seen
             FROM members WHERE trip_id = $1
             ORDER BY joined_at ASC`,
            [req.params.tripId]
        );
        res.json(rows);
    } catch (err) {
        console.error("[api] GET members failed:", err.message);
        res.status(500).json({ error: "Failed to load members" });
    }
});

app.get("/api/members/:id/history", requireDb, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT lat, lng, recorded_at
             FROM locations
             WHERE member_id = $1
             ORDER BY recorded_at ASC
             LIMIT 5000`,
            [req.params.id]
        );
        res.json(rows);
    } catch (err) {
        console.error("[api] GET history failed:", err.message);
        res.status(500).json({ error: "Failed to load location history" });
    }
});

/* =====================================================
   SOCKET.IO — realtime: join, toggle gps, send-location
===================================================== */
io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    // เข้าร่วมทริป — ต้องส่ง { tripId, deviceId, name }
    // deviceId เป็นรหัสอุปกรณ์ที่ client สุ่มเก็บไว้ครั้งแรก (คงอยู่แม้ปิดเปิดเบราว์เซอร์ใหม่)
    // ทำให้คนคนเดียวกันเข้าทริปเดิมซ้ำ (รีเฟรชหน้า/หลุดเน็ต) แล้วกลับมาเป็น "คนเดิม" ไม่ใช่สมาชิกใหม่
    socket.on("join-trip", async ({ tripId, deviceId, name } = {}) => {
        try {
            if (!tripId || !deviceId) {
                return socket.emit("join-error", { reason: "missing_fields" });
            }

            const tripRes = await db.query(`SELECT * FROM trips WHERE id = $1`, [tripId]);
            const trip = tripRes.rows[0];
            if (!trip) {
                return socket.emit("join-error", { reason: "not_found" });
            }

            const safeName = (name || "Guest").toString().trim().slice(0, 24) || "Guest";
            const mem = getTripMem(tripId);
            const isEnded = !!trip.ended_at;

            const existing = mem.members[deviceId];
            const color = existing ? existing.color : COLORS[mem.colorIndex % COLORS.length];
            if (!existing) mem.colorIndex++;

            mem.members[deviceId] = {
                deviceId,
                name: safeName,
                color,
                online: true,
                // ถ้าทริปจบไปแล้ว บังคับปิด GPS เสมอ ต่อให้เคยเปิดไว้
                gpsEnabled: isEnded ? false : (existing ? existing.gpsEnabled : true),
                lat: existing ? existing.lat : null,
                lng: existing ? existing.lng : null,
                lastLocationAt: existing ? existing.lastLocationAt : null,
            };

            socket.join(tripId);
            socketIndex[socket.id] = { tripId, deviceId };

            const rowId = memberRowId(tripId, deviceId);
            await db.query(
                `INSERT INTO members (id, trip_id, device_id, name, color, gps_enabled, joined_at, last_seen)
                 VALUES ($1, $2, $3, $4, $5, $6, now(), now())
                 ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name, last_seen = now()`,
                [rowId, tripId, deviceId, safeName, color, mem.members[deviceId].gpsEnabled]
            );

            // ดึงพิกัดล่าสุดที่เคยบันทึกไว้ในฐานข้อมูล (เผื่อ server รีสตาร์ทไปแล้วความจำหาย)
            const savedRes = await db.query(
                `SELECT current_lat, current_lng, last_location_at FROM members WHERE id = $1`,
                [rowId]
            );
            const saved = savedRes.rows[0];
            if (saved && mem.members[deviceId].lat == null && saved.current_lat != null) {
                mem.members[deviceId].lat = saved.current_lat;
                mem.members[deviceId].lng = saved.current_lng;
                mem.members[deviceId].lastLocationAt = saved.last_location_at
                    ? new Date(saved.last_location_at).getTime()
                    : null;
            }

            const itineraryRes = await db.query(
                `SELECT * FROM itinerary_items WHERE trip_id = $1
                 ORDER BY start_time ASC NULLS LAST, created_at ASC`,
                [tripId]
            );

            socket.emit("joined", {
                trip,
                me: serializeMember(mem.members[deviceId]),
                members: Object.values(mem.members).map(serializeMember),
                itinerary: itineraryRes.rows,
            });

            broadcastMembers(tripId);
        } catch (err) {
            console.error("[socket] join-trip failed:", err.message);
            socket.emit("join-error", { reason: "server_error" });
        }
    });

    // ผู้ใช้กดปุ่มเปิด/ปิด GPS ของตัวเอง
    // ปิดไม่ได้ถ้าทริปจบไปแล้ว (ปิดถาวรแบบเปิดกลับไม่ได้)
    socket.on("toggle-gps", async ({ enabled } = {}) => {
        const idx = socketIndex[socket.id];
        if (!idx) return;
        const { tripId, deviceId } = idx;

        try {
            const tripRes = await db.query(`SELECT ended_at FROM trips WHERE id = $1`, [tripId]);
            const isEnded = !!tripRes.rows[0]?.ended_at;

            const mem = getTripMem(tripId);
            const member = mem.members[deviceId];
            if (!member) return;

            const nextEnabled = isEnded ? false : !!enabled;
            member.gpsEnabled = nextEnabled;

            await db.query(
                `UPDATE members SET gps_enabled = $1, last_seen = now() WHERE id = $2`,
                [nextEnabled, memberRowId(tripId, deviceId)]
            );

            if (isEnded) {
                socket.emit("gps-locked", { reason: "trip_ended" });
            }

            broadcastMembers(tripId);
        } catch (err) {
            console.error("[socket] toggle-gps failed:", err.message);
        }
    });

    // รับพิกัดใหม่จาก client (ถูกส่งเฉพาะตอนเปิด GPS และทริปยังไม่จบ)
    socket.on("send-location", async ({ lat, lng } = {}) => {
        const idx = socketIndex[socket.id];
        if (!idx) return;
        const { tripId, deviceId } = idx;

        if (typeof lat !== "number" || typeof lng !== "number") return;

        const mem = getTripMem(tripId);
        const member = mem.members[deviceId];
        if (!member || !member.gpsEnabled) return; // เคารพสถานะปิด GPS / ทริปจบ เสมอ

        member.lat = lat;
        member.lng = lng;
        member.lastLocationAt = Date.now();

        broadcastMembers(tripId);

        if (db.isEnabled()) {
            try {
                const rowId = memberRowId(tripId, deviceId);
                await db.query(
                    `UPDATE members
                     SET current_lat = $1, current_lng = $2, last_location_at = now(), last_seen = now()
                     WHERE id = $3`,
                    [lat, lng, rowId]
                );
                await db.query(
                    `INSERT INTO locations (member_id, lat, lng) VALUES ($1, $2, $3)`,
                    [rowId, lat, lng]
                );
            } catch (err) {
                console.error("[db] Failed to save location:", err.message);
            }
        }
    });

    socket.on("disconnect", async () => {
        const idx = socketIndex[socket.id];
        delete socketIndex[socket.id];
        if (!idx) return;
        const { tripId, deviceId } = idx;

        console.log("Socket disconnected:", socket.id, "trip:", tripId);

        const mem = getTripMem(tripId);
        if (mem.members[deviceId]) {
            mem.members[deviceId].online = false;
            // หมายเหตุ: ไม่ลบสมาชิกออก และไม่แตะ gps_enabled ที่นี่
            // -> ตอนออฟไลน์จะยังโชว์ "ตำแหน่งล่าสุด" ของเขาอยู่ในแผนที่/รายชื่อ (สีเทา)
        }

        if (db.isEnabled()) {
            try {
                await db.query(`UPDATE members SET last_seen = now() WHERE id = $1`, [memberRowId(tripId, deviceId)]);
            } catch (err) {
                console.error("[db] Failed to update last_seen on disconnect:", err.message);
            }
        }

        broadcastMembers(tripId);
    });
});

db.init()
    .catch((err) => {
        console.error("[db] Startup DB init failed, continuing without persistence:", err.message);
    })
    .finally(() => {
        server.listen(PORT, () => {
            console.log(`Server running : http://localhost:${PORT}`);
        });
    });
