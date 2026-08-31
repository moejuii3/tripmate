const crypto = require("crypto");
const { query, isEnabled } = require("./index");

const COLORS = [
    "#ef4444", "#3b82f6", "#22c55e", "#f59e0b",
    "#a855f7", "#ec4899", "#14b8a6", "#eab308",
];

// คำนวณระยะทางจริงระหว่าง 2 พิกัด (เมตร) ด้วยสูตร Haversine — ใช้ทั้งฝั่ง server (ตรวจ "เคลื่อนที่หรือไม่")
// และฝั่ง client (แสดงระยะห่างสมาชิก/สถานที่/จุดนัดหมาย)
function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
const MOVEMENT_THRESHOLD_METERS = 15; // ขยับน้อยกว่านี้ถือว่า "ยังไม่เคลื่อนที่" (กัน GPS สั่นเล็กน้อย)

function assertEnabled() {
    if (!isEnabled()) {
        const err = new Error(
            "ยังไม่ได้ตั้งค่า DATABASE_URL — เพิ่มไฟล์ .env แล้วใส่ connection string ของ PostgreSQL แล้วรีสตาร์ทเซิร์ฟเวอร์"
        );
        err.status = 503;
        throw err;
    }
}

// รหัสทริป 6 หลัก อ่านง่าย ไม่มีตัวที่สับสน (0/O, 1/I) — ใช้เป็น trips.id โดยตรง (คือ "code" ในตัวเอง)
function genTripId() {
    const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function toEpoch(ts) {
    return ts ? new Date(ts).getTime() : null;
}

function shapeTrip(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        code: row.id, // id ของทริปทำหน้าที่เป็นรหัสเชิญไปในตัว
        is_active: row.ended_at == null,
        created_at: toEpoch(row.created_at),
        closed_at: toEpoch(row.ended_at),
        budget: row.budget != null ? Number(row.budget) : null,
        visibility: row.visibility || "private",
        destination: row.destination || null,
        description: row.description || null,
        start_date: row.start_date ? row.start_date.toISOString().slice(0, 10) : null,
        end_date: row.end_date ? row.end_date.toISOString().slice(0, 10) : null,
        host_user_id: row.host_user_id || null,
        cover_image_path: row.cover_image_path || null,
        meetup_name: row.meetup_name || null,
        meetup_lat: row.meetup_lat,
        meetup_lng: row.meetup_lng,
    };
}

function shapeMember(row) {
    return {
        id: row.user_id,
        name: row.name,
        color: row.color,
        share_enabled: !!row.gps_enabled,
        lat: row.current_lat,
        lng: row.current_lng,
        last_update: toEpoch(row.last_location_at),
        last_moved_at: toEpoch(row.last_moved_at),
    };
}

// ---------------------------------------------------------------------
// Users (บัญชีจริง — สมัคร/เข้าสู่ระบบ)
// ---------------------------------------------------------------------
async function createUser(username, passwordHash) {
    assertEnabled();
    const id = crypto.randomUUID();
    try {
        await query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)", [
            id,
            username,
            passwordHash,
        ]);
    } catch (err) {
        if (err.code === "23505") {
            // unique_violation บน username
            const dup = new Error("มีชื่อผู้ใช้นี้อยู่แล้ว ลองชื่ออื่น");
            dup.status = 409;
            throw dup;
        }
        throw err;
    }
    return { id, username };
}

async function findUserByUsername(username) {
    assertEnabled();
    const { rows } = await query("SELECT * FROM users WHERE username = $1", [username]);
    return rows[0] || null;
}

async function findUserById(userId) {
    assertEnabled();
    const { rows } = await query("SELECT id, username FROM users WHERE id = $1", [userId]);
    return rows[0] || null;
}

