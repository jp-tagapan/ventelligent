import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
    getDatabase,
    ref,
    onValue,
    update,
    push,
    remove,
    query,
    limitToLast
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyCv2uBe1AecDr0Pvq4a7qGHxrv9WDoiLQE",
    authDomain: "ventelligent.firebaseapp.com",
    databaseURL: "https://ventelligent-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "ventelligent",
    storageBucket: "ventelligent.firebasestorage.app",
    messagingSenderId: "431320308985",
    appId: "1:431320308985:web:e0d5c88a7bb69f71c15628"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Thresholds & Constants
const HIGH_THRESHOLD = 35;
const WARN_THRESHOLD = 33;
const FAN_CAPACITY = 4;

let airTemp = 0;
let humidity = 0;
let heatIndex = 0;
let ventOn = false;
let autoMode = true;
let online = false;
let hasData = false;
let ack = false;
let lastUpdateTimestamp = 0;

let readings = [];
let history = [];
let lastRecordedStatus = null;

const $ = (id) => document.getElementById(id);

function getStatus(hi) {
    if (hi >= HIGH_THRESHOLD) return "critical";
    if (hi >= WARN_THRESHOLD) return "warning";
    return "normal";
    }

    function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
        el.style.display = "none";
    }, 2400);
}

// Navigation & Live Clock
function navigate(page) {
    document.querySelectorAll(".page").forEach((p) => {
        p.classList.toggle("active", p.id === "page-" + page);
    });
    document.querySelectorAll("[data-page]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.page === page);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.page));
});
$("viewAllHistoryBtn").addEventListener("click", () => navigate("history"));

function updateClock() {
    $("clock").textContent = new Date().toLocaleString();
}
setInterval(updateClock, 1000);
updateClock();

// Alert Sound
let audioCtx = null;
let tuttOsc = null;
let tuttLfo = null;

window.addEventListener(
    "click",
    () => {
        if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === "suspended") audioCtx.resume();
    },
    { once: true }
);

function startTutt() {
    try {
        if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === "suspended") audioCtx.resume();
        if (tuttOsc) return;

        const now = audioCtx.currentTime;
        tuttOsc = audioCtx.createOscillator();
        tuttOsc.type = "sawtooth";
        tuttOsc.frequency.setValueAtTime(780, now);

        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.08, now);

        tuttLfo = audioCtx.createOscillator();
        tuttLfo.type = "square";
        tuttLfo.frequency.setValueAtTime(14, now);

        const lfoGain = audioCtx.createGain();
        lfoGain.gain.setValueAtTime(0.08, now);

        tuttLfo.connect(lfoGain);
        lfoGain.connect(gain.gain);
        tuttOsc.connect(gain);
        gain.connect(audioCtx.destination);

        tuttOsc.start(now);
        tuttLfo.start(now);
    } catch (e) {}
}

function stopTutt() {
    try {
        if (tuttOsc) {
        tuttOsc.stop();
        tuttOsc.disconnect();
        tuttOsc = null;
        }
        if (tuttLfo) {
        tuttLfo.stop();
        tuttLfo.disconnect();
        tuttLfo = null;
        }
    } catch (e) {}
}

$("ackBtn").addEventListener("click", () => {
    ack = true;
    stopTutt();
    $("banner").classList.remove("active-banner", "flagged");
    toast("Alert acknowledged.");
});

// Firebase Realtime Database References
const liveDataRef = ref(db, "ventilationSystem/liveData");
const controlsRef = ref(db, "ventilationSystem/controls");
const historyRef = ref(db, "ventilationSystem/statusHistory");

// A) Listen to Live Sensor & Vent Data from ESP32
onValue(liveDataRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    airTemp = Number(data.temperature ?? 0);
    humidity = Number(data.humidity ?? 0);
    heatIndex = Number(data.heatIndex ?? 0);
    lastUpdateTimestamp = Number(data.lastUpdated ?? Date.now());

    if (autoMode) {
        ventOn = Boolean(data.fanState);
    }

    hasData = true;
    online = true;

    // Add to trend line (max 30 points)
    readings.push(heatIndex);
    if (readings.length > 30) readings.shift();

    // Check if Heat Index status CHANGED (Normal <-> Warning <-> Critical)
    const currentStatus = getStatus(heatIndex);
    if (lastRecordedStatus !== currentStatus) {
        const previousStatus = lastRecordedStatus;
        lastRecordedStatus = currentStatus;

        const eventLabel =
        previousStatus === null
            ? `Initial status recorded: ${currentStatus.toUpperCase()}`
            : `Status changed: ${previousStatus.toUpperCase()} → ${currentStatus.toUpperCase()}`;

        push(historyRef, {
        time: new Date().toLocaleString(),
        temp: Number(heatIndex.toFixed(1)),
        status: currentStatus,
        vent: ventOn ? "ON" : "OFF",
        event: eventLabel
        });
    }

    if (heatIndex < HIGH_THRESHOLD) ack = false;
    currentStatus === "critical" && !ack ? startTutt() : stopTutt();

    updateUI();
});

