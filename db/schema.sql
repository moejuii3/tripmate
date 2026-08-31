-- ============================================================
-- TripMate database schema (PostgreSQL)
-- รันไฟล์นี้อัตโนมัติตอนสตาร์ทเซิร์ฟเวอร์ (db/index.js -> init())
-- ทุกคำสั่งใช้ IF NOT EXISTS จึงรันซ้ำได้อย่างปลอดภัย
-- ============================================================

-- ---------------------------------------------------------------
-- users: บัญชีผู้ใช้จริง (สมัคร/เข้าสู่ระบบด้วย username + password)
-- password_hash เก็บด้วย bcrypt เท่านั้น ห้ามเก็บรหัสผ่านตรงๆ เด็ดขาด
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
-- id = "<trip_id>:<user_id>"  -> คนคนเดียวกัน (บัญชีเดิม) เข้าได้หลายทริป
--       เพราะแต่ละทริปจะได้แถวของตัวเอง แต่ถ้าเข้าทริปเดิมซ้ำ (เช่นรีเฟรชหน้าเว็บ)
--       จะอัปเดตแถวเดิม ไม่สร้างซ้ำ (ดู ON CONFLICT ใน server.js)
-- user_id = ผู้ใช้ที่ล็อกอินอยู่ (อ้างอิงตาราง users) แทนที่จะเป็น device id แบบเดิม
-- gps_enabled = ผู้ใช้กดเปิด/ปิดแชร์ตำแหน่งเอง (true/false)
-- last_location_at = เวลาที่ "พิกัด" ถูกอัปเดตจริง ๆ ครั้งล่าสุด (ไว้เช็คว่าขาดสัญญาณ)
-- last_seen = เวลาที่เห็นความเคลื่อนไหวล่าสุดของสมาชิก (ออนไลน์/ออฟไลน์)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
    id                TEXT PRIMARY KEY,
    trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_members_user ON members (user_id);

-- หมายเหตุ: ตั้งใจไม่เก็บ "ประวัติ" พิกัดย้อนหลังเลย เก็บเฉพาะตำแหน่งปัจจุบัน
-- (คอลัมน์ current_lat / current_lng / last_location_at ในตาราง members ด้านบน)
-- เพื่อประหยัดพื้นที่ฐานข้อมูล — พิกัดเก่าจะถูกเขียนทับด้วยพิกัดใหม่ทุกครั้ง ไม่สะสม

-- ---------------------------------------------------------------
-- trips.budget: งบประมาณของทริป (ไม่บังคับ) ใช้คำนวณ progress bar ในหน้าค่าใช้จ่าย
-- ---------------------------------------------------------------
ALTER TABLE trips ADD COLUMN IF NOT EXISTS budget NUMERIC(12,2);

-- ---------------------------------------------------------------
-- itinerary_items: กำหนดการเดินทางของแต่ละทริป
-- category = ไอคอนหมวดกิจกรรม (sight / food / transport / hotel / activity / other)
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
ALTER TABLE itinerary_items ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';

CREATE INDEX IF NOT EXISTS idx_itinerary_trip ON itinerary_items (trip_id);
CREATE INDEX IF NOT EXISTS idx_itinerary_start_time
    ON itinerary_items (start_time ASC NULLS LAST, created_at ASC);

-- ---------------------------------------------------------------
-- expenses: ค่าใช้จ่ายของทริป — หารเท่ากันระหว่าง "สมาชิกทั้งหมดในทริป ณ ตอนนี้" เสมอ
-- (โมเดลง่ายที่สุด: ไม่เก็บ per-split ล่วงหน้า คำนวณสดจากจำนวนสมาชิกปัจจุบันตอนสรุปยอด)
-- category = หมวดหมู่ (food / transport / activity / stay / drinks / shopping / other)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
    id            BIGSERIAL PRIMARY KEY,
    trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    description   TEXT NOT NULL,
    amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    category      TEXT NOT NULL DEFAULT 'other',
    paid_by       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses (trip_id);

-- ---------------------------------------------------------------
-- Phase 2: Explore / Community Trips
-- visibility = 'private' (ค่าเริ่มต้น เห็นเฉพาะสมาชิก) หรือ 'public' (ค้นหาเจอในหน้า Explore)
-- destination / description = ข้อมูลโชว์ในการ์ด Explore (ไม่บังคับกรอก)
-- ---------------------------------------------------------------
ALTER TABLE trips ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_trips_visibility ON trips (visibility) WHERE visibility = 'public';

