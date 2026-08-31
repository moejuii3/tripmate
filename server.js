require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const dbConn = require("./db");
const store = require("./db/store");
const { hashPassword, verifyPassword, signToken, verifyToken, requireAuth } = require("./auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// โฟลเดอร์เก็บไฟล์รูปปกทริปที่อัปโหลดจริง (เก็บบนเครื่อง server เอง ไม่พึ่ง cloud storage)
const UPLOADS_DIR = path.join(__dirname, "public", "uploads", "covers");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOADS_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${req.params.tripId}-${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
        cb(ok ? null : new Error("รองรับเฉพาะไฟล์ JPEG, PNG, WEBP เท่านั้น"), ok);
    },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Join via Link: /join/ABC123 — เสิร์ฟหน้าเว็บเดิม (SPA) แล้วให้ฝั่ง client อ่านรหัสจาก URL เองตอนโหลด
app.get("/join/:code", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
app.use("/api/community", requireAuth);
app.use("/api/stories", requireAuth);
app.use("/api/profile", requireAuth);
app.use("/api/travelers", requireAuth);
app.use("/api/invites", requireAuth);

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

// ---------------------------------------------------------------------
// Phase 2: Explore / Community Trips — ทริปสาธารณะให้คนอื่นค้นหา/เข้าร่วมได้
// ---------------------------------------------------------------------

// รายการทริปสาธารณะ (ไม่รวมทริปที่ตัวเองเป็นสมาชิกอยู่แล้ว)
app.get(
    "/api/community/trips",
    ah(async (req, res) => {
        res.json({ trips: await store.getCommunityTrips(req.userId) });
    })
);

// เปิด/ปิดให้ทริปเป็นสาธารณะ (สมาชิกในทริปเท่านั้นที่ทำได้)
app.patch(
    "/api/trips/:tripId/visibility",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;
        const { visibility } = req.body || {};
        const trip = await store.setTripVisibility(tripId, visibility);
        res.json({ trip });
    })
);

// แก้ไขจุดหมายปลายทาง/คำอธิบายทริป (โชว์ในการ์ด Explore)
app.patch(
    "/api/trips/:tripId/details",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;
        const { destination, description } = req.body || {};
        const trip = await store.setTripDetails(tripId, {
            destination: destination ? String(destination).trim().slice(0, 60) : null,
            description: description ? String(description).trim().slice(0, 300) : null,
        });
        res.json({ trip });
    })
);

// ---------------------------------------------------------------------
// Phase 5: ข้อมูลทริป (วันที่/ชื่อ/รูปปก/ลบถาวร) เฉพาะ "หัวหน้าทริป" + จุดนัดหมาย (สมาชิกทุกคนตั้งได้)
// ---------------------------------------------------------------------

// helper: เช็คว่าเป็น "หัวหน้าทริป" ก่อนทำรายการที่มีผลกระทบสูง (แก้ชื่อ/วันที่/รูปปก/ลบถาวร)
async function requireTripHost(req, res, tripId) {
    const trip = await store.getTrip(tripId);
    if (!trip) {
        res.status(404).json({ error: "ไม่พบทริป" });
        return null;
    }
    if (!store.isHost(trip, req.userId)) {
        res.status(403).json({ error: "เฉพาะหัวหน้าทริปเท่านั้นที่ทำรายการนี้ได้" });
        return null;
    }
    return trip;
}

function isValidDateStr(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// แก้ไขชื่อทริป/วันที่เริ่ม-สิ้นสุด — หัวหน้าทริปเท่านั้น
app.patch(
    "/api/trips/:tripId/info",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripHost(req, res, tripId))) return;

        const { name, start_date, end_date } = req.body || {};
        if (start_date && !isValidDateStr(start_date))
            return res.status(400).json({ error: "รูปแบบวันที่เริ่มต้นไม่ถูกต้อง" });
        if (end_date && !isValidDateStr(end_date))
            return res.status(400).json({ error: "รูปแบบวันที่สิ้นสุดไม่ถูกต้อง" });
        if (start_date && end_date && start_date > end_date)
            return res.status(400).json({ error: "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น" });

        const trip = await store.updateTripInfo(tripId, {
            name: name ? String(name).trim().slice(0, 40) : null,
            startDate: start_date || null,
            endDate: end_date || null,
        });
        io.to(`trip:${tripId}`).emit("trip-info-updated", { tripId, trip });
        res.json({ trip });
    })
);

