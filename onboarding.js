// onboarding.js — First-launch flow: device ID, age gate, camera load, level screen

const USER_KEY    = 'ipee_uid'
const AGE_KEY     = 'ipee_age_ok'
const SCORE_KEY   = 'ipee_score'
const CONSENT_KEY = 'ipee_consent'

function _hasConsent() { return localStorage.getItem(CONSENT_KEY) === '1' }

// ── Consent banner ────────────────────────────────────────────────────────────
function showConsentBanner() {
    if (_hasConsent()) return
    if (document.getElementById('ipee-consent-bar')) return

    const bar = document.createElement('div')
    bar.id = 'ipee-consent-bar'
    bar.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:99999',
        'background:#0d1f20', 'border-top:1px solid rgba(13,223,242,0.3)',
        'color:#cbd5e1', 'font-family:Arial,sans-serif', 'font-size:13px',
        'padding:14px 16px 16px', 'display:flex', 'flex-direction:column', 'gap:10px'
    ].join(';')
    bar.innerHTML = `
        <p style="margin:0;line-height:1.5">
            We save your <strong style="color:#0ddff2">progress, settings and stats</strong>
            in your browser\u2019s local storage \u2014 on this device only, no server, no tracking.
            You can delete it anytime in <strong>Settings \u2192 Clear my data</strong>.
        </p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
            <button id="ipee-consent-decline"
                style="padding:8px 20px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;font-size:13px">
                Decline
            </button>
            <button id="ipee-consent-accept"
                style="padding:8px 20px;background:#0ddff2;color:#102122;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold">
                Accept
            </button>
        </div>`
    document.body.appendChild(bar)

    document.getElementById('ipee-consent-accept').onclick = () => {
        localStorage.setItem(CONSENT_KEY, '1')
        bar.remove()
    }
    document.getElementById('ipee-consent-decline').onclick = () => {
        bar.remove()  // hides for this session only; reappears on next visit
    }
}

// ── Device ID ─────────────────────────────────────────────────────────────────
function getOrCreateUID() {
    if (!_hasConsent()) return 'anonymous'
    let uid = localStorage.getItem(USER_KEY)
    if (!uid) {
        uid = 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9)
        localStorage.setItem(USER_KEY, uid)
    }
    return uid
}

// ── Score / Level state ───────────────────────────────────────────────────────
function getScore() {
    try { return JSON.parse(localStorage.getItem(SCORE_KEY)) || {} } catch { return {} }
}
function saveScore(data) {
    if (!_hasConsent()) return
    localStorage.setItem(SCORE_KEY, JSON.stringify(data))
}

function recordHitMs(ms) {
    const s = getScore()
    s.totalHitMs = (s.totalHitMs || 0) + ms
    s.totalHits  = (s.totalHits  || 0) + 1
    s.bestStreak = Math.max(s.bestStreak || 0, ms)
    s.level      = computeLevel(s.totalHitMs)
    saveScore(s)
}
function computeLevel(totalMs) {
    return Math.floor((totalMs || 0) / 5000) + 1
}

// ── Overlay helpers ───────────────────────────────────────────────────────────
function showOverlay(id) {
    document.querySelectorAll('.ipee-overlay').forEach(el => el.style.display = 'none')
    const el = document.getElementById(id)
    if (el) el.style.display = 'flex'
}
function hideAllOverlays() {
    document.querySelectorAll('.ipee-overlay').forEach(el => el.style.display = 'none')
}

// ── Inject overlay shells ─────────────────────────────────────────────────────
function injectOverlays() {
    const wrapper = document.createElement('div')
    wrapper.id = 'ipee-overlays'
    wrapper.innerHTML = `
    <style>
      .ipee-overlay {
        display: none; position: fixed; inset: 0; z-index: 9999;
        align-items: center; justify-content: center;
        background: #0d0d1a;
      }
      .ipee-overlay iframe {
        width: 360px; height: 640px; border: none;
        max-width: 100vw; max-height: 100vh;
      }
    </style>
    <div class="ipee-overlay" id="overlay-age">
      <iframe src="stitch-ui/age-gate.html" id="frame-age"></iframe>
    </div>
    <div class="ipee-overlay" id="overlay-camera">
      <iframe src="stitch-ui/camera-loading.html"></iframe>
    </div>
    <div class="ipee-overlay" id="overlay-main">
      <iframe src="stitch-ui/main-screen.html" id="frame-main"></iframe>
    </div>
    `
    document.body.prepend(wrapper)
}

// ── Main flow ─────────────────────────────────────────────────────────────────
// options:
//   onCameraLoading {fn}  — called as soon as the camera-loading overlay is shown
//                           (sim mode uses this to immediately trigger the file picker)
function startOnboarding(options = {}) {
    const { onCameraLoading = null } = options

    showConsentBanner()

    const uid = getOrCreateUID()
    console.log('[ipee] device uid:', uid)

    if (!document.getElementById('ipee-overlays')) injectOverlays()

    // Iframes communicate via postMessage (works across file:// and http://)
    function _onMessage(e) {
        const action = e.data
        if (action === 'age:yes') {
            showCameraLoading(() => showMainScreen(null), onCameraLoading)
        } else if (action === 'age:no') {
            document.getElementById('overlay-age').innerHTML =
                '<div style="color:#fff;font-size:1.5rem;text-align:center;padding:3rem;font-family:sans-serif">This app is for adults only.<br><br>Please close this page.</div>'
        }
        // 'play' is handled by showMainScreen's own listener
    }
    window.removeEventListener('message', window._ipeeMsg)  // remove any prior listener
    window._ipeeMsg = _onMessage
    window.addEventListener('message', _onMessage)

    // Always show age gate on every page load
    showOverlay('overlay-age')
}

