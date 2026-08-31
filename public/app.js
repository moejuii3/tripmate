/* ---------------------------------------------------
   0) Auth state
--------------------------------------------------- */
let authToken = localStorage.getItem("tripmate:token") || null;
let me = null;
let socket = null;
let myTrips = [];
let currentTrip = null;
let map;
let myMarker;
const markers = {};
let watchId = null;
let firstFix = true;
let currentTripTab = "map";

// Phase 5 state
let currentItineraryItems = [];
let routeLayer = null;
let routeVisible = true;
let meetupMarker = null;
let alertsIntervalId = null;
let mapPickerInstance = null;
let mapPickerMarker = null;
let mapPickerLatLng = null;
let mapPickerOnConfirm = null;
let pendingJoinCode = null;

// ระยะทาง (เมตร) ด้วยสูตร Haversine — ใช้แสดงระยะห่างสมาชิก/สถานที่/จุดนัดหมาย และตรวจ Location Alert
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
function fmtDistance(m) {
    if (m < 1000) return `${Math.round(m)} ม.`;
    return `${(m / 1000).toFixed(1)} กม.`;
}

// อ่านรหัสทริปจาก URL แบบ /join/ABC123 (Join via Link) — เก็บไว้ใช้หลังล็อกอินสำเร็จ
(function detectJoinLink() {
    const match = window.location.pathname.match(/^\/join\/([A-Za-z0-9]{6})$/);
    if (match) {
        pendingJoinCode = match[1].toUpperCase();
        window.history.replaceState({}, "", "/");
    }
})();

async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
        doLogout();
        throw new Error(data.error || "กรุณาเข้าสู่ระบบใหม่");
    }
    if (!res.ok) throw new Error(data.error || "เกิดข้อผิดพลาด");
    return data;
}

// สำหรับอัปโหลดไฟล์ (multipart/form-data) — ห้ามตั้ง Content-Type เอง ให้เบราว์เซอร์ใส่ boundary ให้
async function apiUpload(path, formData) {
    const headers = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(path, { method: "POST", headers, body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
        doLogout();
        throw new Error(data.error || "กรุณาเข้าสู่ระบบใหม่");
    }
    if (!res.ok) throw new Error(data.error || "เกิดข้อผิดพลาด");
    return data;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

/* ---------------------------------------------------
   1) Auth screen
--------------------------------------------------- */
const authScreen = document.getElementById("auth-screen");
const tripsScreen = document.getElementById("trips-screen");
const tripScreen = document.getElementById("trip-screen");
const authTabLogin = document.getElementById("auth-tab-login");
const authTabRegister = document.getElementById("auth-tab-register");
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const authErrorEl = document.getElementById("auth-error");

function setPillTab(activeBtn, inactiveBtn) {
    activeBtn.classList.add("bg-surface-container-lowest", "text-primary", "shadow-sm");
    activeBtn.classList.remove("text-on-surface-variant");
    inactiveBtn.classList.remove("bg-surface-container-lowest", "text-primary", "shadow-sm");
    inactiveBtn.classList.add("text-on-surface-variant");
}

function showAuthTab(tab) {
    authErrorEl.hidden = true;
    const isLogin = tab === "login";
    setPillTab(isLogin ? authTabLogin : authTabRegister, isLogin ? authTabRegister : authTabLogin);
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
        const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
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
        const data = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
        onAuthSuccess(data.token, data.user);
    } catch (err) {
        showAuthError(err.message);
    }
});

function onAuthSuccess(token, user) {
    authToken = token;
    me = user;
    localStorage.setItem("tripmate:token", token);
    authScreen.hidden = true;
    connectSocket();
    handlePostAuthEntry();
}

function doLogout() {
    authToken = null;
    me = null;
    localStorage.removeItem("tripmate:token");
    if (socket) { socket.disconnect(); socket = null; }
    stopWatchingPosition();
    currentTrip = null;
    tripScreen.hidden = true;
    tripsScreen.hidden = true;
    authScreen.hidden = false;
    showAuthTab("login");
}
document.getElementById("profile-logout-btn").addEventListener("click", doLogout);

async function boot() {
    if (!authToken) { authScreen.hidden = false; return; }
    try {
        const { user } = await api("/api/auth/me");
        me = user;
        authScreen.hidden = true;
        connectSocket();
        await handlePostAuthEntry();
    } catch (err) {
        authScreen.hidden = false;
    }
}
boot();

// หลังล็อกอิน/สมัครสมาชิกสำเร็จ (หรือเปิดแอปมาแล้วมี token ค้างอยู่) — ถ้ามาจากลิงก์เชิญ /join/XXXXXX
// ให้เข้าร่วมทริปนั้นทันทีแล้วพาเข้าห้องเลย แทนที่จะโผล่หน้า "ทริปของฉัน" เฉยๆ
async function handlePostAuthEntry() {
    if (pendingJoinCode) {
        const code = pendingJoinCode;
        pendingJoinCode = null;
        try {
            const { trip } = await api("/api/trips/join", { method: "POST", body: JSON.stringify({ code }) });
            await refreshMyTrips();
            const full = myTrips.find((t) => t.id === trip.id);
            if (full) {
                await openTripsScreen();
                enterTrip(full);
                return;
            }
        } catch (err) {
            alert(`เข้าร่วมทริปจากลิงก์ไม่สำเร็จ: ${err.message}`);
        }
    }
    await openTripsScreen();
}

/* ---------------------------------------------------
   2) Socket.io
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
            updateTripStatusUI();
            if (!isActive) stopWatchingPosition();
        }
    });

    socket.on("trip-info-updated", ({ tripId, trip }) => {
        if (currentTrip && currentTrip.id === tripId) {
            Object.assign(currentTrip, trip);
            renderTripInfoPanel();
            document.getElementById("trip-screen-name").textContent = currentTrip.name;
        }
    });

    socket.on("trip-meetup-updated", ({ tripId, trip }) => {
        if (currentTrip && currentTrip.id === tripId) {
            Object.assign(currentTrip, trip);
            renderMeetupDisplay();
            renderMeetupMarker();
        }
    });

    socket.on("trip-deleted", ({ tripId }) => {
        if (currentTrip && currentTrip.id === tripId) {
            alert("ทริปนี้ถูกลบแล้ว");
            tripScreen.hidden = true;
            openTripsScreen();
        }
    });

    socket.on("itinerary-updated", ({ tripId }) => {
        if (currentTrip && currentTrip.id === tripId) loadItinerary();
    });

    socket.on("expenses-updated", ({ tripId }) => {
        if (currentTrip && currentTrip.id === tripId && currentTripTab === "expenses") loadExpenses();
    });

    socket.on("users-location", ({ trip, members }) => {
        if (!currentTrip || (trip && trip.id !== currentTrip.id)) return;
        currentMembers = members;
        renderMapMarkers(members);
        renderMemberList(members);
        document.getElementById("map-member-count").textContent = `${members.length} คน`;
        runAlertChecks();
    });
}

let currentMembers = [];

function setConnStatus(state) {
    const el = document.getElementById("map-conn-status");
    if (!el) return;
    el.textContent = state === "online" ? "ออนไลน์" : state === "offline" ? "ขาดการเชื่อมต่อ" : "กำลังเชื่อมต่อ...";
}

/* ---------------------------------------------------
   3) My Trips screen
--------------------------------------------------- */
async function refreshMyTrips() {
    const data = await api("/api/whoami", { method: "POST" });
    myTrips = data.trips;
    return myTrips;
}

async function openTripsScreen() {
    tripScreen.hidden = true;
    stopWatchingPosition();
    if (currentTrip && socket) {
        socket.emit("leave-trip");
        currentTrip = null;
    }
    tripsScreen.hidden = false;

    const initials = me.username.trim().slice(0, 2).toUpperCase();
    document.getElementById("trips-username").textContent = me.username;
    document.getElementById("header-avatar").textContent = initials;
    document.getElementById("profile-avatar").textContent = initials;
    document.getElementById("profile-username").textContent = me.username;

    switchMainTab("trips");
    await refreshMyTrips();
    renderTripsScreen();
    loadInvites();
}

/* ---------------------------------------------------
   3b) Global tabs: Trips / Explore / Profile / Stories
--------------------------------------------------- */
const fabAddTrip = document.getElementById("fab-add-trip");
const fabAddStory = document.getElementById("fab-add-story");
const TAB_TITLES = { trips: "My Trips", explore: "Explore", profile: "Profile", stories: "Stories" };

function switchMainTab(tab) {
    document.querySelectorAll(".main-tab").forEach((el) => (el.hidden = el.id !== `main-tab-${tab}`));
    document.querySelectorAll(".main-tab-btn").forEach((btn) => {
        const active = btn.dataset.tab === tab;
        btn.classList.toggle("text-primary", active);
        btn.classList.toggle("font-bold", active);
        btn.classList.toggle("text-on-surface-variant", !active);
    });
    document.getElementById("main-screen-title").textContent = TAB_TITLES[tab] || "Travel Buddy";
    fabAddTrip.style.display = tab === "trips" ? "flex" : "none";
    fabAddStory.hidden = tab !== "stories";
    if (tab === "explore") loadCommunityTrips();
    if (tab === "stories") loadStoriesFeed();
    if (tab === "profile") loadProfile();
}
document.querySelectorAll(".main-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchMainTab(btn.dataset.tab));
});