// B) Listen to Control Mode (Auto vs Manual Override)
onValue(controlsRef, (snapshot) => {
    const ctrl = snapshot.val();
    if (!ctrl) return;
    autoMode = ctrl.mode !== "MANUAL";
    if (!autoMode) {
        ventOn = Boolean(ctrl.manualFanState);
    }
    updateUI();
});

// C) Listen to Status-Change History stored in Firebase
onValue(query(historyRef, limitToLast(100)), (snapshot) => {
    const val = snapshot.val();
    if (!val) {
        history = [];
        lastRecordedStatus = null;
    } else {
        history = Object.values(val).reverse(); // Newest first
        if (history.length > 0 && lastRecordedStatus === null) {
        lastRecordedStatus = history[0].status;
        }
    }
    renderRecentHistory();
    renderFullHistory();
    });

// Check every 5s if ESP32 stopped updating (unplugged/offline check)
setInterval(() => {
    if (!hasData) return;
    if (lastUpdateTimestamp > 0 && Date.now() - lastUpdateTimestamp > 15000) {
        online = false;
        stopTutt();
        updateUI();
    }
}, 5000);

// Manual Override Buttons
function sendVentCommand(action) {
    if (action === "auto") {
        autoMode = true;
        update(controlsRef, { mode: "AUTO" });
        toast("Switched to Auto Mode");
    } else {
        const turnOn = action === "on";
        autoMode = false;
        ventOn = turnOn;
        update(controlsRef, {
        mode: "MANUAL",
        manualFanState: turnOn
        });
        toast(`Manual Override: Vent turned ${turnOn ? "ON" : "OFF"}`);
    }
    updateUI();
}

$("btnVentOn").addEventListener("click", () => sendVentCommand("on"));
$("btnVentOff").addEventListener("click", () => sendVentCommand("off"));
$("btnVentAuto").addEventListener("click", () => sendVentCommand("auto"));

// UI Update Functions
function getRecommendation(hi) {
    if (hi < HIGH_THRESHOLD) {
        return {
        count: 0,
        text: "Heat index is within the safe range. Keep automatic monitoring active."
        };
    }
    const n = hi >= 39 ? FAN_CAPACITY : hi >= 37 ? 3 : 2;
    return {
        count: n,
        text: `Heat index is elevated. Recommended: operate ${n} Iwata fan${n === 1 ? "" : "s"} to increase airflow.`
    };
}

function updateUI() {
// System & Connection Indicators
    $("liveDot").style.background = online ? "var(--green)" : "var(--red)";
    $("liveDot").style.boxShadow = online ? "0 0 12px var(--green)" : "0 0 12px var(--red)";
    $("sysState").textContent = online ? "ACTIVE" : "OFFLINE";
    $("sysState").style.color = online ? "var(--green)" : "var(--red)";
    $("sysText").textContent = online ? "Synced with Firebase" : "ESP32 offline";

    const s = getStatus(heatIndex);

    // Heat Index Card
    $("currentTemp").textContent = hasData ? heatIndex.toFixed(1) : "--";
    $("subSensorStats").textContent = hasData
        ? `Temp: ${airTemp.toFixed(1)}°C | Humidity: ${humidity.toFixed(1)}%`
        : "Temp: --°C | Humidity: --%";

    const pill = $("tempStatus");
    if (!online) {
        pill.textContent = hasData ? "Offline" : "Waiting for Sensor...";
        pill.style.background = "#444a66";
    } else {
        pill.textContent = s === "critical" ? "Above Threshold!" : s === "warning" ? "Warning" : "Normal";
        pill.style.background = s === "critical" ? "#81213a" : s === "warning" ? "#815013" : "#087b4b";
    }

// Global Banner
    const banner = $("banner");
    if (online && s !== "normal" && !ack) {
        banner.classList.add("active-banner");
        banner.classList.toggle("flagged", s === "critical");
        $("bannerTitle").textContent = s === "critical" ? "HIGH HEAT INDEX ALERT!" : "HEAT INDEX WARNING";
        $("bannerText").textContent = `Heat index reached ${heatIndex.toFixed(1)}°C (Temp ${airTemp.toFixed(1)}°C). Threshold: ${HIGH_THRESHOLD}°C.`;
        $("bannerTemp").textContent = heatIndex.toFixed(1);
    } else {
        banner.classList.remove("active-banner", "flagged");
    }

// Vent Status & Animated Fan Icon (spins when ventOn === true, static when false)
    $("dashFanIcon").classList.toggle("on", ventOn);
    $("ventPageFanIcon").classList.toggle("on", ventOn);

    const stateText = hasData ? (ventOn ? "ON" : "OFF") : "--";
    $("fanState").textContent = stateText;
    $("ventPageState").textContent = stateText;
    $("fanState").classList.toggle("active-on", ventOn);
    $("ventPageState").classList.toggle("active-on", ventOn);

    const modeLabel = autoMode ? "Auto Mode" : "Manual Override";
    $("fanModeText").textContent = hasData ? modeLabel : "--";
    $("fanCountText").textContent = hasData ? `${ventOn ? 1 : 0} vent(s) running` : "--";
    $("ventPageDetail").textContent = hasData ? `${ventOn ? 1 : 0} vent(s) active • ${modeLabel}` : "--";
    $("ventAdvice").textContent = autoMode
        ? "Automatic mode is active: the ESP32 switches the vent automatically based on the heat index."
        : 'Manual override is active: your app command overrides automatic switching until you press "Auto Mode".';

// Recommendations Card
    const rec = getRecommendation(heatIndex);
    $("recTitle").textContent = !hasData
        ? "System Monitoring Active"
        : `${s === "normal" ? "Heat Index Stable" : s === "critical" ? "Heat Index Spike" : "Heat Index Warning"} (${heatIndex.toFixed(1)}°C)`;
    $("recBody").textContent = !hasData ? "Awaiting live data stream from Firebase." : rec.text;
    $("suggestedFans").textContent = !hasData
        ? "--"
        : rec.count
        ? `${rec.count} Iwata fan${rec.count === 1 ? "" : "s"}`
        : "Vents can remain OFF";
    $("recMode").textContent = !hasData ? "--" : autoMode ? "Automatic" : "Manual Override";
    $("recReason").textContent = !hasData
        ? "System will adapt airflow once sensor readings synchronize."
        : s === "normal"
        ? "No additional ventilation is recommended at this time."
        : "Additional airflow may help reduce the room heat index.";

    drawChart();
}

