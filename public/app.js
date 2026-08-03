/* ==========================================================
   TripMate — client
   ========================================================== */

// ---------- device id: ระบุ "อุปกรณ์นี้" ให้คงที่ ไม่ว่าจะรีเฟรชกี่ครั้ง ----------
function getDeviceId() {
  let id = localStorage.getItem("tripmate_device_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    localStorage.setItem("tripmate_device_id", id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

// ---------- state ----------
let socket = null;
let map = null;
let markers = {};       // deviceId -> L.marker
let membersById = {};   // deviceId -> member object (ล่าสุดจาก server)
let currentTrip = null; // { id, name, ended_at }
let myName = "";
let watchId = null;
let tripEnded = false;

const $ = (sel) => document.querySelector(sel);

/* ============ Gate: สร้าง / เข้าร่วมทริป ============ */
const gateTabs = document.querySelectorAll(".gate-tab");
gateTabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    gateTabs.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("#form-create").classList.toggle("hidden", tab !== "create");
    $("#form-join").classList.toggle("hidden", tab !== "join");
    $("#gate-error").classList.add("hidden");
  });
});

function showGateError(msg) {
  const el = $("#gate-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

$("#form-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#create-name").value.trim();
  const tripName = $("#create-trip-name").value.trim();
  if (!name || !tripName) return;

  try {
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: tripName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "สร้างทริปไม่สำเร็จ");
    }
    const trip = await res.json();
    startSession(trip.id, name);
  } catch (err) {
    showGateError(err.message || "เกิดข้อผิดพลาด — ตรวจสอบว่าตั้งค่าฐานข้อมูล (DATABASE_URL) แล้วหรือยัง");
  }
});

$("#form-join").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#join-name").value.trim();
  const code = $("#join-code").value.trim().toUpperCase();
  if (!name || !code) return;
  startSession(code, name);
});

function startSession(tripId, name) {
  myName = name;
  sessionStorage.setItem("tripmate_trip_id", tripId);
  sessionStorage.setItem("tripmate_name", name);
  connectSocket(tripId, name);
}

/* ============ Socket connection ============ */
function connectSocket(tripId, name) {
  if (socket) socket.disconnect();

  socket = io();

  socket.on("connect", () => {
    setConnBadge(true);
    socket.emit("join-trip", { tripId, deviceId: DEVICE_ID, name });
  });

  socket.on("disconnect", () => setConnBadge(false));

  socket.on("join-error", (payload) => {
    const reasons = {
      not_found: "ไม่พบรหัสทริปนี้ — ตรวจสอบรหัสอีกครั้ง",
      missing_fields: "ข้อมูลไม่ครบ ลองใหม่อีกครั้ง",
      server_error: "เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง",
    };
    showGateError(reasons[payload?.reason] || "เข้าร่วมทริปไม่สำเร็จ");
  });

  socket.on("joined", (data) => {
    currentTrip = data.trip;
    tripEnded = !!data.trip.ended_at;
    enterApp();
    renderTripHeader();
    updateMembers(data.members);
    renderItinerary(data.itinerary);
    if (!tripEnded && data.me.gpsEnabled) startGeoWatch();
    syncGpsUiFromMe(data.me);
  });

  socket.on("members-update", (list) => {
    updateMembers(list);
    const me = list.find((m) => m.deviceId === DEVICE_ID);
    if (me) syncGpsUiFromMe(me);
  });

  socket.on("trip-ended", (trip) => {
    currentTrip = trip;
    tripEnded = true;
    stopGeoWatch();
    $("#trip-ended-banner").classList.remove("hidden");
    $("#end-trip-btn").disabled = true;
    $("#end-trip-btn").textContent = "ทริปจบแล้ว";
    $("#gps-toggle").checked = false;
    $("#gps-toggle").disabled = true;
    $("#gps-sub-text").textContent = "ปิดถาวร — ทริปจบแล้ว";
  });

  socket.on("gps-locked", () => {
    $("#gps-toggle").checked = false;
    $("#gps-sub-text").textContent = "ปิดถาวร — ทริปจบแล้ว";
  });

  socket.on("itinerary-created", (item) => addItineraryItem(item));
  socket.on("itinerary-updated", () => fetchItinerary());
  socket.on("itinerary-deleted", ({ id }) => {
    const el = document.querySelector(`[data-item-id="${id}"]`);
    if (el) el.remove();
    checkItineraryEmpty();
  });
}

