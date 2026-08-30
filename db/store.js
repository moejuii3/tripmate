const crypto = require("crypto");
const { query, isEnabled } = require("./index");

const COLORS = [
    "#ef4444", "#3b82f6", "#22c55e", "#f59e0b",
    "#a855f7", "#ec4899", "#14b8a6", "#eab308",
];

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

    await query("INSERT INTO trips (id, name) VALUES ($1, $2)", [id, name]);
    await addMember(id, userId, memberName);
    return getTrip(id);
}

async function getTrip(tripId) {
    assertEnabled();
    const { rows } = await query("SELECT * FROM trips WHERE id = $1", [tripId]);
    return shapeTrip(rows[0]);
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
        `SELECT t.id, t.name, t.created_at, t.ended_at,
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
        `SELECT user_id, name, color, gps_enabled, current_lat, current_lng, last_location_at
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
    await query(
        `UPDATE members SET current_lat = $3, current_lng = $4, last_location_at = now(), last_seen = now()
         WHERE trip_id = $1 AND user_id = $2`,
        [tripId, userId, lat, lng]
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
        start_time: toEpoch(row.start_time),
        end_time: toEpoch(row.end_time),
        created_by_name: row.created_by_name,
    };
}

async function addItineraryItem(tripId, item, memberId, memberName) {
    assertEnabled();
    const { rows } = await query(
        `INSERT INTO itinerary_items
            (trip_id, title, description, location_name, category, start_time, end_time, created_by, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            tripId,
            item.title,
            item.description || null,
            item.location_name || null,
            item.category || "other",
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

module.exports = {
    createUser,
    findUserByUsername,
    findUserById,
    createTrip,
    getTrip,
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
};
