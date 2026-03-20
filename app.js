const video = document.getElementById("video")
const canvas = document.getElementById("canvas")
const ctx = canvas.getContext("2d")

const upload = document.getElementById("videoUpload")

const playBtn = document.getElementById("play")
const pauseBtn = document.getElementById("pause")
const restartBtn = document.getElementById("restart")
const stepBtn = document.getElementById("step")

const motionSlider = document.getElementById("motionThreshold")
const clusterSlider = document.getElementById("clusterSize")
const trackingSlider = document.getElementById("trackingDist")
const frameSkipSlider = document.getElementById("frameSkip")

const showMotion = document.getElementById("showMotion")
const showFunnel = document.getElementById("showFunnel")
const showPoints = document.getElementById("showPoints")

const memorySlider = document.getElementById("memoryRadius")
const trailSlider = document.getElementById("trailDuration")

const width = 360
const height = 640

canvas.width = width
canvas.height = height

// Draw video frame onto canvas.
// If the camera gives a landscape frame (e.g. 1920×1080), take the center
// 9:16 portrait crop — matching what the phone camera app shows in video mode.
function drawVideoFrame() {
    const vw = video.videoWidth, vh = video.videoHeight
    if (!vw || !vh) { ctx.drawImage(video, 0, 0, width, height); return }
    if (vw > vh) {
        // Landscape frame: crop center portrait slice
        const srcW = vh * (width / height)
        const srcX = (vw - srcW) / 2
        ctx.drawImage(video, srcX, 0, srcW, vh, 0, 0, width, height)
    } else {
        ctx.drawImage(video, 0, 0, vw, vh, 0, 0, width, height)
    }
}

const prevFrame = new Uint8ClampedArray(width * height * 4)
let prevFrameReady = false
let frameCount = 0

const WARMUP_SECONDS = 0.1

let streamPoints = []
let tracker = null
let pendingLock = 0
const LOCK_CONFIRM_FRAMES = 2   // frames that must qualify before first lock
const BIN_WIDTH_MAX = 20        // px: bins narrower than this = stream-like (was 20)
const BIN_WIDTH_RATIO = 0.5     // max fraction of wide bins allowed (was 0.4)
let rafId = null
let lastVideoTime = -1    // tracks last unique video frame we processed
let mainLineCache = []    // persists EMA-smoothed line between frames
let anchorState = { exit: null, entrance: null }  // smoothed X for anchor dots

// ── Bowl Tracker (NCC patch tracking) ──────────────────────────────────────
const BOWL_PATCH_HALF = 18   // 40×40 px reference patch centered on endEllipse
const BOWL_NCC_MIN   = 0.30  // quality gate — below this, hold last known position
const _candidateBuf  = new Float32Array((BOWL_PATCH_HALF*2) * (BOWL_PATCH_HALF*2))
let bowlTracker    = null    // {normRef, x, y, quality} or null
let bowlCalibStart = null    // Date.now() when countdown started, null = off

function _grayAt(d, x, y) {
    const i = (y * width + x) * 4
    return 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]
}

function startBowlCalibCountdown() {
    bowlTracker    = null
    bowlCalibStart = Date.now()
}

function initBowlTracker(data) {
    const ph = BOWL_PATCH_HALF, n = (ph*2)*(ph*2)
    const cx = Math.round(endEllipse.x), cy = Math.round(endEllipse.y- 35)
    const raw = new Float32Array(n)
    let sum = 0
    for (let dy = -ph; dy < ph; dy++) {
        for (let dx = -ph; dx < ph; dx++) {
            const g = _grayAt(data,
                Math.max(0, Math.min(width-1,  cx+dx)),
                Math.max(0, Math.min(height-1, cy+dy)))
            raw[(dy+ph)*(ph*2)+(dx+ph)] = g; sum += g
        }
    }
    const mean = sum / n
    let v = 0
    for (let i = 0; i < n; i++) { raw[i] -= mean; v += raw[i]*raw[i] }
    const std = Math.sqrt(v / n)
    if (std < 1e-6) return   // flat/textureless patch — cannot track reliably
    const normRef = new Float32Array(n)
    for (let i = 0; i < n; i++) normRef[i] = raw[i] / std
    bowlTracker = { normRef, x: cx, y: cy, quality: 1.0 }
}

// Normalized Cross-Correlation at candidate position (cx,cy).
// Returns value in [-1,1]; 1 = perfect match.
// Reuses _candidateBuf to avoid per-call allocation.
function _nccAt(normRef, data, cx, cy) {
    const ph = BOWL_PATCH_HALF, n = (ph*2)*(ph*2)
    let sum = 0
    for (let dy = -ph; dy < ph; dy++) {
        for (let dx = -ph; dx < ph; dx++) {
            const g = _grayAt(data,
                Math.max(0, Math.min(width-1,  cx+dx)),
                Math.max(0, Math.min(height-1, cy+dy)))
            _candidateBuf[(dy+ph)*(ph*2)+(dx+ph)] = g; sum += g
        }
    }
    const mean = sum / n
    let v = 0, dot = 0
    for (let i = 0; i < n; i++) {
        const c = _candidateBuf[i] - mean
        v += c*c; dot += normRef[i] * c
    }
    const std = Math.sqrt(v / n)
    return std < 1e-6 ? 0 : dot / (n * std)
}

