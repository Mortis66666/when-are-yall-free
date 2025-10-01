// -------------------- Data model --------------------
let persons = []; // {id,name,events:[{day,start,end}]}
let nextId = 1;
const API_ROUTE =
    "https://s3-ap-southeast-1.amazonaws.com/open-ws/weektimetable";
const DAY_MAP = {
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
    SUN: 7
};

// Helpers
function hmsToMinutes(t) {
    // "HH:MM"
    if (!t) return 0;
    const [hh, mm] = t.split(":").map(Number);
    return hh * 60 + mm;
}

function minutesToHMS(m) {
    const hh = Math.floor(m / 60)
        .toString()
        .padStart(2, "0");
    const mm = (m % 60).toString().padStart(2, "0");
    return `${hh}:${mm}`;
}

/**
 *
 * @param {String} datestampIso YYYY-MM-DD
 */
function isThisWeek(datestampIso) {
    const d = new Date(datestampIso);

    const todayObj = new Date();
    const todayDate = todayObj.getDate();
    const todayDay = todayObj.getDay();

    // get first date of week
    const firstDayOfWeek = new Date(todayObj.setDate(todayDate - todayDay));

    // get last date of week
    const lastDayOfWeek = new Date(firstDayOfWeek);
    lastDayOfWeek.setDate(lastDayOfWeek.getDate() + 6);

    return d >= firstDayOfWeek && d <= lastDayOfWeek;
}

function clamp(min, v, max) {
    return Math.max(min, Math.min(max, v));
}

function fetchJson(url) {
    return fetch(url).then(r => {
        if (!r.ok) throw new Error("Fetch failed: " + r.status);
        return r.json();
    });
}

fetchJson(API_ROUTE)
    .then(data => {
        window.WEEK_TIMETABLE = data; // [{intakeCode,day,startTime,endTime},...]
    })
    .catch(e => {
        console.error("Failed to fetch timetable data", e);
        window.WEEK_TIMETABLE = [];
    });

// -------------------- Persistence / utility --------------------

function refreshPerson(id) {
    const p = persons.find(x => x.id == id);
    if (!p.intakeCode) return; // nothing to do

    p.events = window.WEEK_TIMETABLE.filter(
        entry =>
            entry.INTAKE === p.intakeCode &&
            entry.GROUPING === `G${p.group}` &&
            isThisWeek(entry.DATESTAMP_ISO)
    ).map(entry => ({
        day: DAY_MAP[entry.DAY],
        start: hmsToMinutes(entry.TIME_FROM_ISO.slice(11, 16)),
        end: hmsToMinutes(entry.TIME_TO_ISO.slice(11, 16))
    }));
}

function saveLocal() {
    localStorage.setItem("meetup_persons", JSON.stringify({ persons, nextId }));
}
function loadLocal() {
    try {
        const raw = localStorage.getItem("meetup_persons");
        if (raw) {
            const obj = JSON.parse(raw);
            persons = obj.persons || [];
            nextId = obj.nextId || persons.length + 1;
        }
    } catch (e) {
        console.warn("loadLocal failed", e);
    }
}

// -------------------- Public API (for your integration) --------------------
window.createPerson = function (p) {
    // p = {name, events: [{day:int,start:'HH:MM',end:'HH:MM'}]}
    const id = p.id || nextId++;

    console.log(p.intake);

    const newP = {
        id,
        name: p.name || "Person " + id,
        intakeCode: p.intakeCode || "",
        group: p.group || "1",
        events: (p.events || []).map(e => ({
            day: e.day,
            start: hmsToMinutes(e.start),
            end: hmsToMinutes(e.end)
        }))
    };
    persons.push(newP);
    refreshPerson(id);
    saveLocal();
    renderAll();
    return newP;
};

window.updatePerson = function (id, patch) {
    const idx = persons.findIndex(x => x.id == id);
    if (idx < 0) return null;
    const cur = persons[idx];
    if (patch.name !== undefined) cur.name = patch.name;
    if (patch.events !== undefined)
        cur.events = patch.events.map(e => ({
            day: e.day,
            start: hmsToMinutes(e.start),
            end: hmsToMinutes(e.end)
        }));
    saveLocal();
    renderAll();
    return cur;
};

