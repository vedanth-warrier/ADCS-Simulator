// ADCS Simulator frontend: Three.js scene, user inputs, backend calls.

const BACKEND_URL = "https://attitude-determination-and-control.onrender.com";

let scene, camera, renderer, controls, satelliteMesh;
let gizmoScene, gizmoCamera, gizmoRenderer;
let wheelSpeedCharts = {};
const clock = new THREE.Clock();

// "seconds" is the only timeframe with an initial tumble (see CLAUDE.md:
// hours/days start from a stationary attitude), kept in sync by the
// timeframe radio listener further down instead of re-querying the DOM
// every animation frame.
let currentTimeframe = "seconds";

// Paused while a Correct Attitude request is in flight, so the live
// preview doesn't keep spinning underneath a correction that's supposedly
// already happening.
let liveTumbleEnabled = true;

// Set by animateSatellite() while a returned trajectory is being played back,
// cleared once playback finishes. null means no playback in progress.
let playback = null;

const AXIS_COLORS = { x: "#ff6b6b", y: "#6bff8f", z: "#6ba8ff" };

function getSatelliteDimensions() {
    return {
        x: parseFloat(document.getElementById("sat-dim-x").value) || 1,
        y: parseFloat(document.getElementById("sat-dim-y").value) || 1,
        z: parseFloat(document.getElementById("sat-dim-z").value) || 1,
    };
}

function initScene() {
    const container = document.getElementById("scene-container");
    const width = container.clientWidth;
    const height = container.clientHeight;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(2.2, 1.6, 2.8);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height);
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(3, 4, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.4);
    rimLight.position.set(-4, -2, -3);
    scene.add(rimLight);

    satelliteMesh = createSatelliteMesh();
    satelliteMesh.scale.set(getSatelliteDimensions().x, getSatelliteDimensions().y, getSatelliteDimensions().z);
    scene.add(satelliteMesh);

    controls = configureTrackballControls(new THREE.TrackballControls(camera, renderer.domElement));

    initRollControls(container);
    initGizmo();

    new ResizeObserver(() => {
        const { clientWidth, clientHeight } = container;
        if (clientWidth === 0 || clientHeight === 0) return;
        camera.aspect = clientWidth / clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(clientWidth, clientHeight);
        controls.handleResize();
    }).observe(container);

    animate();
}

function updateLiveTumble(dt) {
    if (!liveTumbleEnabled || currentTimeframe !== "seconds") return;

    const omega = new THREE.Vector3(fieldValue("omega-x"), fieldValue("omega-y"), fieldValue("omega-z"));
    const angle = omega.length() * dt;
    if (angle === 0) return;

    // Kinematic only: rotates at the current omega as a fixed body-frame
    // axis/rate each frame. It does not solve the actual torque-free
    // rigid-body equations, so it won't show real precession/wobble for
    // an asymmetric body, that only appears once the backend's simulation
    // is wired up and played back. This is just a live visual indicator
    // so the "Correct Attitude" button has a visible tumble to correct.
    const increment = new THREE.Quaternion().setFromAxisAngle(omega.normalize(), angle);
    satelliteMesh.quaternion.multiply(increment);
}

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    if (playback) {
        updatePlayback();
    } else {
        updateLiveTumble(dt);
    }
    controls.update();
    renderer.render(scene, camera);
    updateGizmo();
}

// The skin sheet is a 3x2 grid of equal cells (see Images/Satellite-Skin.jpeg):
// [control panel] [solar array]  [sensor dome]
// [hatch/vent]     [wiring/tanks][thrusters/antenna]
// Mapped onto the box's faces in THREE's BoxGeometry group order below.
// This assignment is arbitrary, swap the {col, row} pairs to put a
// different panel on a different face.
const SKIN_GRID = { cols: 3, rows: 2 };
const SKIN_FACES = [
    { axis: "+X", col: 0, row: 0 }, // right  -> control panel
    { axis: "-X", col: 1, row: 0 }, // left   -> solar array
    { axis: "+Y", col: 2, row: 0 }, // top    -> sensor dome
    { axis: "-Y", col: 0, row: 1 }, // bottom -> hatch/vent
    { axis: "+Z", col: 1, row: 1 }, // front  -> wiring/tanks
    { axis: "-Z", col: 2, row: 1 }, // back   -> thrusters/antenna
];