function _bowlSearch(normRef, data, lx, ly, radius, step) {
    const ph = BOWL_PATCH_HALF
    let bx = lx, by = ly, best = -2
    for (let dy = -radius; dy <= radius; dy += step) {
        for (let dx = -radius; dx <= radius; dx += step) {
            const cx = Math.round(lx+dx), cy = Math.round(ly+dy)
            if (cx-ph < 0 || cx+ph >= width || cy-ph < 0 || cy+ph >= height) continue
            const ncc = _nccAt(normRef, data, cx, cy)
            if (ncc > best) { best = ncc; bx = cx; by = cy }
        }
    }
    return { x: bx, y: by, ncc: best }
}

function updateBowlTracker(data) {
    if (!bowlTracker) return
    const { normRef, x: lx, y: ly } = bowlTracker
    // Adaptive search: start small, expand only if quality is poor
    let res = _bowlSearch(normRef, data, lx, ly, 30, 2)
    if (res.ncc < 0.6) {
        const r2 = _bowlSearch(normRef, data, lx, ly, 70, 3)
        if (r2.ncc > res.ncc) res = r2
    }
    if (res.ncc < 0.4) {
        const r3 = _bowlSearch(normRef, data, lx, ly, 120, 4)
        if (r3.ncc > res.ncc) res = r3
    }
    // Quality gate: only move the dot if match is confident enough
    if (res.ncc >= BOWL_NCC_MIN) { bowlTracker.x = res.x; bowlTracker.y = res.y }
    bowlTracker.quality = res.ncc
}

function drawBowlCalibCountdown() {
    if (bowlCalibStart === null || bowlTracker) return
    const remaining = Math.max(1, Math.ceil(5 - (Date.now() - bowlCalibStart) / 1000))
    ctx.font = 'bold 110px Arial'
    ctx.textAlign = 'center'
    ctx.shadowColor = '#000'; ctx.shadowBlur = 16
    ctx.fillStyle = 'rgba(0,220,255,0.9)'
    ctx.fillText(remaining, width/2, height/2 + 36)
    ctx.shadowBlur = 0
}

function drawBowlDot() {
    if (!bowlTracker) return
    const q = bowlTracker.quality
    // cyan = good lock, orange = marginal, red = holding (below quality gate)
    const color = q >= 0.6 ? '#00ffff' : q >= BOWL_NCC_MIN ? '#ffaa00' : '#ff4444'
    ctx.beginPath()
    ctx.arc(bowlTracker.x, bowlTracker.y, 9, 0, Math.PI*2)
    ctx.fillStyle = color; ctx.globalAlpha = 0.85; ctx.fill()
    ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
    ctx.fillStyle = '#fff'; ctx.font = '10px Arial'; ctx.textAlign = 'center'
    ctx.fillText((q*100).toFixed(0)+'%', bowlTracker.x, bowlTracker.y - 14)
}

// ── Game state ─────────────────────────────────────────────────────────────
let totalHitMs = 0
let hitStartTime = null
const TARGET_RADIUS = 20

// ── Debug logging ──────────────────────────────────────────────
let runCount = 0
let currentRun = null

let startEllipse =
{
x: width*0.5,
y: height*0.9,
rx: 60,
ry: 40
}

let endEllipse =
{
x: width*0.5,
y: height*0.35,
rx: 70,
ry: 50
}

let dragging = null

canvas.addEventListener("mousedown",e=>
{
let r = canvas.getBoundingClientRect()
let x = e.clientX-r.left
let y = e.clientY-r.top

if(pointInEllipse(x,y,startEllipse)) dragging="start"
else if(pointInEllipse(x,y,endEllipse)) dragging="end"
})

canvas.addEventListener("mousemove",e=>
{
if(!dragging) return

let r = canvas.getBoundingClientRect()
let x = e.clientX-r.left
let y = e.clientY-r.top

if(dragging==="start")
{
startEllipse.x=x
startEllipse.y=y
}

if(dragging==="end")
{
endEllipse.x=x
endEllipse.y=y
}
})

canvas.addEventListener("mouseup",()=>dragging=null)
canvas.addEventListener("mouseleave",()=>dragging=null)

canvas.addEventListener("touchstart",e=>{
    e.preventDefault()
    const t=e.touches[0],r=canvas.getBoundingClientRect()
    const x=t.clientX-r.left,y=t.clientY-r.top
    if(pointInEllipse(x,y,startEllipse)) dragging="start"
    else if(pointInEllipse(x,y,endEllipse)) dragging="end"
},{passive:false})

canvas.addEventListener("touchmove",e=>{
    e.preventDefault()
    if(!dragging) return
    const t=e.touches[0],r=canvas.getBoundingClientRect()
    const x=t.clientX-r.left,y=t.clientY-r.top
    if(dragging==="start"){startEllipse.x=x;startEllipse.y=y}
    if(dragging==="end"){endEllipse.x=x;endEllipse.y=y}
},{passive:false})

canvas.addEventListener("touchend",()=>dragging=null)

function pointInEllipse(x,y,e)
{
let dx=(x-e.x)/e.rx
let dy=(y-e.y)/e.ry
return dx*dx+dy*dy<=1
}

upload.onchange=e=>
{
video.src = URL.createObjectURL(e.target.files[0])
video.play()
}

playBtn.onclick = ()=> video.play()

pauseBtn.onclick = ()=> video.pause()

