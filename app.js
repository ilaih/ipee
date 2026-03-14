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
const maxPointGapSlider = document.getElementById("maxPointGap")
const maxPointGapBeforeSlider = document.getElementById("maxPointGapBefore")
const maxCurveAngleSlider = document.getElementById("maxCurveAngle")

const width = 360
const height = 640

canvas.width = width
canvas.height = height

let prevFrame = null
let frameCount = 0

const WARMUP_SECONDS = 0.7

let streamPoints = []
let tracker = null
let pendingLock = 0
const LOCK_CONFIRM_FRAMES = 2   // frames that must qualify before first lock
const BIN_WIDTH_MAX = 20        // px: bins narrower than this = stream-like (was 20)
const BIN_WIDTH_RATIO = 0.5     // max fraction of wide bins allowed (was 0.4)
let rafId = null
let lastVideoTime = -1    // tracks last unique video frame we processed
let mainLineCache = []    // persists EMA-smoothed line between frames

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

let t = (startEllipse.y - y) / (startEllipse.y - endEllipse.y);
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

    ctx.drawImage(video, 0, 0, width, height);
    let img = ctx.getImageData(0, 0, width, height);
    let frame = img.data;

    if (!prevFrame || video.currentTime < WARMUP_SECONDS) {
        // Warm-up: skip until video is at WARMUP_SECONDS so every run starts
        // detection at the same video timestamp regardless of rAF/seek timing
        prevFrame = new Uint8ClampedArray(frame);
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
                streamPoints.push(p);
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

    prevFrame = new Uint8ClampedArray(frame);

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

// ── Main stream line ─────────────────────────────────────────────────────────
// Physics constraints:
//   1. EMA temporal smoothing — X positions glide rather than snap between frames
//   2. Ellipse entry angle cutoff — if the line would enter the orange ellipse at an
//      angle steeper than maxCurveAngle (from vertical), stop the line at that point
//   3. Prediction mode — fits a parabola to the clean stream body and extrapolates
//      through the noisy bowl region instead of trusting splashing detections
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

    const maxGapBefore = parseInt(maxPointGapBeforeSlider.value);
    const maxGapAfter  = parseInt(maxPointGapSlider.value);
    const usePrediction = document.getElementById("showPrediction").checked;

    // Y where the stream enters the orange ellipse from below (high-Y side)
    const ellipseEntryY = endEllipse.y + endEllipse.ry;

    let drawPts;   // final [{x,y}] sorted ascending Y (top→bottom)

    if (usePrediction) {
        // ── Prediction mode ──────────────────────────────────────────────────
        // Use only the clean stream body (above the ellipse entry) for fitting
        const cleanCache = mainLineCache.filter(p => p.y > ellipseEntryY);

        // Gap-filter the clean body (descend from body toward ellipse entry)
        const descClean = cleanCache.slice().sort((a, b) => b.y - a.y);
        const cleanFiltered = [];
        for (const cur of descClean) {
            if (cleanFiltered.length > 0) {
                const prev = cleanFiltered[cleanFiltered.length - 1];
                if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > maxGapBefore) continue;
            }
            cleanFiltered.push({ x: cur.x, y: cur.y });
        }

        // Fit parabola x = a·y² + b·y + c to the clean body
        const fit = fitStreamParabola(cleanFiltered);

        if (fit && cleanFiltered.length >= 4) {
            // Generate predicted points from ellipse entry down to ellipse far edge
            const minY = endEllipse.y - endEllipse.ry;
            const predPts = [];
            for (let y = ellipseEntryY; y >= minY; y -= BIN_H) {
                const predX = fit.a * y * y + fit.b * y + fit.c;
                if (predX >= 0 && predX <= width)
                    predPts.push({ x: predX, y: y + BIN_H / 2, predicted: true });
            }
            // Combine: predicted bowl (low Y) + clean detected body (high Y)
            cleanFiltered.sort((a, b) => a.y - b.y);
            drawPts = [...predPts.sort((a, b) => a.y - b.y), ...cleanFiltered];
            drawPts.sort((a, b) => a.y - b.y);
        } else {
            // Not enough data for fit yet — fall back to detected points only
            cleanFiltered.sort((a, b) => a.y - b.y);
            drawPts = cleanFiltered;
        }

    } else {
        // ── Normal mode: gap-filter detected points ──────────────────────────
        const descending = mainLineCache.slice().sort((a, b) => b.y - a.y);
        const filtered = [];
        let crossedEllipse = false;
        for (const cur of descending) {
            if (!crossedEllipse && cur.y <= endEllipse.y) crossedEllipse = true;
            if (filtered.length > 0) {
                const prev = filtered[filtered.length - 1];
                const limit = crossedEllipse ? maxGapAfter : maxGapBefore;
                if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > limit) continue;
            }
            filtered.push({ x: cur.x, y: cur.y });
        }
        filtered.sort((a, b) => a.y - b.y);
        drawPts = filtered;
    }

    if (!drawPts || drawPts.length < 2) return;

    // Ellipse entry angle cutoff:
    // drawPts is sorted ascending Y → low-Y (bowl side) at start, high-Y (body) at end.
    // bodyStart = first index where y > ellipseEntryY  (first body-side point).
    // The crossing segment goes from bodyStart (body) → bodyStart-1 (bowl).
    // If that segment's angle from vertical exceeds maxCurveAngle, drop all bowl-side
    // points — the line stops at the ellipse boundary.
    const maxAngle = parseInt(maxCurveAngleSlider.value);
    const bodyStart = drawPts.findIndex(p => p.y > ellipseEntryY);
    if (bodyStart > 0) {
        const bowlPt = drawPts[bodyStart - 1];
        const bodyPt = drawPts[bodyStart];
        const dx = bowlPt.x - bodyPt.x;
        const dy = bowlPt.y - bodyPt.y;   // negative: bowl is lower Y
        const entryAngle = Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI;
        if (entryAngle > maxAngle) {
            drawPts = drawPts.slice(bodyStart);   // stop at the ellipse boundary
        }
    }

    if (drawPts.length < 2) return;
    const pts = drawPts;

    // Draw: solid purple for detected, dashed for predicted extension
    // Split into detected and predicted segments
    let i = 0;
    while (i < pts.length) {
        // Find start of next run of same type
        const isPred = !!pts[i].predicted;
        let j = i + 1;
        while (j < pts.length && !!pts[j].predicted === isPred) j++;
        const seg = pts.slice(i, j);

        ctx.beginPath();
        if (isPred) {
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = "rgba(180, 0, 255, 0.6)";
        } else {
            ctx.setLineDash([]);
            ctx.strokeStyle = "rgba(180, 0, 255, 0.85)";
        }
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        ctx.moveTo(seg[0].x, seg[0].y);
        for (let k = 1; k < seg.length - 1; k++) {
            const mx = (seg[k].x + seg[k + 1].x) / 2;
            const my = (seg[k].y + seg[k + 1].y) / 2;
            ctx.quadraticCurveTo(seg[k].x, seg[k].y, mx, my);
        }
        ctx.lineTo(seg[seg.length - 1].x, seg[seg.length - 1].y);
        ctx.stroke();

        i = j;
    }
    ctx.setLineDash([]);   // reset dash for other drawing operations
}