function applySkinTexture(mesh) {
    // TextureLoader.load() returns immediately, before the image has
    // actually finished loading, so building clones and swapping in the
    // per-face materials happens in the onLoad callback, once there is
    // real pixel data to clone and upload rather than an empty placeholder.
    new THREE.TextureLoader().load("Images/Satellite-Skin.jpeg", (baseTexture) => {
        baseTexture.encoding = THREE.sRGBEncoding;

        mesh.material = SKIN_FACES.map(({ col, row }) => {
            const texture = baseTexture.clone();
            texture.needsUpdate = true;
            texture.encoding = THREE.sRGBEncoding;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.repeat.set(1 / SKIN_GRID.cols, 1 / SKIN_GRID.rows);
            // Texture V=0 is the bottom of the source image, so a "top row"
            // cell (row 0 in the file) sits in the upper half of V-space.
            texture.offset.set(col / SKIN_GRID.cols, row === 0 ? 0.5 : 0);
            return new THREE.MeshStandardMaterial({ map: texture, metalness: 0.15, roughness: 0.7 });
        });
    });
}

function createSatelliteMesh() {
    // Unit cube, scaled per axis to match satellite dimensions. Keeps the
    // skin texture and body axes (child below) in sync automatically.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const placeholderMaterial = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.4, roughness: 0.6 });
    const mesh = new THREE.Mesh(geometry, placeholderMaterial);
    mesh.add(new THREE.AxesHelper(0.9));
    applySkinTexture(mesh);

    return mesh;
}

function configureTrackballControls(instance) {
    // TrackballControls rotates freely about whatever axis the drag
    // implies (derived fresh from the camera's current position/up on
    // every call), unlike OrbitControls which locks rotation to a fixed
    // world "up" pole. That's what makes sequential drags (e.g. up/down
    // then left/right) compose the way a hand-held object would, instead
    // of the second drag always spinning around the same fixed axis
    // regardless of the first.
    instance.dynamicDampingFactor = 0.08;
    instance.minDistance = 1;
    instance.maxDistance = 20;
    return instance;
}

function initRollControls(container) {
    // TrackballControls has no dedicated roll gesture, so shift+drag is
    // handled separately here: it rotates camera.up around the
    // camera-to-target axis, which tilts the rendered view (via the
    // lookAt() TrackballControls already does each frame) without
    // touching camera.position, so it doesn't fight the rotate logic.
    // Unlike OrbitControls, TrackballControls reads camera.up fresh on
    // every drag rather than caching a basis at construction, so a roll
    // doesn't leave it in a stale state afterwards.
    let rolling = false;
    let startAngle = 0;
    const upStart = new THREE.Vector3();

    function angleFromCenter(clientX, clientY) {
        const rect = container.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        return Math.atan2(clientY - cy, clientX - cx);
    }

    function onRollMove(event) {
        if (!rolling) return;
        const deltaAngle = angleFromCenter(event.clientX, event.clientY) - startAngle;
        const forward = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
        camera.up.copy(upStart).applyAxisAngle(forward, deltaAngle);
    }

    function onRollUp() {
        rolling = false;
        window.removeEventListener("pointermove", onRollMove);
        window.removeEventListener("pointerup", onRollUp);
    }

    // Capture-phase listener on the container (an ancestor of the canvas),
    // for both event families TrackballControls might be listening for on
    // the canvas itself, so a shift-held drag can be stopped before it
    // ever reaches TrackballControls and starts a rotate instead.
    function interceptForRoll(event) {
        if (!event.shiftKey) return;
        event.stopPropagation();
        event.preventDefault();
        rolling = true;
        startAngle = angleFromCenter(event.clientX, event.clientY);
        upStart.copy(camera.up);
        window.addEventListener("pointermove", onRollMove);
        window.addEventListener("pointerup", onRollUp);
    }

    container.addEventListener("pointerdown", interceptForRoll, true);
    container.addEventListener("mousedown", interceptForRoll, true);
}

function updateSatelliteScale() {
    if (!satelliteMesh) return;
    const dimensions = getSatelliteDimensions();
    satelliteMesh.scale.set(dimensions.x, dimensions.y, dimensions.z);
}

function makeAxisLabel(text, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.font = "bold 44px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 34);

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
    }));
    sprite.scale.set(0.45, 0.45, 0.45);
    return sprite;
}