function setConnBadge(online) {
  const el = $("#conn-status");
  el.textContent = online ? "เชื่อมต่อแล้ว" : "ขาดการเชื่อมต่อ";
  el.classList.toggle("conn-online", online);
  el.classList.toggle("conn-offline", !online);
}

function enterApp() {
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (!map) initMap();
}

function renderTripHeader() {
  $("#trip-name").textContent = currentTrip.name;
  $("#trip-code-value").textContent = currentTrip.id;
  if (currentTrip.ended_at) {
    tripEnded = true;
    $("#trip-ended-banner").classList.remove("hidden");
    $("#end-trip-btn").disabled = true;
    $("#end-trip-btn").textContent = "ทริปจบแล้ว";
  }
}

$("#copy-code").addEventListener("click", () => {
  if (!currentTrip) return;
  navigator.clipboard?.writeText(currentTrip.id);
  const btn = $("#copy-code");
  const old = btn.textContent;
  btn.textContent = "คัดลอกแล้ว!";
  setTimeout(() => (btn.textContent = old), 1500);
});

$("#end-trip-btn").addEventListener("click", async () => {
  if (!currentTrip) return;
  const ok = confirm(
    "จบทริปนี้ใช่ไหม?\nการกระทำนี้จะปิดการแชร์ตำแหน่งของสมาชิกทุกคนถาวร และเปิดกลับไม่ได้"
  );
  if (!ok) return;
  await fetch(`/api/trips/${currentTrip.id}/end`, { method: "POST" });
});

/* ============ Tabs ============ */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "map" && map) setTimeout(() => map.invalidateSize(), 50);
  });
});

/* ============ Map ============ */
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([13.7563, 100.5018], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
}

function colorIcon(color, faded) {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:16px;height:16px;border-radius:50%;
      background:${color};border:2.5px solid white;
      box-shadow:0 0 0 1px rgba(0,0,0,.25);
      opacity:${faded ? 0.4 : 1};"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function upsertMarker(m) {
  if (m.lat == null || m.lng == null) return;
  const faded = !m.online || !m.gpsEnabled || m.gpsStale;
  if (markers[m.deviceId]) {
    markers[m.deviceId].setLatLng([m.lat, m.lng]);
    markers[m.deviceId].setIcon(colorIcon(m.color, faded));
  } else {
    markers[m.deviceId] = L.marker([m.lat, m.lng], { icon: colorIcon(m.color, faded) }).addTo(map);
  }
  markers[m.deviceId].bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${statusLabel(m)}`);
}

$("#locate-btn").addEventListener("click", () => {
  const me = membersById[DEVICE_ID];
  if (me && me.lat != null && map) {
    map.setView([me.lat, me.lng], 15);
  }
});

/* ============ Members ============ */
function statusLabel(m) {
  if (!m.online) return "ออฟไลน์ — แสดงตำแหน่งล่าสุด";
  if (!m.gpsEnabled) return "ปิด GPS — แสดงตำแหน่งล่าสุด";
  if (m.gpsStale) return "ขาดการเชื่อมต่อสัญญาณ GPS";
  return "ออนไลน์";
}

function statusStampClass(m) {
  if (!m.online) return "stamp-offline";
  if (!m.gpsEnabled) return "stamp-off";
  if (m.gpsStale) return "stamp-stale";
  return "stamp-online";
}

function statusStampText(m) {
  if (!m.online) return "OFFLINE";
  if (!m.gpsEnabled) return "GPS OFF";
  if (m.gpsStale) return "NO SIGNAL";
  return "ON AIR";
}

function timeAgo(ts) {
  if (!ts) return "ไม่มีข้อมูล";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return "เมื่อสักครู่";
  if (sec < 60) return `${sec} วินาทีที่แล้ว`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  return `${hr} ชม.ที่แล้ว`;
}

function updateMembers(list) {
  membersById = {};
  list.forEach((m) => (membersById[m.deviceId] = m));

  $("#member-count").textContent = `(${list.length})`;

  const ul = $("#member-list");
  ul.innerHTML = "";
  list
    .slice()
    .sort((a, b) => (a.deviceId === DEVICE_ID ? -1 : b.deviceId === DEVICE_ID ? 1 : a.name.localeCompare(b.name)))
    .forEach((m) => {
      const li = document.createElement("li");
      li.className = "member-row";
      li.innerHTML = `
        <span class="member-dot" style="background:${m.color}"></span>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.name)}${m.deviceId === DEVICE_ID ? " (คุณ)" : ""}</div>
          <div class="member-meta">${timeAgo(m.lastLocationAt)}</div>
        </div>
        <span class="stamp ${statusStampClass(m)}">${statusStampText(m)}</span>
      `;
      ul.appendChild(li);
      upsertMarker(m);
    });
}

/* ============ GPS toggle + geolocation ============ */
const gpsToggle = $("#gps-toggle");

gpsToggle.addEventListener("change", () => {
  if (tripEnded) {
    gpsToggle.checked = false;
    return;
  }
  const enabled = gpsToggle.checked;
  socket.emit("toggle-gps", { enabled });
  if (enabled) startGeoWatch();
  else stopGeoWatch();
  updateGpsSubText(enabled, null);
});

function syncGpsUiFromMe(me) {
  if (tripEnded) {
    gpsToggle.checked = false;
    gpsToggle.disabled = true;
    updateGpsSubText(false, "ปิดถาวร — ทริปจบแล้ว");
    return;
  }
  gpsToggle.checked = !!me.gpsEnabled;
  gpsToggle.disabled = false;
  updateGpsSubText(me.gpsEnabled, me.gpsEnabled ? (me.gpsStale ? "ขาดการเชื่อมต่อสัญญาณ" : "กำลังแชร์ตำแหน่ง") : "ปิดอยู่");
  if (me.gpsEnabled && watchId == null) startGeoWatch();
  if (!me.gpsEnabled) stopGeoWatch();
}

function updateGpsSubText(enabled, text) {
  $("#gps-sub-text").textContent = text || (enabled ? "กำลังแชร์ตำแหน่ง" : "ปิดอยู่");
}

function startGeoWatch() {
  if (watchId != null) return;
  if (!navigator.geolocation) {
    updateGpsSubText(false, "เบราว์เซอร์นี้ไม่รองรับ GPS");
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      socket.emit("send-location", {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
    },
    (err) => {
      console.warn("Geolocation error:", err.message);
      updateGpsSubText(true, "ไม่สามารถอ่านตำแหน่งได้ (เช็คสิทธิ์การเข้าถึง)");
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopGeoWatch() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

/* ============ Itinerary ============ */
$("#itinerary-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentTrip) return;

  const payload = {
    title: $("#it-title").value.trim(),
    locationName: $("#it-location").value.trim(),
    description: $("#it-desc").value.trim(),
    startTime: $("#it-start").value || null,
    endTime: $("#it-end").value || null,
    deviceId: DEVICE_ID,
  };
  if (!payload.title) return;

  const res = await fetch(`/api/trips/${currentTrip.id}/itinerary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    e.target.reset();
  }
});

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

