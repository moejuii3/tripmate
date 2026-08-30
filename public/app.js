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
    openTripsScreen();
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
        await openTripsScreen();
    } catch (err) {
        authScreen.hidden = false;
    }
}
boot();

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

    socket.on("itinerary-updated", ({ tripId }) => {
        if (currentTrip && currentTrip.id === tripId && currentTripTab === "schedule") loadItinerary();
    });

    socket.on("expenses-updated", ({ tripId }) => {
        if (currentTrip && currentTrip.id === tripId && currentTripTab === "expenses") loadExpenses();
    });

    socket.on("users-location", ({ trip, members }) => {
        if (!currentTrip || (trip && trip.id !== currentTrip.id)) return;
        renderMapMarkers(members);
        renderMemberList(members);
        document.getElementById("map-member-count").textContent = `${members.length} คน`;
    });
}

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
}

/* ---------------------------------------------------
   3b) Global tabs: Trips / Explore / Profile
--------------------------------------------------- */
const fabAddTrip = document.getElementById("fab-add-trip");
const TAB_TITLES = { trips: "My Trips", explore: "Explore", profile: "Profile" };

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
    if (tab === "explore") loadCommunityTrips();
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
    if (tab === "map" && map) setTimeout(() => map.invalidateSize(), 50);
    if (tab === "schedule") loadItinerary();
    if (tab === "expenses") loadExpenses();
}

async function enterTrip(trip) {
    currentTrip = trip;
    tripsScreen.hidden = true;
    tripScreen.hidden = false;
    switchTripTab("map");

    document.getElementById("trip-screen-name").textContent = trip.name;
    document.getElementById("member-trip-code").textContent = trip.code;
    updateTripStatusUI();
    updateVisibilityUI();

    if (!map) initMap();
    Object.values(markers).forEach((m) => map.removeLayer(m.marker));
    for (const k in markers) delete markers[k];
    if (myMarker) { map.removeLayer(myMarker); myMarker = null; }
    firstFix = true;

    socket.emit("join-trip", { tripId: trip.id });

    if (trip.is_active && trip.share_enabled) startWatchingPosition();
    else stopWatchingPosition();
    updateShareToggleUI();
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
}

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
    list.innerHTML = members
        .map((u) => {
            const isMe = u.id === me.id;
            const initials = u.name.trim().slice(0, 2).toUpperCase();
            return `
            <div class="flex items-center gap-4 py-3 ${members.indexOf(u) > 0 ? "border-t border-surface-container-high" : ""}">
                <div class="w-11 h-11 rounded-full flex items-center justify-center font-bold text-[13px] text-white flex-shrink-0" style="background:${u.color}">${initials}</div>
                <div class="flex-1 min-w-0">
                    <div class="font-label-md text-on-surface text-sm truncate">${escapeHtml(u.name)}${isMe ? " (คุณ)" : ""}</div>
                    <div class="font-body-md text-[12px] text-on-surface-variant">${timeAgo(u.last_update, !!u.share_enabled)}</div>
                </div>
                ${!u.share_enabled ? '<span class="font-label-md text-[10px] text-error bg-error-container px-2 py-1 rounded-full flex-shrink-0">ปิด GPS</span>' : ""}
            </div>`;
        })
        .join("");
}

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
        renderItinerary(items);
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

    listEl.innerHTML = items
        .map((item, idx) => {
            const icon = CATEGORY_ICON[item.category] || "place";
            const color = CATEGORY_COLOR[item.category] || "#434656";
            const timeLabel = fmtDateTime(item.start_time);
            return `
            <div class="relative pl-10 pb-8 ${idx < items.length - 1 ? "border-l-2 border-surface-container-high ml-4" : "ml-4"}">
                <div class="absolute -left-[9px] top-0 w-4 h-4 rounded-full shadow-[0_0_0_4px_#fcf9f8]" style="background:${color}"></div>
                <div class="bg-surface-container-lowest rounded-[20px] p-4 shadow-[0_4px_16px_rgba(0,0,0,0.03)] flex gap-3 items-start -mt-1">
                    <div class="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${color}22;color:${color}">
                        <span class="material-symbols-outlined text-[20px]">${icon}</span>
                    </div>
                    <div class="flex-1 min-w-0">
                        <h4 class="font-headline-md text-[16px] text-on-surface truncate">${escapeHtml(item.title)}</h4>
                        ${item.location_name ? `<p class="font-body-md text-[13px] text-on-surface-variant truncate">📍 ${escapeHtml(item.location_name)}</p>` : ""}
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
document.getElementById("add-itinerary-btn").addEventListener("click", () => (itinerarySheet.hidden = false));
document.getElementById("itinerary-sheet-close").addEventListener("click", () => (itinerarySheet.hidden = true));
itinerarySheet.addEventListener("click", (e) => { if (e.target === itinerarySheet) itinerarySheet.hidden = true; });

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
    };
    try {
        await api(`/api/trips/${currentTrip.id}/itinerary`, { method: "POST", body: JSON.stringify(body) });
        e.target.reset();
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
