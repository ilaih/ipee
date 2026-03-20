// levels2.js — Level definitions, bomb state, game-loop logic, level overlays, recalib

// ── Level definitions ─────────────────────────────────────────────────────────
const LEVELS = [
    { id: 1, bombs: [{ dx: 50, dy: -50, goalMs: 5000 }] },
    { id: 2, bombs: [{ dx: 50, dy: -50, goalMs: 2000 }, { dx: -50, dy: -50, goalMs: 2000 }] },
]

// ── Bomb overlay ──────────────────────────────────────────────────────────────
// Positioned at the calibration ellipse centre + per-level dx/dy offset.
// Stays glued to the scene by following tracker drift (adaptive EMA).

const BOMB_SPEED_SCALE = 25    // px error at which alpha reaches max
const BOMB_ALPHA_MIN   = 0.04  // minimum smoothing (very small movements)
const BOMB_ALPHA_MAX   = 0.40  // maximum responsiveness (large/fast movements)
const BOMB_SIZE_RATIO  = 0.15  // bomb font size = calibEllipse.ry × this ratio

let _levelIdx       = 0     // current level index into LEVELS[]
let _bombIdx        = 0     // which bomb in current level is active
let _bombStates     = []    // [{ dx, dy, goalMs, initial, pos, done }]
let _levelIntroActive = false

let _bombInitial = null   // alias → active bomb's initial (null-check guard)
let _bombDeltaX  = 0
let _bombDeltaY  = 0
let bombPos      = null   // points to _bombStates[_bombIdx].pos

function isLevelIntroActive() { return _levelIntroActive }

function initBomb() {
    const level = LEVELS[_levelIdx]
    const e     = calibEllipse
    _bombStates = level.bombs.map(b => {
        const initial = { x: e.x + b.dx, y: e.y + b.dy }
        return { dx: b.dx, dy: b.dy, goalMs: b.goalMs, initial, pos: { ...initial }, done: false }
    })
    _bombIdx = 0
    const s = _bombStates[0]
    _bombDeltaX  = s.dx
    _bombDeltaY  = s.dy
    _bombInitial = s.initial
    bombPos      = s.pos
    initStream()
    // tracker2.js starts 8 candidates + countdown; showGo() fires when done
}

function updateBomb() {
    if (!_bombStates.length || !bombPos) return

    const est = getEstimatedCenter()
    if (!est) return

    // Update ALL bomb positions using the same tracker drift
    for (const s of _bombStates) {
        if (s.done) continue
        const rawX  = est.x + s.dx
        const rawY  = est.y + s.dy
        const ddx   = rawX - s.pos.x
        const ddy   = rawY - s.pos.y
        const speed = Math.sqrt(ddx * ddx + ddy * ddy)
        const alpha = Math.min(BOMB_ALPHA_MAX,
            BOMB_ALPHA_MIN + (speed / BOMB_SPEED_SCALE) * (BOMB_ALPHA_MAX - BOMB_ALPHA_MIN))
        s.pos.x += alpha * ddx
        s.pos.y += alpha * ddy
    }

    // Keep calibEllipse centred on the active bomb's bowl position (no offset)
    calibEllipse.x = bombPos.x - _bombDeltaX
    calibEllipse.y = bombPos.y - _bombDeltaY
}

function _bombRingColor(pct) {
    if (pct < 0.5) {
        const t = pct * 2
        return `rgb(${Math.round(13 + t * 242)},${Math.round(223 - t * 58)},${Math.round(242 - t * 242)})`
    }
    if (pct < 0.8) {
        const t = (pct - 0.5) / 0.3
        return `rgb(255,${Math.round(165 - t * 115)},0)`
    }
    return 'rgb(255,50,50)'
}

function drawBomb(ctx) {
    if (!_bombStates.length || !calibDone) return

    const ry       = calibEllipse.ry
    const ringR    = Math.round(ry * 0.28)
    const fontSize = Math.round(ry * BOMB_SIZE_RATIO)

    for (let i = 0; i < _bombStates.length; i++) {
        const s = _bombStates[i]
        const { pos, done, goalMs } = s
        const isActive = i === _bombIdx

        ctx.save()
        ctx.textAlign    = 'center'
        ctx.textBaseline = 'middle'

        if (done) {
            ctx.font        = `${Math.round(fontSize * 1.5)}px serif`
            ctx.globalAlpha = 0.85
            ctx.fillText('💥', pos.x, pos.y)
        } else if (!isActive) {
            ctx.font        = `${fontSize}px serif`
            ctx.globalAlpha = 0.3
            ctx.fillText('💣', pos.x, pos.y)
        } else {
            // Active bomb: progress ring + emoji
            const live      = (typeof hitStartTime !== 'undefined' && hitStartTime !== null) ? Date.now() - hitStartTime : 0
            const hitMs     = (typeof totalHitMs !== 'undefined' ? totalHitMs : 0) + live
            const pct       = Math.min(1, hitMs / goalMs)
            const remaining = Math.max(0, (goalMs - hitMs) / 1000)

            // Empty ring track
            ctx.lineWidth   = 4
            ctx.lineCap     = 'round'
            ctx.beginPath()
            ctx.arc(pos.x, pos.y, ringR, 0, Math.PI * 2)
            ctx.strokeStyle = 'rgba(255,255,255,0.2)'
            ctx.stroke()

            // Progress arc (cyan → orange → red)
            if (pct > 0) {
                ctx.beginPath()
                ctx.arc(pos.x, pos.y, ringR, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2)
                ctx.strokeStyle = _bombRingColor(pct)
                ctx.stroke()
            }

            // Glow while actively hitting
            if (live > 0) {
                const pulse     = 0.6 + 0.4 * Math.sin(Date.now() * 0.012)
                ctx.shadowColor = 'rgba(255,255,255,0.9)'
                ctx.shadowBlur  = pulse * 12
            }

            // Bomb emoji (on top of ring)
            ctx.font = `${fontSize}px serif`
            ctx.fillText('💣', pos.x, pos.y)
            ctx.shadowBlur = 0

            // Remaining time below ring
            ctx.font      = `bold ${Math.max(10, Math.round(ringR * 0.4))}px Arial`
            ctx.fillStyle = pct > 0.8 ? '#ff5050' : pct > 0.5 ? '#ffa500' : '#0ddff2'
            ctx.fillText(remaining.toFixed(1) + 's', pos.x, pos.y + ringR + 13)
        }

        ctx.restore()
    }
}