-- ---------------------------------------------------------------
-- Phase 3: Travel Stories — ฟีดเรื่องเล่าทริป (รูป + แคปชั่น + แท็ก)
-- image_url เป็นลิงก์รูปเท่านั้น (ยังไม่มีระบบอัปโหลดไฟล์)
-- trip_id ไม่บังคับ ผูกกับทริปได้ถ้าอยากอ้างอิงว่าเป็นเรื่องจากทริปไหน
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stories (
    id          BIGSERIAL PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trip_id     TEXT REFERENCES trips(id) ON DELETE SET NULL,
    image_url   TEXT NOT NULL,
    caption     TEXT,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stories_created ON stories (created_at DESC);

CREATE TABLE IF NOT EXISTS story_likes (
    story_id    BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS story_comments (
    id          BIGSERIAL PRIMARY KEY,
    story_id    BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_story_comments_story ON story_comments (story_id, created_at ASC);

-- ---------------------------------------------------------------
-- Phase 4: Profile + Find Travelers
-- discoverable = ผู้ใช้เปิดสวิตช์ยินยอมให้คนอื่นค้นหาเจอในหน้า Find Travelers เอง (ปิดเป็นค่าเริ่มต้น เพื่อความเป็นส่วนตัว)
-- interests = แท็กความสนใจ ใช้ทั้งแสดงผลและคำนวณ % match แบบง่ายๆ (นับแท็กที่ตรงกัน)
-- ---------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_text TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------
-- trip_invites: คำเชิญเข้าทริป — ผู้ถูกเชิญต้องกดตอบรับเองถึงจะเข้าร่วมจริง (ไม่เพิ่มสมาชิกให้เฉยๆ)
-- UNIQUE(trip_id, to_user_id) กันเชิญซ้ำหลายรอบขณะที่คำเชิญเดิมยังค้างอยู่
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_invites (
    id            BIGSERIAL PRIMARY KEY,
    trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    from_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending / accepted / declined
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at  TIMESTAMPTZ,
    UNIQUE (trip_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_invites_to_user ON trip_invites (to_user_id, status);

-- ---------------------------------------------------------------
-- Phase 5: Trip fields (วันที่/หัวหน้าทริป/รูปปกอัปโหลดจริง/จุดนัดหมาย) + Route + Distance + Alerts
--
-- host_user_id = "หัวหน้าทริป" (ผู้สร้างทริป) มีสิทธิ์พิเศษ: แก้ชื่อ/วันที่/รูปปก และลบทริปถาวร
--   ตั้งใจใช้คำว่า "host" ไม่ใช่ "owner" กันชนกับ role เจ้าของเว็บไซต์ในอนาคต
-- cover_image_path = path ไฟล์รูปปกที่อัปโหลดเก็บบนเครื่อง server เอง (เช่น /uploads/covers/xxx.jpg)
-- meetup_* = จุดนัดหมายของทริป (ไม่บังคับ) ใช้คำนวณระยะห่างของสมาชิกแต่ละคนจากจุดนัดหมาย
-- ---------------------------------------------------------------
ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS host_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS cover_image_path TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS meetup_name TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS meetup_lat DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS meetup_lng DOUBLE PRECISION;

-- ทริปเก่าที่สร้างไว้ก่อนมีคอลัมน์นี้ (host_user_id เป็น NULL) ให้ตั้งสมาชิกที่เข้าร่วมก่อนสุดเป็นหัวหน้าแทน
-- เพื่อไม่ให้ทริปเก่ากลายเป็น "ไม่มีหัวหน้า" แล้วลบไม่ได้เลย
UPDATE trips t SET host_user_id = (
    SELECT user_id FROM members WHERE trip_id = t.id ORDER BY joined_at ASC LIMIT 1
) WHERE t.host_user_id IS NULL;

-- lat/lng ของ itinerary_items มีอยู่แล้วในตารางเดิม (ดูด้านบน) แต่ API ไม่เคยส่งค่าเข้ามา
-- Phase 5 แก้ที่ server.js/app.js ให้ส่ง lat/lng จริงตอนเพิ่มกิจกรรม เพื่อพล็อตเส้นทาง (Route) บนแผนที่ได้

-- track "เคลื่อนที่ล่าสุด" แยกจาก "อัปเดตพิกัดล่าสุด" — เพื่อตรวจจับ "ไม่มีการเคลื่อนที่" (Location Alert)
-- last_location_at จะอัปเดตทุกครั้งที่ส่ง GPS เข้ามา (แม้ตำแหน่งเดิม)
-- last_moved_at จะอัปเดตเฉพาะตอนตำแหน่งเปลี่ยนไปเกิน ~15 เมตรเท่านั้น
ALTER TABLE members ADD COLUMN IF NOT EXISTS last_moved_at TIMESTAMPTZ;
