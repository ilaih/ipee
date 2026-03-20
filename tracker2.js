// tracker2.js — Multi-point NCC scene-lock tracking for ipee
//
// ── ALGORITHM: Weighted-drift centroid ───────────────────────────────────────
//
// Each tracker records where it was at calibration time (start_i).
// Every frame, tracker i is at curr_i.  Its "drift" is curr_i − start_i.
// Adding that drift to the original reference centre gives an independent
// estimate of where the bowl/bomb is right now:
//
//   vote_i = refCenter + (curr_i − start_i)
//
// Quality-weighted average over all active trackers:
//
//   estCenter = refCenter + Σ(q_i × drift_i) / Σ(q_i)   (q_i = NCC quality)
//
// Why this beats picking one tracker:
//   • All trackers always contribute — no sudden switch or jump
//   • Low-quality trackers auto-downweight; they can't snap the position
//   • One tracker temporarily losing lock barely moves the estimate
//
// ── CANDIDATE SELECTION (5-second countdown) ─────────────────────────────────
//
// 8 candidates are placed immediately after the user presses OK:
//
//   Outer group (on ellipse border):  O0=top  O1=bottom  O2=left  O3=right
//   Inner group (INNER_DIST from cx): I0=top  I1=bottom  I2=left  I3=right
//
// During the countdown every candidate runs NCC tracking and accumulates an
// average quality score.  At 5 s the best OUTER_COUNT (3) outer and INNER_COUNT (2) inner
// are selected, guaranteeing ≥1 outer and ≥1 inner in the final 5.
// If one group has fewer valid trackers, the gap is filled from the other group.
// showGo() fires once selection is complete.
//
// ── Public API ────────────────────────────────────────────────────────────────
//   initCandidateTrackers(data)  — start 8 candidates + countdown
//   updateTrackers(data)         — per-frame update (candidates or active)
//   drawTrackerDots(ctx)         — visualise candidates or active trackers
//   getEstimatedCenter()         — { x, y } weighted-drift bowl-centre estimate
//   isCountdownActive()          — true while selection countdown is running
//   resetTrackers()              — full reset; call from _resetCalib()

// ── NCC constants (moved here from shared2.js) ────────────────────────────────
const BOWL_PATCH_HALF = 18     // half-size of the 36×36 px NCC reference patch
const BOWL_NCC_MIN    = 0.30   // quality gate — below this, hold last known position

// ── Tracking constants ────────────────────────────────────────────────────────
const COUNTDOWN_MS    = 5000   // ms of candidate evaluation before selection
const TRACKER_MIN_Q   = 0.30   // min quality for a tracker to vote on position
const OUTER_COUNT     = 3      // trackers selected from outer group
const INNER_COUNT     = 2      // trackers selected from inner group

// ── Pre-allocated NCC buffers (one per candidate, avoids GC pressure) ─────────
const _bufs = Array.from({ length: 8 },
    () => new Float32Array((BOWL_PATCH_HALF * 2) * (BOWL_PATCH_HALF * 2)))

// ── State ─────────────────────────────────────────────────────────────────────
let _candidates     = []    // [{ tracker, group, label, sumQ, frames }]
let _activeTrackers = []    // [{ tracker, start:{x,y}, label }] — selected 5
let _refCenter      = null  // { x, y } calibEllipse centre at calibration
let _countdownStart = null  // Date.now() when countdown began; null = inactive
let _selectionDone  = false

// ── NCC helpers (ported from shared2.js) ──────────────────────────────────────

function _grayAt(d, x, y) {
    const i = (y * W + x) * 4
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
}