// อัปโหลดรูปปกทริปจริง (เก็บไฟล์บนเครื่อง server) — หัวหน้าทริปเท่านั้น
app.post(
    "/api/trips/:tripId/cover",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripHost(req, res, tripId))) return;

        upload.single("cover")(req, res, async (err) => {
            if (err) return res.status(400).json({ error: err.message });
            if (!req.file) return res.status(400).json({ error: "ไม่พบไฟล์รูปภาพ" });

            const relPath = `/uploads/covers/${req.file.filename}`;
            const trip = await store.setTripCoverImage(tripId, relPath);
            io.to(`trip:${tripId}`).emit("trip-info-updated", { tripId, trip });
            res.json({ trip });
        });
    })
);

// ตั้ง/แก้ไขจุดนัดหมายของทริป (ใช้คำนวณระยะห่างของสมาชิกจากจุดนัดหมาย) — สมาชิกทุกคนตั้งได้
app.patch(
    "/api/trips/:tripId/meetup",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;

        const { name, lat, lng } = req.body || {};
        const latNum = lat != null ? Number(lat) : null;
        const lngNum = lng != null ? Number(lng) : null;
        if ((latNum != null && !Number.isFinite(latNum)) || (lngNum != null && !Number.isFinite(lngNum)))
            return res.status(400).json({ error: "พิกัดไม่ถูกต้อง" });

        const trip = await store.setTripMeetup(tripId, {
            name: name ? String(name).trim().slice(0, 60) : null,
            lat: latNum,
            lng: lngNum,
        });
        io.to(`trip:${tripId}`).emit("trip-meetup-updated", { tripId, trip });
        res.json({ trip });
    })
);

// ลบทริปถาวร — หัวหน้าทริปเท่านั้น และต้อง "ปิดทริป" อยู่ก่อนแล้ว (กันลบทริปที่ยังใช้งานอยู่โดยไม่ตั้งใจ)
app.delete(
    "/api/trips/:tripId",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripHost(req, res, tripId))) return;

        const result = await store.deleteTripPermanently(tripId);
        if (!result.ok && result.reason === "still_active")
            return res.status(400).json({ error: "ต้องปิดทริปนี้ก่อนถึงจะลบถาวรได้" });
        if (!result.ok) return res.status(404).json({ error: "ไม่พบทริป" });

        io.to(`trip:${tripId}`).emit("trip-deleted", { tripId });
        res.json({ ok: true });
    })
);

// ---------------------------------------------------------------------
// Phase 3: Travel Stories — ฟีดเรื่องเล่าทริป (รูป + แคปชั่น + แท็ก)
// ---------------------------------------------------------------------
function isValidImageUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

app.get(
    "/api/stories",
    ah(async (req, res) => {
        res.json({ stories: await store.getStoriesFeed(req.userId) });
    })
);

app.post(
    "/api/stories",
    ah(async (req, res) => {
        const { image_url, caption, tags, trip_id } = req.body || {};
        if (!image_url || !isValidImageUrl(image_url))
            return res.status(400).json({ error: "กรุณาใส่ลิงก์รูปภาพที่ถูกต้อง (http/https)" });

        const cleanTags = Array.isArray(tags)
            ? tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 6)
            : [];

        let tripId = null;
        if (trip_id) {
            const upperId = String(trip_id).toUpperCase();
            if (await store.isMember(upperId, req.userId)) tripId = upperId;
        }

        const story = await store.createStory(req.userId, {
            imageUrl: image_url,
            caption: caption ? String(caption).trim().slice(0, 500) : null,
            tags: cleanTags,
            tripId,
        });
        res.json({ story });
    })
);