const TRIP_COVERS = [
    "https://images.unsplash.com/photo-1500534623283-312aade485b7?w=800&q=60",
    "https://images.unsplash.com/photo-1524231757912-21f4fe3a7200?w=800&q=60",
    "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=800&q=60",
    "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=800&q=60",
    "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&q=60",
];
function coverFor(tripId) {
    let h = 0;
    for (const ch of tripId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return TRIP_COVERS[h % TRIP_COVERS.length];
}

function renderTripsScreen() {
    const activeSection = document.getElementById("active-trip-section");
    const activeCard = document.getElementById("active-trip-card");
    const otherList = document.getElementById("other-trips-list");
    const closedSection = document.getElementById("closed-trips-section");
    const closedList = document.getElementById("closed-trips-list");
    const emptyState = document.getElementById("trips-empty-state");

    const openTrips = myTrips.filter((t) => t.is_active);
    const closedTrips = myTrips.filter((t) => !t.is_active);
    const featured = openTrips[0] || null;
    const rest = openTrips.slice(1);

    emptyState.hidden = myTrips.length !== 0;

    if (featured) {
        activeSection.hidden = false;
        activeCard.innerHTML = `
            <div class="relative w-full rounded-2xl bg-surface-container flex flex-col pb-6 shadow-[0_4px_24px_rgba(0,0,0,0.02)] cursor-pointer" data-trip-id="${featured.id}">
                <div class="w-full h-[220px] bg-cover bg-center rounded-2xl" style="background-image:url('${coverFor(featured.id)}')">
                    <div class="absolute top-4 left-4 bg-surface/85 backdrop-blur-md px-3 py-1.5 rounded-full shadow-sm flex items-center gap-1.5 text-on-surface">
                        <span class="material-symbols-outlined text-[16px] text-primary">tag</span>
                        <span class="font-label-md text-sm">${featured.code}</span>
                    </div>
                </div>
                <div class="relative -mt-12 mx-4 bg-surface-container-lowest p-5 rounded-[20px] shadow-[0_20px_48px_-8px_rgba(0,0,0,0.08)] flex flex-col gap-3">
                    <div class="flex justify-between items-start">
                        <div class="pr-2 min-w-0">
                            <h3 class="font-display-lg-mobile text-[22px] text-on-surface leading-tight truncate">${escapeHtml(featured.name)}</h3>
                            <p class="font-body-md text-on-surface-variant mt-1 text-sm">${featured.member_count} สมาชิก · ${featured.share_enabled ? "กำลังแชร์ตำแหน่ง" : "ปิดแชร์ตำแหน่ง"}</p>
                        </div>
                        <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style="background:${featured.color}22">
                            <span class="material-symbols-outlined text-[20px]" style="color:${featured.color}">luggage</span>
                        </div>
                    </div>
                    <button class="w-full py-3 rounded-full bg-primary text-on-primary font-label-md text-sm mt-1 active:scale-[0.98] transition-transform">เปิดทริปนี้</button>
                </div>
            </div>`;
        activeCard.querySelector("[data-trip-id]").addEventListener("click", () => enterTrip(featured));
    } else {
        activeSection.hidden = true;
    }

    otherList.innerHTML = rest
        .map(
            (t) => `
        <div class="relative w-full rounded-[20px] bg-surface-container-lowest shadow-[0_8px_32px_rgba(0,0,0,0.03)] flex flex-col overflow-hidden cursor-pointer" data-trip-id="${t.id}">
            <div class="w-full h-[130px] bg-cover bg-center" style="background-image:url('${coverFor(t.id)}')"></div>
            <div class="p-4 flex flex-col gap-2">
                <h3 class="font-headline-md text-[17px] text-on-surface truncate">${escapeHtml(t.name)}</h3>
                <div class="flex justify-between items-center">
                    <span class="font-body-md text-on-surface-variant text-[13px]">${t.member_count} สมาชิก · รหัส ${t.code}</span>
                    <span class="material-symbols-outlined text-outline-variant">chevron_right</span>
                </div>
            </div>
        </div>`
        )
        .join("");
    otherList.querySelectorAll("[data-trip-id]").forEach((el) => {
        el.addEventListener("click", () => {
            const trip = myTrips.find((t) => t.id === el.dataset.tripId);
            if (trip) enterTrip(trip);
        });
    });

    if (closedTrips.length > 0) {
        closedSection.hidden = false;
        closedList.innerHTML = closedTrips
            .map(
                (t) => `
            <div class="flex items-center gap-4 bg-surface-container-lowest p-3 rounded-[20px] shadow-[0_4px_16px_rgba(0,0,0,0.02)] cursor-pointer" data-trip-id="${t.id}">
                <div class="w-16 h-16 flex-shrink-0 bg-cover bg-center rounded-[14px] opacity-70" style="background-image:url('${coverFor(t.id)}')"></div>
                <div class="flex flex-col flex-1 min-w-0 justify-center">
                    <h4 class="font-headline-md text-[16px] text-on-surface truncate">${escapeHtml(t.name)}</h4>
                    <p class="font-body-md text-on-surface-variant text-[13px] mt-0.5">ปิดแล้ว · รหัส ${t.code}</p>
                </div>
                <span class="material-symbols-outlined text-outline-variant">chevron_right</span>
            </div>`
            )
            .join("");
        closedList.querySelectorAll("[data-trip-id]").forEach((el) => {
            el.addEventListener("click", () => {
                const trip = myTrips.find((t) => t.id === el.dataset.tripId);
                if (trip) enterTrip(trip);
            });
        });
    } else {
        closedSection.hidden = true;
    }
}

/* ---------------------------------------------------
   4) Create/Join trip bottom sheet
--------------------------------------------------- */
const sheetBackdrop = document.getElementById("trip-sheet-backdrop");
const sheetTabCreate = document.getElementById("sheet-tab-create");
const sheetTabJoin = document.getElementById("sheet-tab-join");
const createTripForm = document.getElementById("create-trip-form");
const joinTripForm = document.getElementById("join-trip-form");
const sheetErrorEl = document.getElementById("sheet-error");

function showSheetTab(tab) {
    sheetErrorEl.hidden = true;
    const isCreate = tab === "create";
    setPillTab(isCreate ? sheetTabCreate : sheetTabJoin, isCreate ? sheetTabJoin : sheetTabCreate);
    createTripForm.hidden = !isCreate;
    joinTripForm.hidden = isCreate;
}
sheetTabCreate.addEventListener("click", () => showSheetTab("create"));
sheetTabJoin.addEventListener("click", () => showSheetTab("join"));

document.getElementById("fab-add-trip").addEventListener("click", () => {
    sheetBackdrop.hidden = false;
    showSheetTab("create");
});
document.getElementById("sheet-close-btn").addEventListener("click", () => (sheetBackdrop.hidden = true));
sheetBackdrop.addEventListener("click", (e) => { if (e.target === sheetBackdrop) sheetBackdrop.hidden = true; });

function showSheetError(msg) {
    sheetErrorEl.textContent = msg;
    sheetErrorEl.hidden = false;
}

createTripForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tripName = document.getElementById("create-trip-name").value.trim();
    if (!tripName) return;
    try {
        const { trip } = await api("/api/trips", { method: "POST", body: JSON.stringify({ tripName }) });
        document.getElementById("create-trip-name").value = "";
        sheetBackdrop.hidden = true;
        await refreshMyTrips();
        renderTripsScreen();
        const full = myTrips.find((t) => t.id === trip.id);
        if (full) enterTrip(full);
    } catch (err) {
        showSheetError(err.message);
    }
});

joinTripForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("join-trip-code").value.trim().toUpperCase();
    if (!code) return;
    try {
        const { trip } = await api("/api/trips/join", { method: "POST", body: JSON.stringify({ code }) });
        document.getElementById("join-trip-code").value = "";
        sheetBackdrop.hidden = true;
        await refreshMyTrips();
        renderTripsScreen();
        const full = myTrips.find((t) => t.id === trip.id);
        if (full) enterTrip(full);
    } catch (err) {
        showSheetError(err.message);
    }
});

/* ---------------------------------------------------
   5) Trip screen (Map / Schedule / Expenses / Members)
--------------------------------------------------- */
document.getElementById("trip-back-btn").addEventListener("click", () => {
    tripScreen.hidden = true;
    openTripsScreen();
});

document.querySelectorAll(".trip-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTripTab(btn.dataset.tab));
});

function switchTripTab(tab) {
    currentTripTab = tab;
    document.querySelectorAll(".trip-tab").forEach((el) => (el.hidden = el.id !== `trip-tab-${tab}`));
    document.querySelectorAll(".trip-tab-btn").forEach((btn) => {
        const active = btn.dataset.tab === tab;
        btn.classList.toggle("text-primary", active);
        btn.classList.toggle("font-bold", active);
        btn.classList.toggle("text-on-surface-variant", !active);
    });
    if (tab === "map" && map) {
        setTimeout(() => map.invalidateSize(), 50);
        runAlertChecks();
    }
    if (tab === "schedule") loadItinerary();
    if (tab === "expenses") loadExpenses();
}

async function enterTrip(trip) {
    currentTrip = trip;
    tripsScreen.hidden = true;
    tripScreen.hidden = false;
    switchTripTab("map");

    document.getElementById("trip-screen-name").textContent = trip.name;
    updateTripStatusUI();
    updateVisibilityUI();
    renderTripInfoPanel();
    renderMeetupDisplay();

    if (!map) initMap();
    Object.values(markers).forEach((m) => map.removeLayer(m.marker));
    for (const k in markers) delete markers[k];
    if (myMarker) { map.removeLayer(myMarker); myMarker = null; }
    if (meetupMarker) { map.removeLayer(meetupMarker); meetupMarker = null; }
    firstFix = true;

    socket.emit("join-trip", { tripId: trip.id });

    if (trip.is_active && trip.share_enabled) startWatchingPosition();
    else stopWatchingPosition();
    updateShareToggleUI();

    renderMeetupMarker();
    loadItinerary(); // โหลดกำหนดการล่วงหน้าเพื่อพล็อตเส้นทาง (Route) บนแผนที่ทันทีที่เข้าทริป

    if (alertsIntervalId) clearInterval(alertsIntervalId);
    alertsIntervalId = setInterval(runAlertChecks, 30000); // เช็คแจ้งเตือนซ้ำทุก 30 วิ (เผื่อกรณีไม่มี GPS ping ใหม่)
}

function updateTripStatusUI() {
    const badge = document.getElementById("trip-screen-badge");
    const sub = document.getElementById("trip-screen-sub");
    const statusEl = document.getElementById("member-trip-status");
    const toggleBtn = document.getElementById("toggle-trip-active-btn");

    if (currentTrip.is_active) {
        badge.textContent = "เปิดอยู่";
        badge.className = "bg-primary text-on-primary px-3 py-1 rounded-full font-label-md text-[10px] uppercase tracking-widest shadow-sm flex-shrink-0";
        sub.textContent = "กำลังดำเนินอยู่";
        statusEl.textContent = "เปิดอยู่";
        statusEl.className = "font-label-md text-sm text-primary";
        toggleBtn.textContent = "ปิดทริปนี้ (เก็บเป็นทริปเก่า)";
    } else {
        badge.textContent = "ปิดแล้ว";
        badge.className = "bg-surface-container-high text-on-surface-variant px-3 py-1 rounded-full font-label-md text-[10px] uppercase tracking-widest flex-shrink-0";
        sub.textContent = "ทริปนี้ปิดแล้ว";
        statusEl.textContent = "ปิดแล้ว";
        statusEl.className = "font-label-md text-sm text-on-surface-variant";
        toggleBtn.textContent = "เปิดทริปนี้อีกครั้ง";
    }
    renderTripInfoPanel(); // ปุ่มลบทริปถาวรโผล่เฉพาะตอนปิดแล้ว + เป็นหัวหน้าทริป
}

/* ---------------------------------------------------
   5b) Members tab — ข้อมูลทริป / รูปปก / หัวหน้าทริป / ลบถาวร (Phase 5)
--------------------------------------------------- */
function fmtDateRange(startStr, endStr) {
    if (!startStr && !endStr) return "ยังไม่ระบุ";
    const opts = { day: "numeric", month: "short", year: "2-digit" };
    const s = startStr ? new Date(startStr + "T00:00:00").toLocaleDateString("th-TH", opts) : "?";
    const e = endStr ? new Date(endStr + "T00:00:00").toLocaleDateString("th-TH", opts) : "?";
    return startStr && endStr ? `${s} – ${e}` : s;
}