function addItineraryItem(item) {
  $("#itinerary-empty").classList.add("hidden");
  const li = document.createElement("li");
  li.className = "itinerary-item";
  li.dataset.itemId = item.id;
  const timeStr = [fmtDateTime(item.start_time), fmtDateTime(item.end_time)].filter(Boolean).join(" – ");
  li.innerHTML = `
    <div>
      <h3>${escapeHtml(item.title)}</h3>
      ${item.location_name ? `<p>📍 ${escapeHtml(item.location_name)}</p>` : ""}
      ${timeStr ? `<p class="it-time">🕒 ${timeStr}</p>` : ""}
      ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
    </div>
    <button class="it-delete" data-id="${item.id}">ลบ</button>
  `;
  li.querySelector(".it-delete").addEventListener("click", async () => {
    await fetch(`/api/itinerary/${item.id}`, { method: "DELETE" });
  });
  $("#itinerary-list").prepend(li);
}

function checkItineraryEmpty() {
  const list = $("#itinerary-list");
  $("#itinerary-empty").classList.toggle("hidden", list.children.length > 0);
}

function renderItinerary(items) {
  $("#itinerary-list").innerHTML = "";
  items.forEach(addItineraryItem);
  checkItineraryEmpty();
}

async function fetchItinerary() {
  if (!currentTrip) return;
  const res = await fetch(`/api/trips/${currentTrip.id}/itinerary`);
  if (res.ok) renderItinerary(await res.json());
}

/* ============ utils ============ */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// รีเฟรชสถานะ "ขาดการเชื่อมต่อสัญญาณ" ทุก ๆ 5 วิ แม้ไม่มี event ใหม่เข้ามา
setInterval(() => {
  if (Object.keys(membersById).length) updateMembers(Object.values(membersById));
}, 5000);
