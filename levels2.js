// levels2.js — Level definitions, bomb state, game-loop logic, level overlays, recalib

// ── Level definitions ─────────────────────────────────────────────────────────
const LEVELS = [
    { id: 1, bombs: [{ dx: 50, dy: -50, goalMs: 3000 }],                                           threeStarMs: 4000,  twoStarMs: 30000 },
    { id: 2, bombs: [{ dx: 50, dy: -50, goalMs: 2000 }, { dx: -50, dy: -50, goalMs: 2000 }],       threeStarMs: 10000, twoStarMs: 16000 },
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
let _levelStartMs   = 0     // Date.now() when initBomb() was called — for star rating
let _stopInProgress = false // guard: prevent double-stop from timeout + button simultaneously

let _bombInitial = null   // alias → active bomb's initial (null-check guard)
let _bombDeltaX  = 0
let _bombDeltaY  = 0
let bombPos      = null   // points to _bombStates[_bombIdx].pos

function isLevelIntroActive() { return _levelIntroActive }

// True while the player is actively aiming (bombs placed, countdown done, game not finishing)
function isGameActive() {
    return _bombStates.length > 0 && !_levelIntroActive && !isCountdownActive()
}

function restoreProgress() {
    if (typeof getScore !== 'function') return
    const saved = (getScore() || {}).gameLevel
    if (saved != null) _levelIdx = Math.min(saved, LEVELS.length - 1)
}

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
    if (typeof saveScore === 'function') saveScore({ ...getScore(), gameLevel: _levelIdx })
    _levelStartMs   = 0     // set to Date.now() in showGo() once countdown ends
    _stopInProgress = false
    // Push a history entry so the phone back button can be intercepted via popstate
    history.pushState({ ipeeGame: true }, '')
    initStream()
    // tracker2.js starts 8 candidates + countdown; showGo() fires when done
}

function updateBomb() {
    if (!_bombStates.length || !bombPos) return

    // Auto-stop if elapsed time exceeds twoStarMs × 1.3 (game is no longer winnable at 1 star)
    if (!isCountdownActive() && _levelStartMs > 0) {
        const limit = LEVELS[_levelIdx].twoStarMs * 1.3
        if (Date.now() - _levelStartMs > limit) {
            stopGame('timeout')
            return
        }
    }

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
    if (typeof recordHitMs === 'function') recordHitMs(_bombStates[_bombIdx].goalMs)
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
    if (typeof saveScore === 'function') saveScore({ ...getScore(), gameLevel: 0 })
    _recalibCore()
}

// ── Stop game ─────────────────────────────────────────────────────────────────
// reason: 'timeout' | 'manual' | 'back'
// timeout  → cooldown saved (pee happened), brief "Time's Up" overlay shown
// manual/back → straight to menu, no cooldown (player chose to quit)
function stopGame(reason) {
    if (_stopInProgress) return
    _stopInProgress = true

    // Clean up any lingering history entry we pushed (prevents double-pop)
    if (history.state && history.state.ipeeGame) history.back()

    _recalibCore()   // resets bomb/tracker state, shows OK button

    if (reason === 'timeout') {
        // Mark cooldown so the play button is locked for X time (player must wait before trying again)
        if (typeof getScore === 'function' && typeof saveScore === 'function') {
            const s = getScore() || {}
            s.lastGameCompletedAt = Date.now()
            saveScore(s)
        }
        // Show a brief "Time's Up" screen then go to menu
        const overlay = document.createElement('div')
        overlay.id = 'stop-overlay'
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:9999',
            'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
            'gap:12px', 'background:#102122',
            'font-family:"Space Grotesk",Arial,sans-serif'
        ].join(';')
        overlay.innerHTML = `
            <div style="font-size:60px">⏱️</div>
            <div style="color:#0ddff2;font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:2px">Time's Up!</div>
            <div style="color:#94a3b8;font-size:14px">Aim faster next time</div>`
        document.body.appendChild(overlay)
        setTimeout(() => {
            overlay.remove()
            if (typeof showMainScreen === 'function') showMainScreen(null)
        }, 2000)
    } else {
        // Manual quit / back button — go straight to menu (no delay, no cooldown)
        if (typeof showMainScreen === 'function') showMainScreen(null)
    }
}

