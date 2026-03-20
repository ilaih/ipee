// ── Shared constants ─────────────────────────────────────────────────────────
const W = 360
const H = 640
const ZOOM = 1.1
// Draw video frame with portrait center-crop for landscape sources.
// Landscape (e.g. 1920×1080) → crops the center 9:16 slice matching
// the phone camera app's video-mode FOV.
function drawVideoFrame(video, ctx) {
    const vw = video.videoWidth, vh = video.videoHeight
    if (!vw || !vh) return
    if (vw > vh) {
        const srcW = vh * (W / H)
        const srcX = (vw - srcW) / 2
        ctx.drawImage(video, srcX, 0, srcW, vh, 0, 0, W, H)
    } else {
        // Portrait source — crop/zoom from centre
        const srcW = vw / ZOOM
        const srcH = vh / ZOOM
        const srcX = (vw - srcW) / 2
        const srcY = (vh - srcH) / 2
        ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, W, H)
    }
}

// ── Settings state ────────────────────────────────────────────────────────────
const settings = {
    // Motion Filter
    motionThreshold: 46,
    frameSkip:       1,
    // Entrance Detection
    outerRRatio:     0.8,
    innerRRatio:     0.5,
    dirTolerance:    25,
    // Hit Detection
    hitRRatio:       0.1,
    bombDeltaX:      50,   // px offset from ellipse centre (horizontal)
    bombDeltaY:      -50,   // px offset from ellipse centre (vertical)
    // Water Detector
    showWater:       false,
    useWaterFilter:  false,
    // Corridor Filter
    useCorridorFilter: true,
    corridorWidth:     30,
    // Rim Exclusion
    useRimExclusion:  true,
    showRimExclusion: true,
    // Debug
    showDebugStream:  true,
    showStreamPoints: true,
    showTrackers:     true,
    // Parallel detectors
    useChromaDetect:  true,
    chromaThreshold:  12,
    useAdaptDetect:   true,
    adaptThreshold:   18,
    // Logging
    enableLogging:    false,
    enableDetLog:     false,
}

// ── Settings panel (injected into body) ──────────────────────────────────────
function _row(content) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;margin:7px 0">${content}</div>`
}
function _label(text) {
    return `<span style="flex:1;font-size:13px;color:#ccd">${text}</span>`
}
function _sectionHead(text) {
    return `<div style="color:#7788ff;font-size:11px;font-weight:bold;text-transform:uppercase;
        letter-spacing:0.6px;margin:14px 0 6px">${text}</div>`
}
function _slider(key, label, min, max, step=1) {
    return _row(`
        ${_label(label)}
        <input type="range" id="sp_${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}"
            style="width:110px;accent-color:#7788ff;margin:0 8px"
            oninput="settings['${key}']=+this.value;document.getElementById('sv_${key}').textContent=this.value">
        <span id="sv_${key}" style="width:36px;text-align:right;color:#aaf;font-weight:bold;font-size:13px">${settings[key]}</span>
    `)
}
function _check(key, label) {
    return _row(`
        ${_label(label)}
        <input type="checkbox" id="sp_${key}" ${settings[key] ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:#7788ff"
            onchange="settings['${key}']=this.checked">
    `)
}