function initGizmo() {
    const gizmoEl = document.getElementById("axis-gizmo");
    const size = gizmoEl.clientWidth || 84;

    gizmoScene = new THREE.Scene();
    gizmoCamera = new THREE.PerspectiveCamera(70, 1, 0.1, 10);

    gizmoRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    gizmoRenderer.setPixelRatio(window.devicePixelRatio || 1);
    gizmoRenderer.setSize(size, size);
    gizmoEl.appendChild(gizmoRenderer.domElement);

    gizmoScene.add(new THREE.AxesHelper(1));

    [
        { text: "X", color: AXIS_COLORS.x, position: [1.4, 0, 0] },
        { text: "Y", color: AXIS_COLORS.y, position: [0, 1.4, 0] },
        { text: "Z", color: AXIS_COLORS.z, position: [0, 0, 1.4] },
    ].forEach(({ text, color, position }) => {
        const label = makeAxisLabel(text, color);
        label.position.set(...position);
        label.scale.set(0.4, 0.4, 0.4);
        gizmoScene.add(label);
    });
}

function updateGizmo() {
    if (!gizmoCamera) return;
    gizmoCamera.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(3);
    gizmoCamera.up.copy(camera.up);
    gizmoCamera.lookAt(0, 0, 0);
    gizmoRenderer.render(gizmoScene, gizmoCamera);
}

function createWheelSpeedChart(canvasId, color) {
    return new Chart(document.getElementById(canvasId), {
        type: "line",
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: color,
                backgroundColor: color,
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.15,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
            },
            scales: {
                x: {
                    // Linear, not category: the raw returned time samples are
                    // unevenly spaced (adaptive solver steps), so plotting
                    // them as category labels put a tick at every single
                    // value. A linear scale with an explicit stepSize (set
                    // per-frame in updateWheelSpeedCharts) draws clean ticks
                    // at fixed intervals instead.
                    type: "linear",
                    min: 0,
                    title: { display: true, text: "Time (s)", color: "#8b95a5", font: { size: 10 } },
                    ticks: {
                        color: "#8b95a5",
                        font: { size: 9 },
                        // Always exactly one decimal place, even for whole
                        // numbers (12 -> "12.0"), so label width/digit count
                        // stays constant frame to frame instead of jittering
                        // as ticks flip between "12" and "12.3"-style widths.
                        callback: (value) => Number(value).toFixed(1),
                    },
                    grid: { color: "rgba(139, 149, 165, 0.12)" },
                },
                y: {
                    // No min/max set, so Chart.js autoscales to whatever
                    // data updateWheelSpeedCharts() is given.
                    title: { display: true, text: "Speed (RPM)", color: "#8b95a5", font: { size: 10 } },
                    ticks: { color: "#8b95a5", font: { size: 9 } },
                    grid: { color: "rgba(139, 149, 165, 0.12)" },
                },
            },
        },
    });
}

// Adaptive mode's single combined graph: all three wheels as separate
// datasets on shared axes instead of three separate charts. The legend's
// circular dots (instead of Chart.js's default line-swatch) are what show
// which coloured line is which wheel.
function createCombinedWheelSpeedChart(canvasId) {
    const axisDataset = (axis) => ({
        label: axis.toUpperCase(),
        data: [],
        borderColor: AXIS_COLORS[axis],
        backgroundColor: AXIS_COLORS[axis],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.15,
    });

    return new Chart(document.getElementById(canvasId), {
        type: "line",
        data: {
            labels: [],
            datasets: ["x", "y", "z"].map(axisDataset),
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    align: "end",
                    labels: {
                        color: "#8b95a5",
                        font: { size: 10 },
                        usePointStyle: true,
                        pointStyle: "circle",
                        boxWidth: 8,
                        boxHeight: 8,
                    },
                },
            },
            scales: {
                x: {
                    type: "linear",
                    min: 0,
                    title: { display: true, text: "Time (s)", color: "#8b95a5", font: { size: 10 } },
                    ticks: {
                        color: "#8b95a5",
                        font: { size: 9 },
                        callback: (value) => Number(value).toFixed(1),
                    },
                    grid: { color: "rgba(139, 149, 165, 0.12)" },
                },
                y: {
                    title: { display: true, text: "Speed (RPM)", color: "#8b95a5", font: { size: 10 } },
                    ticks: { color: "#8b95a5", font: { size: 9 } },
                    grid: { color: "rgba(139, 149, 165, 0.12)" },
                },
            },
        },
    });
}

function initWheelSpeedCharts() {
    wheelSpeedCharts = {
        x: createWheelSpeedChart("graph-wheel-x", AXIS_COLORS.x),
        y: createWheelSpeedChart("graph-wheel-y", AXIS_COLORS.y),
        z: createWheelSpeedChart("graph-wheel-z", AXIS_COLORS.z),
        combined: createCombinedWheelSpeedChart("graph-wheel-combined"),
    };
}