// ── Endpoint estimator helpers ───────────────────────────────────────────────

// Linear regression x = m·y + b (y as independent variable). Returns {m,b} or null.
function linearRegression(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let sy = 0, sx = 0, sy2 = 0, sxy = 0;
    for (const p of pts) { sy += p.y; sx += p.x; sy2 += p.y * p.y; sxy += p.x * p.y; }
    const denom = n * sy2 - sy * sy;
    if (Math.abs(denom) < 1e-10) return null;
    const m = (n * sxy - sy * sx) / denom;
    const b = (sx - m * sy) / n;
    return { m, b };
}
function drawEstimatorCircle(x, y, color, label) {
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
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

// Algo 1 — Frontier Centroid (cyan)
// Takes the lowest-Y 25% of streamPoints (closest to bowl) and shows their median.
function drawEstimator1() {
    if (!tracker || streamPoints.length < 4) return;
    const sorted = streamPoints.slice().sort((a, b) => a.y - b.y);
    const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.25)));
    const xs = top.map(p => p.x).sort((a, b) => a - b);
    const ys = top.map(p => p.y).sort((a, b) => a - b);
    const medX = xs[Math.floor(xs.length / 2)];
    const medY = ys[Math.floor(ys.length / 2)];
    drawEstimatorCircle(medX, medY, "cyan", "E1");
}