function showCameraLoading(onDone, onShow) {
    showOverlay('overlay-camera')
    if (onShow) onShow()

    function _advance() { hideAllOverlays(); if (onDone) onDone() }

    // If the video is already playing (camera started before Play was pressed),
    // advance immediately — otherwise wait for the _ipeeCameraReady signal.
    const vid = document.getElementById('video')
    if (vid && !vid.paused && vid.readyState >= 2) {
        _advance()
    } else {
        window._ipeeCameraReady = _advance
    }
}

function showMainScreen(onDone) {
    window._ipeeCameraReady = null

    const s            = getScore()
    const playerLevel  = computeLevel(s.totalHitMs)
    const xpNow        = (s.totalHitMs || 0) % 5000
    const xpTarget     = 5000
    const levelStars   = s.levelStars || []
    const totalStars   = levelStars.reduce((a, b) => a + (b || 0), 0)
    const levelsBeaten = levelStars.filter(x => x > 0).length
    const bestLevelMs  = s.bestLevelMs || 0
    const nextLevel    = (s.gameLevel != null ? s.gameLevel : 0) + 1

    // Cooldown check — one game per X time
    const COOLDOWN_MS = 1 * 60 * 1000
    const lastPlayed  = s.lastGameCompletedAt || 0
    const remaining   = COOLDOWN_MS - (Date.now() - lastPlayed)
    const onCooldown  = remaining > 0

    showOverlay('overlay-main')

    const frame = document.getElementById('frame-main')
    function patchFrame() {
        try {
            const doc = frame.contentDocument
            if (!doc || doc.readyState === 'loading') return
            const q = sel => doc.querySelector(sel)

            const lvlEl = q('#player-level')
            if (lvlEl) lvlEl.textContent = playerLevel

            const xpCircle = q('#xp-circle')
            if (xpCircle) {
                const pct = Math.min(1, xpNow / xpTarget)
                xpCircle.setAttribute('stroke-dashoffset', Math.round(100 - pct * 100))
            }
            const xpEl = q('#xp-text')
            if (xpEl) xpEl.textContent = `${Math.round(xpNow)}/${xpTarget}`

            const bestEl = q('#stat-best-time')
            if (bestEl) bestEl.textContent = bestLevelMs ? `${(bestLevelMs / 1000).toFixed(1)}s` : '-'
            const beatenEl = q('#stat-levels-beaten')
            if (beatenEl) beatenEl.textContent = levelsBeaten
            const starsEl = q('#stat-total-stars')
            if (starsEl) starsEl.textContent = totalStars

            const nextLvlEl = q('#next-level-label')
            if (nextLvlEl) nextLvlEl.textContent = `Level ${nextLevel}`

            const playBtn     = q('#play-btn')
            const cooldownEl  = q('#cooldown-text')
            if (onCooldown && playBtn) {
                playBtn.setAttribute('disabled', 'true')
                playBtn.style.cssText += ';opacity:0.45;cursor:not-allowed;pointer-events:none;background:#334155;box-shadow:none'
                if (cooldownEl) cooldownEl.textContent = `Come back in ${Math.ceil(remaining / 60000)}m`
            }
        } catch (_) {}
    }

    if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') {
        patchFrame()
    } else {
        frame.addEventListener('load', patchFrame, { once: true })
    }

    // Live countdown ticker — updates every 30s while overlay is open
    let _cooldownTimer = null
    if (onCooldown) {
        _cooldownTimer = setInterval(() => {
            const rem = COOLDOWN_MS - (Date.now() - lastPlayed)
            try {
                const doc = frame.contentDocument
                const cooldownEl = doc.querySelector('#cooldown-text')
                const playBtn    = doc.querySelector('#play-btn')
                if (rem <= 0) {
                    clearInterval(_cooldownTimer)
                    if (playBtn) {
                        playBtn.removeAttribute('disabled')
                        playBtn.style.cssText = playBtn.style.cssText
                            .replace(/opacity:[^;]+;?/g, '')
                            .replace(/cursor:[^;]+;?/g, '')
                            .replace(/pointer-events:[^;]+;?/g, '')
                            .replace(/background:[^;]+;?/g, '')
                            .replace(/box-shadow:[^;]+;?/g, '')
                    }
                    if (cooldownEl) cooldownEl.textContent = ''
                } else {
                    if (cooldownEl) cooldownEl.textContent = `Come back in ${Math.ceil(rem / 60000)}m`
                }
            } catch (_) {}
        }, 30000)
    }

    // Self-contained 'play' listener (re-registered every time showMainScreen is called)
    function _onPlayMsg(e) {
        if (e.data === 'play') {
            window.removeEventListener('message', _onPlayMsg)
            clearInterval(_cooldownTimer)
            hideAllOverlays()
            const fn = onDone || window._ipeeStartGame
            if (fn) fn()
        }
    }
    window.addEventListener('message', _onPlayMsg)

    // Tap-anywhere fallback after 2s (disabled on cooldown)
    if (!onCooldown) {
        setTimeout(() => {
            const overlay = document.getElementById('overlay-main')
            if (overlay) overlay.addEventListener('click', () => {
                window.removeEventListener('message', _onPlayMsg)
                clearInterval(_cooldownTimer)
                hideAllOverlays()
                const fn = onDone || window._ipeeStartGame
                if (fn) fn()
            }, { once: true })
        }, 2000)
    }
}