// Picks a gridline spacing from {1, 2, 5, 10} seconds, the smallest of those
// that keeps the number of gridlines across finalTime reasonable (defaults
// to 10 for a finalTime large enough that even that is a lot of gridlines).
function niceTimeStep(finalTime) {
    const candidates = [1, 2, 5, 10];
    const targetTicks = 8;
    for (const step of candidates) {
        if (finalTime / step <= targetTicks) return step;
    }
    return 10;
}

// Each backend timeframe branch now scales its own returned `time` array
// Adaptive mode rescales whatever timespan the correction actually took to
// fit a fixed real-time playback window (see the timescale pill below), so
// its `time` array is already in real seconds too - same axis unit as
// "seconds" mode, not simulated minutes/hours like it used to be.
const TIME_AXIS_LABELS = {
    seconds: "Time (s)",
    adaptive: "Time (s)",
};

// Sets each chart's x-axis title to match the current run's actual time
// unit. Called once per run, range/spacing themselves are handled dynamically
// in updateWheelSpeedCharts() below.
function configureChartTimeAxisLabel() {
    const label = TIME_AXIS_LABELS[currentTimeframe] || "Time";
    Object.values(wheelSpeedCharts).forEach((chart) => {
        chart.options.scales.x.title.text = label;
        chart.update();
    });
}

// { time: [t0, t1, ...], rpm: { x: [...], y: [...], z: [...] } }, all arrays
// the same length. uptoIndex draws only the data up to that sample (used to
// reveal the graph in step with the 3D playback rather than dumping the
// whole trace at once); omit it to plot everything. The x-axis is rescaled
// to the latest plotted time on every call (not fixed to the eventual final
// time), so the visible curve always fills the full chart width instead of
// being a sliver on the left of a mostly-empty axis early in playback.
function updateWheelSpeedCharts(simulationData, uptoIndex) {
    const { time, rpm } = simulationData;
    const end = uptoIndex === undefined ? time.length : uptoIndex + 1;
    // Rounded (up, so the last point never sits exactly on the boundary) to
    // a clean 1-decimal value rather than the raw solver time, which has ~15
    // significant digits that change on every single frame - left unrounded,
    // that noise in the axis's own boundary made Chart.js's tick layout
    // recompute slightly differently frame to frame, visible as a jitter.
    const currentMax = Math.ceil(time[end - 1] * 10) / 10;
    const stepSize = niceTimeStep(currentMax);
    const slicedTime = time.slice(0, end);

    ["x", "y", "z"].forEach((axis) => {
        const chart = wheelSpeedCharts[axis];
        chart.data.datasets[0].data = slicedTime.map((t, i) => ({ x: t, y: rpm[axis][i] }));
        chart.options.scales.x.max = currentMax;
        chart.options.scales.x.ticks.stepSize = stepSize;
        chart.update();
    });

    // Combined chart: same three series, but as three datasets sharing one
    // set of axes instead of three separate charts.
    const combinedChart = wheelSpeedCharts.combined;
    ["x", "y", "z"].forEach((axis, i) => {
        combinedChart.data.datasets[i].data = slicedTime.map((t, j) => ({ x: t, y: rpm[axis][j] }));
    });
    combinedChart.options.scales.x.max = currentMax;
    combinedChart.options.scales.x.ticks.stepSize = stepSize;
    combinedChart.update();
}

function resetWheelSpeedCharts() {
    ["x", "y", "z"].forEach((axis) => {
        wheelSpeedCharts[axis].data.datasets[0].data = [];
        wheelSpeedCharts[axis].update();
    });
    wheelSpeedCharts.combined.data.datasets.forEach((dataset) => { dataset.data = []; });
    wheelSpeedCharts.combined.update();
}

function fieldValue(id) {
    return parseFloat(document.getElementById(id).value) || 0;
}

// All three reaction wheels are assumed identical, so there's one shared
// set of properties rather than a separate one per axis.
function readWheelInputs() {
    return {
        mass: fieldValue("wheel-mass"),
        radius: fieldValue("wheel-radius"),
        max_rpm: fieldValue("wheel-max-rpm"),
        max_spinup_rate: fieldValue("wheel-max-spinup"),
    };
}