app.delete(
    "/api/stories/:storyId",
    ah(async (req, res) => {
        const ok = await store.deleteStory(req.params.storyId, req.userId);
        if (!ok) return res.status(403).json({ error: "ลบได้เฉพาะเรื่องเล่าของตัวเองเท่านั้น" });
        res.json({ ok: true });
    })
);

app.post(
    "/api/stories/:storyId/like",
    ah(async (req, res) => {
        const story = await store.toggleStoryLike(req.params.storyId, req.userId);
        if (!story) return res.status(404).json({ error: "ไม่พบเรื่องเล่านี้" });
        res.json({ story });
    })
);

app.get(
    "/api/stories/:storyId/comments",
    ah(async (req, res) => {
        res.json({ comments: await store.getStoryComments(req.params.storyId) });
    })
);

app.post(
    "/api/stories/:storyId/comments",
    ah(async (req, res) => {
        const { body } = req.body || {};
        if (!body || !String(body).trim()) return res.status(400).json({ error: "กรุณาพิมพ์คอมเมนต์" });
        const comments = await store.addStoryComment(req.params.storyId, req.userId, String(body).trim().slice(0, 300));
        res.json({ comments });
    })
);

// ---------------------------------------------------------------------
// Phase 4: Profile + Find Travelers + Trip Invites
// ---------------------------------------------------------------------
app.get(
    "/api/profile/me",
    ah(async (req, res) => {
        const profile = await store.getProfileWithStats(req.userId);
        if (!profile) return res.status(404).json({ error: "ไม่พบบัญชีนี้" });
        res.json({ profile });
    })
);

app.patch(
    "/api/profile",
    ah(async (req, res) => {
        const { bio, location_text, interests, discoverable } = req.body || {};
        const cleanInterests = Array.isArray(interests)
            ? interests.map((i) => String(i).trim().slice(0, 24)).filter(Boolean).slice(0, 10)
            : [];
        const profile = await store.updateProfile(req.userId, {
            bio: bio ? String(bio).trim().slice(0, 300) : null,
            location_text: location_text ? String(location_text).trim().slice(0, 80) : null,
            interests: cleanInterests,
            discoverable: !!discoverable,
        });
        res.json({ profile });
    })
);

app.get(
    "/api/travelers",
    ah(async (req, res) => {
        const q = req.query.q ? String(req.query.q).trim() : "";
        res.json({ travelers: await store.findTravelers(req.userId, q) });
    })
);

// ชวนนักเดินทางเข้าทริปของฉัน (ต้องเป็นสมาชิกทริปนั้นก่อน) — สร้างเป็นคำเชิญ ผู้ถูกเชิญต้องตอบรับเอง
app.post(
    "/api/travelers/:userId/invite",
    ah(async (req, res) => {
        const { tripId } = req.body || {};
        if (!tripId) return res.status(400).json({ error: "กรุณาเลือกทริป" });
        const upperId = String(tripId).toUpperCase();
        if (!(await requireTripMember(req, res, upperId))) return;

        await store.createInvite(upperId, req.userId, req.params.userId);
        res.json({ ok: true });
    })
);

app.get(
    "/api/invites",
    ah(async (req, res) => {
        res.json({ invites: await store.getMyInvites(req.userId) });
    })
);

app.post(
    "/api/invites/:inviteId/accept",
    ah(async (req, res) => {
        const trip = await store.respondInvite(req.params.inviteId, req.userId, true);
        res.json({ trip });
    })
);

app.post(
    "/api/invites/:inviteId/decline",
    ah(async (req, res) => {
        await store.respondInvite(req.params.inviteId, req.userId, false);
        res.json({ ok: true });
    })
);

// helper: เช็คว่าเป็นสมาชิกทริปนี้ก่อนทุก endpoint ของ itinerary/expenses
async function requireTripMember(req, res, tripId) {
    const trip = await store.getTrip(tripId);
    if (!trip) {
        res.status(404).json({ error: "ไม่พบทริป" });
        return null;
    }
    if (!(await store.isMember(tripId, req.userId))) {
        res.status(403).json({ error: "ไม่ใช่สมาชิกทริปนี้" });
        return null;
    }
    return trip;
}