stepBtn.onclick = () =>
{
video.pause()
video.currentTime += 1/30
processFrame()
drawOverlay()
}

function drawEllipse(e,color)
{
ctx.beginPath()
ctx.ellipse(e.x,e.y,e.rx,e.ry,0,0,Math.PI*2)
ctx.strokeStyle=color
ctx.lineWidth=3
ctx.stroke()

ctx.fillStyle=color
ctx.globalAlpha=0.2
ctx.fill()
ctx.globalAlpha=1
}

function drawFunnel()
{
ctx.strokeStyle="yellow"
ctx.lineWidth=2

ctx.beginPath()
ctx.moveTo(startEllipse.x-startEllipse.rx,startEllipse.y)
ctx.lineTo(endEllipse.x-endEllipse.rx,endEllipse.y)
ctx.stroke()

ctx.beginPath()
ctx.moveTo(startEllipse.x+startEllipse.rx,startEllipse.y)
ctx.lineTo(endEllipse.x+endEllipse.rx,endEllipse.y)
ctx.stroke()
}

function inFunnel(x,y)
{
if (y > startEllipse.y || y < endEllipse.y - 40) return false;

const denom = startEllipse.y - endEllipse.y;
if (Math.abs(denom) < 1) return false;
let t = (startEllipse.y - y) / denom;
let center = startEllipse.x + (endEllipse.x - startEllipse.x) * t;

let startW = startEllipse.rx * 2;
let endW   = endEllipse.rx * 2;
let halfW  = (startW * (1 - t) + endW * t) / 2;

return Math.abs(x - center) < halfW;

}

function getRidgePoints(points) {
    if (points.length < 6) return [];

    let bins = {};
    for (let p of points) {
        let binY = Math.floor(p.y / 6) * 6;
        if (!bins[binY]) bins[binY] = [];
        bins[binY].push(p.x);
    }

    let ridge = [];
    const MIN_PER_BIN = 2;
    for (let by in bins) {
        let xs = bins[by];
        if (xs.length < MIN_PER_BIN) continue;
        xs.sort((a, b) => a - b);
        let medX = xs[Math.floor(xs.length / 2)];
        ridge.push({ x: medX, y: parseInt(by), t: Date.now() });
    }

    if (ridge.length > 0) {
        let minY = Infinity, maxY = -Infinity;
        for (let p of ridge) {
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }
        if (maxY - minY < 70) return [];   // stricter — real stream is tall
    }

    return ridge;
}