function readUserInputs() {
    const dimensions = getSatelliteDimensions();
    return {
        initial_angular_velocity: {
            x: fieldValue("omega-x"),
            y: fieldValue("omega-y"),
            z: fieldValue("omega-z"),
        },
        satellite: {
            mass: fieldValue("sat-mass"),
            dimensions,
        },
        reaction_wheels: readWheelInputs(),
        disturbance_torque: {
            // The UI splits this into a mantissa [0,10) and a power-of-ten
            // exponent so extreme magnitudes stay easy to dial in precisely,
            // but the backend still just gets one combined number, same as
            // before.
            magnitude: fieldValue("disturbance-magnitude-mantissa") * Math.pow(10, fieldValue("disturbance-magnitude-exponent")),
            direction: {
                x: fieldValue("disturbance-dir-x"),
                y: fieldValue("disturbance-dir-y"),
                z: fieldValue("disturbance-dir-z"),
            },
        },
        timeframe: document.querySelector('input[name="timeframe"]:checked').value,
        // The live preview (see updateLiveTumble) has likely rotated the
        // satellite away from identity by the time this button is clicked,
        // so the backend needs the attitude it's actually correcting from,
        // not just the original angular velocity, or the returned
        // trajectory won't line up with what's on screen when playback
        // starts.
        current_orientation: satelliteMesh.quaternion.toArray(),
    };
}