function initSettingsPanel() {
    const panel = `
    <div id="settingsOverlay" style="display:none;position:fixed;inset:0;
        background:rgba(0,0,0,0.55);z-index:500"
        onclick="if(event.target===this)closeSettings()">
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
          background:rgba(8,8,24,0.98);border:1px solid #446;border-radius:14px;
          padding:20px 18px;width:min(92vw,320px);max-height:85vh;overflow-y:auto">

        ${_sectionHead('Entrance Detection')}
        ${_slider('outerRRatio','Outer Circle (×ry)',0.5,3.0,0.1)}
        ${_slider('innerRRatio','Inner Circle (×ry)',0.2,1.5,0.1)}
        ${_slider('dirTolerance','Aim Tolerance (px)',5,60)}

        ${_sectionHead('Hit Detection')}
        ${_slider('hitRRatio','Hit Zone (×ry)',0.1,1.0,0.1)}
        ${_slider('bombDeltaX','Bomb Offset X (px)',-100,100)}
        ${_slider('bombDeltaY','Bomb Offset Y (px)',-100,100)}

        ${_sectionHead('Motion Filter')}
        ${_slider('motionThreshold','Motion Threshold',5,80)}
        ${_slider('frameSkip','Frame Skip',1,5)}
        ${_check('useChromaDetect','Yellow Detector (chroma)')}
        ${_slider('chromaThreshold','Yellow Threshold',5,40)}
        ${_check('useAdaptDetect','Adaptive Brightness')}
        ${_slider('adaptThreshold','Adaptive Threshold',5,40)}

        ${_sectionHead('Corridor Filter')}
        ${_check('useCorridorFilter','Enable Corridor Filter')}
        ${_slider('corridorWidth','Corridor Width (px)',10,100,5)}
        ${_sectionHead('Rim Exclusion')}
        ${_check('useRimExclusion','Enable Rim Exclusion')}
        ${_check('showRimExclusion','Show Rim Band (debug)')}

        ${_sectionHead('Water Detector')}
        ${_check('showWater','Show Water Outline')}
        ${_check('useWaterFilter','Water Zone Filter')}

        ${_sectionHead('Debug')}
        ${_check('showTrackers','Tracking Ellipse + Dots')}
        ${_check('showStreamPoints','Motion Points (green)')}
        ${_check('showDebugStream','Stream Debug Overlay')}
        ${_check('enableLogging','Enable Frame Logging')}
        ${_check('enableDetLog','Enable Detector Log')}
        <button onclick="saveLog()" style="display:block;width:100%;margin-top:8px;
            padding:10px;background:#1a3a1a;color:#cfc;border:1px solid #484;
            border-radius:8px;font-size:14px;cursor:pointer">💾 Save Log (CSV)</button>

        <button onclick="recalib()" style="display:block;width:100%;margin-top:14px;
            padding:10px;background:#3a1a1a;color:#fcc;border:1px solid #844;
            border-radius:8px;font-size:14px;cursor:pointer">↺ Recalibrate</button>
        <button onclick="closeSettings()" style="display:block;width:100%;margin-top:8px;
            padding:10px;background:#1a1a3a;color:#ccd;border:1px solid #446;
            border-radius:8px;font-size:14px;cursor:pointer">Close</button>
      </div>
    </div>`
    document.body.insertAdjacentHTML('beforeend', panel)
}

function openSettings()  { document.getElementById('settingsOverlay').style.display = 'block' }
function closeSettings() { document.getElementById('settingsOverlay').style.display = 'none'  }

// Reset calibration — re-show the ellipse overlay and OK button without reloading.
// Ellipse position/size are preserved so the user just presses OK if still correct.
function recalib() {
    calibDone    = false
    bombPos      = null
    _bombInitial = null
    _bombDeltaX  = 0
    _bombDeltaY  = 0
    _goUntil     = 0
    resetTrackers()
    resetWater()
    initStream()
    document.getElementById('okBtn').style.display = ''
    closeSettings()
}

// ── Calibration ellipse ───────────────────────────────────────────────────────
// The user drags and resizes this ellipse to match the toilet bowl border.
// On OK its centre replaces the old red-dot position; rx/ry are preserved for
// downstream use (tracker placement, bomb offset, etc.).
const calibEllipse = { x: 144, y: 414, rx: 128, ry: 131 }

// Legacy alias — keeps initBowlTracker / initBomb working without change.
const redDot = calibEllipse

let calibDone = false

// Draw instruction banner + the draggable/resizable ellipse.
function drawCalibOverlay(ctx) {
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.52)'
    ctx.fillRect(0, 0, W, 68)
    ctx.font      = 'bold 14px Arial'
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.shadowColor = '#000'; ctx.shadowBlur = 8
    ctx.fillText('Place the ellipse on the toilet bowl border', W / 2, 24)
    ctx.fillText('Drag to move · pinch to resize · then press OK', W / 2, 48)
    ctx.shadowBlur = 0
    ctx.restore()

    const e = calibEllipse
    // Filled ellipse
    ctx.beginPath()
    ctx.ellipse(e.x, e.y, e.rx, e.ry, 0, 0, Math.PI * 2)
    ctx.fillStyle   = 'rgba(255,40,40,0.12)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,40,40,0.9)'
    ctx.lineWidth   = 2.5
    ctx.stroke()

    // Centre dot
    ctx.beginPath()
    ctx.arc(e.x, e.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,40,40,0.9)'
    ctx.fill()

    // Cardinal handles (visual cue for resize on desktop)
    const handles = [
        { x: e.x + e.rx, y: e.y },
        { x: e.x - e.rx, y: e.y },
        { x: e.x, y: e.y - e.ry },
        { x: e.x, y: e.y + e.ry },
    ]
    for (const h of handles) {
        ctx.beginPath()
        ctx.arc(h.x, h.y, 6, 0, Math.PI * 2)
        ctx.fillStyle   = 'rgba(255,200,0,0.85)'
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth   = 1.5
        ctx.stroke()
    }
}