function processFrame() {
    // Skip if the video hasn't advanced to a new frame yet (rAF at 60fps, video at 30fps)
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    drawVideoFrame();
    let img = ctx.getImageData(0, 0, width, height);
    let frame = img.data;

    // Bowl tracker runs every frame independently of motion detection
    if (bowlCalibStart !== null && !bowlTracker && Date.now() - bowlCalibStart >= 5000) {
        initBowlTracker(frame)
        bowlCalibStart = null
    }
    if (bowlTracker) updateBowlTracker(frame)

    if (!prevFrameReady || video.currentTime < WARMUP_SECONDS) {
        // Warm-up: skip until video is at WARMUP_SECONDS so every run starts
        // detection at the same video timestamp regardless of rAF/seek timing
        prevFrame.set(frame);
        prevFrameReady = true;
        return;
    }

    const motionThreshold = parseInt(motionSlider.value);
    let motionPoints = [];

    for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
            let i = (y * width + x) * 4;
            let diff = Math.abs(frame[i] - prevFrame[i]) +
                       Math.abs(frame[i+1] - prevFrame[i+1]) +
                       Math.abs(frame[i+2] - prevFrame[i+2]);

            if (diff > motionThreshold && inFunnel(x, y)) {
                motionPoints.push({x, y});
            }
        }
    }

    // Splash corridor filter: when stream is locked, discard bowl-region motion
    // that falls outside the parabola corridor (splash, not stream).
    if (tracker && document.getElementById("useSplashFilter").checked) {
        motionPoints = applyBowlSplashFilter(motionPoints);
    }

    let ridge = [];

    if (!tracker) {
        const startRad = 90;
        let startPoints = motionPoints.filter(p => {
            return Math.hypot(p.x - startEllipse.x, p.y - startEllipse.y) < startRad;
        });

        let logEntry = null;
        if (currentRun) {
            logEntry = {
                processedFrame: frameCount,
                videoTime: +video.currentTime.toFixed(4),
                motionTotal: motionPoints.length,
                startPointsCount: startPoints.length,
                ridgeAfterDetect: 0,
                ridgeAfterEllipse: 0,
                widthFilter: null,
                ridgeAfterWidth: 0,
                pendingLockBefore: pendingLock,
                pendingLockAfter: 0,
                suppressed: true,
            };
        }

        if (startPoints.length >= 8) {
            ridge = getRidgePoints(startPoints);
            if (logEntry) logEntry.ridgeAfterDetect = ridge.length;

            if (ridge.length > 5) {
                // MUST TOUCH THE BLUE ELLIPSE (kills noise higher up)
                let maxYRidge = Math.max(...ridge.map(p => p.y));
                if (Math.abs(maxYRidge - startEllipse.y) > 40) {
                    ridge = [];   // false start — noise higher up
                }
            }
            if (logEntry) logEntry.ridgeAfterEllipse = ridge.length;

            // WIDTH FILTER: stream is narrow (<20px per bin); body motion is wide.
            // Reject if more than 40% of bins are wider than 20px.
            if (ridge.length > 5) {
                let bins = {};
                for (let p of startPoints) {
                    let binY = Math.floor(p.y / 6) * 6;
                    if (!bins[binY]) bins[binY] = [];
                    bins[binY].push(p.x);
                }
                let totalBins = 0, wideBins = 0;
                for (let by in bins) {
                    let xs = bins[by];
                    if (xs.length < 2) continue;
                    totalBins++;
                    if (Math.max(...xs) - Math.min(...xs) > BIN_WIDTH_MAX) wideBins++;
                }
                if (logEntry) logEntry.widthFilter = { totalBins, wideBins, ratio: totalBins > 0 ? +(wideBins/totalBins).toFixed(2) : 0 };
                if (totalBins > 0 && wideBins / totalBins > BIN_WIDTH_RATIO) {
                    ridge = [];   // too diffuse — body motion, not stream
                }
            }
            if (logEntry) logEntry.ridgeAfterWidth = ridge.length;
        }

        // Require N consecutive qualifying frames before committing the first lock
        if (ridge.length > 5) {
            pendingLock++;
        } else if (startPoints.length > 0) {
            // Motion was present near the start zone but failed the filters — genuine miss
            pendingLock = 0;
        }
        // If startPoints=0 (no data at all), hold pendingLock — don't count a blank frame as a miss
        if (logEntry) logEntry.pendingLockAfter = pendingLock;
        if (pendingLock < LOCK_CONFIRM_FRAMES) {
            ridge = [];   // not confirmed yet — suppress points
        }
        if (logEntry) {
            logEntry.suppressed = (ridge.length === 0);
            if (currentRun.frames.length < 2000)
                currentRun.frames.push(logEntry);
        }
    } else {
        ridge = getRidgePoints(motionPoints);
    }

    if (ridge.length > 5) {
        let sumX = 0, sumY = 0;
        for (let p of ridge) {
            sumX += p.x; sumY += p.y;
        }
        let avgX = sumX / ridge.length;
        let avgY = sumY / ridge.length;

        let accept = true;

        if (tracker) {
            let dist = Math.hypot(avgX - tracker.x, avgY - tracker.y);
            if (dist > parseInt(trackingSlider.value) * 1.8) accept = false;
            if (Math.abs(avgY - tracker.y) > 120) accept = false;
        }

        if (tracker && ridge.every(p => p.y < endEllipse.y + 60)) {
            accept = false;
        }

        if (accept) {
            for (let p of ridge) {
                streamPoints.push({ x: p.x, y: p.y, t: p.t ?? Date.now() });
            }

            if (!tracker) {
                tracker = { x: avgX, y: avgY };
                if (currentRun && !currentRun.detectionFired) {
                    currentRun.detectionFired = true;
                    currentRun.detectionAtFrame = frameCount;
                    currentRun.detectionAvgX = +avgX.toFixed(1);
                    currentRun.detectionAvgY = +avgY.toFixed(1);
                }
            } else {
                tracker.x = avgX;
                tracker.y = avgY;
            }
        }
    }

    prevFrame.set(frame);

    if (showMotion.checked) drawMotion(motionPoints);
}


function cleanTrail() {
    const maxAge = parseInt(trailSlider.value)
    const now = Date.now()
    streamPoints = streamPoints.filter(p => now - p.t < maxAge)
}

function drawMotion(points)
{
ctx.fillStyle="rgba(255,0,0,0.5)"

for(let p of points)
ctx.fillRect(p.x,p.y,2,2)
}

function drawStream()
{
ctx.fillStyle="lime"

for(let p of streamPoints)
{
ctx.beginPath()
ctx.arc(p.x,p.y,3,0,Math.PI*2)
ctx.fill()
}
}

// ── Parabola fitting helpers ────────────────────────────────────────────────
// Solve 3×3 linear system via Gaussian elimination; returns [x0,x1,x2] or null
function solveLinear3(A, B) {
    const M = A.map((row, i) => [...row, B[i]]);
    for (let col = 0; col < 3; col++) {
        let maxRow = col;
        for (let row = col + 1; row < 3; row++)
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
        if (Math.abs(M[col][col]) < 1e-10) return null;
        for (let row = col + 1; row < 3; row++) {
            const f = M[row][col] / M[col][col];
            for (let j = col; j <= 3; j++) M[row][j] -= f * M[col][j];
        }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
        x[i] = M[i][3];
        for (let j = i + 1; j < 3; j++) x[i] -= M[i][j] * x[j];
        x[i] /= M[i][i];
    }
    return x;
}

// Fit x = a·y² + b·y + c to pts[] using least squares (y is independent var).
// A pee stream under gravity is a parabola; using y as the independent variable
// handles the case where the stream spans a tall vertical range.
// Returns {a,b,c} or null if insufficient/degenerate data.
function fitStreamParabola(pts) {
    if (pts.length < 3) return null;
    let sy4=0, sy3=0, sy2=0, sy1=0;
    let sxy2=0, sxy1=0, sxy0=0;
    const n = pts.length;
    for (const p of pts) {
        const y = p.y, x = p.x;
        sy4 += y*y*y*y; sy3 += y*y*y; sy2 += y*y; sy1 += y;
        sxy2 += x*y*y;  sxy1 += x*y;  sxy0 += x;
    }
    const coef = solveLinear3(
        [[sy4, sy3, sy2], [sy3, sy2, sy1], [sy2, sy1, n]],
        [sxy2, sxy1, sxy0]
    );
    if (!coef) return null;
    return { a: coef[0], b: coef[1], c: coef[2] };
}