async function runSimulation(params) {
    const response = await fetch(`${BACKEND_URL}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
    });
    if (!response.ok) {
        throw new Error(`Backend responded with ${response.status} ${response.statusText}`);
    }
    return response.json();
}

// Finds the returned sample index whose interval [times[i], times[i+1]]
// contains simTime. solve_ivp's adaptive stepping means the `time` array
// isn't evenly spaced, so this can't just index by a fixed frame rate, it
// has to search for the bracketing pair each call.
function sampleIndexAtSimTime(simTime) {
    const { times } = playback;
    if (simTime <= times[0]) return 0;
    if (simTime >= times[times.length - 1]) return times.length - 1;

    let i = 0;
    while (i < times.length - 1 && times[i + 1] < simTime) i++;
    return i;
}

// Slerps between the two returned orientation samples either side of simTime.
function quaternionAtSimTime(simTime) {
    const { times, quaternions } = playback;
    const i = sampleIndexAtSimTime(simTime);
    if (i >= times.length - 1) return quaternions[quaternions.length - 1];

    const span = times[i + 1] - times[i];
    const t = span === 0 ? 0 : (simTime - times[i]) / span;
    // slerpQuaternions() exists in this three.js build but silently returns
    // undefined instead of interpolating, so clone()+slerp() is used instead
    // (the older, more reliably supported instance method).
    return quaternions[i].clone().slerp(quaternions[i + 1], t);
}

// Maps the exact status strings the backend sends in stateTimeSeries.text to
// a display colour: red while precessing freely, yellow while the wheels are
// actively correcting, green once stable.
const STATUS_COLORS = {
    "Torque-Free Precession": "#ff6b6b",
    "Applying Correction": "#f5c518",
    "Stability Achieved": "#4ade80",
    "Saturated": "#ff6b6b",
    // Idle default shown in "seconds" mode before Correct Attitude has ever
    // been clicked, not something the backend ever sends.
    "Constant Axis Tumble": "#ff6b6b",
};

function updateStatusLabel(text) {
    if (!text) return;
    sceneStatusLabel.textContent = text;
    sceneStatusLabel.style.color = STATUS_COLORS[text] || "";
    sceneStatusLabel.hidden = false;
}

// Minutes/hours mode has no "text" field at all - saturation there comes
// back as a per-timestep boolean array per axis instead, driving these 4
// pills (3 per-axis + 1 overall stability) rather than the single text pill
// "seconds" mode uses.
const SATURATION_PILL_DEFAULT_COLOR = "#8b95a5";
const SATURATION_PILL_SATURATED_COLOR = "#f5a623";

function setSaturationPill(pillEl, isSaturated) {
    pillEl.style.color = isSaturated ? SATURATION_PILL_SATURATED_COLOR : SATURATION_PILL_DEFAULT_COLOR;
}

function resetSaturationPills() {
    setSaturationPill(pillXSaturated, false);
    setSaturationPill(pillYSaturated, false);
    setSaturationPill(pillZSaturated, false);
    pillStability.textContent = "Satellite Stable";
    pillStability.style.color = SATURATION_PILL_DEFAULT_COLOR;
}

function updateSaturationPills(saturated, index) {
    const xSat = !!saturated.x[index];
    const ySat = !!saturated.y[index];
    const zSat = !!saturated.z[index];
    setSaturationPill(pillXSaturated, xSat);
    setSaturationPill(pillYSaturated, ySat);
    setSaturationPill(pillZSaturated, zSat);

    const anySaturated = xSat || ySat || zSat;
    pillStability.textContent = anySaturated ? "Satellite Unstable" : "Satellite Stable";
    pillStability.style.color = anySaturated ? "#ff6b6b" : "#4ade80";
}

// "1 sec is 1 day 12 hours 15 minutes and 34 seconds" - scaleSeconds is how
// many simulated seconds one second of adaptive-mode playback represents.
function formatTimeScale(scaleSeconds) {
    let remaining = Math.round(scaleSeconds);
    const days = Math.floor(remaining / 86400);
    remaining -= days * 86400;
    const hours = Math.floor(remaining / 3600);
    remaining -= hours * 3600;
    const minutes = Math.floor(remaining / 60);
    remaining -= minutes * 60;
    const seconds = remaining;

    const parts = [];
    if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
    if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    if (seconds || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);

    const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(" ")} and ${parts[parts.length - 1]}`;
    return `1 sec is ${joined}`;
}

function updateTimescalePill(scaleSeconds) {
    pillTimescale.textContent = formatTimeScale(scaleSeconds);
    pillTimescale.hidden = false;
}

// Idle state shown before Correct Attitude has ever been clicked (and
// restored by Reset): "seconds" mode is always literally real-time, so its
// timescale pill permanently reads 1:1 rather than needing a real run to
// compute one. The scene-status/saturation-pills split by timeframe is
// unchanged from before, just no longer left fully hidden while idle.
function setIdleStatusDefaults() {
    if (currentTimeframe === "seconds") {
        // Seconds mode is always literally real-time, so a "1 sec is 1
        // second" pill states nothing useful - left out entirely there
        // rather than shown as a permanent no-op.
        pillTimescale.hidden = true;
        updateStatusLabel("Constant Axis Tumble");
    } else {
        pillTimescale.textContent = formatTimeScale(1);
        pillTimescale.hidden = false;
        sceneStatusLabel.hidden = true;
    }
}

function updatePlayback() {
    const elapsedWall = (performance.now() - playback.wallStart) / 1000;
    // Played back 1:1 against simulated seconds (the returned time span
    // itself, not a fixed guess), so playback length tracks however long the
    // correction actually took rather than compressing/stretching it.
    const progress = playback.durationSeconds === 0 ? 1 : Math.min(elapsedWall / playback.durationSeconds, 1);
    const simTime = playback.simStart + progress * (playback.simEnd - playback.simStart);
    const index = sampleIndexAtSimTime(simTime);

    // quaternions/texts are only present once the backend actually returns
    // real per-timestep data for them (some in-progress branches return a
    // placeholder while that part isn't implemented yet) - skip rather than
    // crash when they're not there, the RPM graphs don't depend on them.
    if (playback.quaternions) satelliteMesh.quaternion.copy(quaternionAtSimTime(simTime));
    if (playback.texts) updateStatusLabel(playback.texts[index]);
    // Reveals the RPM graphs in step with the 3D playback, using the same
    // simTime/index the orientation and status label are driven from, rather
    // than dumping the whole trace onto the chart the instant the response
    // arrives.
    if (playback.rpm) updateWheelSpeedCharts({ time: playback.times, rpm: playback.rpm }, index);
    if (playback.saturated) updateSaturationPills(playback.saturated, index);

    if (progress >= 1) {
        // Correction has finished: hold this attitude rather than resuming
        // the live tumble preview, which would spin the satellite again
        // using the pre-correction angular velocity and misrepresent it as
        // still tumbling.
        playback = null;
    }
}

function animateSatellite(stateTimeSeries) {
    const { time, orientation, text, rpm, saturated, time_scale } = stateTimeSeries;
    if (!time || !rpm || time.length === 0) {
        // Nothing to play back, don't leave the satellite frozen forever.
        liveTumbleEnabled = true;
        return;
    }

    const simStart = time[0];
    const simEnd = time[time.length - 1];

    resetWheelSpeedCharts();
    configureChartTimeAxisLabel();
    if (currentTimeframe !== "seconds") {
        resetSaturationPills();
        // time_scale is a single factor for the whole run (unlike the
        // per-timestep saturation pills), so it's set once here rather than
        // updated every frame in updatePlayback().
        if (typeof time_scale === "number") updateTimescalePill(time_scale);
    }

    playback = {
        times: time,
        // Only built when the backend sent real per-timestep quaternions/text
        // (still a placeholder string on some in-progress branches) - the RPM
        // graphs work fine without either, so this degrades instead of
        // crashing when only part of the response is implemented so far.
        quaternions: Array.isArray(orientation)
            ? orientation.map(([x, y, z, w]) => new THREE.Quaternion(x, y, z, w))
            : null,
        texts: Array.isArray(text) ? text : null,
        // "seconds" mode sends a single final boolean per axis (used
        // elsewhere), not the per-timestep array these top-left pills need -
        // only adaptive mode returns that shape.
        saturated: (currentTimeframe !== "seconds" && saturated && Array.isArray(saturated.x)) ? saturated : null,
        rpm,
        simStart,
        simEnd,
        durationSeconds: simEnd - simStart,
        wallStart: performance.now(),
    };
}

const correctAttitudeBtn = document.getElementById("correct-attitude-btn");
const correctAttitudeLabel = correctAttitudeBtn?.querySelector(".btn-label");
const CORRECT_ATTITUDE_IDLE_LABEL = "Correct Attitude";
const CORRECT_ATTITUDE_LOADING_LABEL = "Correcting Attitude...";
const resetBtn = document.getElementById("reset-btn");
const simulationStatus = document.getElementById("simulation-status");
const sceneStatusLabel = document.getElementById("scene-status");
const sceneContainer = document.getElementById("scene-container");
const saturationPillsContainer = document.getElementById("saturation-pills");
const pillXSaturated = document.getElementById("pill-x-saturated");
const pillYSaturated = document.getElementById("pill-y-saturated");
const pillZSaturated = document.getElementById("pill-z-saturated");
const pillStability = document.getElementById("pill-stability");
const pillTimescale = document.getElementById("pill-timescale");

// Resets the simulation, not the page: inputs are left exactly as the user
// set them, only the 3D attitude, RPM graphs and status indicators go back
// to their pre-"Correct Attitude" state.
function resetSimulationState() {
    playback = null;
    liveTumbleEnabled = true;
    satelliteMesh.quaternion.identity();
    resetWheelSpeedCharts();
    if (currentTimeframe !== "seconds") resetSaturationPills();
    setIdleStatusDefaults();
    simulationStatus.hidden = true;
    simulationStatus.classList.remove("status-error");
    correctAttitudeBtn.disabled = false;
    correctAttitudeBtn.classList.remove("loading");
    correctAttitudeLabel.textContent = CORRECT_ATTITUDE_IDLE_LABEL;
}

resetBtn?.addEventListener("click", resetSimulationState);

correctAttitudeBtn?.addEventListener("click", async () => {
    const params = readUserInputs();

    correctAttitudeBtn.disabled = true;
    // Render/Pages can take a while to respond (cold starts especially), so
    // this spinner+label swap is the only feedback the user gets that the
    // click actually registered and something is happening.
    correctAttitudeBtn.classList.add("loading");
    correctAttitudeLabel.textContent = CORRECT_ATTITUDE_LOADING_LABEL;
    liveTumbleEnabled = false;
    simulationStatus.hidden = true;
    simulationStatus.classList.remove("status-error");

    try {
        const result = await runSimulation(params);
        animateSatellite(result);
    } catch (error) {
        // Nothing was actually corrected, so let the live preview carry on
        // from wherever it already was rather than leaving the satellite
        // frozen because of a failed request.
        liveTumbleEnabled = true;
        simulationStatus.textContent = `Could not reach the backend: ${error.message}`;
        simulationStatus.classList.add("status-error");
        simulationStatus.hidden = false;
    } finally {
        correctAttitudeBtn.disabled = false;
        correctAttitudeBtn.classList.remove("loading");
        correctAttitudeLabel.textContent = CORRECT_ATTITUDE_IDLE_LABEL;
    }
});

// Fields where a fractional value doesn't mean anything (a power of ten has
// to be a whole number), rounded here rather than blocked at the keyboard so
// it behaves the same as every other field's blur/stepper correction.
const integerOnlyIds = ["disturbance-magnitude-exponent"];

function clampToRange(input, value) {
    if (input.min !== "" && value < parseFloat(input.min)) value = parseFloat(input.min);
    if (input.max !== "" && value > parseFloat(input.max)) value = parseFloat(input.max);
    if (integerOnlyIds.includes(input.id)) value = Math.round(value);
    return value;
}

const satelliteDimensionIds = ["sat-dim-x", "sat-dim-y", "sat-dim-z"];

document.querySelectorAll(".stepper-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        const input = document.getElementById(btn.dataset.target);
        const step = parseFloat(input.step) || 1;
        const direction = parseFloat(btn.dataset.step);
        const next = Math.round(((parseFloat(input.value) || 0) + direction * step) * 1e6) / 1e6;
        input.value = clampToRange(input, next);
        if (satelliteDimensionIds.includes(input.id)) updateSatelliteScale();
    });
});

