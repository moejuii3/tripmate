const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "tripmate.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    created_by  TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,   -- 1 = ทริปเปิดอยู่ (รับ GPS ได้) / 0 = ปิด/เก็บเข้าคลัง
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ผู้ใช้หนึ่งคนเข้าร่วมได้หลายทริป และแต่ละทริปมีสวิตช์แชร์ตำแหน่งของตัวเอง
CREATE TABLE IF NOT EXISTS trip_members (
    trip_id         TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    color           TEXT NOT NULL,
    share_enabled   INTEGER NOT NULL DEFAULT 1, -- toggle เปิด/ปิด GPS รายทริป
    lat             REAL,
    lng             REAL,
    last_update     INTEGER,
    joined_at       INTEGER NOT NULL,
    PRIMARY KEY (trip_id, user_id),
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

const COLORS = [
    "#ef4444", "#3b82f6", "#22c55e", "#f59e0b",
    "#a855f7", "#ec4899", "#14b8a6", "#eab308",
];

function genCode() {
    // รหัสเข้าร่วมทริป 6 หลัก อ่านง่าย ไม่มีตัวที่สับสน (0/O, 1/I)
    const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
function upsertUser(id, name) {
    const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (existing) {
        if (name && name !== existing.name) {
            db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
        }
        return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    }
    db.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)")
        .run(id, name, Date.now());
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

// ---------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------
function createTrip(name, userId) {
    const id = require("crypto").randomUUID();
    let code = genCode();
    while (db.prepare("SELECT 1 FROM trips WHERE code = ?").get(code)) code = genCode();

    const now = Date.now();
    db.prepare(
        "INSERT INTO trips (id, name, code, created_by, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run(id, name, code, userId, now);

    addMember(id, userId);
    return getTrip(id);
}

function getTrip(tripId) {
    return db.prepare("SELECT * FROM trips WHERE id = ?").get(tripId);
}

function getTripByCode(code) {
    return db.prepare("SELECT * FROM trips WHERE code = ?").get(code.toUpperCase());
}

function addMember(tripId, userId) {
    const existing = db
        .prepare("SELECT * FROM trip_members WHERE trip_id = ? AND user_id = ?")
        .get(tripId, userId);
    if (existing) return existing;

    const memberCount = db
        .prepare("SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ?")
        .get(tripId).n;
    const color = COLORS[memberCount % COLORS.length];

    db.prepare(
        `INSERT INTO trip_members (trip_id, user_id, color, share_enabled, joined_at)
         VALUES (?, ?, ?, 1, ?)`
    ).run(tripId, userId, color, Date.now());

    return db
        .prepare("SELECT * FROM trip_members WHERE trip_id = ? AND user_id = ?")
        .get(tripId, userId);
}

function isMember(tripId, userId) {
    return !!db
        .prepare("SELECT 1 FROM trip_members WHERE trip_id = ? AND user_id = ?")
        .get(tripId, userId);
}

// ทริปทั้งหมดที่ user คนนี้เข้าร่วม (รองรับหลายทริปพร้อมกัน)
function getUserTrips(userId) {
    return db
        .prepare(
            `SELECT t.id, t.name, t.code, t.is_active, t.created_at, t.created_by,
                    tm.share_enabled, tm.color,
                    (SELECT COUNT(*) FROM trip_members WHERE trip_id = t.id) AS member_count
             FROM trips t
             JOIN trip_members tm ON tm.trip_id = t.id
             WHERE tm.user_id = ?
             ORDER BY t.is_active DESC, t.created_at DESC`
        )
        .all(userId);
}

function getTripMembers(tripId) {
    return db
        .prepare(
            `SELECT tm.user_id AS id, u.name, tm.color, tm.share_enabled,
                    tm.lat, tm.lng, tm.last_update
             FROM trip_members tm
             JOIN users u ON u.id = tm.user_id
             WHERE tm.trip_id = ?`
        )
        .all(tripId);
}

// เปิด/ปิด "สวิตช์ใหญ่" ของทริป — ทริปที่ปิดแล้ว (เช่นทริปเก่า) จะไม่รับ/ส่งพิกัด GPS อีก
function setTripActive(tripId, isActive) {
    db.prepare("UPDATE trips SET is_active = ?, closed_at = ? WHERE id = ?").run(
        isActive ? 1 : 0,
        isActive ? null : Date.now(),
        tripId
    );
    return getTrip(tripId);
}

// เปิด/ปิดการแชร์ตำแหน่งของ "ผู้ใช้คนนี้" เฉพาะในทริปนี้ (คนเดียวอยู่ได้หลายทริป เลือกแชร์เป็นรายทริป)
function setMemberShare(tripId, userId, enabled) {
    db.prepare(
        "UPDATE trip_members SET share_enabled = ? WHERE trip_id = ? AND user_id = ?"
    ).run(enabled ? 1 : 0, tripId, userId);

    if (!enabled) {
        // เคลียร์พิกัดล่าสุดออกเมื่อปิดแชร์ ป้องกันหมุดค้างอยู่บนแผนที่คนอื่น
        db.prepare(
            "UPDATE trip_members SET lat = NULL, lng = NULL WHERE trip_id = ? AND user_id = ?"
        ).run(tripId, userId);
    }
}

function updateLocation(tripId, userId, lat, lng) {
    db.prepare(
        `UPDATE trip_members SET lat = ?, lng = ?, last_update = ?
         WHERE trip_id = ? AND user_id = ?`
    ).run(lat, lng, Date.now(), tripId, userId);
}

module.exports = {
    db,
    upsertUser,
    createTrip,
    getTrip,
    getTripByCode,
    addMember,
    isMember,
    getUserTrips,
    getTripMembers,
    setTripActive,
    setMemberShare,
    updateLocation,
};