// ── Level overlays ────────────────────────────────────────────────────────────
// onStart — called when user taps "Tap to Play"; should initCandidateTrackers + initBomb
function showLevelIntro(onStart) {
    _levelIntroActive = true
    const level = LEVELS[_levelIdx]

    const existing = document.getElementById('level-intro-overlay')
    if (existing) existing.remove()

    const bombParams = level.bombs.map((b, i) => `bomb${i}=${b.goalMs / 1000}`).join('&')
    const introSrc   = `stitch-ui/level-intro.html?level=${level.id}&${bombParams}`

    const div = document.createElement('div')
    div.id = 'level-intro-overlay'
    div.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:#102122'
    div.innerHTML = `<iframe src="${introSrc}" style="width:360px;height:640px;border:none;max-width:100vw;max-height:100vh"></iframe>`
    document.body.appendChild(div)

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
    const lvl         = LEVELS[_levelIdx]
    const elapsed     = Date.now() - _levelStartMs
    const stars       = elapsed <= lvl.threeStarMs ? 3 : elapsed <= lvl.twoStarMs ? 2 : 1

    // Save: next game level, completion timestamp, best level time, per-level stars
    if (typeof getScore === 'function' && typeof saveScore === 'function') {
        const s           = getScore() || {}
        s.gameLevel       = isLastLevel ? 0 : _levelIdx + 1
        s.lastGameCompletedAt = Date.now()
        s.bestLevelMs     = s.bestLevelMs ? Math.min(s.bestLevelMs, elapsed) : elapsed
        const levelStars  = s.levelStars || []
        levelStars[_levelIdx] = Math.max(levelStars[_levelIdx] || 0, stars)
        s.levelStars      = levelStars
        saveScore(s)
    }

    const existing = document.getElementById('level-success-overlay')
    if (existing) existing.remove()

    const div = document.createElement('div')
    div.id = 'level-success-overlay'
    div.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:#102122'
    const successSrc = `stitch-ui/level-success.html?level=${levelId}&stars=${stars}&elapsedMs=${elapsed}`
    div.innerHTML = `<iframe src="${successSrc}" style="width:360px;height:640px;border:none;max-width:100vw;max-height:100vh"></iframe>`
    document.body.appendChild(div)

    function _onMsg(e) {
        if (e.data === 'level:next') {
            window.removeEventListener('message', _onMsg)
            div.remove()
            // Reset game state for next session (OK button shows, covered by level screen)
            _recalibCore()
            // Return to main menu — player must recalibrate for next level
            if (typeof showLevelScreen === 'function') {
                showLevelScreen(null)
            }
        }
    }
    window.addEventListener('message', _onMsg)
}

// ── Time bar ──────────────────────────────────────────────────────────────────
// Red HP bar drawn at the bottom of the canvas. Starts full, drains to zero
// over twoStarMs × 1.3. Only visible after the countdown ends.
function drawTimeBar(ctx) {
    if (!isGameActive() || _levelStartMs === 0) return

    const timeLimit = LEVELS[_levelIdx].twoStarMs * 1.3
    const elapsed   = Date.now() - _levelStartMs
    const pct       = Math.max(0, 1 - elapsed / timeLimit)

    const BAR_H = 10
    const BAR_Y = H - BAR_H

    // Dark track
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, BAR_Y, W, BAR_H)

    if (pct > 0) {
        // Pulse faster as time runs low
        const pulse = pct < 0.25
            ? 0.75 + 0.25 * Math.sin(Date.now() * 0.018)
            : 1

        // Colour shifts red → deep red → bright red as bar drains
        const r = 255
        const g = Math.round(pct > 0.5 ? 60 * (pct - 0.5) * 2 : 0)
        ctx.globalAlpha = pulse
        ctx.fillStyle = `rgb(${r},${g},0)`
        ctx.fillRect(0, BAR_Y, Math.round(W * pct), BAR_H)
        ctx.globalAlpha = 1

        // Thin bright edge on the leading edge of the bar
        const barW = Math.round(W * pct)
        ctx.fillStyle = 'rgba(255,180,180,0.6)'
        ctx.fillRect(Math.max(0, barW - 3), BAR_Y, 3, BAR_H)
    }
}

// ── GO flash (no-op — level intro overlay replaced it) ────────────────────────
let _goUntil = 0

function showGo() {
    // Countdown done — start the level timer now (used for star rating and timeout bar)
    _levelStartMs = Date.now()
}

function drawGoFlash(_ctx) {
    // Visual GO flash replaced by level intro overlay — this is now a no-op.
}
