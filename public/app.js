/* ---------------------------------------------------
   0) Auth state — token ที่ได้จากล็อกอิน/สมัครสมาชิก เก็บใน localStorage
--------------------------------------------------- */
let authToken = localStorage.getItem("tripmate:token") || null;
let me = null; // { id, username }

let socket = null;
let myTrips = [];
let currentTrip = null; // { id, name, code, is_active, share_enabled, ... }
let map;
let myMarker;
const markers = {}; // user_id -> { marker, data }
let watchId = null;
let firstFix = true;

async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
        // token หมดอายุ/ไม่ถูกต้อง -> เด้งกลับไปหน้าล็อกอิน
        doLogout();
        throw new Error(data.error || "กรุณาเข้าสู่ระบบใหม่");
    }
    if (!res.ok) throw new Error(data.error || "เกิดข้อผิดพลาด");
    return data;
}

/* ---------------------------------------------------
   1) Auth screen — สลับแท็บ login / register
--------------------------------------------------- */
const authOverlay = document.getElementById("auth-overlay");
const authTabLogin = document.getElementById("auth-tab-login");
const authTabRegister = document.getElementById("auth-tab-register");
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const authErrorEl = document.getElementById("auth-error");
const tripsOverlay = document.getElementById("trips-overlay");
const appEl = document.getElementById("app");

function showAuthTab(tab) {
    authErrorEl.hidden = true;
    const isLogin = tab === "login";
    authTabLogin.classList.toggle("active", isLogin);
    authTabRegister.classList.toggle("active", !isLogin);
    loginForm.hidden = !isLogin;
    registerForm.hidden = isLogin;
}
authTabLogin.addEventListener("click", () => showAuthTab("login"));
authTabRegister.addEventListener("click", () => showAuthTab("register"));

function showAuthError(msg) {
    authErrorEl.textContent = msg;
    authErrorEl.hidden = false;
}

loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    try {
        const data = await api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password }),
        });
        onAuthSuccess(data.token, data.user);
    } catch (err) {
        showAuthError(err.message);
    }
});

registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("register-username").value.trim();
    const password = document.getElementById("register-password").value;
    try {
        const data = await api("/api/auth/register", {
            method: "POST",
            body: JSON.stringify({ username, password }),
        });
        onAuthSuccess(data.token, data.user);
    } catch (err) {
        showAuthError(err.message);
    }
});

function onAuthSuccess(token, user) {
    authToken = token;
    me = user;
    localStorage.setItem("tripmate:token", token);
    authOverlay.style.display = "none";
    connectSocket();
    openTripPicker();
}

function doLogout() {
    authToken = null;
    me = null;
    localStorage.removeItem("tripmate:token");
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    stopWatchingPosition();
    currentTrip = null;
    appEl.hidden = true;
    tripsOverlay.hidden = true;
    authOverlay.style.display = "flex";
    showAuthTab("login");
}

document.getElementById("logout-btn").addEventListener("click", doLogout);
document.getElementById("logout-btn-2").addEventListener("click", doLogout);

async function boot() {
    if (!authToken) {
        authOverlay.style.display = "flex";
        return;
    }
    try {
        const { user } = await api("/api/auth/me");
        me = user;
        authOverlay.style.display = "none";
        connectSocket();
        await openTripPicker();
    } catch (err) {
        authOverlay.style.display = "flex";
    }
}
boot();