function _createTracker(data, cx, cy) {
    const ph = BOWL_PATCH_HALF, n = (ph * 2) * (ph * 2)
    const raw = new Float32Array(n)
    let sum = 0
    for (let dy = -ph; dy < ph; dy++) {
        for (let dx = -ph; dx < ph; dx++) {
            const g = _grayAt(data,
                Math.max(0, Math.min(W - 1, cx + dx)),
                Math.max(0, Math.min(H - 1, cy + dy)))
            raw[(dy + ph) * (ph * 2) + (dx + ph)] = g
            sum += g
        }
    }
    const mean = sum / n
    let v = 0
    for (let i = 0; i < n; i++) { raw[i] -= mean; v += raw[i] * raw[i] }
    const std = Math.sqrt(v / n)
    if (std < 1e-6) return null   // flat/textureless patch — cannot track
    const normRef = new Float32Array(n)
    for (let i = 0; i < n; i++) normRef[i] = raw[i] / std
    return { normRef, x: cx, y: cy, quality: 1.0 }
}

function _nccAt(normRef, buf, data, cx, cy) {
    const ph = BOWL_PATCH_HALF, n = (ph * 2) * (ph * 2)
    let sum = 0
    for (let dy = -ph; dy < ph; dy++) {
        for (let dx = -ph; dx < ph; dx++) {
            const g = _grayAt(data,
                Math.max(0, Math.min(W - 1, cx + dx)),
                Math.max(0, Math.min(H - 1, cy + dy)))
            buf[(dy + ph) * (ph * 2) + (dx + ph)] = g
            sum += g
        }
    }
    const mean = sum / n
    let v = 0, dot = 0
    for (let i = 0; i < n; i++) {
        const c = buf[i] - mean
        v += c * c; dot += normRef[i] * c
    }
    const std = Math.sqrt(v / n)
    return std < 1e-6 ? 0 : dot / (n * std)
}

function _bowlSearch(normRef, buf, data, lx, ly, radius, step) {
    const ph = BOWL_PATCH_HALF
    let bx = lx, by = ly, best = -2, anyValid = false
    for (let dy = -radius; dy <= radius; dy += step) {
        for (let dx = -radius; dx <= radius; dx += step) {
            const cx = Math.round(lx + dx), cy = Math.round(ly + dy)
            if (cx - ph < 0 || cx + ph >= W || cy - ph < 0 || cy + ph >= H) continue
            anyValid = true
            const ncc = _nccAt(normRef, buf, data, cx, cy)
            if (ncc > best) { best = ncc; bx = cx; by = cy }
        }
    }
    return { x: bx, y: by, ncc: best, anyValid }
}

function _updateTracker(tracker, buf, data) {
    if (!tracker) return
    const { normRef, x: lx, y: ly } = tracker
    const margin = BOWL_PATCH_HALF + 5   // 5px buffer before patch reaches frame edge

    // Pause when patch centre is too close to any frame edge (prevents edge-drift artefacts)
    if (lx < margin || lx + margin >= W || ly < margin || ly + margin >= H) {
        tracker.outOfFrame = true
        tracker.quality    = 0
        return
    }

    let res = _bowlSearch(normRef, buf, data, lx, ly, 30, 2)
    let anyValid = res.anyValid
    if (!anyValid || res.ncc < 0.6) {
        const r2 = _bowlSearch(normRef, buf, data, lx, ly, 70, 3)
        if (r2.anyValid) { anyValid = true; if (r2.ncc > res.ncc) res = r2 }
    }
    if (!anyValid || res.ncc < 0.4) {
        const r3 = _bowlSearch(normRef, buf, data, lx, ly, 120, 4)
        if (r3.anyValid) { anyValid = true; if (r3.ncc > res.ncc) res = r3 }
    }
    // All search positions out of frame — pause this tracker until visible again
    if (!anyValid) {
        tracker.outOfFrame = true
        tracker.quality    = 0
        return
    }
    tracker.outOfFrame = false
    if (res.ncc >= BOWL_NCC_MIN) { tracker.x = res.x; tracker.y = res.y }
    tracker.quality = res.ncc
}

// ── Internal: select best 4 from the 8 candidates ────────────────────────────

