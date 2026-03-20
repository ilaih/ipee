// onboarding.js — First-launch flow: device ID, age gate, camera load, level screen

const USER_KEY  = 'ipee_uid'
const AGE_KEY   = 'ipee_age_ok'
const SCORE_KEY = 'ipee_score'

// ── Device ID ─────────────────────────────────────────────────────────────────
function getOrCreateUID() {
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
function saveScore(data) { localStorage.setItem(SCORE_KEY, JSON.stringify(data)) }

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
    <div class="ipee-overlay" id="overlay-level">
      <iframe src="stitch-ui/level-screen.html" id="frame-level"></iframe>
    </div>
    `
    document.body.prepend(wrapper)
}

// ── Main flow ─────────────────────────────────────────────────────────────────
// options:
//   skipCameraLoad {bool}  — skip the camera loading screen (sim mode)
//   onDone        {fn}     — called when the user dismisses the level screen
function startOnboarding(options = {}) {
    const { skipCameraLoad = false, onDone = null } = options

    const uid = getOrCreateUID()
    console.log('[ipee] device uid:', uid)

    if (!document.getElementById('ipee-overlays')) injectOverlays()

    // Iframes communicate via postMessage (works across file:// and http://)
    function _onMessage(e) {
        const action = e.data
        if (action === 'age:yes') {
            localStorage.setItem(AGE_KEY, '1')
            if (skipCameraLoad) showLevelScreen(onDone)
            else showCameraLoading(onDone)
        } else if (action === 'age:no') {
            document.getElementById('overlay-age').innerHTML =
                '<div style="color:#fff;font-size:1.5rem;text-align:center;padding:3rem;font-family:sans-serif">This app is for adults only.<br><br>Please close this page.</div>'
        } else if (action === 'play') {
            window.removeEventListener('message', _onMessage)
            hideAllOverlays()
            if (onDone) onDone()
        }
    }
    window.removeEventListener('message', window._ipeeMsg)  // remove any prior listener
    window._ipeeMsg = _onMessage
    window.addEventListener('message', _onMessage)

    if (localStorage.getItem(AGE_KEY) === '1') {
        if (skipCameraLoad) showLevelScreen(onDone)
        else showCameraLoading(onDone)
    } else {
        showOverlay('overlay-age')
    }
}

function showCameraLoading(onDone) {
    showOverlay('overlay-camera')

    // If the video is already playing (camera started before age gate was dismissed),
    // advance immediately — otherwise wait for the video.play signal.
    const vid = document.getElementById('video')
    if (vid && !vid.paused && vid.readyState >= 2) {
        showLevelScreen(onDone)
    } else {
        window._ipeeCameraReady = () => showLevelScreen(onDone)
    }
}

function showLevelScreen(onDone) {
    window._ipeeCameraReady = null

    const s        = getScore()
    const level    = computeLevel(s.totalHitMs)
    const bestMs   = Math.round(s.bestStreak || 0)
    const hits     = s.totalHits || 0
    const xpNow    = (s.totalHitMs || 0) % 5000
    const xpTarget = 5000

    showOverlay('overlay-level')

    // Patch live stats into the iframe (works whether it's already loaded or not)
    const frame = document.getElementById('frame-level')
    function patchFrame() {
        try {
            const doc = frame.contentDocument
            if (!doc || doc.readyState === 'loading') return
            const q = (sel) => doc.querySelector(sel)
            // Level number in the hexagon
            const lvlEl = q('.text-4xl.font-bold')
            if (lvlEl) lvlEl.textContent = level

            // Stats values (3rd span.font-bold in each row)
            const vals = doc.querySelectorAll('.text-slate-100.font-bold')
            if (vals[0]) vals[0].textContent = bestMs ? `${bestMs}ms` : '0s'
            if (vals[1]) vals[1].textContent = hits
            if (vals[2]) vals[2].textContent = `${hits} pts`

            // XP centre text
            const xpEl = q('.text-lg.font-bold')
            if (xpEl) xpEl.textContent = `${xpNow}/${xpTarget}`
        } catch (_) {}
    }

    if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') {
        patchFrame()
    } else {
        frame.addEventListener('load', patchFrame, { once: true })
    }

    // Tapping anywhere on the overlay after 2s also proceeds
    setTimeout(() => {
        document.getElementById('overlay-level')
            .addEventListener('click', () => { hideAllOverlays(); if (onDone) onDone() }, { once: true })
    }, 2000)
}
