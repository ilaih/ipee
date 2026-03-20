// calib2.js — Calibration ellipse state, drawing, and drag/pinch interaction

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