// ── Level advance ─────────────────────────────────────────────────────────────
function advanceBomb() {
    _bombStates[_bombIdx].done = true
    _bombIdx++
    if (_bombIdx < _bombStates.length) {
        const s      = _bombStates[_bombIdx]
        _bombDeltaX  = s.dx
        _bombDeltaY  = s.dy
        _bombInitial = s.initial
        bombPos      = s.pos
        initStream()   // reset stream state for clean start on next bomb
    } else {
        showLevelSuccess()
    }
}

// ── Recalibration ─────────────────────────────────────────────────────────────
// _recalibCore does NOT reset _levelIdx — callers set it before calling if needed.
function _recalibCore() {
    calibDone    = false
    bombPos      = null
    _bombInitial = null
    _bombDeltaX  = 0
    _bombDeltaY  = 0
    _bombIdx     = 0
    _bombStates  = []
    _goUntil     = 0
    resetTrackers()
    resetWater()
    initStream()
    document.getElementById('okBtn').style.display = ''
    closeSettings()
}

function recalib() {
    _levelIdx = 0   // manual recalibrate always restarts from level 1
    _recalibCore()
}

// ── Level overlays ────────────────────────────────────────────────────────────
// onStart — called when user taps "Tap to Play"; should initCandidateTrackers + initBomb
function showLevelIntro(onStart) {
    _levelIntroActive = true
    const level = LEVELS[_levelIdx]

    const existing = document.getElementById('level-intro-overlay')
    if (existing) existing.remove()

    const div = document.createElement('div')
    div.id = 'level-intro-overlay'
    div.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:#102122'
    div.innerHTML = '<iframe src="stitch-ui/level-intro.html" style="width:360px;height:640px;border:none;max-width:100vw;max-height:100vh"></iframe>'
    document.body.appendChild(div)

    const frame = div.querySelector('iframe')
    function patchIntro() {
        try {
            const doc = frame.contentDocument
            if (!doc || doc.readyState === 'loading') return
            const numEl = doc.getElementById('level-num')
            if (numEl) numEl.textContent = level.id
            const goalsEl = doc.getElementById('bomb-goals')
            if (goalsEl) {
                goalsEl.innerHTML = level.bombs.map((b, i) => `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(13,223,242,0.15)">
                        <div style="display:flex;align-items:center;gap:12px">
                            <span style="font-size:26px">💣</span>
                            <span style="color:#94a3b8;font-size:14px;font-weight:500">Bomb ${i + 1}</span>
                        </div>
                        <span style="color:#f1f5f9;font-weight:700;font-size:16px">${(b.goalMs / 1000).toFixed(1)}s</span>
                    </div>`).join('')
            }
        } catch (_) {}
    }
    if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') patchIntro()
    else frame.addEventListener('load', patchIntro, { once: true })

    function _onMsg(e) {
        if (e.data === 'level:start') {
            window.removeEventListener('message', _onMsg)
            div.remove()
            _levelIntroActive = false
            if (onStart) onStart()   // start tracker countdown + bomb
        }
    }
    window.addEventListener('message', _onMsg)
}

function showLevelSuccess() {
    const levelId     = LEVELS[_levelIdx].id
    const isLastLevel = _levelIdx >= LEVELS.length - 1

    const existing = document.getElementById('level-success-overlay')
    if (existing) existing.remove()

    const div = document.createElement('div')
    div.id = 'level-success-overlay'
    div.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:#102122'
    div.innerHTML = '<iframe src="stitch-ui/level-success.html" style="width:360px;height:640px;border:none;max-width:100vw;max-height:100vh"></iframe>'
    document.body.appendChild(div)

    const frame = div.querySelector('iframe')
    function patchSuccess() {
        try {
            const doc = frame.contentDocument
            if (!doc || doc.readyState === 'loading') return
            const titleEl = doc.getElementById('level-complete-title')
            if (titleEl) titleEl.textContent = `Level ${levelId} Complete!`
            const btnEl = doc.getElementById('next-btn-text')
            if (btnEl) btnEl.textContent = isLastLevel ? 'Play Again' : 'Next Level →'
        } catch (_) {}
    }
    if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') patchSuccess()
    else frame.addEventListener('load', patchSuccess, { once: true })

    function _onMsg(e) {
        if (e.data === 'level:next') {
            window.removeEventListener('message', _onMsg)
            div.remove()
            _levelIdx = isLastLevel ? 0 : _levelIdx + 1
            _recalibCore()
        }
    }
    window.addEventListener('message', _onMsg)
}

// ── GO flash (no-op — level intro overlay replaced it) ────────────────────────
let _goUntil = 0

function showGo() { /* countdown done — stream detection starts automatically via isCountdownActive() */ }

function drawGoFlash(_ctx) {
    // Visual GO flash replaced by level intro overlay — this is now a no-op.
}