document.querySelectorAll('input[type="number"]').forEach((input) => {
    input.addEventListener("change", () => {
        if (input.value === "") {
            // A field left empty on blur falls back to its minimum if it has
            // one (fields where 0 is physically impossible, e.g. mass), or
            // to 0 otherwise (fields where 0 is a legitimate value, e.g.
            // angular velocity), rather than silently sending whatever
            // parseFloat("") || 0 would have produced without the user
            // seeing it reflected in the field.
            input.value = input.min !== "" ? input.min : "0";
        } else {
            input.value = clampToRange(input, parseFloat(input.value));
        }
        if (satelliteDimensionIds.includes(input.id)) updateSatelliteScale();
    });
});

// Which of the 4 input sections are relevant to each timeframe - seconds mode
// never reads disturbance_torque, adaptive mode's long_timeframe() doesn't
// even accept inertia/mass/dimensions any more (orientation isn't modelled),
// so those genuinely don't affect its output at all.
const SECTION_IDS = ["section-angular-velocity", "section-satellite-properties", "section-reaction-wheels", "section-disturbance-torque"];
const SECTION_VISIBILITY = {
    seconds: ["section-angular-velocity", "section-satellite-properties", "section-reaction-wheels"],
    adaptive: ["section-reaction-wheels", "section-disturbance-torque"],
};

