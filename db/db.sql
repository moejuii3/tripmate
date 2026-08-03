-- TripMate database schema (PostgreSQL)

-- ทุกครั้งที่มีคนเข้าร่วมทริป จะถูกบันทึกเป็นแถวใหม่ในตารางนี้ (log การเข้าร่วม)
CREATE TABLE IF NOT EXISTS members (
    id           TEXT PRIMARY KEY,               -- socket.id ของผู้ใช้ในเซสชันนั้น ๆ
    name         TEXT NOT NULL,
    color        TEXT NOT NULL,
    current_lat  DOUBLE PRECISION,
    current_lng  DOUBLE PRECISION,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ประวัติตำแหน่งทั้งหมด (เก็บทุกจุดที่ผู้ใช้ส่งเข้ามา ไว้ทำ playback / รายงานย้อนหลังได้)
CREATE TABLE IF NOT EXISTS locations (
    id           BIGSERIAL PRIMARY KEY,
    member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    lat          DOUBLE PRECISION NOT NULL,
    lng          DOUBLE PRECISION NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_locations_member_time
    ON locations (member_id, recorded_at DESC);

-- กำหนดการเดินทาง (Itinerary) ของทริป
CREATE TABLE IF NOT EXISTS itinerary_items (
    id             BIGSERIAL PRIMARY KEY,
    title          TEXT NOT NULL,
    description    TEXT,
    location_name  TEXT,
    lat            DOUBLE PRECISION,
    lng            DOUBLE PRECISION,
    start_time     TIMESTAMPTZ,
    end_time       TIMESTAMPTZ,
    created_by     TEXT REFERENCES members(id) ON DELETE SET NULL,
    created_by_name TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_itinerary_start_time
    ON itinerary_items (start_time ASC NULLS LAST, created_at ASC);
