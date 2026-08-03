const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// ตั้งค่าการเชื่อมต่อผ่าน environment variable เดียว: DATABASE_URL
// ตัวอย่าง: postgres://user:password@localhost:5432/tripmate
// ถ้าไม่ได้ตั้งค่าไว้ แอปจะยังรันได้ (real-time location ทำงานปกติ)
// แต่ฟีเจอร์ที่ต้องใช้ฐานข้อมูล (ประวัติ/กำหนดการ) จะถูกปิดใช้งาน
const connectionString = process.env.DATABASE_URL;

let pool = null;

if (connectionString) {
    pool = new Pool({
        connectionString,
        ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
    });

    pool.on("error", (err) => {
        console.error("[db] Unexpected Postgres error:", err.message);
    });
}

function isEnabled() {
    return pool !== null;
}

async function query(text, params) {
    if (!pool) {
        throw new Error("Database is not configured (missing DATABASE_URL)");
    }
    return pool.query(text, params);
}

// รัน schema.sql เพื่อสร้างตารางถ้ายังไม่มี (idempotent, ปลอดภัยที่จะรันซ้ำ)
async function init() {
    if (!pool) {
        console.warn(
            "[db] DATABASE_URL is not set — running without persistence. " +
            "Set DATABASE_URL to enable itinerary & history features."
        );
        return;
    }

    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");

    try {
        await pool.query(schemaSql);
        console.log("[db] Connected to PostgreSQL and schema is ready.");
    } catch (err) {
        console.error("[db] Failed to initialize schema:", err.message);
        throw err;
    }
}

module.exports = { pool, query, init, isEnabled };