const workspaceEl = document.querySelector(".workspace");
const adaptivePillsRow = document.getElementById("adaptive-pills-row");
const perAxisGraphPanels = [
    document.getElementById("graph-panel-x"),
    document.getElementById("graph-panel-y"),
    document.getElementById("graph-panel-z"),
];
const combinedGraphPanel = document.getElementById("graph-panel-combined");

// Drives everything that depends on which timeframe is selected: which input
// sections are shown, whether the workspace is in "seconds" (3D + graphs) or
// "adaptive" (graphs only, bigger) layout, and physically moving the
// saturation/stability/timescale pills between overlaying the 3D view's
// corners (seconds) and sitting in a plain row above the graphs (adaptive,
// where there's no 3D view left to overlay).
function applyTimeframeVisibility() {
    const visibleIds = SECTION_VISIBILITY[currentTimeframe] || SECTION_VISIBILITY.seconds;
    SECTION_IDS.forEach((id) => {
        document.getElementById(id).hidden = !visibleIds.includes(id);
    });

    const isAdaptive = currentTimeframe !== "seconds";
    workspaceEl.dataset.mode = isAdaptive ? "adaptive" : "seconds";

    // Adaptive mode replaces the three separate per-axis graphs with one
    // combined plot (all three wheels on shared axes) instead of showing both.
    perAxisGraphPanels.forEach((panel) => { panel.hidden = isAdaptive; });
    combinedGraphPanel.hidden = !isAdaptive;

    if (isAdaptive) {
        adaptivePillsRow.appendChild(saturationPillsContainer);
        adaptivePillsRow.appendChild(pillTimescale);
        adaptivePillsRow.hidden = false;
    } else {
        sceneContainer.appendChild(saturationPillsContainer);
        sceneContainer.appendChild(pillTimescale);
        // Seconds mode is always 1:1, so the timescale pill carries no
        // information there - kept out of the 3D view entirely.
        pillTimescale.hidden = true;
        adaptivePillsRow.hidden = true;
    }
}

document.querySelectorAll('input[name="timeframe"]').forEach((radio) => {
    radio.addEventListener("change", (event) => {
        currentTimeframe = event.target.value;
        // Adaptive mode starts from a stationary attitude (see CLAUDE.md), so
        // switching to it drops whatever the live preview had spun up.
        if (currentTimeframe !== "seconds") satelliteMesh.quaternion.identity();
        configureChartTimeAxisLabel();

        // The 4 saturation/stability pills replace the single status pill in
        // adaptive mode (which has no "text" field at all), greyed out the
        // moment the mode is selected, before any run has happened.
        const isAdaptive = currentTimeframe !== "seconds";
        saturationPillsContainer.hidden = !isAdaptive;
        if (isAdaptive) resetSaturationPills();
        setIdleStatusDefaults();
        applyTimeframeVisibility();
    });
});

const infoBtn = document.getElementById("info-btn");
const infoModal = document.getElementById("info-modal");
const infoModalClose = document.getElementById("info-modal-close");

infoBtn?.addEventListener("click", () => {
    infoModal.hidden = false;
});
infoModalClose?.addEventListener("click", () => {
    infoModal.hidden = true;
});
infoModal?.addEventListener("click", (event) => {
    if (event.target === infoModal) infoModal.hidden = true;
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !infoModal.hidden) infoModal.hidden = true;
});

initScene();
initWheelSpeedCharts();
setIdleStatusDefaults();
applyTimeframeVisibility();