// Wire mouse + 1/2-finger touch interaction for the calibration ellipse.
//   Mouse  — inside interior: drag centre; near border: resize rx or ry
//   Touch 1 finger — drag centre
//   Touch 2 fingers — independent pinch: horizontal spread → rx, vertical → ry
//                     midpoint movement also translates the ellipse
function initCalibDrag(canvas) {
    let _mode  = null   // 'drag' | 'resizeRx' | 'resizeRy' | 'pinch' | null
    let _last  = null   // last mouse { x, y } in CSS px (for delta resize)
    let _pinch = null   // pinch start state

    function scale() {
        const r = canvas.getBoundingClientRect()
        return { sx: canvas.width / r.width, sy: canvas.height / r.height }
    }
    function toPt(clientX, clientY) {
        const { sx, sy } = scale()
        const r = canvas.getBoundingClientRect()
        return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy }
    }

    // Returns 'drag', 'resizeRx', 'resizeRy', or null
    function hitTest(p) {
        const e  = calibEllipse
        const dx = (p.x - e.x) / e.rx
        const dy = (p.y - e.y) / e.ry
        const d2 = dx*dx + dy*dy
        if (d2 > 1.44) return null          // outside (1.2× ellipse)
        if (d2 > 0.64) {                    // border zone (0.8–1.2×)
            return Math.abs(dx) >= Math.abs(dy) ? 'resizeRx' : 'resizeRy'
        }
        return 'drag'
    }

    // ── Mouse ──────────────────────────────────────────────────────────────────
    canvas.addEventListener('mousedown', e => {
        if (calibDone) return
        const p = toPt(e.clientX, e.clientY)
        _mode = hitTest(p)
        _last = { x: e.clientX, y: e.clientY }
    })
    canvas.addEventListener('mousemove', e => {
        if (!_mode || !_last) return
        const { sx, sy } = scale()
        const ddx = (e.clientX - _last.x) * sx
        const ddy = (e.clientY - _last.y) * sy
        const el  = calibEllipse
        if (_mode === 'drag') {
            el.x = Math.max(el.rx, Math.min(W - el.rx, el.x + ddx))
            el.y = Math.max(el.ry, Math.min(H - el.ry, el.y + ddy))
        } else if (_mode === 'resizeRx') {
            el.rx = Math.max(20, el.rx + ddx)
        } else if (_mode === 'resizeRy') {
            el.ry = Math.max(15, el.ry + ddy)
        }
        _last = { x: e.clientX, y: e.clientY }
    })
    canvas.addEventListener('mouseup',    () => { _mode = null; _last = null })
    canvas.addEventListener('mouseleave', () => { _mode = null; _last = null })

    // ── Touch ──────────────────────────────────────────────────────────────────
    canvas.addEventListener('touchstart', e => {
        e.preventDefault()
        if (calibDone) return
        if (e.touches.length === 1) {
            _mode  = 'drag'
            _pinch = null
        } else if (e.touches.length >= 2) {
            const t0 = e.touches[0], t1 = e.touches[1]
            _mode  = 'pinch'
            _pinch = {
                h:  Math.abs(t1.clientX - t0.clientX),
                v:  Math.abs(t1.clientY - t0.clientY),
                rx: calibEllipse.rx,
                ry: calibEllipse.ry,
                mx: (t0.clientX + t1.clientX) / 2,
                my: (t0.clientY + t1.clientY) / 2,
                ex: calibEllipse.x,
                ey: calibEllipse.y,
            }
        }
    }, { passive: false })

    canvas.addEventListener('touchmove', e => {
        e.preventDefault()
        if (!_mode) return
        const { sx, sy } = scale()
        const el = calibEllipse

        if (_mode === 'drag' && e.touches.length >= 1) {
            const p = toPt(e.touches[0].clientX, e.touches[0].clientY)
            el.x = Math.max(el.rx, Math.min(W - el.rx, p.x))
            el.y = Math.max(el.ry, Math.min(H - el.ry, p.y))

        } else if (_mode === 'pinch' && e.touches.length >= 2 && _pinch) {
            const t0 = e.touches[0], t1 = e.touches[1]
            const curH = Math.abs(t1.clientX - t0.clientX)
            const curV = Math.abs(t1.clientY - t0.clientY)

            // Horizontal spread → rx, vertical spread → ry
            if (_pinch.h > 8)  el.rx = Math.max(20, _pinch.rx * (curH / _pinch.h))
            if (_pinch.v > 8)  el.ry = Math.max(15, _pinch.ry * (curV / _pinch.v))

            // Midpoint translation
            const mx  = (t0.clientX + t1.clientX) / 2
            const my  = (t0.clientY + t1.clientY) / 2
            el.x = Math.max(el.rx, Math.min(W - el.rx, _pinch.ex + (mx - _pinch.mx) * sx))
            el.y = Math.max(el.ry, Math.min(H - el.ry, _pinch.ey + (my - _pinch.my) * sy))
        }
    }, { passive: false })

    canvas.addEventListener('touchend', e => {
        if (e.touches.length === 0) { _mode = null; _pinch = null }
        else if (e.touches.length === 1 && _mode === 'pinch') _mode = 'drag'
    })
}