// Algo 2 — Parabola Endpoint (yellow)
// Fits x = a·y² + b·y + c to the clean stream body (above ellipse entry)
// and evaluates it at the bowl centre Y.
function drawEstimator2() {
    if (!tracker || mainLineCache.length < 4) return;
    const ellipseEntryY = endEllipse.y + endEllipse.ry;
    const cleanPts = mainLineCache.filter(p => p.y > ellipseEntryY);
    if (cleanPts.length < 4) return;
    const fit = fitStreamParabola(cleanPts);
    if (!fit) return;
    const predX = fit.a * endEllipse.y * endEllipse.y + fit.b * endEllipse.y + fit.c;
    if (predX < 0 || predX > width) return;
    drawEstimatorCircle(predX, endEllipse.y, "yellow", "E2");
}

// Algo 3 — Direction Projection (red)
// Takes the bowl-nearest 30% of mainLineCache bands, fits a line x = m·y + b,
// then walks along it from the last known point toward decreasing Y until the
// point enters the endEllipse.
function drawEstimator3() {
    if (!tracker || mainLineCache.length < 3) return;
    const sorted = mainLineCache.slice().sort((a, b) => a.y - b.y);  // ascending Y
    const nearBowl = sorted.slice(0, Math.max(2, Math.ceil(sorted.length * 0.3)));
    const reg = linearRegression(nearBowl);
    if (!reg) return;

    // Walk from the leading point toward decreasing Y (into the bowl)
    const startY = nearBowl[0].y;
    for (let y = startY; y >= endEllipse.y - endEllipse.ry; y--) {
        const x = reg.m * y + reg.b;
        if (pointInEllipse(x, y, endEllipse)) {
            drawEstimatorCircle(x, y, "red", "E3");
            return;
        }
    }
    // Fallback: if the line never enters the ellipse, draw at ellipse centre Y
    const fallbackX = reg.m * endEllipse.y + reg.b;
    if (fallbackX >= 0 && fallbackX <= width)
        drawEstimatorCircle(fallbackX, endEllipse.y, "red", "E3");
}

// ── Overlay ──────────────────────────────────────────────────────────────────

function drawOverlay() {
    cleanTrail()                     // ← this makes green disappear after 1500 ms

    if (showPoints.checked)
        drawStream()

    if (document.getElementById("showStreamLine").checked)
        drawMainStreamLine()

    if (document.getElementById("showEst1").checked) drawEstimator1()
    if (document.getElementById("showEst2").checked) drawEstimator2()
    if (document.getElementById("showEst3").checked) drawEstimator3()

    if (showFunnel.checked)
        drawFunnel()

    drawEllipse(startEllipse, "blue")
    drawEllipse(endEllipse, "orange")
}

function loop()
{
if(video.paused || video.ended)
{
rafId = null
return
}

ctx.drawImage(video,0,0,width,height)

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
    prevFrame = null;
    frameCount = 0;
    pendingLock = 0;
    lastVideoTime = -1;
    mainLineCache = [];
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
    prevFrame = null;
    pendingLock = 0;
    lastVideoTime = -1;
    mainLineCache = [];
});

restartBtn.onclick = () =>
{
    video.pause();

    streamPoints = [];
    tracker = null;
    prevFrame = null;
    frameCount = 0;
    pendingLock = 0;
    lastVideoTime = -1;
    mainLineCache = [];
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