// Weighted variant: pts must carry a .w field (raw detection count).
// Higher-count bins pull the fit toward themselves; sparse bins barely influence it.
function fitStreamParabolaWeighted(pts) {
    if (pts.length < 3) return null;
    let sw=0, swy4=0, swy3=0, swy2=0, swy1=0;
    let swxy2=0, swxy1=0, swxy0=0;
    for (const p of pts) {
        const w = p.w ?? 1, y = p.y, x = p.x;
        sw    += w;
        swy4  += w*y*y*y*y; swy3 += w*y*y*y; swy2 += w*y*y; swy1 += w*y;
        swxy2 += w*x*y*y;   swxy1 += w*x*y;  swxy0 += w*x;
    }
    const coef = solveLinear3(
        [[swy4, swy3, swy2], [swy3, swy2, swy1], [swy2, swy1, sw]],
        [swxy2, swxy1, swxy0]
    );
    if (!coef) return null;
    return { a: coef[0], b: coef[1], c: coef[2] };
}

// ── Main stream line ─────────────────────────────────────────────────────────
// Physics constraints:
//   1. EMA temporal smoothing — X positions glide rather than snap between frames
//   2. Ellipse entry angle cutoff — if the line would enter the orange ellipse at an
//      angle steeper than maxCurveAngle (from vertical), stop the line at that point
//   3. Prediction mode — fits a parabola to the clean stream body and extrapolates
//      through the noisy bowl region instead of trusting splashing detections
// Walk fitted parabola from startY toward endY (1px steps); return first {x,y}
// where predicate(x,y) is true, or null if never satisfied.
function parabolaIntersect(fit, startY, endY, predicate) {
    const step = endY < startY ? -1 : 1;
    for (let y = startY; step < 0 ? y >= endY : y <= endY; y += step) {
        const x = fit.a*y*y + fit.b*y + fit.c;
        if (predicate(x, y)) return { x, y };
    }
    return null;
}

// Where the parabola first enters the end ellipse coming from the body (high Y → low Y).
function getEntryPt(fit) {
    const pt = parabolaIntersect(
        fit,
        endEllipse.y + endEllipse.ry,    // start: bottom (body-facing) edge
        endEllipse.y - endEllipse.ry,    // end:   top edge
        (x, y) => pointInEllipse(x, y, endEllipse)
    );
    if (pt) return pt;
    // Fallback: evaluate parabola at extreme Y
    const y = endEllipse.y + endEllipse.ry;
    return { x: fit.a*y*y + fit.b*y + fit.c, y };
}

// Where the parabola exits the start ellipse heading toward the bowl.
function getExitPt(fit) {
    const pt = parabolaIntersect(
        fit,
        startEllipse.y,                      // start: centre of start ellipse
        startEllipse.y - startEllipse.ry,    // end:   top (bowl-facing) edge
        (x, y) => !pointInEllipse(x, y, startEllipse)
    );
    if (pt) {
        // Step back one pixel — last point still inside/on the boundary
        const y = pt.y + 1;
        return { x: fit.a*y*y + fit.b*y + fit.c, y };
    }
    const y = startEllipse.y - startEllipse.ry;
    return { x: fit.a*y*y + fit.b*y + fit.c, y };
}

function drawMainStreamLine() {
    if (streamPoints.length < 6) return;

    const BIN_H = 10;
    const EMA_X = 0.25;

    // Build fresh median-X per Y-band
    const freshMap = {};
    for (let p of streamPoints) {
        const by = Math.floor(p.y / BIN_H) * BIN_H;
        if (!freshMap[by]) freshMap[by] = [];
        freshMap[by].push(p.x);
    }
    const freshPts = {};
    for (let by in freshMap) {
        const xs = freshMap[by].slice().sort((a, b) => a - b);
        freshPts[by] = xs[Math.floor(xs.length / 2)];
    }

    // EMA merge into cache
    const cacheMap = {};
    for (let c of mainLineCache) cacheMap[c.by] = c.x;
    const newCache = [];
    for (let by in freshPts) {
        const byInt = parseInt(by);
        const smoothX = cacheMap[by] !== undefined
            ? cacheMap[by] * (1 - EMA_X) + freshPts[by] * EMA_X
            : freshPts[by];
        newCache.push({ by: byInt, x: smoothX, y: byInt + BIN_H / 2 });
    }
    mainLineCache = newCache;
    if (mainLineCache.length < 2) return;

    // ── Fit parabola to clean body ────────────────────────────────────────────
    const ellipseEntryY = endEllipse.y + endEllipse.ry;
    const exitY         = startEllipse.y - startEllipse.ry;
    const cleanPts = mainLineCache.filter(p => p.y > ellipseEntryY && p.y <= exitY + BIN_H);
    const fit = cleanPts.length >= 4 ? fitStreamParabola(cleanPts) : null;

    // ── Compute exact ellipse-boundary intersection points ────────────────────
    let exitPt, entryPt;

    if (fit) {
        exitPt  = getExitPt(fit);
        entryPt = getEntryPt(fit);
    } else {
        // Fallback: use smoothed anchor X from previous frame at fixed extreme Y
        const eX = anchorState.exit;
        const nX = anchorState.entrance;
        if (eX === null || nX === null) return;
        exitPt  = { x: eX, y: exitY };
        entryPt = { x: nX, y: ellipseEntryY };
    }

    // ── Sample parabola from exitPt → entryPt ────────────────────────────────
    const STEP = 8;
    let linePts;

    if (fit) {
        linePts = [];
        for (let y = exitPt.y; y >= entryPt.y; y -= STEP)
            linePts.push({ x: fit.a*y*y + fit.b*y + fit.c, y });
        // Guarantee the entry endpoint is always included
        if (!linePts.length || linePts[linePts.length-1].y > entryPt.y)
            linePts.push({ x: fit.a*entryPt.y*entryPt.y + fit.b*entryPt.y + fit.c, y: entryPt.y });
        // Pin exact intersection points at both ends
        linePts[0]                  = exitPt;
        linePts[linePts.length - 1] = entryPt;
    } else {
        linePts = [exitPt, entryPt];
    }

    if (linePts.length < 2) return;

    // ── Draw single smooth stroke ─────────────────────────────────────────────
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(180, 0, 255, 0.85)";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap  = "round";

    ctx.moveTo(linePts[0].x, linePts[0].y);
    for (let k = 1; k < linePts.length - 1; k++) {
        const mx = (linePts[k].x + linePts[k+1].x) / 2;
        const my = (linePts[k].y + linePts[k+1].y) / 2;
        ctx.quadraticCurveTo(linePts[k].x, linePts[k].y, mx, my);
    }
    ctx.lineTo(linePts[linePts.length-1].x, linePts[linePts.length-1].y);
    ctx.stroke();
}

