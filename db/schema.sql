-- ============================================================
-- TripMate database schema (PostgreSQL)
-- รันไฟล์นี้อัตโนมัติตอนสตาร์ทเซิร์ฟเวอร์ (db/index.js -> init())
-- ทุกคำสั่งใช้ IF NOT EXISTS จึงรันซ้ำได้อย่างปลอดภัย
-- ============================================================

-- ---------------------------------------------------------------
-- trips: หนึ่งแถว = หนึ่งทริป มี "รหัสทริป" (id) ให้แชร์ต่อกันเข้าร่วม
-- ended_at ไม่ใช่ NULL แปลว่าทริปนี้ "จบแล้ว" -> ปิด GPS ถาวรของทุกคนในทริป
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
    id          TEXT PRIMARY KEY,              -- รหัสทริป เช่น "A7K9QZ"
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ                    -- NULL = ยังดำเนินอยู่, มีค่า = จบแล้ว
);

-- ---------------------------------------------------------------
-- members: สมาชิกของแต่ละทริป
-- id = "<trip_id>:<device_id>"  -> คนคนเดียวกัน (device_id เดิม) เข้าได้หลายทริป
--       เพราะแต่ละทริปจะได้แถวของตัวเอง แต่ถ้าเข้าทริปเดิมซ้ำ (เช่นรีเฟรชหน้าเว็บ)
--       จะอัปเดตแถวเดิม ไม่สร้างซ้ำ (ดู ON CONFLICT ใน server.js)
-- gps_enabled = ผู้ใช้กดเปิด/ปิดแชร์ตำแหน่งเอง (true/false)
-- last_location_at = เวลาที่ "พิกัด" ถูกอัปเดตจริง ๆ ครั้งล่าสุด (ไว้เช็คว่าขาดสัญญาณ)
-- last_seen = เวลาที่เห็นความเคลื่อนไหวล่าสุดของสมาชิก (ออนไลน์/ออฟไลน์)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
    id                TEXT PRIMARY KEY,
    trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    device_id         TEXT NOT NULL,
    name              TEXT NOT NULL,
    color             TEXT NOT NULL,
    gps_enabled       BOOLEAN NOT NULL DEFAULT true,
    current_lat       DOUBLE PRECISION,
    current_lng       DOUBLE PRECISION,
    last_location_at  TIMESTAMPTZ,
    joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_members_trip ON members (trip_id);

-- หมายเหตุ: ตั้งใจไม่เก็บ "ประวัติ" พิกัดย้อนหลังเลย เก็บเฉพาะตำแหน่งปัจจุบัน
-- (คอลัมน์ current_lat / current_lng / last_location_at ในตาราง members ด้านบน)
-- เพื่อประหยัดพื้นที่ฐานข้อมูล — พิกัดเก่าจะถูกเขียนทับด้วยพิกัดใหม่ทุกครั้ง ไม่สะสม

-- ---------------------------------------------------------------
-- itinerary_items: กำหนดการเดินทางของแต่ละทริป
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS itinerary_items (
    id              BIGSERIAL PRIMARY KEY,
    trip_id         TEXT REFERENCES trips(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    location_name   TEXT,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    start_time      TIMESTAMPTZ,
    end_time        TIMESTAMPTZ,
    created_by      TEXT REFERENCES members(id) ON DELETE SET NULL,
    created_by_name TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_itinerary_trip ON itinerary_items (trip_id);
CREATE INDEX IF NOT EXISTS idx_itinerary_start_time
    ON itinerary_items (start_time ASC NULLS LAST, created_at ASC);