function renderTripInfoPanel() {
    if (!currentTrip) return;
    const isHost = currentTrip.host_user_id === me.id;

    document.getElementById("member-trip-code").textContent = currentTrip.code;
    document.getElementById("member-trip-dates").textContent = fmtDateRange(currentTrip.start_date, currentTrip.end_date);

    const hostMember = currentMembers.find((m) => m.id === currentTrip.host_user_id);
    document.getElementById("member-trip-host").textContent = isHost ? "คุณ" : hostMember ? hostMember.name : "—";

    document.getElementById("edit-trip-info-btn").hidden = !isHost;
    document.getElementById("edit-cover-btn").hidden = !isHost;
    document.getElementById("delete-trip-btn").hidden = !(isHost && !currentTrip.is_active);

    const coverImg = document.getElementById("trip-cover-img");
    const coverPlaceholder = document.getElementById("trip-cover-placeholder");
    if (currentTrip.cover_image_path) {
        coverImg.src = currentTrip.cover_image_path;
        coverImg.classList.remove("hidden");
        coverPlaceholder.classList.add("hidden");
    } else {
        coverImg.classList.add("hidden");
        coverPlaceholder.classList.remove("hidden");
    }
}

document.getElementById("edit-trip-info-btn").addEventListener("click", () => {
    document.getElementById("edit-trip-name").value = currentTrip.name;
    document.getElementById("edit-trip-start").value = currentTrip.start_date || "";
    document.getElementById("edit-trip-end").value = currentTrip.end_date || "";
    document.getElementById("edit-trip-error").hidden = true;
    document.getElementById("edit-trip-sheet-backdrop").hidden = false;
});
document.getElementById("edit-trip-sheet-close").addEventListener("click", () => {
    document.getElementById("edit-trip-sheet-backdrop").hidden = true;
});

document.getElementById("edit-trip-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("edit-trip-name").value.trim();
    const start_date = document.getElementById("edit-trip-start").value || null;
    const end_date = document.getElementById("edit-trip-end").value || null;
    try {
        const { trip } = await api(`/api/trips/${currentTrip.id}/info`, {
            method: "PATCH",
            body: JSON.stringify({ name, start_date, end_date }),
        });
        Object.assign(currentTrip, trip);
        document.getElementById("trip-screen-name").textContent = currentTrip.name;
        renderTripInfoPanel();
        document.getElementById("edit-trip-sheet-backdrop").hidden = true;
    } catch (err) {
        const errEl = document.getElementById("edit-trip-error");
        errEl.textContent = err.message;
        errEl.hidden = false;
    }
});

document.getElementById("edit-cover-btn").addEventListener("click", () => {
    document.getElementById("cover-file-input").click();
});
document.getElementById("cover-file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || !currentTrip) return;
    const formData = new FormData();
    formData.append("cover", file);
    try {
        const { trip } = await apiUpload(`/api/trips/${currentTrip.id}/cover`, formData);
        Object.assign(currentTrip, trip);
        renderTripInfoPanel();
    } catch (err) {
        alert(err.message);
    } finally {
        e.target.value = "";
    }
});

document.getElementById("delete-trip-btn").addEventListener("click", async () => {
    if (!currentTrip) return;
    if (!confirm(`ลบทริป "${currentTrip.name}" ถาวร? กู้คืนไม่ได้`)) return;
    try {
        await api(`/api/trips/${currentTrip.id}`, { method: "DELETE" });
        tripScreen.hidden = true;
        currentTrip = null;
        openTripsScreen();
    } catch (err) {
        alert(err.message);
    }
});

document.getElementById("copy-invite-link-btn").addEventListener("click", async (e) => {
    if (!currentTrip) return;
    const link = `${window.location.origin}/join/${currentTrip.code}`;
    const btn = e.currentTarget;
    const original = btn.innerHTML;
    try {
        await navigator.clipboard.writeText(link);
        btn.innerHTML = `<span class="material-symbols-outlined text-[18px]">check</span> คัดลอกแล้ว!`;
    } catch {
        prompt("คัดลอกลิงก์นี้:", link);
    }
    setTimeout(() => (btn.innerHTML = original), 1800);
});

document.getElementById("toggle-trip-active-btn").addEventListener("click", async () => {
    if (!currentTrip) return;
    const nextActive = !currentTrip.is_active;
    try {
        const { trip } = await api(`/api/trips/${currentTrip.id}/active`, {
            method: "PATCH",
            body: JSON.stringify({ isActive: nextActive }),
        });
        currentTrip.is_active = !!trip.is_active;
        updateTripStatusUI();
        updateShareToggleUI();
        if (currentTrip.is_active && currentTrip.share_enabled) { firstFix = true; startWatchingPosition(); }
        else stopWatchingPosition();
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   6) Map
--------------------------------------------------- */
function initMap() {
    map = L.map("map", { zoomControl: false }).setView([13.7563, 100.5018], 13);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
    }).addTo(map);
}

function memberDivIcon(u, isMe) {
    const initials = u.name.trim().slice(0, 2).toUpperCase();
    return L.divIcon({
        className: "",
        html: `
            <div class="relative" style="width:48px;height:48px;">
                ${isMe ? `<div class="marker-pulse absolute inset-0 rounded-full" style="background:${u.color}"></div>` : ""}
                <div class="marker-pin relative w-11 h-11 rounded-full flex items-center justify-center font-bold text-[13px] shadow-lg" style="background:${u.color};color:white;border:3px solid white;">${initials}</div>
                <div class="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-white px-2 py-0.5 rounded-full shadow whitespace-nowrap text-[10px] font-semibold" style="color:#1c1b1b;">${escapeHtml(u.name)}</div>
            </div>`,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
    });
}

function renderMapMarkers(members) {
    if (!map) return;
    const activeMembers = members.filter((m) => m.lat != null && m.lng != null);
    const seen = new Set();

    for (const u of activeMembers) {
        if (u.id === me.id) continue;
        seen.add(u.id);
        if (!markers[u.id]) {
            const marker = L.marker([u.lat, u.lng], { icon: memberDivIcon(u, false) }).addTo(map);
            markers[u.id] = { marker, data: u };
        } else {
            markers[u.id].marker.setLatLng([u.lat, u.lng]);
            markers[u.id].marker.setIcon(memberDivIcon(u, false));
            markers[u.id].data = u;
        }
    }
    for (const id in markers) {
        if (!seen.has(id)) { map.removeLayer(markers[id].marker); delete markers[id]; }
    }
}

/* ---------------------------------------------------
   6b) จุดนัดหมาย (Meetup Point) — marker บนแผนที่ + ตั้ง/แก้ไข (Phase 5)
--------------------------------------------------- */
function renderMeetupMarker() {
    if (!map || !currentTrip) return;
    if (meetupMarker) { map.removeLayer(meetupMarker); meetupMarker = null; }
    if (currentTrip.meetup_lat == null || currentTrip.meetup_lng == null) return;

    const icon = L.divIcon({
        className: "",
        html: `
            <div class="relative" style="width:40px;height:52px;">
                <div class="w-10 h-10 rounded-full bg-secondary-fixed border-3 border-white shadow-lg flex items-center justify-center">
                    <span class="material-symbols-outlined text-[20px]" style="color:#1b1c1a;">flag</span>
                </div>
            </div>`,
        iconSize: [40, 52],
        iconAnchor: [20, 40],
    });
    meetupMarker = L.marker([currentTrip.meetup_lat, currentTrip.meetup_lng], { icon })
        .addTo(map)
        .bindPopup(currentTrip.meetup_name || "จุดนัดหมาย");
}

function renderMeetupDisplay() {
    const el = document.getElementById("meetup-display");
    if (!currentTrip || currentTrip.meetup_lat == null) {
        el.textContent = "ยังไม่ได้ตั้งจุดนัดหมาย";
        return;
    }
    el.textContent = currentTrip.meetup_name
        ? `📍 ${currentTrip.meetup_name}`
        : `📍 ${currentTrip.meetup_lat.toFixed(5)}, ${currentTrip.meetup_lng.toFixed(5)}`;
}

let meetupPickedLatLng = null;
document.getElementById("edit-meetup-btn").addEventListener("click", () => {
    document.getElementById("meetup-name-input").value = currentTrip.meetup_name || "";
    meetupPickedLatLng =
        currentTrip.meetup_lat != null ? { lat: currentTrip.meetup_lat, lng: currentTrip.meetup_lng } : null;
    updateMeetupCoordsLabel();
    document.getElementById("edit-meetup-sheet-backdrop").hidden = false;
});
document.getElementById("edit-meetup-sheet-close").addEventListener("click", () => {
    document.getElementById("edit-meetup-sheet-backdrop").hidden = true;
});

function updateMeetupCoordsLabel() {
    const label = document.getElementById("meetup-coords-label");
    label.textContent = meetupPickedLatLng
        ? `พิกัด: ${meetupPickedLatLng.lat.toFixed(5)}, ${meetupPickedLatLng.lng.toFixed(5)}`
        : "ยังไม่ได้ปักพิกัด";
}

document.getElementById("meetup-pick-map-btn").addEventListener("click", () => {
    openMapPicker(meetupPickedLatLng, (latlng) => {
        meetupPickedLatLng = latlng;
        updateMeetupCoordsLabel();
    });
});