// ── Endpoint estimator helpers ───────────────────────────────────────────────

function drawEstimatorCircle(x, y, color, label) {
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Arial";
    ctx.textAlign = "center";
    ctx.fillText(label, x, y + 32);
}


// Algo 2 — Parabola Impact (yellow)
// Fits the count-weighted parabola to the stream body and evaluates it at the
// bowl centre Y — predicts the X where the stream arc meets the water surface.
function getE2Point() {
    if (!tracker || mainLineCache.length < 4) return null;
    const ellipseEntryY = endEllipse.y + endEllipse.ry;
    const cleanPts = mainLineCache.filter(p => p.y > ellipseEntryY);
    if (cleanPts.length < 4) return null;
    const fit = fitStreamParabolaWeighted(cleanPts);
    if (!fit) return null;
    const predX = fit.a * endEllipse.y * endEllipse.y + fit.b * endEllipse.y + fit.c;
    if (predX < 0 || predX > width) return null;
    return { x: predX, y: endEllipse.y };
}
function drawEstimator2() {
    const pt = getE2Point();
    if (!pt) return;
    drawEstimatorCircle(pt.x, pt.y, "yellow", "E2");
}

// Algo 3 — Bowl Impact Centroid (magenta)
// Looks at stream points actually detected INSIDE the end ellipse (direct hit evidence).
// Falls back to parabola extrapolation if no in-bowl detections are available.
function drawEstimator3() {
    if (!tracker || streamPoints.length < 4) return;
    const now = Date.now();
    const recent = streamPoints.filter(p => now - (p.t ?? now) < 500);
    const inBowl = recent.filter(p => pointInEllipse(p.x, p.y, endEllipse));
    if (inBowl.length >= 3) {
        inBowl.sort((a, b) => a.x - b.x);
        const med = inBowl[Math.floor(inBowl.length / 2)];
        drawEstimatorCircle(med.x, med.y, "magenta", "E3");
        return;
    }
    // Fallback: parabola body extrapolated to bowl centre
    const ellipseEntryY = endEllipse.y + endEllipse.ry;
    const cleanPts = mainLineCache.filter(p => p.y > ellipseEntryY);
    if (cleanPts.length < 4) return;
    const fit = fitStreamParabolaWeighted(cleanPts);
    if (!fit) return;
    const predX = fit.a * endEllipse.y * endEllipse.y + fit.b * endEllipse.y + fit.c;
    if (predX < 0 || predX > width) return;
    drawEstimatorCircle(predX, endEllipse.y, "magenta", "E3");
}

// ── Smart Splash Corridor Filter ─────────────────────────────────────────────
// When the stream body (above the end ellipse bottom) has been detected and a
// parabola x = a·y² + b·y + c is fitted to it, restrict bowl-region motion
// points to a ±corridorW-pixel band around the predicted X.  Splash scatters
// widely; the real stream impact stays in a narrow column.
function applyBowlSplashFilter(motionPoints) {
    const ellipseEntryY = endEllipse.y + endEllipse.ry;   // bottom of end ellipse
    const cleanPts = mainLineCache.filter(p => p.y > ellipseEntryY);
    if (cleanPts.length < 4) return motionPoints;          // not enough body data yet

    const fit = fitStreamParabola(cleanPts);
    if (!fit) return motionPoints;

    const corridorEl = document.getElementById("splashCorridor");
    const CORRIDOR_W = corridorEl ? parseInt(corridorEl.value) : 30;

    return motionPoints.filter(p => {
        if (p.y >= ellipseEntryY) return true;             // stream body: keep as-is
        // Bowl / impact region: keep only within corridor of extrapolated trajectory
        const predX = fit.a * p.y * p.y + fit.b * p.y + fit.c;
        if (predX < 0 || predX > width) return false;
        return Math.abs(p.x - predX) <= CORRIDOR_W;
    });
}