// ---------------------------------------------------------------------
// Itinerary — กำหนดการเดินทางของทริป (Phase 1)
// ---------------------------------------------------------------------
app.get(
    "/api/trips/:tripId/itinerary",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;
        res.json({ items: await store.getItinerary(tripId) });
    })
);

app.post(
    "/api/trips/:tripId/itinerary",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;

        const { title, description, location_name, category, start_time, end_time, lat, lng } = req.body || {};
        if (!title || !String(title).trim()) return res.status(400).json({ error: "กรุณาใส่ชื่อกิจกรรม" });

        const latNum = lat != null ? Number(lat) : null;
        const lngNum = lng != null ? Number(lng) : null;
        if ((latNum != null && !Number.isFinite(latNum)) || (lngNum != null && !Number.isFinite(lngNum)))
            return res.status(400).json({ error: "พิกัดไม่ถูกต้อง" });

        const memberId = `${tripId}:${req.userId}`;
        const item = await store.addItineraryItem(
            tripId,
            {
                title: String(title).trim().slice(0, 120),
                description: description ? String(description).trim().slice(0, 500) : null,
                location_name: location_name ? String(location_name).trim().slice(0, 120) : null,
                category,
                lat: latNum,
                lng: lngNum,
                start_time,
                end_time,
            },
            memberId,
            req.username
        );
        io.to(`trip:${tripId}`).emit("itinerary-updated", { tripId });
        res.json({ item });
    })
);

app.delete(
    "/api/trips/:tripId/itinerary/:itemId",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;
        await store.deleteItineraryItem(tripId, req.params.itemId);
        io.to(`trip:${tripId}`).emit("itinerary-updated", { tripId });
        res.json({ ok: true });
    })
);

// ---------------------------------------------------------------------
// Expenses — ค่าใช้จ่ายร่วมกันของทริป (Phase 1) หารเท่ากันทุกคนในทริปตอนสรุปยอด
// ---------------------------------------------------------------------
app.get(
    "/api/trips/:tripId/expenses",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;
        res.json(await store.getExpensesSummary(tripId));
    })
);

app.post(
    "/api/trips/:tripId/expenses",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;

        const { description, amount, category } = req.body || {};
        const amountNum = Number(amount);
        if (!description || !String(description).trim())
            return res.status(400).json({ error: "กรุณาใส่รายละเอียดค่าใช้จ่าย" });
        if (!Number.isFinite(amountNum) || amountNum <= 0)
            return res.status(400).json({ error: "จำนวนเงินไม่ถูกต้อง" });

        await store.addExpense(
            tripId,
            { description: String(description).trim().slice(0, 120), amount: amountNum, category },
            req.userId
        );
        const summary = await store.getExpensesSummary(tripId);
        io.to(`trip:${tripId}`).emit("expenses-updated", { tripId });
        res.json(summary);
    })
);

app.patch(
    "/api/trips/:tripId/budget",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;

        const { budget } = req.body || {};
        const budgetNum = budget === null || budget === "" ? null : Number(budget);
        if (budgetNum != null && (!Number.isFinite(budgetNum) || budgetNum < 0))
            return res.status(400).json({ error: "งบประมาณไม่ถูกต้อง" });

        await store.setTripBudget(tripId, budgetNum);
        const summary = await store.getExpensesSummary(tripId);
        io.to(`trip:${tripId}`).emit("expenses-updated", { tripId });
        res.json(summary);
    })
);

app.delete(
    "/api/trips/:tripId/expenses/:expenseId",
    ah(async (req, res) => {
        const tripId = req.params.tripId.toUpperCase();
        if (!(await requireTripMember(req, res, tripId))) return;
        await store.deleteExpense(tripId, req.params.expenseId);
        const summary = await store.getExpensesSummary(tripId);
        io.to(`trip:${tripId}`).emit("expenses-updated", { tripId });
        res.json(summary);
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