// ---------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------
async function createTrip(name, userId, memberName) {
    assertEnabled();

    let id = genTripId();
    for (let i = 0; i < 5; i++) {
        const { rows } = await query("SELECT 1 FROM trips WHERE id = $1", [id]);
        if (rows.length === 0) break;
        id = genTripId();
    }

    // ผู้สร้างทริปกลายเป็น "หัวหน้าทริป" (host) โดยอัตโนมัติ
    await query("INSERT INTO trips (id, name, host_user_id) VALUES ($1, $2, $3)", [id, name, userId]);
    await addMember(id, userId, memberName);
    return getTrip(id);
}

async function getTrip(tripId) {
    assertEnabled();
    const { rows } = await query("SELECT * FROM trips WHERE id = $1", [tripId]);
    return shapeTrip(rows[0]);
}

function isHost(trip, userId) {
    return !!trip && trip.host_user_id === userId;
}

// แก้ชื่อทริป/วันที่เริ่ม-สิ้นสุด — เฉพาะหัวหน้าทริปเท่านั้น (เช็คสิทธิ์ที่ server.js ก่อนเรียกฟังก์ชันนี้)
async function updateTripInfo(tripId, { name, startDate, endDate }) {
    assertEnabled();
    await query(
        `UPDATE trips SET name = COALESCE($2, name), start_date = $3, end_date = $4 WHERE id = $1`,
        [tripId, name || null, startDate || null, endDate || null]
    );
    return getTrip(tripId);
}

async function setTripCoverImage(tripId, coverPath) {
    assertEnabled();
    await query("UPDATE trips SET cover_image_path = $2 WHERE id = $1", [tripId, coverPath]);
    return getTrip(tripId);
}

async function setTripMeetup(tripId, { name, lat, lng }) {
    assertEnabled();
    await query("UPDATE trips SET meetup_name = $2, meetup_lat = $3, meetup_lng = $4 WHERE id = $1", [
        tripId,
        name || null,
        lat != null ? lat : null,
        lng != null ? lng : null,
    ]);
    return getTrip(tripId);
}

// ลบทริปถาวร — อนุญาตเฉพาะทริปที่ "ปิดอยู่แล้ว" เท่านั้น (กันลบทริปที่ยังใช้งานอยู่โดยไม่ตั้งใจ)
// เช็คสิทธิ์หัวหน้าทริปที่ server.js ก่อนเรียกฟังก์ชันนี้
async function deleteTripPermanently(tripId) {
    assertEnabled();
    const trip = await getTrip(tripId);
    if (!trip) return { ok: false, reason: "not_found" };
    if (trip.is_active) return { ok: false, reason: "still_active" };
    await query("DELETE FROM trips WHERE id = $1", [tripId]); // CASCADE ลบ members/itinerary/expenses ที่ผูกไว้ด้วย
    return { ok: true };
}

async function setTripVisibility(tripId, visibility) {
    assertEnabled();
    const v = visibility === "public" ? "public" : "private";
    await query("UPDATE trips SET visibility = $2 WHERE id = $1", [tripId, v]);
    return getTrip(tripId);
}

async function setTripDetails(tripId, { destination, description }) {
    assertEnabled();
    await query("UPDATE trips SET destination = $2, description = $3 WHERE id = $1", [
        tripId,
        destination || null,
        description || null,
    ]);
    return getTrip(tripId);
}

// ทริปสาธารณะทั้งหมด (สำหรับหน้า Explore) — เรียงตามจำนวนสมาชิกมาก่อน แล้วตามใหม่สุด
async function getCommunityTrips(excludeUserId) {
    assertEnabled();
    const { rows } = await query(
        `SELECT t.*, (SELECT COUNT(*) FROM members WHERE trip_id = t.id) AS member_count
         FROM trips t
         WHERE t.visibility = 'public' AND t.ended_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM members m WHERE m.trip_id = t.id AND m.user_id = $1)
         ORDER BY member_count DESC, t.created_at DESC
         LIMIT 50`,
        [excludeUserId]
    );
    return rows.map((r) => ({ ...shapeTrip(r), member_count: Number(r.member_count) }));
}