window.exportData = function () {
    return JSON.stringify({
        persons: persons.map(p => ({
            id: p.id,
            name: p.name,
            intakeCode: p.intakeCode || "",
            group: p.group || "1",
            events: p.events.map(e => ({
                day: e.day,
                start: minutesToHMS(e.start),
                end: minutesToHMS(e.end)
            }))
        })),
        nextId
    });
};

window.importData = function (json) {
    try {
        const obj = typeof json === "string" ? JSON.parse(json) : json;
        persons = (obj.persons || []).map(p => ({
            id: p.id,
            name: p.name,
            intakeCode: p.intakeCode || "",
            group: p.group || "1",
            events: p.events.map(e => ({
                day: e.day,
                start: hmsToMinutes(e.start),
                end: hmsToMinutes(e.end)
            }))
        }));
        nextId =
            obj.nextId || persons.reduce((a, b) => Math.max(a, b.id), 0) + 1;
        saveLocal();
        renderAll();
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
};

/**
 * calculateFree
 * ids: array of person ids to include. if omitted => all persons
 * opts: {windowStart:'HH:MM', windowEnd:'HH:MM', minDuration:minutes}
 * returns {byDay: {0:[{start,end}],...}} times in minutes
 */
window.calculateFree = function (ids, opts) {
    for (const p of persons) {
        if (p.intakeCode) refreshPerson(p.id);
    }

    ids = ids && ids.length ? ids : persons.map(p => p.id);
    opts = opts || {};
    const ws = hmsToMinutes(
        opts.windowStart || document.getElementById("windowStart").value
    );
    const we = hmsToMinutes(
        opts.windowEnd || document.getElementById("windowEnd").value
    );
    const minD = parseInt(
        opts.minDuration || document.getElementById("minDuration").value || 30,
        10
    );

    // For each person create busy intervals by day
    const busyByPerson = {};
    ids.forEach(id => {
        const p = persons.find(x => x.id == id);
        busyByPerson[id] = [0, 1, 2, 3, 4, 5, 6].map(() => []);
        if (!p) return;
        p.events.forEach(ev => {
            // clamp within day [0,24h]
            const s = clamp(0, ev.start, 24 * 60);
            const e = clamp(0, ev.end, 24 * 60);
            if (e > s) busyByPerson[id][ev.day].push([s, e]);
        });
        // merge individual's intervals per day
        busyByPerson[id] = busyByPerson[id].map(arr => mergeIntervals(arr));
    });

    // For each day, compute union of busy intervals across selected persons
    const byDay = {};
    for (let d = 0; d < 7; d++) {
        let allBusy = [];
        ids.forEach(id => {
            allBusy = allBusy.concat(busyByPerson[id][d] || []);
        });
        allBusy = mergeIntervals(allBusy);
        // invert within window to get free
        const free = [];
        let cursor = ws;
        for (const [s, e] of allBusy) {
            if (e <= ws || s >= we) continue;
            const ns = Math.max(s, ws);
            const ne = Math.min(e, we);
            if (ns > cursor) {
                free.push([cursor, ns]);
            }
            cursor = Math.max(cursor, ne);
        }
        if (cursor < we) free.push([cursor, we]);
        // filter by min duration
        byDay[d] = free.filter(([s, e]) => e - s >= minD);
    }
    return { byDay, windowStart: ws, windowEnd: we, minDuration: minD };
};

// merge intervals [[s,e],...]
function mergeIntervals(arr) {
    if (!arr || arr.length === 0) return [];
    const a = arr.slice().sort((x, y) => x[0] - y[0]);
    const out = [];
    let [cs, ce] = a[0];
    for (let i = 1; i < a.length; i++) {
        const [s, e] = a[i];
        if (s <= ce) {
            ce = Math.max(ce, e);
        } else {
            out.push([cs, ce]);
            cs = s;
            ce = e;
        }
    }
    out.push([cs, ce]);
    return out;
}

// -------------------- UI rendering --------------------
function renderAll() {
    renderPersons();
    renderIncludeHeader();
    renderSelectPersonOptions();
}

function renderPersons() {
    const container = document.getElementById("personsList");
    container.innerHTML = "";
    persons.forEach(p => {
        const div = document.createElement("div");
        div.className = "person-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "checkbox";
        cb.checked = true;
        cb.dataset.id = p.id;
        cb.addEventListener("change", () => {
            document.getElementById("status").textContent =
                "Selection changed — recalc when ready";
            calculate();
        });
        const name = document.createElement("div");
        name.className = "person-name";
        name.innerHTML = `<strong>${escapeHtml(
            p.name
        )}</strong><div class=muted style="font-size:12px">${
            p.events.length
        } event(s)</div>`;
        const edit = document.createElement("button");
        edit.textContent = "Edit";
        edit.className = "small";
        edit.onclick = () => {
            document.getElementById("selectPersonForEdit").value = p.id;
            loadEventsForPerson();
        };
        div.appendChild(cb);
        div.appendChild(name);
        div.appendChild(edit);
        container.appendChild(div);
    });
}

function renderIncludeHeader() {
    const d = document.getElementById("includeHeader");
    d.innerHTML = "";
    persons.forEach(p => {
        const wrap = document.createElement("label");
        wrap.style.display = "inline-flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "6px";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.dataset.id = p.id;
        cb.addEventListener("change", calculate);
        const span = document.createElement("span");
        span.textContent = p.name;
        wrap.appendChild(cb);
        wrap.appendChild(span);
        d.appendChild(wrap);
    });
}

function renderSelectPersonOptions() {
    const sel = document.getElementById("selectPersonForEdit");
    sel.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "-- select person --";
    sel.appendChild(empty);
    persons.forEach(p => {
        const o = document.createElement("option");
        o.value = p.id;
        o.text = p.name;
        sel.appendChild(o);
    });
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// -------------------- Event editor --------------------
function loadEventsForPerson() {
    const sel = document.getElementById("selectPersonForEdit");
    const id = Number(sel.value);
    const container = document.getElementById("eventsEditor");
    container.innerHTML = "";
    if (!id) return;
    const p = persons.find(x => x.id == id);
    if (!p) return;
    p.events.forEach((ev, idx) => {
        const row = document.createElement("div");
        row.className = "event-row";
        const day = document.createElement("div");
        day.textContent = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
            ev.day
        ];
        day.style.width = "50px";
        const times = document.createElement("div");
        times.textContent = `${minutesToHMS(ev.start)} — ${minutesToHMS(
            ev.end
        )}`;
        const del = document.createElement("button");
        del.textContent = "Delete";
        del.className = "small";
        del.onclick = () => {
            p.events.splice(idx, 1);
            saveLocal();
            loadEventsForPerson();
            renderAll();
        };
        row.appendChild(day);
        row.appendChild(times);
        row.appendChild(del);
        container.appendChild(row);
    });
}

document.getElementById("addPerson").addEventListener("click", () => {
    const name = document.getElementById("newName").value.trim();
    if (!name) {
        alert("Give them a name.");
        return;
    }
    const intake = document.getElementById("newIntake").value.trim();
    const group = document.getElementById("newGroup").value.trim();
    window.createPerson({ name, intakeCode: intake, group, events: [] });
    document.getElementById("newName").value = "";
    document.getElementById("newIntake").value = "";
    document.getElementById("newGroup").value = "";
});

document.getElementById("addEventBtn").addEventListener("click", () => {
    const sel = document.getElementById("selectPersonForEdit");
    const id = Number(sel.value);
    if (!id) {
        alert("Select a person to add event to");
        return;
    }
    const p = persons.find(x => x.id == id);
    if (!p) return;
    const day = Number(document.getElementById("eventDay").value);
    const s = hmsToMinutes(document.getElementById("eventStart").value);
    const e = hmsToMinutes(document.getElementById("eventEnd").value);
    if (e <= s) {
        alert("End must be after start");
        return;
    }
    p.events.push({ day, start: s, end: e }); // keep unsorted; will be merged on calculation
    saveLocal();
    loadEventsForPerson();
    renderAll();
});

document
    .getElementById("loadEvents")
    .addEventListener("click", loadEventsForPerson);

document.getElementById("saveEvents").addEventListener("click", () => {
    const sel = document.getElementById("selectPersonForEdit");
    const id = Number(sel.value);
    if (!id) {
        alert("Select person");
        return;
    }
    // nothing special: events modified via UI delete/add; saved in place
    saveLocal();
    renderAll();
    alert("Saved");
});

document.getElementById("deletePerson").addEventListener("click", () => {
    const sel = document.getElementById("selectPersonForEdit");
    const id = Number(sel.value);
    if (!id) {
        alert("Select person");
        return;
    }
    if (!confirm("Delete this person and all their events?")) return;
    persons = persons.filter(x => x.id != id);
    saveLocal();
    renderAll();
    document.getElementById("selectPersonForEdit").value = "";
});

document.getElementById("clearAll").addEventListener("click", () => {
    if (confirm("Clear ALL people?")) {
        persons = [];
        nextId = 1;
        saveLocal();
        renderAll();
        document.getElementById("resultsContainer").innerHTML = "";
        document.getElementById("status").textContent = "Cleared";
    }
});

function calculate() {
    const includeChecks = Array.from(
        document.querySelectorAll("#includeHeader input[type=checkbox]")
    );
    const ids = includeChecks
        .filter(c => c.checked)
        .map(c => Number(c.dataset.id));
    const res = window.calculateFree(ids, {
        windowStart: document.getElementById("windowStart").value,
        windowEnd: document.getElementById("windowEnd").value,
        minDuration: document.getElementById("minDuration").value
    });
    renderResults(res, ids);
}

document.getElementById("calcBtn").addEventListener("click", calculate);

function renderResults(result, ids) {
    const container = document.getElementById("resultsContainer");
    container.innerHTML = "";
    const { byDay, windowStart, windowEnd, minDuration } = result;
    document.getElementById(
        "status"
    ).textContent = `Found free slots (min ${minDuration}m) for ${ids.length} person(s)`;

    const tbl = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Day</th><th>Free slots</th></tr>";
    const tbody = document.createElement("tbody");
    for (let d = 1; d <= 7; d++) {
        // show Mon-Sun in a human order
        const dayIndex = d % 7;
        const row = document.createElement("tr");
        const dayCell = document.createElement("td");
        dayCell.textContent = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
            dayIndex
        ];
        const slots = byDay[dayIndex] || [];
        const cell = document.createElement("td");
        cell.innerHTML = slots.length
            ? slots
                  .map(
                      s =>
                          `<div class=free-pill>${minutesToHMS(
                              s[0]
                          )} → ${minutesToHMS(s[1])}</div>`
                  )
                  .join(" ")
            : "<span class=muted>No free slot</span>";
        // const pretty = document.createElement("td");
        // // also show overlapping calendar-like text
        // if (slots.length) {
        //     pretty.innerHTML = slots
        //         .map(s => `${minutesToHMS(s[0])}-${minutesToHMS(s[1])}`)
        //         .join("<br/>");
        // } else {
        //     pretty.innerHTML = "";
        // }
        row.appendChild(dayCell);
        row.appendChild(cell);
        // row.appendChild(pretty);
        tbody.appendChild(row);
    }
    tbl.appendChild(thead);
    tbl.appendChild(tbody);
    container.appendChild(tbl);
}