// ── Anchor Points ─────────────────────────────────────────────────────────────
// Start exit  — top edge of start ellipse (body side facing bowl), on the stream line
// End entrance — bottom edge of end ellipse (body side), on the stream line
// Both use the parabola fit from the clean stream body for X; fall back to
// nearest cache point or ellipse-centre X if no fit is available.

// Returns {x, count} where count = number of recent nearby raw detections that
// produced the answer (high = direct evidence; 0 = extrapolated).
function getAnchorX(targetY) {
    const BIN_H           = 10;
    const LOCAL_BAND      = 40;    // px either side of targetY for direct median
    const MIN_DIRECT      = 10;    // min recent points to fire Stage 1 (raised from 5)
    const ANCHOR_WINDOW_MS = 300;  // only use the last 300 ms for Stage 1
    const MIN_COUNT_RATIO  = 0.15; // discard bins with < 15% of peak detection count

    const ellipseEntryY = endEllipse.y + endEllipse.ry;
    const now = Date.now();

    // ── Stage 1: direct median of RECENT raw streamPoints near targetY ───────
    // Short time window (300ms) makes the anchor responsive without reducing the
    // global trail that the stream line and Stage 2 weighting depend on.
    const nearby = streamPoints.filter(p =>
        p.y > ellipseEntryY &&
        Math.abs(p.y - targetY) <= LOCAL_BAND &&
        (now - p.t) < ANCHOR_WINDOW_MS);
    if (nearby.length >= MIN_DIRECT) {
        const xs = nearby.map(p => p.x).sort((a, b) => a - b);
        return { x: xs[Math.floor(xs.length / 2)], count: nearby.length };
    }

    // ── Stage 2: count-weighted parabola over body bins ─────────────────────
    const map = {};
    for (const p of streamPoints) {
        if (p.y <= ellipseEntryY) continue;
        const by = Math.floor(p.y / BIN_H) * BIN_H;
        if (!map[by]) map[by] = [];
        map[by].push(p.x);
    }
    let peakCount = 0;
    const bins = [];
    for (const by in map) {
        const xs = map[by].slice().sort((a, b) => a - b);
        const cnt = xs.length;
        peakCount = Math.max(peakCount, cnt);
        bins.push({ x: xs[Math.floor(xs.length / 2)], y: parseInt(by) + BIN_H / 2, w: cnt });
    }
    const filtered = bins.filter(b => b.w >= peakCount * MIN_COUNT_RATIO);
    if (filtered.length >= 4) {
        const fit = fitStreamParabolaWeighted(filtered);
        if (fit) {
            const x = fit.a * targetY * targetY + fit.b * targetY + fit.c;
            if (x >= 0 && x <= width) return { x, count: 0 };
        }
    }

    // ── Stage 3: nearest mainLineCache bin (last resort) ────────────────────
    if (mainLineCache.length > 0) {
        const closest = mainLineCache.reduce((best, p) =>
            Math.abs(p.y - targetY) < Math.abs(best.y - targetY) ? p : best);
        return { x: closest.x, count: 0 };
    }
    return null;
}

// Wraps getAnchorX with jump veto + EMA smoothing, persisted in anchorState[key].
const JUMP_THRESHOLD = 20;    // px — jumps larger than this need high confidence
const JUMP_MIN_COUNT = 15;    // recent raw points required to accept a large jump
const EMA_ALPHA      = 0.25;  // output smoothing (≈4 frame lag at 30fps)

function getSmoothedAnchorX(targetY, key) {
    const result = getAnchorX(targetY);
    if (!result) return anchorState[key];

    const { x: rawX, count } = result;

    if (anchorState[key] === null) {
        anchorState[key] = rawX;   // first frame: accept any value
        return rawX;
    }

    const jump = Math.abs(rawX - anchorState[key]);
    if (jump > JUMP_THRESHOLD && count < JUMP_MIN_COUNT) {
        return anchorState[key];   // reject — not enough nearby evidence for this jump
    }

    anchorState[key] = anchorState[key] * (1 - EMA_ALPHA) + rawX * EMA_ALPHA;
    return anchorState[key];
}

function drawAnchorPoint(pt, color, label) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px Arial";
    ctx.textAlign = "center";
    ctx.fillText(label, pt.x, pt.y - 11);
}

function drawStartExitPoint() {
    if (!tracker || mainLineCache.length < 2) return;
    const ellipseEntryY = endEllipse.y + endEllipse.ry;
    const cleanPts = mainLineCache.filter(p => p.y > ellipseEntryY);
    const fit = cleanPts.length >= 4 ? fitStreamParabola(cleanPts) : null;
    if (fit) {
        drawAnchorPoint(getExitPt(fit), "#00ccff", "exit");
    } else {
        const y = startEllipse.y - startEllipse.ry;
        const x = getSmoothedAnchorX(y, "exit") ?? startEllipse.x;
        drawAnchorPoint({ x, y }, "#00ccff", "exit");
    }
}