function _selectTrackers() {
    // Compute average quality for each candidate
    for (const c of _candidates) {
        c.avgQ = c.frames > 0 ? c.sumQ / c.frames : 0
    }

    const inner = _candidates.filter(c => c.group === 'inner' && c.tracker !== null)
        .sort((a, b) => b.avgQ - a.avgQ)
    const outer = _candidates.filter(c => c.group === 'outer' && c.tracker !== null)
        .sort((a, b) => b.avgQ - a.avgQ)

    // Pick top OUTER_COUNT from outer, INNER_COUNT from inner; fill gaps from the other group
    const selected = []
    const takeOuter = Math.min(OUTER_COUNT, outer.length)
    const takeInner = Math.min(INNER_COUNT, inner.length)
    for (let i = 0; i < takeOuter; i++) selected.push(outer[i])
    for (let i = 0; i < takeInner; i++) selected.push(inner[i])

    // Fill remaining slots if either group was short
    const need = OUTER_COUNT + INNER_COUNT - selected.length
    if (need > 0) {
        const leftover = [...outer.slice(takeOuter), ...inner.slice(takeInner)]
            .sort((a, b) => b.avgQ - a.avgQ)
        for (let i = 0; i < Math.min(need, leftover.length); i++) selected.push(leftover[i])
    }

    _activeTrackers = selected.map(c => ({
        tracker: c.tracker,
        start:   { x: c.tracker.x, y: c.tracker.y },
        label:   c.label,
    }))

    _selectionDone = true
    showGo()
}

// ── Public API ────────────────────────────────────────────────────────────────

function resetTrackers() {
    _candidates     = []
    _activeTrackers = []
    _refCenter      = null
    _countdownStart = null
    _selectionDone  = false
}

function initCandidateTrackers(data) {
    resetTrackers()
    const cx = Math.round(calibEllipse.x)
    const cy = Math.round(calibEllipse.y)
    const rx = Math.round(calibEllipse.rx)
    const ry = Math.round(calibEllipse.ry)

    _refCenter = { x: cx, y: cy }

    // Inner candidates placed at 60% of the smaller ellipse radius — guarantees
    // all 4 inner points land inside the bowl regardless of ellipse size.
    const innerDist = Math.round(Math.min(rx, ry) * 0.6)

    // Bottom points shifted to 135° (bottom-right) to avoid the stream entry path.
    // 135° in clock coords (0=top, CW) = 45° in canvas math (0=right, CW):
    //   x offset = r * cos(45°) = r * √½,  y offset = r * sin(45°) = r * √½
    const s = Math.SQRT1_2   // ≈ 0.707

    const positions = [
        // Outer group — on ellipse border
        { x: cx,                       y: cy - ry,                    group: 'outer', label: 'O0' },
        { x: cx + Math.round(rx * s),  y: cy + Math.round(ry * s),   group: 'outer', label: 'O1' },
        { x: cx - rx,                  y: cy,                         group: 'outer', label: 'O2' },
        { x: cx + rx,                  y: cy,                         group: 'outer', label: 'O3' },
        // Inner group — innerDist from centre (scales with ellipse)
        { x: cx,                              y: cy - innerDist,                     group: 'inner', label: 'I0' },
        { x: cx + Math.round(innerDist * s),  y: cy + Math.round(innerDist * s),    group: 'inner', label: 'I1' },
        { x: cx - innerDist,                  y: cy,                                 group: 'inner', label: 'I2' },
        { x: cx + innerDist,                  y: cy,                                 group: 'inner', label: 'I3' },
    ]

    for (let i = 0; i < positions.length; i++) {
        const p = positions[i]
        _candidates.push({
            tracker: _createTracker(data, p.x, p.y),
            group:   p.group,
            label:   p.label,
            sumQ:    0,
            frames:  0,
        })
    }

    _countdownStart = Date.now()
}

