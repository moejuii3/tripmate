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

// แปลงแถว trip จาก DB -> รูปแบบ JSON ที่ฝั่งหน้าเว็บ (public/app.js) คาดหวัง
function shapeTrip(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        code: row.id, // id ของทริปทำหน้าที่เป็นรหัสเชิญไปในตัว
        is_active: row.ended_at == null,
        created_at: toEpoch(row.created_at),
        closed_at: toEpoch(row.ended_at),
    };
}

function shapeMember(row) {
    return {
        id: row.device_id,
        name: row.name,
        color: row.color,
        share_enabled: !!row.gps_enabled,
        lat: row.current_lat,
        lng: row.current_lng,
        last_update: toEpoch(row.last_location_at),
    };
}

// ---------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------
async function createTrip(name, deviceId, memberName) {
    assertEnabled();

    let id = genTripId();
    for (let i = 0; i < 5; i++) {
        const { rows } = await query("SELECT 1 FROM trips WHERE id = $1", [id]);
        if (rows.length === 0) break;
        id = genTripId();
    }

    await query("INSERT INTO trips (id, name) VALUES ($1, $2)", [id, name]);
    await addMember(id, deviceId, memberName);
    return getTrip(id);
}

async function getTrip(tripId) {
    assertEnabled();
    const { rows } = await query("SELECT * FROM trips WHERE id = $1", [tripId]);
    return shapeTrip(rows[0]);
}

async function isMember(tripId, deviceId) {
    assertEnabled();
    const { rows } = await query(
        "SELECT 1 FROM members WHERE trip_id = $1 AND device_id = $2",
        [tripId, deviceId]
    );
    return rows.length > 0;
}

async function addMember(tripId, deviceId, memberName) {
    assertEnabled();

    const existing = await query(
        "SELECT 1 FROM members WHERE trip_id = $1 AND device_id = $2",
        [tripId, deviceId]
    );
    if (existing.rows.length > 0) {
        await query(
            "UPDATE members SET name = $3, last_seen = now() WHERE trip_id = $1 AND device_id = $2",
            [tripId, deviceId, memberName || "Guest"]
        );
        return;
    }

    const countRes = await query("SELECT COUNT(*)::int AS n FROM members WHERE trip_id = $1", [tripId]);
    const color = COLORS[countRes.rows[0].n % COLORS.length];
    const id = `${tripId}:${deviceId}`;

    await query(
        `INSERT INTO members (id, trip_id, device_id, name, color, gps_enabled)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [id, tripId, deviceId, memberName || "Guest", color]
    );
}

// ทริปทั้งหมดที่ device นี้เข้าร่วม (รองรับหลายทริปพร้อมกัน)
async function getDeviceTrips(deviceId) {
    assertEnabled();
    const { rows } = await query(
        `SELECT t.id, t.name, t.created_at, t.ended_at,
                m.gps_enabled, m.color,
                (SELECT COUNT(*) FROM members WHERE trip_id = t.id) AS member_count
         FROM trips t
         JOIN members m ON m.trip_id = t.id
         WHERE m.device_id = $1
         ORDER BY (t.ended_at IS NULL) DESC, t.created_at DESC`,
        [deviceId]
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
        `SELECT device_id, name, color, gps_enabled, current_lat, current_lng, last_location_at
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
async function setMemberShare(tripId, deviceId, enabled) {
    assertEnabled();
    if (enabled) {
        await query(
            "UPDATE members SET gps_enabled = true WHERE trip_id = $1 AND device_id = $2",
            [tripId, deviceId]
        );
    } else {
        // เคลียร์พิกัดล่าสุดออกเมื่อปิดแชร์ ป้องกันหมุดค้างอยู่บนแผนที่คนอื่น
        await query(
            `UPDATE members SET gps_enabled = false, current_lat = NULL, current_lng = NULL
             WHERE trip_id = $1 AND device_id = $2`,
            [tripId, deviceId]
        );
    }
}

async function updateLocation(tripId, deviceId, lat, lng) {
    assertEnabled();
    await query(
        `UPDATE members SET current_lat = $3, current_lng = $4, last_location_at = now(), last_seen = now()
         WHERE trip_id = $1 AND device_id = $2`,
        [tripId, deviceId, lat, lng]
    );
}

module.exports = {
    createTrip,
    getTrip,
    isMember,
    addMember,
    getDeviceTrips,
    getTripMembers,
    setTripActive,
    setMemberShare,
    updateLocation,
};