function drawChart() {
    const el = $("trendChart");
    if (!el) return;

    const w = 620, h = 210, p = 34, min = 20, max = 45;
    const y = (v) => h - p - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * (h - 2 * p);
    const pts = readings.map((v, i) => [
        p + (i * (w - 2 * p)) / Math.max(1, readings.length - 1),
        y(v)
    ]);

    const path = pts.map((a, i) => (i ? "L" : "M") + a.join(",")).join(" ");
    const grid = [20, 25, 30, 35, 40, 45]
        .map(
        (v) =>
            `<line x1="${p}" y1="${y(v)}" x2="${w - p}" y2="${y(v)}" stroke="#343954" stroke-dasharray="3 4"/>
            <text x="2" y="${y(v) + 4}">${v}°</text>`
        )
        .join("");
    const dots = pts.map((a) => `<circle cx="${a[0]}" cy="${a[1]}" r="4" fill="#ff609b"/>`).join("");

    el.innerHTML = `
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
        ${grid}
        <line x1="${p}" y1="${y(HIGH_THRESHOLD)}" x2="${w - p}" y2="${y(HIGH_THRESHOLD)}" stroke="#ffbd43" stroke-dasharray="6 4"/>
        ${pts.length > 0 ? `<path d="${path}" fill="none" stroke="#fa5795" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
        ${dots}
        <text x="${p}" y="${h - 5}">Earlier</text>
        <text x="${w - p - 28}" y="${h - 5}">Now</text>
        </svg>
    `;
}

// History Table
function renderRecentHistory() {
    const tbody = $("recentRows");
    if (!history.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty">No status changes recorded yet.</td></tr>`;
        return;
    }
    tbody.innerHTML = history
        .slice(0, 4)
        .map(
        (x) => `
        <tr>
            <td>${x.time}</td>
            <td><b>${Number(x.temp).toFixed(1)}°C</b></td>
            <td><span class="status ${x.status}">${x.status.toUpperCase()}</span></td>
            <td>${x.vent}</td>
        </tr>`
        )
        .join("");
}

function renderFullHistory() {
    const tbody = $("historyRows");
    const filter = $("historyFilter").value;
    const rows = history.filter((x) => filter === "all" || x.status === filter);

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty">No status change entries found.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows
        .map(
        (x) => `
        <tr>
            <td>${x.time}</td>
            <td>${Number(x.temp).toFixed(1)}°C</td>
            <td><span class="status ${x.status}">${x.status.toUpperCase()}</span></td>
            <td>${x.vent}</td>
            <td>${x.event}</td>
        </tr>`
        )
        .join("");
}

$("historyFilter").addEventListener("change", renderFullHistory);

$("exportCsvBtn").addEventListener("click", () => {
    const rows = [
        ["Date & Time", "Heat Index C", "Status", "Vent", "Event"],
        ...history.map((x) => [x.time, x.temp, x.status, x.vent, x.event])
    ];
    const csv = rows
        .map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))
        .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "ventelligent-status-history.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("History CSV exported.");
});

$("clearHistoryBtn").addEventListener("click", async () => {
    if (confirm("Clear all status change history from Firebase?")) {
        await remove(historyRef);
        lastRecordedStatus = null;
        toast("History cleared.");
    }
});

// Initial blank chart render
drawChart();