async function isMember(tripId, userId) {
    assertEnabled();
    const { rows } = await query(
        "SELECT 1 FROM members WHERE trip_id = $1 AND user_id = $2",
        [tripId, userId]
    );
    return rows.length > 0;
}

async function addMember(tripId, userId, memberName) {
    assertEnabled();

    const existing = await query(
        "SELECT 1 FROM members WHERE trip_id = $1 AND user_id = $2",
        [tripId, userId]
    );
    if (existing.rows.length > 0) {
        await query(
            "UPDATE members SET name = $3, last_seen = now() WHERE trip_id = $1 AND user_id = $2",
            [tripId, userId, memberName || "Guest"]
        );
        return;
    }

    const countRes = await query("SELECT COUNT(*)::int AS n FROM members WHERE trip_id = $1", [tripId]);
    const color = COLORS[countRes.rows[0].n % COLORS.length];
    const id = `${tripId}:${userId}`;

    await query(
        `INSERT INTO members (id, trip_id, user_id, name, color, gps_enabled)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [id, tripId, userId, memberName || "Guest", color]
    );
}

// ทริปทั้งหมดที่บัญชีนี้เข้าร่วม (รองรับหลายทริปพร้อมกัน)
async function getUserTrips(userId) {
    assertEnabled();
    const { rows } = await query(
        `SELECT t.*,
                m.gps_enabled, m.color,
                (SELECT COUNT(*) FROM members WHERE trip_id = t.id) AS member_count
         FROM trips t
         JOIN members m ON m.trip_id = t.id
         WHERE m.user_id = $1
         ORDER BY (t.ended_at IS NULL) DESC, t.created_at DESC`,
        [userId]
    );
    return rows.map((r) => ({
        ...shapeTrip(r),
        share_enabled: !!r.gps_enabled,
        color: r.color,
        member_count: Number(r.member_count),
    }));
}

async function getTripMembers(tripId) {
    assertEnabled();
    const { rows } = await query(
        `SELECT user_id, name, color, gps_enabled, current_lat, current_lng, last_location_at, last_moved_at
         FROM members WHERE trip_id = $1 ORDER BY joined_at ASC`,
        [tripId]
    );
    return rows.map(shapeMember);
}

// เปิด/ปิด "สวิตช์ใหญ่" ของทริป — ทริปที่ปิดแล้ว (เช่นทริปเก่า) จะไม่รับ/ส่งพิกัด GPS อีก
async function setTripActive(tripId, isActive) {
    assertEnabled();
    await query(
        `UPDATE trips SET ended_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1`,
        [tripId, isActive]
    );
    return getTrip(tripId);
}

// เปิด/ปิดการแชร์ตำแหน่งของ "ผู้ใช้คนนี้" เฉพาะในทริปนี้ (คนเดียวอยู่ได้หลายทริป เลือกแชร์เป็นรายทริป)
async function setMemberShare(tripId, userId, enabled) {
    assertEnabled();
    if (enabled) {
        await query(
            "UPDATE members SET gps_enabled = true WHERE trip_id = $1 AND user_id = $2",
            [tripId, userId]
        );
    } else {
        // เคลียร์พิกัดล่าสุดออกเมื่อปิดแชร์ ป้องกันหมุดค้างอยู่บนแผนที่คนอื่น
        await query(
            `UPDATE members SET gps_enabled = false, current_lat = NULL, current_lng = NULL
             WHERE trip_id = $1 AND user_id = $2`,
            [tripId, userId]
        );
    }
}

async function updateLocation(tripId, userId, lat, lng) {
    assertEnabled();

    const prevRes = await query(
        "SELECT current_lat, current_lng, last_moved_at FROM members WHERE trip_id = $1 AND user_id = $2",
        [tripId, userId]
    );
    const prev = prevRes.rows[0];
    const hasMoved =
        !prev || prev.current_lat == null || prev.current_lng == null ||
        haversineMeters(prev.current_lat, prev.current_lng, lat, lng) > MOVEMENT_THRESHOLD_METERS;

    await query(
        `UPDATE members
         SET current_lat = $3, current_lng = $4, last_location_at = now(), last_seen = now(),
             last_moved_at = CASE WHEN $5 THEN now() ELSE last_moved_at END
         WHERE trip_id = $1 AND user_id = $2`,
        [tripId, userId, lat, lng, hasMoved]
    );
}

async function setTripBudget(tripId, budget) {
    assertEnabled();
    await query("UPDATE trips SET budget = $2 WHERE id = $1", [tripId, budget]);
}

// ---------------------------------------------------------------------
// Itinerary (กำหนดการเดินทาง) — เรียงตามวัน/เวลา ไม่มีเวลาจะอยู่ท้ายสุดของรายการ
// ---------------------------------------------------------------------
function shapeItineraryItem(row) {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        location_name: row.location_name,
        category: row.category,
        lat: row.lat,
        lng: row.lng,
        start_time: toEpoch(row.start_time),
        end_time: toEpoch(row.end_time),
        created_by_name: row.created_by_name,
    };
}

async function addItineraryItem(tripId, item, memberId, memberName) {
    assertEnabled();
    const { rows } = await query(
        `INSERT INTO itinerary_items
            (trip_id, title, description, location_name, category, lat, lng, start_time, end_time, created_by, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
            tripId,
            item.title,
            item.description || null,
            item.location_name || null,
            item.category || "other",
            item.lat != null ? item.lat : null,
            item.lng != null ? item.lng : null,
            item.start_time ? new Date(item.start_time) : null,
            item.end_time ? new Date(item.end_time) : null,
            memberId,
            memberName,
        ]
    );
    return shapeItineraryItem(rows[0]);
}