// -------------------- Import/Export UI --------------------
document.getElementById("exportBtn").addEventListener("click", () => {
    const json = window.exportData();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "meetup_data.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
});
document.getElementById("importBtn").addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json";
    inp.onchange = () => {
        const f = inp.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                window.importData(reader.result);
                alert("Imported");
            } catch (e) {
                alert("Import failed");
            }
        };
        reader.readAsText(f);
    };
    inp.click();
});

// -------------------- init sample data --------------------
loadLocal();
// if (persons.length === 0) {
//     // add sample people
//     window.createPerson({
//         name: "Alice",
//         events: [
//             { day: 1, start: "09:00", end: "11:00" },
//             { day: 3, start: "18:00", end: "20:00" }
//         ]
//     });
//     window.createPerson({
//         name: "Bob",
//         events: [
//             { day: 1, start: "10:30", end: "12:00" },
//             { day: 2, start: "14:00", end: "15:30" },
//             { day: 4, start: "19:00", end: "21:00" }
//         ]
//     });
//     window.createPerson({
//         name: "Cathy",
//         events: [
//             { day: 1, start: "08:00", end: "09:30" },
//             { day: 3, start: "17:00", end: "19:00" },
//             { day: 5, start: "13:00", end: "14:00" }
//         ]
//     });
// }
renderAll();

// Expose a convenience for direct calculation UI-call
window.uiCalculateAndRender = function (ids, opts) {
    const result = window.calculateFree(ids, opts);
    renderResults(result, ids && ids.length ? ids : persons.map(p => p.id));
    return result;
};