function updateTrackers(data) {
    if (_countdownStart === null) return

    if (!_selectionDone) {
        // Countdown phase: update all candidates and accumulate quality stats
        for (let i = 0; i < _candidates.length; i++) {
            const c = _candidates[i]
            if (!c.tracker) continue
            _updateTracker(c.tracker, _bufs[i], data)
            c.sumQ += c.tracker.quality
            c.frames++
        }
        if (Date.now() - _countdownStart >= COUNTDOWN_MS) {
            _selectTrackers()
        }
    } else {
        // Game phase: update only the selected 4
        for (let i = 0; i < _activeTrackers.length; i++) {
            _updateTracker(_activeTrackers[i].tracker, _bufs[i], data)
        }
    }
}

// Returns the quality-weighted estimate of the calibration ellipse centre.
// During countdown returns the fixed refCenter (no drift computed yet).
function getEstimatedCenter() {
    if (!_refCenter) return null
    if (!_selectionDone || _activeTrackers.length === 0) return { ..._refCenter }

    let w = 0, dx = 0, dy = 0
    for (const t of _activeTrackers) {
        const q = t.tracker.quality
        if (t.tracker.outOfFrame || q < TRACKER_MIN_Q) continue
        w  += q
        dx += q * (t.tracker.x - t.start.x)
        dy += q * (t.tracker.y - t.start.y)
    }
    if (w === 0) return { ..._refCenter }
    return { x: _refCenter.x + dx / w, y: _refCenter.y + dy / w }
}

function isCountdownActive() {
    return _countdownStart !== null && !_selectionDone
}

// Draw quality-coloured dots:
//   Countdown: all 8 candidates + countdown number
//   Game:      selected 4 active trackers
// Outer group stroke: yellow  Inner group stroke: magenta
// Fill colour reflects quality: cyan ≥0.6 · orange ≥0.30 · red (poor)
function drawTrackerDots(ctx) {
    if (!settings.showTrackers) return

    function _dot(tracker, label, group) {
        if (!tracker || tracker.outOfFrame) return
        const q      = tracker.quality
        const fill   = q >= 0.6 ? '#00ffff' : q >= BOWL_NCC_MIN ? '#ffaa00' : '#ff4444'
        const stroke = group === 'inner' ? '#ff44ff' : '#ffee00'
        ctx.beginPath()
        ctx.arc(tracker.x, tracker.y, 7, 0, Math.PI * 2)
        ctx.fillStyle = fill; ctx.globalAlpha = 0.85; ctx.fill()
        ctx.globalAlpha = 1; ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke()
        ctx.fillStyle = '#fff'; ctx.font = '10px Arial'; ctx.textAlign = 'center'
        ctx.fillText(label + ' ' + (q * 100).toFixed(0) + '%', tracker.x, tracker.y - 11)
    }

    // Always draw the calibration ellipse border (faint red) as a reference
    ctx.save()
    ctx.beginPath()
    ctx.ellipse(calibEllipse.x, calibEllipse.y, calibEllipse.rx, calibEllipse.ry, 0, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,40,40,0.6)'
    ctx.lineWidth   = 2
    ctx.stroke()
    ctx.restore()

    if (isCountdownActive()) {
        // Show all 8 candidates
        for (const c of _candidates) _dot(c.tracker, c.label, c.group)

        // Countdown number (small, top-right corner)
        const elapsed   = Date.now() - _countdownStart
        const remaining = Math.max(1, Math.ceil((COUNTDOWN_MS - elapsed) / 1000))
        ctx.save()
        ctx.font        = 'bold 48px Arial'
        ctx.textAlign   = 'right'
        ctx.shadowColor = '#000'; ctx.shadowBlur = 8
        ctx.fillStyle   = 'rgba(0,220,255,0.9)'
        ctx.fillText(remaining, W - 12, 52)
        ctx.shadowBlur  = 0
        ctx.restore()
    } else {
        for (const t of _activeTrackers) _dot(t.tracker, t.label, t.label[0] === 'I' ? 'inner' : 'outer')
    }
}