async function getItinerary(tripId) {
    assertEnabled();
    const { rows } = await query(
        `SELECT * FROM itinerary_items WHERE trip_id = $1
         ORDER BY start_time ASC NULLS LAST, created_at ASC`,
        [tripId]
    );
    return rows.map(shapeItineraryItem);
}

async function deleteItineraryItem(tripId, itemId) {
    assertEnabled();
    await query("DELETE FROM itinerary_items WHERE trip_id = $1 AND id = $2", [tripId, itemId]);
}

// ---------------------------------------------------------------------
// Expenses (ค่าใช้จ่ายร่วมกัน) — หารเท่ากันทุกคนในทริป ณ ตอนสรุปยอด
// ---------------------------------------------------------------------
function shapeExpense(row) {
    return {
        id: row.id,
        description: row.description,
        amount: Number(row.amount),
        category: row.category,
        paid_by: row.paid_by,
        paid_by_name: row.paid_by_name,
        created_at: toEpoch(row.created_at),
    };
}

async function addExpense(tripId, { description, amount, category }, userId) {
    assertEnabled();
    const { rows } = await query(
        `INSERT INTO expenses (trip_id, description, amount, category, paid_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [tripId, description, amount, category || "other", userId]
    );
    return getExpenseWithName(tripId, rows[0].id);
}

async function getExpenseWithName(tripId, expenseId) {
    const { rows } = await query(
        `SELECT e.*, m.name AS paid_by_name
         FROM expenses e
         JOIN members m ON m.trip_id = e.trip_id AND m.user_id = e.paid_by
         WHERE e.trip_id = $1 AND e.id = $2`,
        [tripId, expenseId]
    );
    return shapeExpense(rows[0]);
}

async function deleteExpense(tripId, expenseId) {
    assertEnabled();
    await query("DELETE FROM expenses WHERE trip_id = $1 AND id = $2", [tripId, expenseId]);
}

// คืนทั้งรายการค่าใช้จ่าย + สรุปยอด (รวม, งบ, ใครติดเงินใคร) หารเท่ากันทุกคนในทริปตอนนี้
async function getExpensesSummary(tripId) {
    assertEnabled();

    const tripRes = await query("SELECT budget FROM trips WHERE id = $1", [tripId]);
    const budget = tripRes.rows[0]?.budget != null ? Number(tripRes.rows[0].budget) : null;

    const { rows: expenseRows } = await query(
        `SELECT e.*, m.name AS paid_by_name
         FROM expenses e
         JOIN members m ON m.trip_id = e.trip_id AND m.user_id = e.paid_by
         WHERE e.trip_id = $1
         ORDER BY e.created_at DESC`,
        [tripId]
    );
    const expenses = expenseRows.map(shapeExpense);
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);

    const members = await getTripMembers(tripId); // [{id, name, color, ...}]
    const share = members.length > 0 ? total / members.length : 0;

    const paidByMember = {};
    for (const e of expenses) paidByMember[e.paid_by] = (paidByMember[e.paid_by] || 0) + e.amount;

    const balances = members.map((m) => ({
        user_id: m.id,
        name: m.name,
        color: m.color,
        paid: paidByMember[m.id] || 0,
        net: (paidByMember[m.id] || 0) - share, // บวก = ได้คืน, ลบ = ติดเงินเพื่อน
    }));

    return { expenses, total, budget, share, balances };
}

// ---------------------------------------------------------------------
// Phase 3: Travel Stories — ฟีดเรื่องเล่าทริป (รูป + แคปชั่น + แท็ก + ไลค์/คอมเมนต์)
// ---------------------------------------------------------------------
function shapeStory(row, myUserId) {
    return {
        id: String(row.id),
        user_id: row.user_id,
        author_name: row.author_name,
        trip_id: row.trip_id,
        trip_name: row.trip_name || null,
        image_url: row.image_url,
        caption: row.caption,
        tags: row.tags || [],
        like_count: Number(row.like_count || 0),
        comment_count: Number(row.comment_count || 0),
        liked_by_me: !!row.liked_by_me,
        is_mine: row.user_id === myUserId,
        created_at: toEpoch(row.created_at),
    };
}

async function createStory(userId, { imageUrl, caption, tags, tripId }) {
    assertEnabled();
    const { rows } = await query(
        `INSERT INTO stories (user_id, trip_id, image_url, caption, tags)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, tripId || null, imageUrl, caption || null, tags && tags.length ? tags : []]
    );
    return getStory(rows[0].id, userId);
}