function drawEndEntrancePoint() {
    if (!tracker || mainLineCache.length < 2) return;
    const ellipseEntryY = endEllipse.y + endEllipse.ry;
    const cleanPts = mainLineCache.filter(p => p.y > ellipseEntryY);
    const fit = cleanPts.length >= 4 ? fitStreamParabola(cleanPts) : null;
    if (fit) {
        drawAnchorPoint(getEntryPt(fit), "#ff6600", "entry");
    } else {
        const y = ellipseEntryY;
        const x = getSmoothedAnchorX(y, "entrance") ?? endEllipse.x;
        drawAnchorPoint({ x, y }, "#ff6600", "entry");
    }
}

// ── Overlay ──────────────────────────────────────────────────────────────────

function drawOverlay() {
    cleanTrail()                     // ← this makes green disappear after 1500 ms

    if (showPoints.checked)
        drawStream()

    if (document.getElementById("showStreamLine").checked)
        drawMainStreamLine()


    if (document.getElementById("showEst2").checked) drawEstimator2()
    if (document.getElementById("showEst3").checked) drawEstimator3()

    if (document.getElementById("showStartExit").checked) drawStartExitPoint()
    if (document.getElementById("showEndEntrance").checked) drawEndEntrancePoint()

    if (showFunnel.checked)
        drawFunnel()

    drawEllipse(startEllipse, "blue")
    drawEllipse(endEllipse, "orange")

    // ── Target circle (left edge of end ellipse) ──────────────────────────
    const targetX = endEllipse.x - endEllipse.rx + TARGET_RADIUS
    const targetY = endEllipse.y
    ctx.beginPath()
    ctx.arc(targetX, targetY, TARGET_RADIUS, 0, Math.PI * 2)
    ctx.strokeStyle = "white"
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = "rgba(255,255,255,0.15)"
    ctx.fill()

    // ── Hit detection for E2 (yellow) ─────────────────────────────────────
    const e2pt = getE2Point()
    const now = Date.now()
    if (e2pt && Math.hypot(e2pt.x - targetX, e2pt.y - targetY) <= TARGET_RADIUS) {
        if (hitStartTime === null) hitStartTime = now
    } else {
        if (hitStartTime !== null) {
            totalHitMs += now - hitStartTime
            hitStartTime = null
        }
    }

    // ── HUD: total hit time ───────────────────────────────────────────────
    const displayMs = totalHitMs + (hitStartTime !== null ? now - hitStartTime : 0)
    ctx.fillStyle = "white"
    ctx.font = "bold 18px Arial"
    ctx.textAlign = "left"
    ctx.fillText(`Hit: ${displayMs} ms`, 10, 25)

    if (typeof chosenCamLabel === "string" && chosenCamLabel) {
        ctx.font = "11px Arial"
        ctx.fillStyle = "rgba(255,255,255,0.6)"
        ctx.fillText(chosenCamLabel, 10, height - 8)
    }

    drawBowlCalibCountdown()
    if (document.getElementById("showWaterBounds")?.checked) drawBowlDot()
}

function loop()
{
if(video.paused || video.ended)
{
rafId = null
return
}

drawVideoFrame()

frameCount++

let frameSkip = parseInt(frameSkipSlider.value)

if(frameCount % frameSkip == 0)
processFrame()

drawOverlay()

rafId = requestAnimationFrame(loop)
}

video.addEventListener("play", () => {
    streamPoints = [];
    tracker = null;
    prevFrameReady = false;
    frameCount = 0;
    pendingLock = 0;
    lastVideoTime = -1;
    mainLineCache = [];
    anchorState = { exit: null, entrance: null };
    totalHitMs = 0; hitStartTime = null;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }

    runCount++;
    document.getElementById("runNum").textContent = runCount;
    currentRun = {
        run: runCount,
        startedAt: new Date().toISOString(),
        settings: {
            motionThreshold: parseInt(motionSlider.value),
            clusterSize: parseInt(clusterSlider.value),
            trackingDist: parseInt(trackingSlider.value),
            frameSkip: parseInt(frameSkipSlider.value),
            memoryRadius: parseInt(memorySlider.value),
            trailDuration: parseInt(trailSlider.value),
        },
        frames: [],
        detectionFired: false,
        detectionAtFrame: null,
    };

    rafId = requestAnimationFrame(loop);
});

video.addEventListener("pause", () => {
    // Clear everything when pausing so next Play is 100% clean
    streamPoints = [];
    tracker = null;
    prevFrameReady = false;
    pendingLock = 0;
    lastVideoTime = -1;
    mainLineCache = [];
    anchorState = { exit: null, entrance: null };
});

restartBtn.onclick = () =>
{
    video.pause();

    streamPoints = [];
    tracker = null;
    prevFrameReady = false;
    frameCount = 0;
    pendingLock = 0;
    lastVideoTime = -1;
    mainLineCache = [];
    anchorState = { exit: null, entrance: null };
    totalHitMs = 0; hitStartTime = null;
    bowlTracker = null; bowlCalibStart = null;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }

    ctx.clearRect(0, 0, width, height);

    // Seek to 0; disable Play until seek settles so every run starts at identical position
    playBtn.disabled = true;
    video.addEventListener("seeked", () => { playBtn.disabled = false; }, { once: true });
    video.currentTime = 0;
}

function downloadCurrentRun() {
    if (!currentRun) return;
    const json = JSON.stringify(currentRun, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stream_run_${currentRun.run}.json`;
    a.click();
    URL.revokeObjectURL(url);
    currentRun = null;   // free memory
}

// video.addEventListener("ended", downloadCurrentRun);

document.getElementById("saveLog").onclick = downloadCurrentRun;