/* ---------------------------------------------------
   2) Socket.io — ยืนยันตัวตนด้วย token ตอนเชื่อมต่อ
--------------------------------------------------- */
function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token: authToken } });

    socket.on("connect", () => {
        setConnStatus("online");
        if (currentTrip) socket.emit("join-trip", { tripId: currentTrip.id });
    });
    socket.on("disconnect", () => setConnStatus("offline"));
    socket.on("connect_error", () => setConnStatus("offline"));

    socket.on("trip-active-changed", ({ tripId, isActive }) => {
        if (currentTrip && currentTrip.id === tripId) {
            currentTrip.is_active = isActive;
            updateTripStatusUI(isActive);
            updateShareToggleUI(currentTrip.share_enabled);
            if (!isActive) stopWatchingPosition();
        }
    });

    socket.on("users-location", ({ trip, members }) => {
        if (!currentTrip || (trip && trip.id !== currentTrip.id)) return;

        const activeMembers = members.filter((m) => m.lat != null && m.lng != null);
        const seen = new Set();

        for (const u of activeMembers) {
            if (u.id === me.id) continue; // ตัวเองใช้ myMarker แยก
            seen.add(u.id);

            if (!markers[u.id]) {
                const icon = L.divIcon({
                    className: "",
                    html: `<div style="width:16px;height:16px;border-radius:50%;background:${u.color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4);"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                });
                const marker = L.marker([u.lat, u.lng], { icon }).addTo(map);
                marker.bindPopup(`${u.name}`);
                markers[u.id] = { marker, data: u };
            } else {
                markers[u.id].marker.setLatLng([u.lat, u.lng]);
                markers[u.id].data = u;
            }
        }

        for (const id in markers) {
            if (!seen.has(id)) {
                map.removeLayer(markers[id].marker);
                delete markers[id];
            }
        }

        renderMemberList(members);
    });
}

/* ---------------------------------------------------
   3) Trip picker — สร้าง/เข้าร่วม/เลือกทริป (รองรับหลายทริป)
--------------------------------------------------- */
const tripListEl = document.getElementById("trip-list");
const createTripForm = document.getElementById("create-trip-form");
const createTripNameInput = document.getElementById("create-trip-name");
const joinTripForm = document.getElementById("join-trip-form");
const joinTripCodeInput = document.getElementById("join-trip-code");
const tripsErrorEl = document.getElementById("trips-error");
const backToTripsBtn = document.getElementById("back-to-trips");

async function refreshMyTrips() {
    const data = await api("/api/whoami", { method: "POST" });
    myTrips = data.trips;
    return myTrips;
}

async function openTripPicker() {
    appEl.hidden = true;
    stopWatchingPosition();
    if (currentTrip) {
        socket.emit("leave-trip");
        currentTrip = null;
    }
    tripsOverlay.hidden = false;
    tripsErrorEl.hidden = true;
    document.getElementById("whoami-username").textContent = me.username;
    await refreshMyTrips();
    renderTripList();
}

function renderTripList() {
    if (myTrips.length === 0) {
        tripListEl.innerHTML = `<p class="trip-list-empty">ยังไม่มีทริป — สร้างหรือเข้าร่วมทริปด้านล่างได้เลย</p>`;
        return;
    }
    tripListEl.innerHTML = myTrips
        .map((t) => {
            const statusLabel = t.is_active ? "เปิดอยู่" : "ปิดแล้ว";
            const statusClass = t.is_active ? "trip-badge-active" : "trip-badge-closed";
            const shareLabel = t.share_enabled ? "แชร์ตำแหน่งอยู่" : "ปิดแชร์ตำแหน่ง";
            return `
                <button class="trip-item" data-trip-id="${t.id}">
                    <span class="trip-item-color" style="background:${t.color}"></span>
                    <span class="trip-item-body">
                        <span class="trip-item-name">${escapeHtml(t.name)}</span>
                        <span class="trip-item-meta">รหัส ${t.code} · ${t.member_count} คน · ${shareLabel}</span>
                    </span>
                    <span class="trip-badge ${statusClass}">${statusLabel}</span>
                </button>
            `;
        })
        .join("");

    tripListEl.querySelectorAll(".trip-item").forEach((btn) => {
        btn.addEventListener("click", () => {
            const trip = myTrips.find((t) => t.id === btn.dataset.tripId);
            if (trip) enterTrip(trip);
        });
    });
}

createTripForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tripName = createTripNameInput.value.trim();
    if (!tripName) return;
    try {
        const { trip } = await api("/api/trips", {
            method: "POST",
            body: JSON.stringify({ tripName }),
        });
        createTripNameInput.value = "";
        await refreshMyTrips();
        renderTripList();
        const full = myTrips.find((t) => t.id === trip.id);
        if (full) enterTrip(full);
    } catch (err) {
        showTripsError(err.message);
    }
});

joinTripForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = joinTripCodeInput.value.trim().toUpperCase();
    if (!code) return;
    try {
        const { trip } = await api("/api/trips/join", {
            method: "POST",
            body: JSON.stringify({ code }),
        });
        joinTripCodeInput.value = "";
        await refreshMyTrips();
        renderTripList();
        const full = myTrips.find((t) => t.id === trip.id);
        if (full) enterTrip(full);
    } catch (err) {
        showTripsError(err.message);
    }
});

function showTripsError(msg) {
    tripsErrorEl.textContent = msg;
    tripsErrorEl.hidden = false;
}

backToTripsBtn.addEventListener("click", () => {
    openTripPicker();
});

/* ---------------------------------------------------
   4) เปิดทริปที่เลือก -> โหลดแผนที่ + สมัครห้อง socket ของทริปนี้
--------------------------------------------------- */
async function enterTrip(trip) {
    currentTrip = trip;
    tripsOverlay.hidden = true;
    appEl.hidden = false;

    document.getElementById("current-trip-name").textContent = trip.name;
    document.getElementById("account-username-display").textContent = me.username;
    updateTripStatusUI(trip.is_active);
    updateShareToggleUI(trip.share_enabled);
    document.getElementById("trip-code-display").textContent = trip.code;

    if (!map) initMap();
    Object.values(markers).forEach((m) => map.removeLayer(m.marker));
    for (const k in markers) delete markers[k];
    if (myMarker) {
        map.removeLayer(myMarker);
        myMarker = null;
    }
    firstFix = true;

    socket.emit("join-trip", { tripId: trip.id });

    if (trip.is_active && trip.share_enabled) {
        startWatchingPosition();
    } else {
        stopWatchingPosition();
    }
}

/* ---------------------------------------------------
   5) Connection status
--------------------------------------------------- */
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");

function setConnStatus(state) {
    connDot.className = "dot dot-" + state;
    connText.textContent =
        state === "online" ? "เชื่อมต่อแล้ว" :
        state === "offline" ? "ขาดการเชื่อมต่อ" :
        "กำลังเชื่อมต่อ...";
}

/* ---------------------------------------------------
   6) Tabs
--------------------------------------------------- */
document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".panel").forEach((p) => p.classList.remove("panel-active"));

        btn.classList.add("active");
        document.getElementById("panel-" + btn.dataset.tab).classList.add("panel-active");

        if (btn.dataset.tab === "location" && map) {
            setTimeout(() => map.invalidateSize(), 50);
        }
    });
});

/* ---------------------------------------------------
   7) Map setup
--------------------------------------------------- */
function initMap() {
    map = L.map("map", { zoomControl: false }).setView([13.7563, 100.5018], 13);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
    }).addTo(map);

    document.getElementById("locate-btn").addEventListener("click", () => {
        if (myMarker) map.flyTo(myMarker.getLatLng(), 16, { duration: 0.6 });
    });
}

/* ---------------------------------------------------
   8) Geolocation -> emit to server (เฉพาะทริปที่เปิดอยู่ + เปิดแชร์)
--------------------------------------------------- */
function startWatchingPosition() {
    if (watchId !== null) return; // กำลังติดตามอยู่แล้ว
    if (!navigator.geolocation) {
        connText.textContent = "เบราว์เซอร์ไม่รองรับ GPS";
        return;
    }

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            if (!currentTrip || !currentTrip.is_active || !currentTrip.share_enabled) return;

            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            socket.emit("send-location", { tripId: currentTrip.id, lat, lng });

            if (!myMarker) {
                myMarker = L.marker([lat, lng]).addTo(map);
                myMarker.bindPopup(`📍 ${me.username} (คุณ)`);
            } else {
                myMarker.setLatLng([lat, lng]);
            }

            if (firstFix) {
                map.setView([lat, lng], 16);
                firstFix = false;
            }
        },
        (error) => console.warn("Geolocation error:", error.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
}

function stopWatchingPosition() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (myMarker && map) {
        map.removeLayer(myMarker);
        myMarker = null;
    }
    firstFix = true;
}

/* ---------------------------------------------------
   9) สวิตช์เปิด/ปิดแชร์ตำแหน่ง "รายทริป" — เก็บลง DB ผ่าน API
--------------------------------------------------- */
const shareToggleInput = document.getElementById("share-toggle-input");

function updateShareToggleUI(enabled) {
    shareToggleInput.checked = !!enabled;
    shareToggleInput.disabled = !(currentTrip && currentTrip.is_active);
}

shareToggleInput.addEventListener("change", async () => {
    if (!currentTrip) return;
    const enabled = shareToggleInput.checked;
    try {
        await api(`/api/trips/${currentTrip.id}/share`, {
            method: "PATCH",
            body: JSON.stringify({ enabled }),
        });
        currentTrip.share_enabled = enabled;
        if (enabled && currentTrip.is_active) {
            firstFix = true;
            startWatchingPosition();
        } else {
            stopWatchingPosition();
        }
    } catch (err) {
        shareToggleInput.checked = !enabled; // revert on failure
        alert(err.message);
    }
});

/* ---------------------------------------------------
   10) เปิด/ปิดทริป (สวิตช์ใหญ่ระดับทริป) — ทริปเก่าปิดแล้วจะไม่รับ GPS อีก
--------------------------------------------------- */
const toggleTripActiveBtn = document.getElementById("toggle-trip-active-btn");

function updateTripStatusUI(isActive) {
    document.getElementById("current-trip-badge").textContent = isActive ? "เปิดอยู่" : "ปิดแล้ว";
    document.getElementById("current-trip-badge").className =
        "trip-badge " + (isActive ? "trip-badge-active" : "trip-badge-closed");
    document.getElementById("trip-status-display").textContent = isActive
        ? "เปิดอยู่ — รับตำแหน่ง GPS ได้ตามปกติ"
        : "ปิดแล้ว — ไม่รับตำแหน่ง GPS จากสมาชิก (เหมาะกับทริปเก่า)";
    toggleTripActiveBtn.textContent = isActive ? "ปิดทริปนี้ (เก็บเป็นทริปเก่า)" : "เปิดทริปนี้อีกครั้ง";
}

toggleTripActiveBtn.addEventListener("click", async () => {
    if (!currentTrip) return;
    const nextActive = !currentTrip.is_active;
    try {
        const { trip } = await api(`/api/trips/${currentTrip.id}/active`, {
            method: "PATCH",
            body: JSON.stringify({ isActive: nextActive }),
        });
        currentTrip.is_active = !!trip.is_active;
        updateTripStatusUI(currentTrip.is_active);
        updateShareToggleUI(currentTrip.share_enabled);
        if (currentTrip.is_active && currentTrip.share_enabled) {
            firstFix = true;
            startWatchingPosition();
        } else {
            stopWatchingPosition();
        }
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   11) Sidebar rendering
--------------------------------------------------- */
const memberListEl = document.getElementById("member-list");
const memberCountEl = document.getElementById("member-count");
const membersPanelListEl = document.getElementById("members-panel-list");

function initials(name) {
    return name.trim().slice(0, 2).toUpperCase();
}

function timeAgo(ts, shareEnabled) {
    if (!shareEnabled) return "ปิดแชร์ตำแหน่ง";
    if (!ts) return "กำลังหาตำแหน่ง...";
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 5) return "อัปเดตล่าสุด";
    if (seconds < 60) return `${seconds} วินาทีที่แล้ว`;
    const mins = Math.floor(seconds / 60);
    return `${mins} นาทีที่แล้ว`;
}

function memberCardHtml(u) {
    const isMe = u.id === me.id;
    return `
        <div class="member-card ${isMe ? "is-me" : ""}">
            <div class="member-avatar" style="background:${u.color}">${initials(u.name)}</div>
            <div class="member-info">
                <div class="member-name">${escapeHtml(u.name)}${isMe ? " (คุณ)" : ""}</div>
                <div class="member-meta">${timeAgo(u.last_update, !!u.share_enabled)}</div>
            </div>
            ${u.share_enabled ? "" : '<span class="share-off-pill">ปิด GPS</span>'}
        </div>
    `;
}

function renderMemberList(members) {
    memberCountEl.textContent = members.length;
    memberListEl.innerHTML = members.map(memberCardHtml).join("");
    membersPanelListEl.innerHTML = members.map(memberCardHtml).join("");
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