const STORY_SELECT = `
    SELECT s.*, u.username AS author_name, t.name AS trip_name,
           (SELECT COUNT(*) FROM story_likes WHERE story_id = s.id) AS like_count,
           (SELECT COUNT(*) FROM story_comments WHERE story_id = s.id) AS comment_count,
           EXISTS(SELECT 1 FROM story_likes WHERE story_id = s.id AND user_id = $1) AS liked_by_me
    FROM stories s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN trips t ON t.id = s.trip_id
`;

async function getStoriesFeed(myUserId) {
    assertEnabled();
    const { rows } = await query(`${STORY_SELECT} ORDER BY s.created_at DESC LIMIT 50`, [myUserId]);
    return rows.map((r) => shapeStory(r, myUserId));
}

async function getStory(storyId, myUserId) {
    assertEnabled();
    const { rows } = await query(`${STORY_SELECT} WHERE s.id = $2`, [myUserId, storyId]);
    return rows[0] ? shapeStory(rows[0], myUserId) : null;
}

async function deleteStory(storyId, userId) {
    assertEnabled();
    const { rowCount } = await query("DELETE FROM stories WHERE id = $1 AND user_id = $2", [storyId, userId]);
    return rowCount > 0;
}

// toggle: ถ้าไลค์อยู่แล้วให้ยกเลิก ถ้ายังไม่ไลค์ให้เพิ่ม คืนสถานะล่าสุด
async function toggleStoryLike(storyId, userId) {
    assertEnabled();
    const existing = await query("SELECT 1 FROM story_likes WHERE story_id = $1 AND user_id = $2", [storyId, userId]);
    if (existing.rows.length > 0) {
        await query("DELETE FROM story_likes WHERE story_id = $1 AND user_id = $2", [storyId, userId]);
    } else {
        await query(
            "INSERT INTO story_likes (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [storyId, userId]
        );
    }
    return getStory(storyId, userId);
}