document.getElementById("edit-meetup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentTrip) return;
    const name = document.getElementById("meetup-name-input").value.trim();
    try {
        const { trip } = await api(`/api/trips/${currentTrip.id}/meetup`, {
            method: "PATCH",
            body: JSON.stringify({
                name,
                lat: meetupPickedLatLng ? meetupPickedLatLng.lat : null,
                lng: meetupPickedLatLng ? meetupPickedLatLng.lng : null,
            }),
        });
        Object.assign(currentTrip, trip);
        renderMeetupDisplay();
        renderMeetupMarker();
        document.getElementById("edit-meetup-sheet-backdrop").hidden = true;
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   6c) Mini-map location picker (ใช้ร่วมกัน: กำหนดการ + จุดนัดหมาย)
--------------------------------------------------- */
function openMapPicker(initialLatLng, onConfirm) {
    mapPickerOnConfirm = onConfirm;
    mapPickerLatLng = initialLatLng || null;
    document.getElementById("map-picker-backdrop").hidden = false;
    document.getElementById("map-picker-confirm").disabled = !mapPickerLatLng;

    setTimeout(() => {
        if (!mapPickerInstance) {
            const startView = initialLatLng
                ? [initialLatLng.lat, initialLatLng.lng]
                : myMarker
                ? [myMarker.getLatLng().lat, myMarker.getLatLng().lng]
                : [13.7563, 100.5018];
            mapPickerInstance = L.map("map-picker", { zoomControl: false }).setView(startView, 14);
            L.control.zoom({ position: "bottomright" }).addTo(mapPickerInstance);
            L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                attribution: "&copy; OpenStreetMap contributors",
                maxZoom: 19,
            }).addTo(mapPickerInstance);
            mapPickerInstance.on("click", (e) => {
                mapPickerLatLng = e.latlng;
                if (!mapPickerMarker) mapPickerMarker = L.marker(e.latlng).addTo(mapPickerInstance);
                else mapPickerMarker.setLatLng(e.latlng);
                document.getElementById("map-picker-confirm").disabled = false;
            });
        } else {
            mapPickerInstance.invalidateSize();
            mapPickerInstance.setView(
                initialLatLng ? [initialLatLng.lat, initialLatLng.lng] : mapPickerInstance.getCenter(),
                14
            );
        }
        if (mapPickerLatLng) {
            if (!mapPickerMarker) mapPickerMarker = L.marker(mapPickerLatLng).addTo(mapPickerInstance);
            else mapPickerMarker.setLatLng(mapPickerLatLng);
        } else if (mapPickerMarker) {
            mapPickerInstance.removeLayer(mapPickerMarker);
            mapPickerMarker = null;
        }
    }, 50);
}

document.getElementById("map-picker-cancel").addEventListener("click", () => {
    document.getElementById("map-picker-backdrop").hidden = true;
});
document.getElementById("map-picker-confirm").addEventListener("click", () => {
    if (mapPickerLatLng && mapPickerOnConfirm) mapPickerOnConfirm(mapPickerLatLng);
    document.getElementById("map-picker-backdrop").hidden = true;
});

/* ---------------------------------------------------
   7) Geolocation
--------------------------------------------------- */
function startWatchingPosition() {
    if (watchId !== null) return;
    if (!navigator.geolocation) return;

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            if (!currentTrip || !currentTrip.is_active || !currentTrip.share_enabled) return;
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            socket.emit("send-location", { tripId: currentTrip.id, lat, lng });

            if (!myMarker) {
                myMarker = L.marker([lat, lng], {
                    icon: memberDivIcon({ name: me.username, color: "#0040e0" }, true),
                }).addTo(map);
            } else {
                myMarker.setLatLng([lat, lng]);
            }
            if (firstFix) { map.setView([lat, lng], 16); firstFix = false; }

            // ตำแหน่งตัวเองขยับ -> รีเฟรชระยะทางที่แสดงในลิสต์สมาชิก/กำหนดการ + เช็คแจ้งเตือนใหม่
            renderMemberList(currentMembers);
            if (currentTripTab === "schedule") renderItinerary(currentItineraryItems);
            runAlertChecks();
        },
        (error) => console.warn("Geolocation error:", error.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
}

function stopWatchingPosition() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (myMarker && map) { map.removeLayer(myMarker); myMarker = null; }
    firstFix = true;
}

/* ---------------------------------------------------
   8) Share toggle (floating pill on map)
--------------------------------------------------- */
const shareToggleBtn = document.getElementById("share-toggle-btn");
const shareToggleIcon = document.getElementById("share-toggle-icon");
const shareToggleText = document.getElementById("share-toggle-text");

function updateShareToggleUI() {
    const enabled = currentTrip.share_enabled;
    const disabled = !currentTrip.is_active;
    shareToggleBtn.disabled = disabled;
    shareToggleBtn.style.opacity = disabled ? "0.5" : "1";
    if (enabled) {
        shareToggleBtn.classList.remove("bg-surface-variant", "text-on-surface-variant");
        shareToggleBtn.classList.add("bg-secondary-container", "text-on-secondary-container");
        shareToggleIcon.textContent = "my_location";
        shareToggleText.textContent = "Sharing";
    } else {
        shareToggleBtn.classList.remove("bg-secondary-container", "text-on-secondary-container");
        shareToggleBtn.classList.add("bg-surface-variant", "text-on-surface-variant");
        shareToggleIcon.textContent = "location_disabled";
        shareToggleText.textContent = "Hidden";
    }
}