// NCC tracking is handled by tracker2.js (loaded before this file).
// tracker2.js exports: initCandidateTrackers, updateTrackers, drawTrackerDots,
//   getEstimatedCenter, isCountdownActive, resetTrackers.

// ── Bomb overlay ─────────────────────────────────────────────────────────────
// Positioned at the calibration ellipse centre (the target the player aims at).
// Stays glued to the scene by following the drift of the more stable tracker.
// Adaptive EMA: slow/smooth for tiny jitter, more responsive for fast movement.

const BOMB_SPEED_SCALE = 25    // px error at which alpha reaches max
const BOMB_ALPHA_MIN   = 0.04  // minimum smoothing (very small movements)
const BOMB_ALPHA_MAX   = 0.40  // maximum responsiveness (large/fast movements)

let _bombInitial = null   // { x, y } bomb's world-anchor at OK press
let _bombDeltaX  = 0     // delta captured at initBomb — not live from settings
let _bombDeltaY  = 0
let bombPos      = null   // { x, y } current smoothed display position

function initBomb() {
    _bombDeltaX  = settings.bombDeltaX
    _bombDeltaY  = settings.bombDeltaY
    _bombInitial = { x: calibEllipse.x + _bombDeltaX, y: calibEllipse.y + _bombDeltaY }
    bombPos      = { ..._bombInitial }
    initStream()
    // tracker2.js starts 8 candidates + countdown; showGo() fires when done
}

function updateBomb() {
    if (!_bombInitial || !bombPos) return

    // Get weighted-drift estimate of the bowl centre from tracker2.js
    const est = getEstimatedCenter()
    if (!est) return

    // Raw position = ellipse centre drift + fixed delta captured at OK press
    const rawX = est.x + _bombDeltaX
    const rawY = est.y + _bombDeltaY

    // Adaptive EMA — smooth for small jitter, responsive for real movement
    const ddx   = rawX - bombPos.x
    const ddy   = rawY - bombPos.y
    const speed = Math.sqrt(ddx * ddx + ddy * ddy)
    const alpha = Math.min(BOMB_ALPHA_MAX,
        BOMB_ALPHA_MIN + (speed / BOMB_SPEED_SCALE) * (BOMB_ALPHA_MAX - BOMB_ALPHA_MIN))
    bombPos.x += alpha * ddx
    bombPos.y += alpha * ddy

    // Keep the calibration ellipse centred on the tracked bowl centre (without bomb offset)
    calibEllipse.x = bombPos.x - _bombDeltaX
    calibEllipse.y = bombPos.y - _bombDeltaY
}

const BOMB_SIZE_RATIO = 0.15   // bomb font size = calibEllipse.ry × this ratio

function drawBomb(ctx) {
    if (!bombPos || !calibDone) return
    ctx.save()
    ctx.font         = `${Math.round(calibEllipse.ry * BOMB_SIZE_RATIO)}px serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('💣', bombPos.x, bombPos.y)
    ctx.restore()
}

// ── GO! flash ─────────────────────────────────────────────────────────────────
let _goUntil = 0

function showGo() { _goUntil = Date.now() + 2000 }

function drawGoFlash(ctx) {
    if (Date.now() > _goUntil) return
    ctx.save()
    ctx.font        = 'bold 48px Arial'
    ctx.textAlign   = 'right'
    ctx.shadowColor = '#000'; ctx.shadowBlur = 8
    ctx.fillStyle   = 'rgba(50,255,100,0.95)'
    ctx.fillText('GO!', W - 12, 52)
    ctx.shadowBlur  = 0
    ctx.restore()
}

document.addEventListener('DOMContentLoaded', initSettingsPanel)