async function getStoryComments(storyId) {
    assertEnabled();
    const { rows } = await query(
        `SELECT c.*, u.username AS author_name
         FROM story_comments c JOIN users u ON u.id = c.user_id
         WHERE c.story_id = $1 ORDER BY c.created_at ASC`,
        [storyId]
    );
    return rows.map((r) => ({
        id: String(r.id),
        user_id: r.user_id,
        author_name: r.author_name,
        body: r.body,
        created_at: toEpoch(r.created_at),
    }));
}

async function addStoryComment(storyId, userId, body) {
    assertEnabled();
    await query("INSERT INTO story_comments (story_id, user_id, body) VALUES ($1, $2, $3)", [
        storyId,
        userId,
        body,
    ]);
    return getStoryComments(storyId);
}

// ---------------------------------------------------------------------
// Phase 4: Profile + Find Travelers + Trip Invites
// ---------------------------------------------------------------------
function shapeProfile(row) {
    return {
        id: row.id,
        username: row.username,
        bio: row.bio || null,
        location_text: row.location_text || null,
        interests: row.interests || [],
        discoverable: !!row.discoverable,
    };
}

async function updateProfile(userId, { bio, location_text, interests, discoverable }) {
    assertEnabled();
    const { rows } = await query(
        `UPDATE users SET bio = $2, location_text = $3, interests = $4, discoverable = $5
         WHERE id = $1 RETURNING *`,
        [userId, bio || null, location_text || null, interests || [], !!discoverable]
    );
    return shapeProfile(rows[0]);
}

async function getProfileWithStats(userId) {
    assertEnabled();
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [userId]);
    if (!rows[0]) return null;

    const tripCountRes = await query("SELECT COUNT(DISTINCT trip_id)::int AS n FROM members WHERE user_id = $1", [userId]);
    const storyCountRes = await query("SELECT COUNT(*)::int AS n FROM stories WHERE user_id = $1", [userId]);
    const destinationsRes = await query(
        `SELECT COUNT(DISTINCT t.destination)::int AS n
         FROM trips t JOIN members m ON m.trip_id = t.id
         WHERE m.user_id = $1 AND t.destination IS NOT NULL`,
        [userId]
    );

    return {
        ...shapeProfile(rows[0]),
        trip_count: tripCountRes.rows[0].n,
        story_count: storyCountRes.rows[0].n,
        destination_count: destinationsRes.rows[0].n,
    };
}

// นักเดินทางที่เปิดให้ค้นหาเจอ (ไม่รวมตัวเอง) — คำนวณ % match แบบง่ายจากจำนวนความสนใจที่ตรงกัน
async function findTravelers(myUserId, searchQuery) {
    assertEnabled();
    const meRes = await query("SELECT interests FROM users WHERE id = $1", [myUserId]);
    const myInterests = new Set((meRes.rows[0]?.interests || []).map((i) => i.toLowerCase()));

    let sql = `
        SELECT u.*, (SELECT COUNT(DISTINCT trip_id) FROM members WHERE user_id = u.id)::int AS trip_count,
               (SELECT COUNT(*) FROM stories WHERE user_id = u.id)::int AS story_count
        FROM users u
        WHERE u.discoverable = true AND u.id != $1
    `;
    const params = [myUserId];
    if (searchQuery) {
        params.push(`%${searchQuery.toLowerCase()}%`);
        sql += ` AND (LOWER(u.username) LIKE $2 OR LOWER(u.bio) LIKE $2 OR LOWER(u.location_text) LIKE $2
                       OR EXISTS (SELECT 1 FROM unnest(u.interests) i WHERE LOWER(i) LIKE $2))`;
    }
    sql += " ORDER BY u.created_at DESC LIMIT 50";

    const { rows } = await query(sql, params);
    return rows.map((r) => {
        const theirInterests = (r.interests || []).map((i) => i.toLowerCase());
        const overlap = theirInterests.filter((i) => myInterests.has(i)).length;
        const base = Math.max(myInterests.size, theirInterests.length, 1);
        const matchPct = myInterests.size > 0 ? Math.round((overlap / base) * 100) : null;
        return {
            id: r.id,
            username: r.username,
            bio: r.bio || null,
            location_text: r.location_text || null,
            interests: r.interests || [],
            trip_count: r.trip_count,
            story_count: r.story_count,
            match_pct: matchPct,
        };
    });
}