shareToggleBtn.addEventListener("click", async () => {
    if (!currentTrip || !currentTrip.is_active) return;
    const enabled = !currentTrip.share_enabled;
    try {
        await api(`/api/trips/${currentTrip.id}/share`, { method: "PATCH", body: JSON.stringify({ enabled }) });
        currentTrip.share_enabled = enabled;
        updateShareToggleUI();
        if (enabled) { firstFix = true; startWatchingPosition(); } else stopWatchingPosition();
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   8b) Route — เส้นทางจากกำหนดการที่ปักพิกัดไว้ (Phase 5)
--------------------------------------------------- */
const routeToggleBtn = document.getElementById("route-toggle-btn");
routeToggleBtn.addEventListener("click", () => {
    routeVisible = !routeVisible;
    routeToggleBtn.classList.toggle("bg-primary", routeVisible);
    routeToggleBtn.classList.toggle("text-on-primary", routeVisible);
    routeToggleBtn.classList.toggle("bg-surface-container-low", !routeVisible);
    routeToggleBtn.classList.toggle("text-on-surface-variant", !routeVisible);
    renderRoute();
});

function renderRoute() {
    if (!map) return;
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (!routeVisible) return;

    const points = currentItineraryItems.filter((it) => it.lat != null && it.lng != null);
    if (points.length < 1) return;

    routeLayer = L.layerGroup();
    if (points.length >= 2) {
        L.polyline(points.map((p) => [p.lat, p.lng]), {
            color: "#0040e0",
            weight: 3,
            dashArray: "6, 8",
            opacity: 0.8,
        }).addTo(routeLayer);
    }
    points.forEach((p, idx) => {
        const icon = L.divIcon({
            className: "",
            html: `<div class="w-7 h-7 rounded-full bg-primary text-on-primary flex items-center justify-center font-bold text-[12px] shadow-md border-2 border-white">${idx + 1}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
        });
        L.marker([p.lat, p.lng], { icon }).bindPopup(escapeHtml(p.title)).addTo(routeLayer);
    });
    routeLayer.addTo(map);
}

/* ---------------------------------------------------
   9) Member list (Members tab)
--------------------------------------------------- */
function timeAgo(ts, shareEnabled) {
    if (!shareEnabled) return "ปิดแชร์ตำแหน่ง";
    if (!ts) return "กำลังหาตำแหน่ง...";
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 5) return "อัปเดตล่าสุด";
    if (seconds < 60) return `${seconds} วินาทีที่แล้ว`;
    return `${Math.floor(seconds / 60)} นาทีที่แล้ว`;
}

function renderMemberList(members) {
    const list = document.getElementById("members-panel-list");
    const myPos = myMarker ? myMarker.getLatLng() : null;

    list.innerHTML = members
        .map((u) => {
            const isMe = u.id === me.id;
            const initials = u.name.trim().slice(0, 2).toUpperCase();

            let distanceLabel = "";
            if (!isMe && myPos && u.lat != null && u.lng != null) {
                const d = haversineMeters(myPos.lat, myPos.lng, u.lat, u.lng);
                distanceLabel = `<span class="font-label-md text-[11px] text-primary flex-shrink-0">${fmtDistance(d)} จากคุณ</span>`;
            }

            const noMovementLabel =
                u.share_enabled && u.last_moved_at && Date.now() - u.last_moved_at > NO_MOVEMENT_THRESHOLD_MS
                    ? `<span class="font-label-md text-[10px] text-error bg-error-container px-2 py-1 rounded-full flex-shrink-0">ไม่ขยับ ${Math.round((Date.now() - u.last_moved_at) / 60000)} นาที</span>`
                    : "";

            return `
            <div class="flex items-center gap-3 py-3 ${members.indexOf(u) > 0 ? "border-t border-surface-container-high" : ""}">
                <div class="w-11 h-11 rounded-full flex items-center justify-center font-bold text-[13px] text-white flex-shrink-0" style="background:${u.color}">${initials}</div>
                <div class="flex-1 min-w-0">
                    <div class="font-label-md text-on-surface text-sm truncate">${escapeHtml(u.name)}${isMe ? " (คุณ)" : ""}</div>
                    <div class="font-body-md text-[12px] text-on-surface-variant">${timeAgo(u.last_update, !!u.share_enabled)}</div>
                </div>
                ${distanceLabel}
                ${noMovementLabel}
                ${!u.share_enabled ? '<span class="font-label-md text-[10px] text-error bg-error-container px-2 py-1 rounded-full flex-shrink-0">ปิด GPS</span>' : ""}
            </div>`;
        })
        .join("");
}
const NO_MOVEMENT_THRESHOLD_MS = 20 * 60 * 1000; // 20 นาที ไม่ขยับเกินนี้ = แจ้งเตือน

/* ---------------------------------------------------
   10) Schedule (itinerary) — Phase 1
--------------------------------------------------- */
const CATEGORY_ICON = {
    sight: "temple_buddhist", food: "restaurant", transport: "directions_car",
    hotel: "hotel", activity: "confirmation_number", other: "place",
};
const CATEGORY_COLOR = {
    sight: "#0040e0", food: "#556500", transport: "#747688",
    hotel: "#93000a", activity: "#3f4c00", other: "#434656",
};

async function loadItinerary() {
    if (!currentTrip) return;
    try {
        const { items } = await api(`/api/trips/${currentTrip.id}/itinerary`);
        currentItineraryItems = items;
        renderItinerary(items);
        renderRoute();
        runAlertChecks();
    } catch (err) {
        console.warn("loadItinerary failed:", err.message);
    }
}

function fmtDateTime(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    return d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function renderItinerary(items) {
    const listEl = document.getElementById("itinerary-list");
    const emptyMsg = document.getElementById("itinerary-empty-msg");
    emptyMsg.hidden = items.length !== 0;
    const myPos = myMarker ? myMarker.getLatLng() : null;

    listEl.innerHTML = items
        .map((item, idx) => {
            const icon = CATEGORY_ICON[item.category] || "place";
            const color = CATEGORY_COLOR[item.category] || "#434656";
            const timeLabel = fmtDateTime(item.start_time);
            const distanceLabel =
                myPos && item.lat != null && item.lng != null
                    ? `<span class="font-label-md text-[11px] text-primary">· ${fmtDistance(haversineMeters(myPos.lat, myPos.lng, item.lat, item.lng))} จากคุณ</span>`
                    : "";
            return `
            <div class="relative pl-10 pb-8 ${idx < items.length - 1 ? "border-l-2 border-surface-container-high ml-4" : "ml-4"}">
                <div class="absolute -left-[9px] top-0 w-4 h-4 rounded-full shadow-[0_0_0_4px_#fcf9f8]" style="background:${color}"></div>
                <div class="bg-surface-container-lowest rounded-[20px] p-4 shadow-[0_4px_16px_rgba(0,0,0,0.03)] flex gap-3 items-start -mt-1">
                    <div class="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${color}22;color:${color}">
                        <span class="material-symbols-outlined text-[20px]">${icon}</span>
                    </div>
                    <div class="flex-1 min-w-0">
                        <h4 class="font-headline-md text-[16px] text-on-surface truncate">${escapeHtml(item.title)}${item.lat != null ? ' <span class="material-symbols-outlined text-[14px] text-primary align-middle">location_on</span>' : ""}</h4>
                        ${item.location_name ? `<p class="font-body-md text-[13px] text-on-surface-variant truncate">📍 ${escapeHtml(item.location_name)} ${distanceLabel}</p>` : distanceLabel ? `<p class="font-body-md text-[13px]">${distanceLabel}</p>` : ""}
                        ${timeLabel ? `<p class="font-label-md text-[11px] text-primary mt-1">${timeLabel}</p>` : ""}
                        ${item.description ? `<p class="font-body-md text-[13px] text-on-surface-variant mt-1">${escapeHtml(item.description)}</p>` : ""}
                        <p class="font-body-md text-[11px] text-outline mt-1">เพิ่มโดย ${escapeHtml(item.created_by_name || "—")}</p>
                    </div>
                    <button class="delete-itinerary-btn w-8 h-8 flex items-center justify-center text-outline-variant hover:text-error flex-shrink-0" data-id="${item.id}">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>
            </div>`;
        })
        .join("");

    listEl.querySelectorAll(".delete-itinerary-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            try {
                await api(`/api/trips/${currentTrip.id}/itinerary/${btn.dataset.id}`, { method: "DELETE" });
                loadItinerary();
            } catch (err) {
                alert(err.message);
            }
        });
    });
}

const itinerarySheet = document.getElementById("itinerary-sheet-backdrop");
document.getElementById("add-itinerary-btn").addEventListener("click", () => {
    itineraryPickedLatLng = null;
    updateItineraryCoordsLabel();
    itinerarySheet.hidden = false;
});
document.getElementById("itinerary-sheet-close").addEventListener("click", () => (itinerarySheet.hidden = true));
itinerarySheet.addEventListener("click", (e) => { if (e.target === itinerarySheet) itinerarySheet.hidden = true; });

let itineraryPickedLatLng = null;
function updateItineraryCoordsLabel() {
    const label = document.getElementById("itinerary-coords-label");
    label.textContent = itineraryPickedLatLng
        ? `📍 พิกัด: ${itineraryPickedLatLng.lat.toFixed(5)}, ${itineraryPickedLatLng.lng.toFixed(5)}`
        : "ยังไม่ได้ปักพิกัด (ไม่บังคับ — ปักเพื่อให้ขึ้นเส้นทางบนแผนที่)";
}

document.getElementById("itinerary-pick-map-btn").addEventListener("click", () => {
    openMapPicker(itineraryPickedLatLng, (latlng) => {
        itineraryPickedLatLng = latlng;
        updateItineraryCoordsLabel();
    });
});

document.getElementById("itinerary-use-current-btn").addEventListener("click", () => {
    if (!navigator.geolocation) return alert("เบราว์เซอร์นี้ไม่รองรับ GPS");
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            itineraryPickedLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            updateItineraryCoordsLabel();
        },
        (err) => alert("อ่านตำแหน่งไม่สำเร็จ: " + err.message)
    );
});

document.getElementById("itinerary-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("itinerary-title").value.trim();
    if (!title || !currentTrip) return;
    const body = {
        title,
        category: document.getElementById("itinerary-category").value,
        location_name: document.getElementById("itinerary-location").value.trim() || null,
        description: document.getElementById("itinerary-description").value.trim() || null,
        start_time: document.getElementById("itinerary-start").value
            ? new Date(document.getElementById("itinerary-start").value).getTime()
            : null,
        lat: itineraryPickedLatLng ? itineraryPickedLatLng.lat : null,
        lng: itineraryPickedLatLng ? itineraryPickedLatLng.lng : null,
    };
    try {
        await api(`/api/trips/${currentTrip.id}/itinerary`, { method: "POST", body: JSON.stringify(body) });
        e.target.reset();
        itineraryPickedLatLng = null;
        itinerarySheet.hidden = true;
        loadItinerary();
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   11) Expenses — Phase 1 (หารเท่ากันทุกคนในทริป)
--------------------------------------------------- */
const EXPENSE_ICON = {
    food: "restaurant", transport: "directions_car", stay: "hotel",
    activity: "confirmation_number", drinks: "local_bar", shopping: "shopping_bag", other: "receipt_long",
};

async function loadExpenses() {
    if (!currentTrip) return;
    try {
        const summary = await api(`/api/trips/${currentTrip.id}/expenses`);
        renderExpenses(summary);
    } catch (err) {
        console.warn("loadExpenses failed:", err.message);
    }
}

function fmtMoney(n) {
    return "฿" + Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function renderExpenses(summary) {
    document.getElementById("expenses-total").textContent = fmtMoney(summary.total);

    const budgetLabel = document.getElementById("expenses-budget-label");
    const barWrap = document.getElementById("expenses-budget-bar-wrap");
    const bar = document.getElementById("expenses-budget-bar");
    if (summary.budget != null) {
        budgetLabel.textContent = `งบประมาณ ${fmtMoney(summary.budget)}`;
        barWrap.hidden = false;
        const pct = summary.budget > 0 ? Math.min(100, (summary.total / summary.budget) * 100) : 0;
        bar.style.width = pct + "%";
        bar.classList.toggle("bg-error", summary.total > summary.budget);
        bar.classList.toggle("bg-primary", summary.total <= summary.budget);
    } else {
        budgetLabel.textContent = "ยังไม่ได้ตั้งงบประมาณ";
        barWrap.hidden = true;
    }

    const balancesList = document.getElementById("balances-list");
    balancesList.innerHTML = summary.balances
        .filter((b) => Math.abs(b.net) > 0.5)
        .map((b) => {
            const owes = b.net < 0;
            const initials = b.name.trim().slice(0, 2).toUpperCase();
            return `
            <div class="min-w-[160px] bg-surface-container rounded-[20px] p-4 flex flex-col gap-2 shadow-sm flex-shrink-0">
                <div class="flex justify-between items-start">
                    <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-[12px] text-white" style="background:${b.color}">${initials}</div>
                    <span class="material-symbols-outlined text-[18px] ${owes ? "text-error" : "text-secondary"}">${owes ? "arrow_upward" : "arrow_downward"}</span>
                </div>
                <div class="flex flex-col">
                    <span class="font-label-md text-[13px] text-on-surface truncate">${escapeHtml(b.name)}${b.user_id === me.id ? " (คุณ)" : ""}</span>
                    <span class="font-body-md text-[13px] ${owes ? "text-error" : "text-secondary"}">${owes ? "ติดเงิน " : "ได้คืน "}${fmtMoney(Math.abs(b.net))}</span>
                </div>
            </div>`;
        })
        .join("") || `<p class="font-body-md text-on-surface-variant text-sm px-1">ยอดเท่ากันพอดี ไม่มีใครติดเงินใคร</p>`;

    const listEl = document.getElementById("expenses-list");
    const emptyMsg = document.getElementById("expenses-empty-msg");
    emptyMsg.hidden = summary.expenses.length !== 0;

    listEl.innerHTML = summary.expenses
        .map(
            (e, idx) => `
        <div class="flex items-center justify-between p-4 bg-surface-container-lowest ${idx > 0 ? "border-t border-surface-container-high" : ""}">
            <div class="flex items-center gap-4 min-w-0">
                <div class="w-12 h-12 rounded-full bg-primary-container/20 text-primary flex items-center justify-center flex-shrink-0">
                    <span class="material-symbols-outlined">${EXPENSE_ICON[e.category] || "receipt_long"}</span>
                </div>
                <div class="flex flex-col min-w-0">
                    <span class="font-label-md text-on-surface text-sm truncate">${escapeHtml(e.description)}</span>
                    <span class="font-body-md text-[13px] text-on-surface-variant truncate">จ่ายโดย ${escapeHtml(e.paid_by_name)}${e.paid_by === me.id ? " (คุณ)" : ""}</span>
                </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
                <span class="font-label-md text-on-surface text-sm">${fmtMoney(e.amount)}</span>
                <button class="delete-expense-btn w-8 h-8 flex items-center justify-center text-outline-variant hover:text-error" data-id="${e.id}">
                    <span class="material-symbols-outlined text-[16px]">close</span>
                </button>
            </div>
        </div>`
        )
        .join("");

    listEl.querySelectorAll(".delete-expense-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            try {
                await api(`/api/trips/${currentTrip.id}/expenses/${btn.dataset.id}`, { method: "DELETE" });
                loadExpenses();
            } catch (err) {
                alert(err.message);
            }
        });
    });
}

const expenseSheet = document.getElementById("expense-sheet-backdrop");
document.getElementById("add-expense-btn").addEventListener("click", () => (expenseSheet.hidden = false));
document.getElementById("expense-sheet-close").addEventListener("click", () => (expenseSheet.hidden = true));
expenseSheet.addEventListener("click", (e) => { if (e.target === expenseSheet) expenseSheet.hidden = true; });

document.getElementById("expense-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentTrip) return;
    const body = {
        description: document.getElementById("expense-description").value.trim(),
        amount: parseFloat(document.getElementById("expense-amount").value),
        category: document.getElementById("expense-category").value,
    };
    try {
        await api(`/api/trips/${currentTrip.id}/expenses`, { method: "POST", body: JSON.stringify(body) });
        e.target.reset();
        expenseSheet.hidden = true;
        loadExpenses();
    } catch (err) {
        alert(err.message);
    }
});

const budgetSheet = document.getElementById("budget-sheet-backdrop");
document.getElementById("edit-budget-btn").addEventListener("click", () => (budgetSheet.hidden = false));
document.getElementById("budget-sheet-close").addEventListener("click", () => (budgetSheet.hidden = true));
budgetSheet.addEventListener("click", (e) => { if (e.target === budgetSheet) budgetSheet.hidden = true; });

document.getElementById("budget-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentTrip) return;
    const raw = document.getElementById("budget-amount").value;
    const budget = raw === "" ? null : parseFloat(raw);
    try {
        await api(`/api/trips/${currentTrip.id}/budget`, { method: "PATCH", body: JSON.stringify({ budget }) });
        budgetSheet.hidden = true;
        loadExpenses();
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   12) Explore — Community Trips (Phase 2)
--------------------------------------------------- */
async function loadCommunityTrips() {
    const listEl = document.getElementById("community-list");
    const emptyState = document.getElementById("community-empty-state");
    try {
        const { trips } = await api("/api/community/trips");
        emptyState.hidden = trips.length !== 0;
        listEl.innerHTML = trips
            .map((t, idx) => {
                const isHero = idx === 0;
                const cover = coverFor(t.id);
                if (isHero) {
                    return `
                    <article class="relative w-full rounded-[24px] overflow-hidden shadow-[0_8px_40px_rgba(0,0,0,0.08)] bg-surface-container-lowest cursor-pointer" data-trip-id="${t.id}">
                        <div class="relative h-72 w-full">
                            <div class="w-full h-full bg-cover bg-center" style="background-image:url('${cover}')"></div>
                            <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent"></div>
                            <div class="absolute top-4 left-4 bg-secondary-fixed text-on-secondary-fixed px-3 py-1 rounded-full font-label-md text-xs flex items-center gap-1 shadow-lg">
                                <span class="material-symbols-outlined text-[16px]">local_fire_department</span> ยอดนิยม
                            </div>
                            <div class="absolute bottom-0 left-0 w-full p-6 text-white">
                                <h2 class="font-headline-lg text-white mb-1 truncate">${escapeHtml(t.name)}</h2>
                                <p class="font-body-md text-white/80 mb-4 truncate">${t.destination ? escapeHtml(t.destination) + " · " : ""}${t.member_count} สมาชิก</p>
                                <button class="join-community-btn bg-primary text-on-primary px-5 py-2.5 rounded-full font-label-md flex items-center gap-2 active:scale-95 transition-transform" data-trip-id="${t.id}">
                                    <span class="material-symbols-outlined text-[18px]">add</span> เข้าร่วมทริป
                                </button>
                            </div>
                        </div>
                    </article>`;
                }
                return `
                <article class="relative w-full rounded-[24px] overflow-hidden shadow-[0_4px_24px_rgba(0,0,0,0.05)] bg-surface-container-lowest flex gap-4 p-3 cursor-pointer" data-trip-id="${t.id}">
                    <div class="w-24 h-24 rounded-xl bg-cover bg-center flex-shrink-0" style="background-image:url('${cover}')"></div>
                    <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
                        <h4 class="font-headline-md text-[16px] text-on-surface truncate">${escapeHtml(t.name)}</h4>
                        <p class="font-body-md text-[13px] text-on-surface-variant truncate">${t.destination ? escapeHtml(t.destination) + " · " : ""}${t.member_count} สมาชิก</p>
                        ${t.description ? `<p class="font-body-md text-[12px] text-on-surface-variant line-clamp-1">${escapeHtml(t.description)}</p>` : ""}
                    </div>
                    <button class="join-community-btn self-center bg-surface-container-high text-on-surface px-4 py-2 rounded-full font-label-md text-[13px] flex-shrink-0 active:scale-95 transition-transform" data-trip-id="${t.id}">เข้าร่วม</button>
                </article>`;
            })
            .join("");

        listEl.querySelectorAll(".join-community-btn").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const tripId = btn.dataset.tripId;
                try {
                    const { trip } = await api("/api/trips/join", { method: "POST", body: JSON.stringify({ code: tripId }) });
                    await refreshMyTrips();
                    switchMainTab("trips");
                    renderTripsScreen();
                    const full = myTrips.find((t) => t.id === trip.id);
                    if (full) enterTrip(full);
                } catch (err) {
                    alert(err.message);
                }
            });
        });
    } catch (err) {
        console.warn("loadCommunityTrips failed:", err.message);
    }
}

/* ---------------------------------------------------
   13) Trip visibility toggle (แชร์ในหน้า Explore) — Phase 2
--------------------------------------------------- */
const visibilityToggleBtn = document.getElementById("visibility-toggle-btn");
const visibilityToggleKnob = document.getElementById("visibility-toggle-knob");
const visibilityFields = document.getElementById("visibility-fields");

function updateVisibilityUI() {
    const isPublic = currentTrip.visibility === "public";
    visibilityToggleBtn.classList.toggle("bg-primary", isPublic);
    visibilityToggleBtn.classList.toggle("bg-surface-container-high", !isPublic);
    visibilityToggleKnob.style.transform = isPublic ? "translateX(24px)" : "translateX(0)";
    visibilityFields.hidden = !isPublic;
    document.getElementById("trip-destination-input").value = currentTrip.destination || "";
    document.getElementById("trip-description-input").value = currentTrip.description || "";
}

visibilityToggleBtn.addEventListener("click", async () => {
    if (!currentTrip) return;
    const nextVisibility = currentTrip.visibility === "public" ? "private" : "public";
    try {
        const { trip } = await api(`/api/trips/${currentTrip.id}/visibility`, {
            method: "PATCH",
            body: JSON.stringify({ visibility: nextVisibility }),
        });
        currentTrip.visibility = trip.visibility;
        updateVisibilityUI();
    } catch (err) {
        alert(err.message);
    }
});

document.getElementById("save-trip-details-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentTrip) return;
    const destination = document.getElementById("trip-destination-input").value.trim();
    const description = document.getElementById("trip-description-input").value.trim();
    try {
        const { trip } = await api(`/api/trips/${currentTrip.id}/details`, {
            method: "PATCH",
            body: JSON.stringify({ destination, description }),
        });
        currentTrip.destination = trip.destination;
        currentTrip.description = trip.description;
        const btn = document.getElementById("save-trip-details-btn");
        const original = btn.textContent;
        btn.textContent = "บันทึกแล้ว ✓";
        setTimeout(() => (btn.textContent = original), 1500);
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   14) Travel Stories — Phase 3
--------------------------------------------------- */
let currentCommentsStoryId = null;

function timeAgoShort(ts) {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return "เมื่อสักครู่";
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins} นาทีที่แล้ว`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} ชม.ที่แล้ว`;
    return `${Math.floor(hrs / 24)} วันที่แล้ว`;
}

async function loadStoriesFeed() {
    const feedEl = document.getElementById("stories-feed");
    const emptyState = document.getElementById("stories-empty-state");
    try {
        const { stories } = await api("/api/stories");
        emptyState.hidden = stories.length !== 0;
        feedEl.innerHTML = stories.map(storyCardHtml).join("");
        attachStoryCardHandlers();
    } catch (err) {
        console.warn("loadStoriesFeed failed:", err.message);
    }
}

function storyCardHtml(s) {
    const initials = s.author_name.trim().slice(0, 2).toUpperCase();
    return `
    <article class="relative w-full h-[75vh] flex-shrink-0 snap-start overflow-hidden rounded-[24px] bg-surface-container-highest" data-story-id="${s.id}">
        <div class="w-full h-full bg-cover bg-center" style="background-image:url('${s.image_url.replace(/'/g, "%27")}')"></div>
        <div class="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/80"></div>

        <div class="absolute top-4 left-4 z-10 flex items-center gap-2">
            <div class="flex items-center bg-surface-container-lowest/20 backdrop-blur-md rounded-full px-3 py-1.5 gap-2">
                <div class="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-on-primary font-bold text-[10px] flex-shrink-0">${initials}</div>
                <span class="font-label-md text-on-primary text-[13px]">@${escapeHtml(s.author_name)}</span>
            </div>
        </div>

        ${s.is_mine ? `
        <button class="delete-story-btn absolute top-4 right-4 z-10 w-9 h-9 rounded-full bg-surface-container-lowest/20 backdrop-blur-md flex items-center justify-center text-on-primary" data-id="${s.id}">
            <span class="material-symbols-outlined text-[18px]">delete</span>
        </button>` : ""}

        <div class="absolute bottom-4 left-4 right-4 z-10 flex flex-col gap-3">
            ${s.tags.length ? `<div class="flex flex-wrap gap-2">${s.tags.map((t) => `<span class="bg-secondary-fixed text-on-secondary-fixed font-label-md text-[10px] uppercase tracking-wider px-2 py-1 rounded-full shadow-sm">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            ${s.trip_name ? `<span class="font-label-md text-[11px] text-white/70">📍 ${escapeHtml(s.trip_name)}</span>` : ""}
            ${s.caption ? `<p class="font-body-md text-white/90 line-clamp-3 pr-12">${escapeHtml(s.caption)}</p>` : ""}
            <span class="font-label-md text-[11px] text-white/60">${timeAgoShort(s.created_at)}</span>
        </div>

        <div class="flex flex-col gap-4 absolute right-3 bottom-24 items-center z-10">
            <button class="like-story-btn flex flex-col items-center gap-1 text-white drop-shadow-md" data-id="${s.id}">
                <div class="w-12 h-12 rounded-full bg-surface-container-lowest/10 backdrop-blur-sm flex items-center justify-center active:scale-90 transition-transform">
                    <span class="material-symbols-outlined text-[28px] ${s.liked_by_me ? "text-error" : ""}" style="font-variation-settings: 'FILL' ${s.liked_by_me ? 1 : 0}">favorite</span>
                </div>
                <span class="font-label-md text-[12px] like-count-label">${s.like_count}</span>
            </button>
            <button class="open-comments-btn flex flex-col items-center gap-1 text-white drop-shadow-md" data-id="${s.id}">
                <div class="w-12 h-12 rounded-full bg-surface-container-lowest/10 backdrop-blur-sm flex items-center justify-center active:scale-90 transition-transform">
                    <span class="material-symbols-outlined text-[28px]">chat_bubble</span>
                </div>
                <span class="font-label-md text-[12px]">${s.comment_count}</span>
            </button>
            <button class="share-story-btn flex flex-col items-center gap-1 text-white drop-shadow-md" data-caption="${escapeHtml(s.caption || "")}" data-url="${s.image_url.replace(/"/g, "&quot;")}">
                <div class="w-12 h-12 rounded-full bg-surface-container-lowest/10 backdrop-blur-sm flex items-center justify-center active:scale-90 transition-transform">
                    <span class="material-symbols-outlined text-[28px]">send</span>
                </div>
                <span class="font-label-md text-[12px]">Share</span>
            </button>
        </div>
    </article>`;
}

function attachStoryCardHandlers() {
    document.querySelectorAll(".like-story-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            try {
                const { story } = await api(`/api/stories/${btn.dataset.id}/like`, { method: "POST" });
                const icon = btn.querySelector(".material-symbols-outlined");
                icon.style.setProperty("font-variation-settings", `'FILL' ${story.liked_by_me ? 1 : 0}`);
                icon.classList.toggle("text-error", story.liked_by_me);
                btn.querySelector(".like-count-label").textContent = story.like_count;
            } catch (err) {
                alert(err.message);
            }
        });
    });

    document.querySelectorAll(".delete-story-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            if (!confirm("ลบเรื่องเล่านี้?")) return;
            try {
                await api(`/api/stories/${btn.dataset.id}`, { method: "DELETE" });
                loadStoriesFeed();
            } catch (err) {
                alert(err.message);
            }
        });
    });

    document.querySelectorAll(".open-comments-btn").forEach((btn) => {
        btn.addEventListener("click", () => openComments(btn.dataset.id));
    });

    document.querySelectorAll(".share-story-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const text = `${btn.dataset.caption}\n${btn.dataset.url}`;
            try {
                if (navigator.share) {
                    await navigator.share({ text, url: btn.dataset.url });
                } else {
                    await navigator.clipboard.writeText(text);
                    alert("คัดลอกลิงก์แล้ว");
                }
            } catch (err) {
                /* user cancelled share — ignore */
            }
        });
    });
}

const storySheet = document.getElementById("story-sheet-backdrop");
document.getElementById("fab-add-story").addEventListener("click", async () => {
    storySheet.hidden = false;
    const select = document.getElementById("story-trip-select");
    select.innerHTML = '<option value="">ไม่ผูกกับทริปไหน</option>';
    try {
        const trips = myTrips.length ? myTrips : await refreshMyTrips();
        trips.forEach((t) => {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
    } catch { /* ignore */ }
});
document.getElementById("story-sheet-close").addEventListener("click", () => (storySheet.hidden = true));
storySheet.addEventListener("click", (e) => { if (e.target === storySheet) storySheet.hidden = true; });

document.getElementById("story-image-url").addEventListener("input", (e) => {
    const preview = document.getElementById("story-image-preview");
    if (e.target.value) {
        preview.src = e.target.value;
        preview.classList.remove("hidden");
    } else {
        preview.classList.add("hidden");
    }
});

document.getElementById("story-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const image_url = document.getElementById("story-image-url").value.trim();
    const caption = document.getElementById("story-caption").value.trim();
    const tags = document.getElementById("story-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
    const trip_id = document.getElementById("story-trip-select").value || null;
    try {
        await api("/api/stories", { method: "POST", body: JSON.stringify({ image_url, caption, tags, trip_id }) });
        e.target.reset();
        document.getElementById("story-image-preview").classList.add("hidden");
        storySheet.hidden = true;
        loadStoriesFeed();
    } catch (err) {
        alert(err.message);
    }
});

/* ---- Comments sheet ---- */
const commentsSheet = document.getElementById("comments-sheet-backdrop");
document.getElementById("comments-sheet-close").addEventListener("click", () => (commentsSheet.hidden = true));
commentsSheet.addEventListener("click", (e) => { if (e.target === commentsSheet) commentsSheet.hidden = true; });

async function openComments(storyId) {
    currentCommentsStoryId = storyId;
    commentsSheet.hidden = false;
    await loadComments();
}

async function loadComments() {
    const listEl = document.getElementById("comments-list");
    listEl.innerHTML = `<p class="font-body-md text-on-surface-variant text-sm text-center py-4">กำลังโหลด...</p>`;
    try {
        const { comments } = await api(`/api/stories/${currentCommentsStoryId}/comments`);
        if (comments.length === 0) {
            listEl.innerHTML = `<p class="font-body-md text-on-surface-variant text-sm text-center py-8">ยังไม่มีคอมเมนต์ เป็นคนแรกสิ!</p>`;
            return;
        }
        listEl.innerHTML = comments
            .map((c) => {
                const initials = c.author_name.trim().slice(0, 2).toUpperCase();
                return `
                <div class="flex items-start gap-3">
                    <div class="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-on-primary font-bold text-[11px] flex-shrink-0">${initials}</div>
                    <div class="flex-1 min-w-0">
                        <div class="flex items-baseline gap-2">
                            <span class="font-label-md text-on-surface text-[13px]">@${escapeHtml(c.author_name)}</span>
                            <span class="font-body-md text-[11px] text-outline">${timeAgoShort(c.created_at)}</span>
                        </div>
                        <p class="font-body-md text-on-surface text-sm mt-0.5">${escapeHtml(c.body)}</p>
                    </div>
                </div>`;
            })
            .join("");
    } catch (err) {
        listEl.innerHTML = `<p class="font-body-md text-error text-sm text-center py-4">${escapeHtml(err.message)}</p>`;
    }
}

document.getElementById("comment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("comment-input");
    const body = input.value.trim();
    if (!body || !currentCommentsStoryId) return;
    try {
        await api(`/api/stories/${currentCommentsStoryId}/comments`, { method: "POST", body: JSON.stringify({ body }) });
        input.value = "";
        await loadComments();
        loadStoriesFeed(); // refresh comment count on the card behind
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   15) Trip Invites — คำเชิญเข้าทริป (Phase 4)
--------------------------------------------------- */
async function loadInvites() {
    const section = document.getElementById("invites-section");
    const listEl = document.getElementById("invites-list");
    try {
        const { invites } = await api("/api/invites");
        section.hidden = invites.length === 0;
        listEl.innerHTML = invites
            .map(
                (inv) => `
            <div class="flex items-center gap-3 bg-surface-container-lowest p-4 rounded-[18px] shadow-sm">
                <div class="w-11 h-11 rounded-full bg-secondary-fixed flex items-center justify-center text-on-secondary-fixed flex-shrink-0">
                    <span class="material-symbols-outlined text-[20px]">mail</span>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="font-label-md text-on-surface text-sm truncate"><strong>@${escapeHtml(inv.from_username)}</strong> ชวนคุณไป</p>
                    <p class="font-body-md text-on-surface-variant text-[13px] truncate">${escapeHtml(inv.trip_name)}</p>
                </div>
                <div class="flex gap-2 flex-shrink-0">
                    <button class="decline-invite-btn w-9 h-9 rounded-full bg-surface-container-high text-on-surface-variant flex items-center justify-center" data-id="${inv.id}">
                        <span class="material-symbols-outlined text-[18px]">close</span>
                    </button>
                    <button class="accept-invite-btn w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center" data-id="${inv.id}">
                        <span class="material-symbols-outlined text-[18px]">check</span>
                    </button>
                </div>
            </div>`
            )
            .join("");

        listEl.querySelectorAll(".accept-invite-btn").forEach((btn) => {
            btn.addEventListener("click", async () => {
                try {
                    await api(`/api/invites/${btn.dataset.id}/accept`, { method: "POST" });
                    await refreshMyTrips();
                    renderTripsScreen();
                    loadInvites();
                } catch (err) {
                    alert(err.message);
                }
            });
        });
        listEl.querySelectorAll(".decline-invite-btn").forEach((btn) => {
            btn.addEventListener("click", async () => {
                try {
                    await api(`/api/invites/${btn.dataset.id}/decline`, { method: "POST" });
                    loadInvites();
                } catch (err) {
                    alert(err.message);
                }
            });
        });
    } catch (err) {
        console.warn("loadInvites failed:", err.message);
    }
}

/* ---------------------------------------------------
   16) Explore sub-tabs: Community Trips / Find Travelers
--------------------------------------------------- */
const exploreTabTrips = document.getElementById("explore-tab-trips");
const exploreTabTravelers = document.getElementById("explore-tab-travelers");
const explorePanelTrips = document.getElementById("explore-panel-trips");
const explorePanelTravelers = document.getElementById("explore-panel-travelers");

function switchExploreTab(tab) {
    const isTrips = tab === "trips";
    setPillTab(isTrips ? exploreTabTrips : exploreTabTravelers, isTrips ? exploreTabTravelers : exploreTabTrips);
    explorePanelTrips.hidden = !isTrips;
    explorePanelTravelers.hidden = isTrips;
    if (!isTrips) loadTravelers();
}
exploreTabTrips.addEventListener("click", () => switchExploreTab("trips"));
exploreTabTravelers.addEventListener("click", () => switchExploreTab("travelers"));

let travelersSearchTimer = null;
document.getElementById("travelers-search").addEventListener("input", (e) => {
    clearTimeout(travelersSearchTimer);
    travelersSearchTimer = setTimeout(() => loadTravelers(e.target.value.trim()), 350);
});

async function loadTravelers(q) {
    const listEl = document.getElementById("travelers-list");
    const emptyState = document.getElementById("travelers-empty-state");
    try {
        const url = q ? `/api/travelers?q=${encodeURIComponent(q)}` : "/api/travelers";
        const { travelers } = await api(url);
        emptyState.hidden = travelers.length !== 0;
        listEl.innerHTML = travelers.map(travelerCardHtml).join("");

        listEl.querySelectorAll(".invite-traveler-btn").forEach((btn) => {
            btn.addEventListener("click", () => openInviteSheet(btn.dataset.id, btn.dataset.name));
        });
    } catch (err) {
        console.warn("loadTravelers failed:", err.message);
    }
}

function travelerCardHtml(t) {
    const initials = t.username.trim().slice(0, 2).toUpperCase();
    const matchBadge =
        t.match_pct != null
            ? `<div class="absolute top-4 right-4 bg-surface-container-lowest/90 backdrop-blur-md text-primary font-label-md text-xs px-3 py-1.5 rounded-full shadow-sm flex items-center gap-1">
                 <span class="material-symbols-outlined text-[16px]">verified</span> ${t.match_pct}% Match
               </div>`
            : "";
    return `
    <article class="relative flex flex-col w-full">
        <div class="w-full h-40 rounded-[24px] overflow-hidden bg-gradient-to-br from-primary/15 to-secondary/15 relative flex items-center justify-center">
            <span class="font-display-xl text-primary/40 text-[64px]">${initials}</span>
            ${matchBadge}
        </div>
        <div class="relative z-10 w-[92%] mx-auto mt-overlap-offset bg-surface-container-lowest rounded-3xl p-5 shadow-[0_20px_48px_rgba(0,0,0,0.08)]">
            <h2 class="font-headline-lg text-[20px] text-on-surface">@${escapeHtml(t.username)}</h2>
            ${t.location_text ? `<p class="font-body-md text-on-surface-variant flex items-center gap-1 mt-1 text-sm"><span class="material-symbols-outlined text-[16px]">location_on</span> ${escapeHtml(t.location_text)}</p>` : ""}
            <div class="flex flex-wrap gap-2 mt-3">
                ${t.interests.map((i) => `<span class="bg-primary-fixed text-on-primary-fixed-variant font-label-md text-[11px] px-3 py-1 rounded-full">${escapeHtml(i)}</span>`).join("")}
                <span class="bg-surface-container-low text-on-surface-variant font-label-md text-[11px] px-3 py-1 rounded-full border border-outline-variant/30 flex items-center gap-1">
                    <span class="material-symbols-outlined text-[12px]">luggage</span> ${t.trip_count} ทริป
                </span>
            </div>
            ${t.bio ? `<p class="mt-3 font-body-md text-on-surface text-sm line-clamp-3">${escapeHtml(t.bio)}</p>` : ""}
            <button class="invite-traveler-btn w-full mt-4 bg-secondary-fixed text-on-secondary-fixed font-label-md text-sm py-3 rounded-full flex items-center justify-center gap-2 active:scale-95 transition-transform" data-id="${t.id}" data-name="${escapeHtml(t.username)}">
                <span class="material-symbols-outlined text-[18px]">add_reaction</span> ชวนไปทริป
            </button>
        </div>
    </article>`;
}

/* ---- Invite-to-trip picker sheet ---- */
const inviteSheet = document.getElementById("invite-sheet-backdrop");
let inviteTargetUserId = null;

async function openInviteSheet(userId, username) {
    inviteTargetUserId = userId;
    document.getElementById("invite-target-name").textContent = "@" + username;
    inviteSheet.hidden = false;

    const listEl = document.getElementById("invite-trip-list");
    const emptyEl = document.getElementById("invite-trip-empty");
    listEl.innerHTML = "";
    try {
        const trips = (await refreshMyTrips()).filter((t) => t.is_active);
        emptyEl.hidden = trips.length !== 0;
        listEl.innerHTML = trips
            .map(
                (t) => `
            <button class="invite-pick-trip-btn w-full text-left flex items-center gap-3 p-3 rounded-[16px] bg-surface-container-low hover:bg-surface-container-high transition-colors" data-trip-id="${t.id}">
                <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${t.color}"></span>
                <span class="font-label-md text-on-surface text-sm flex-1 truncate">${escapeHtml(t.name)}</span>
                <span class="material-symbols-outlined text-outline-variant text-[18px]">chevron_right</span>
            </button>`
            )
            .join("");

        listEl.querySelectorAll(".invite-pick-trip-btn").forEach((btn) => {
            btn.addEventListener("click", async () => {
                try {
                    await api(`/api/travelers/${inviteTargetUserId}/invite`, {
                        method: "POST",
                        body: JSON.stringify({ tripId: btn.dataset.tripId }),
                    });
                    inviteSheet.hidden = true;
                    const original = btn.innerHTML;
                    alert("ส่งคำเชิญแล้ว!");
                } catch (err) {
                    alert(err.message);
                }
            });
        });
    } catch (err) {
        console.warn("openInviteSheet failed:", err.message);
    }
}
document.getElementById("invite-sheet-close").addEventListener("click", () => (inviteSheet.hidden = true));
inviteSheet.addEventListener("click", (e) => { if (e.target === inviteSheet) inviteSheet.hidden = true; });

/* ---------------------------------------------------
   17) Profile — Phase 4
--------------------------------------------------- */
let myProfile = null;

async function loadProfile() {
    try {
        const { profile } = await api("/api/profile/me");
        myProfile = profile;
        renderProfile(profile);
    } catch (err) {
        console.warn("loadProfile failed:", err.message);
    }
}

function renderProfile(p) {
    document.getElementById("profile-bio").textContent = p.bio || "นักเดินทาง Travel Buddy";
    const locEl = document.getElementById("profile-location");
    if (p.location_text) {
        locEl.hidden = false;
        locEl.querySelector("span:last-child").textContent = p.location_text;
    } else {
        locEl.hidden = true;
    }
    document.getElementById("profile-interests").innerHTML = (p.interests || [])
        .map((i) => `<span class="bg-primary-container/20 text-primary font-label-md text-[11px] px-3 py-1 rounded-full uppercase tracking-wider">${escapeHtml(i)}</span>`)
        .join("");
    document.getElementById("profile-stat-trips").textContent = p.trip_count ?? 0;
    document.getElementById("profile-stat-destinations").textContent = p.destination_count ?? 0;
    document.getElementById("profile-stat-stories").textContent = p.story_count ?? 0;
}

const editProfileSheet = document.getElementById("edit-profile-sheet-backdrop");
const discoverableToggleBtn = document.getElementById("edit-profile-discoverable-toggle");
const discoverableKnob = document.getElementById("edit-profile-discoverable-knob");
let editDiscoverable = false;

function setDiscoverableUI(on) {
    editDiscoverable = on;
    discoverableToggleBtn.classList.toggle("bg-primary", on);
    discoverableToggleBtn.classList.toggle("bg-surface-container-high", !on);
    discoverableKnob.style.transform = on ? "translateX(24px)" : "translateX(0)";
}

document.getElementById("edit-profile-btn").addEventListener("click", () => {
    if (!myProfile) return;
    document.getElementById("edit-profile-bio").value = myProfile.bio || "";
    document.getElementById("edit-profile-location").value = myProfile.location_text || "";
    document.getElementById("edit-profile-interests").value = (myProfile.interests || []).join(", ");
    setDiscoverableUI(myProfile.discoverable);
    editProfileSheet.hidden = false;
});
document.getElementById("edit-profile-sheet-close").addEventListener("click", () => (editProfileSheet.hidden = true));
editProfileSheet.addEventListener("click", (e) => { if (e.target === editProfileSheet) editProfileSheet.hidden = true; });
discoverableToggleBtn.addEventListener("click", () => setDiscoverableUI(!editDiscoverable));

document.getElementById("edit-profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const bio = document.getElementById("edit-profile-bio").value.trim();
    const location_text = document.getElementById("edit-profile-location").value.trim();
    const interests = document.getElementById("edit-profile-interests").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
        const { profile } = await api("/api/profile", {
            method: "PATCH",
            body: JSON.stringify({ bio, location_text, interests, discoverable: editDiscoverable }),
        });
        myProfile = profile;
        renderProfile({ ...profile, trip_count: document.getElementById("profile-stat-trips").textContent,
            destination_count: document.getElementById("profile-stat-destinations").textContent,
            story_count: document.getElementById("profile-stat-stories").textContent });
        editProfileSheet.hidden = true;
    } catch (err) {
        alert(err.message);
    }
});

/* ---------------------------------------------------
   18) Location Alerts — ห่างจากกลุ่ม / ห่างจากจุดนัดหมาย / ไม่เคลื่อนที่ / ใกล้ถึงกำหนดการ (Phase 5)
   ทำงานแบบ in-app banner เท่านั้น (ไม่มีระบบ push notification) — เช็คทุกครั้งที่มีพิกัดใหม่ + ทุก 30 วิ
   หมายเหตุ: นี่คือการแจ้งเตือนตามเงื่อนไขตำแหน่ง/เวลาเท่านั้น ไม่ใช่การตรวจจับอุบัติเหตุ
--------------------------------------------------- */
const GROUP_DISTANCE_THRESHOLD_M = 500;   // ห่างจากศูนย์กลางกลุ่มเกินนี้ = แจ้งเตือน
const MEETUP_DISTANCE_THRESHOLD_M = 500;  // ห่างจากจุดนัดหมายเกินนี้ = แจ้งเตือน
const UPCOMING_SCHEDULE_WINDOW_MS = 15 * 60 * 1000; // แจ้งเตือนล่วงหน้า 15 นาทีก่อนถึงกำหนดการ

function runAlertChecks() {
    if (!currentTrip || !currentTrip.is_active || currentTripTab !== "map") {
        document.getElementById("alerts-banner-stack").innerHTML = "";
        return;
    }

    const banners = [];
    const myPos = myMarker ? myMarker.getLatLng() : null;

    // 1) ใกล้ถึงกำหนดการ (ลำดับความสำคัญสูงสุด)
    const now = Date.now();
    const upcoming = currentItineraryItems.find(
        (it) => it.start_time && it.start_time > now && it.start_time - now <= UPCOMING_SCHEDULE_WINDOW_MS
    );
    if (upcoming) {
        const mins = Math.round((upcoming.start_time - now) / 60000);
        banners.push({
            icon: "schedule",
            style: "bg-primary text-on-primary",
            text: `กิจกรรม "${upcoming.title}" เริ่มในอีก ${mins} นาที`,
        });
    }

    // 2) ห่างจากจุดนัดหมาย (เฉพาะตอนที่ฉันแชร์ตำแหน่งอยู่)
    if (myPos && currentTrip.share_enabled && currentTrip.meetup_lat != null) {
        const d = haversineMeters(myPos.lat, myPos.lng, currentTrip.meetup_lat, currentTrip.meetup_lng);
        if (d > MEETUP_DISTANCE_THRESHOLD_M) {
            banners.push({
                icon: "flag",
                style: "bg-secondary-fixed text-on-secondary-fixed",
                text: `คุณอยู่ห่างจากจุดนัดหมาย${currentTrip.meetup_name ? ` "${currentTrip.meetup_name}"` : ""} ${fmtDistance(d)}`,
            });
        }
    }

    // 3) ห่างจากกลุ่ม (เทียบกับจุดศูนย์กลางของสมาชิกที่แชร์ตำแหน่งอยู่ทั้งหมด รวมตัวเอง)
    if (myPos && currentTrip.share_enabled) {
        const sharing = currentMembers.filter((m) => m.share_enabled && m.lat != null && m.lng != null);
        if (sharing.length >= 2) {
            const centroid = sharing.reduce(
                (acc, m) => ({ lat: acc.lat + m.lat / sharing.length, lng: acc.lng + m.lng / sharing.length }),
                { lat: 0, lng: 0 }
            );
            const d = haversineMeters(myPos.lat, myPos.lng, centroid.lat, centroid.lng);
            if (d > GROUP_DISTANCE_THRESHOLD_M) {
                banners.push({
                    icon: "social_distance",
                    style: "bg-error text-on-error",
                    text: `คุณอยู่ห่างจากกลุ่มประมาณ ${fmtDistance(d)}`,
                });
            }
        }
    }

    // 4) สมาชิกไม่มีการเคลื่อนที่ (สรุปรวม ไม่นับตัวเอง — รายละเอียดดูได้ที่แท็บ Members)
    const stale = currentMembers.filter(
        (m) => m.id !== me.id && m.share_enabled && m.last_moved_at && now - m.last_moved_at > NO_MOVEMENT_THRESHOLD_MS
    );
    if (stale.length > 0) {
        banners.push({
            icon: "pause_circle",
            style: "bg-surface-container-lowest text-on-surface border border-outline-variant",
            text: `${stale.map((m) => m.name).join(", ")} ไม่มีการเคลื่อนที่มาสักพักแล้ว`,
        });
    }

    document.getElementById("alerts-banner-stack").innerHTML = banners
        .slice(0, 3)
        .map(
            (b) => `
        <div class="flex items-center gap-2 ${b.style} rounded-2xl px-4 py-3 shadow-[0_4px_16px_rgba(0,0,0,0.12)] backdrop-blur-md">
            <span class="material-symbols-outlined text-[18px] flex-shrink-0">${b.icon}</span>
            <span class="font-label-md text-[12.5px] leading-snug">${escapeHtml(b.text)}</span>
        </div>`
        )
        .join("");
}