// ---------------------------------------------------------------------
// Trip invites — ต้องกดตอบรับเองถึงจะเข้าทริปจริง
// ---------------------------------------------------------------------
async function createInvite(tripId, fromUserId, toUserId) {
    assertEnabled();
    if (fromUserId === toUserId) {
        const err = new Error("เชิญตัวเองไม่ได้");
        err.status = 400;
        throw err;
    }
    const already = await query("SELECT 1 FROM members WHERE trip_id = $1 AND user_id = $2", [tripId, toUserId]);
    if (already.rows.length > 0) {
        const err = new Error("คนนี้อยู่ในทริปนี้แล้ว");
        err.status = 400;
        throw err;
    }

    await query(
        `INSERT INTO trip_invites (trip_id, from_user_id, to_user_id, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (trip_id, to_user_id) DO UPDATE
           SET status = 'pending', from_user_id = $2, created_at = now(), responded_at = NULL
           WHERE trip_invites.status = 'declined'`,
        [tripId, fromUserId, toUserId]
    );
}

async function getMyInvites(userId) {
    assertEnabled();
    const { rows } = await query(
        `SELECT i.*, t.name AS trip_name, u.username AS from_username
         FROM trip_invites i
         JOIN trips t ON t.id = i.trip_id
         JOIN users u ON u.id = i.from_user_id
         WHERE i.to_user_id = $1 AND i.status = 'pending'
         ORDER BY i.created_at DESC`,
        [userId]
    );
    return rows.map((r) => ({
        id: String(r.id),
        trip_id: r.trip_id,
        trip_name: r.trip_name,
        from_username: r.from_username,
        created_at: toEpoch(r.created_at),
    }));
}

async function respondInvite(inviteId, userId, accept) {
    assertEnabled();
    const { rows } = await query(
        "SELECT * FROM trip_invites WHERE id = $1 AND to_user_id = $2 AND status = 'pending'",
        [inviteId, userId]
    );
    const invite = rows[0];
    if (!invite) {
        const err = new Error("ไม่พบคำเชิญนี้ หรือตอบรับไปแล้ว");
        err.status = 404;
        throw err;
    }

    await query("UPDATE trip_invites SET status = $2, responded_at = now() WHERE id = $1", [
        inviteId,
        accept ? "accepted" : "declined",
    ]);

    if (accept) {
        const userRes = await query("SELECT username FROM users WHERE id = $1", [userId]);
        await addMember(invite.trip_id, userId, userRes.rows[0]?.username || "Guest");
        return getTrip(invite.trip_id);
    }
    return null;
}

module.exports = {
    createUser,
    findUserByUsername,
    findUserById,
    createTrip,
    getTrip,
    isHost,
    updateTripInfo,
    setTripCoverImage,
    setTripMeetup,
    deleteTripPermanently,
    haversineMeters,
    setTripVisibility,
    setTripDetails,
    getCommunityTrips,
    isMember,
    addMember,
    getUserTrips,
    getTripMembers,
    setTripActive,
    setMemberShare,
    updateLocation,
    setTripBudget,
    addItineraryItem,
    getItinerary,
    deleteItineraryItem,
    addExpense,
    deleteExpense,
    getExpensesSummary,
    createStory,
    getStoriesFeed,
    getStory,
    deleteStory,
    toggleStoryLike,
    getStoryComments,
    addStoryComment,
    updateProfile,
    getProfileWithStats,
    findTravelers,
    createInvite,
    getMyInvites,
    respondInvite,
};
