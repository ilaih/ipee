// ── Canvas dimensions (9:16 portrait, fixed) ────────────────────────────────
const W = 360
const H = 640

// ── Simulation ───────────────────────────────────────────────────────────────
const simVideo  = document.getElementById('simVideo')
const simCanvas = document.getElementById('simCanvas')
const simCtx    = simCanvas.getContext('2d')
simCanvas.width  = W
simCanvas.height = H

// ── Camera ───────────────────────────────────────────────────────────────────
const camVideo  = document.getElementById('camVideo')
const camCanvas = document.getElementById('camCanvas')
const camCtx    = camCanvas.getContext('2d')
camCanvas.width  = W
camCanvas.height = H

// Draw video frame with portrait center-crop for landscape sources.
// If camera returns 1920×1080, crops the center 9:16 slice matching
// the phone camera app's video mode FOV (from the old app's drawVideoFrame).
function drawVideoFrame(video, ctx) {
    const vw = video.videoWidth, vh = video.videoHeight
    if (!vw || !vh) return
    if (vw > vh) {
        // Landscape frame: center-crop a portrait 9:16 slice
        const srcW = vh * (W / H)
        const srcX = (vw - srcW) / 2
        ctx.drawImage(video, srcX, 0, srcW, vh, 0, 0, W, H)
    } else {
        ctx.drawImage(video, 0, 0, vw, vh, 0, 0, W, H)
    }
}

// ── Simulation loop ──────────────────────────────────────────────────────────
let simRafId = null

function simLoop() {
    drawVideoFrame(simVideo, simCtx)
    if (!simVideo.paused && !simVideo.ended) {
        simRafId = requestAnimationFrame(simLoop)
    } else {
        simRafId = null
    }
}

document.getElementById('simUpload').addEventListener('change', e => {
    const file = e.target.files[0]
    if (!file) return
    simVideo.src = URL.createObjectURL(file)
})

document.getElementById('simPlay').addEventListener('click', () => simVideo.play())
document.getElementById('simPause').addEventListener('click', () => simVideo.pause())
document.getElementById('simRestart').addEventListener('click', () => {
    simVideo.pause()
    simVideo.currentTime = 0
    simCtx.clearRect(0, 0, W, H)
    if (simRafId) { cancelAnimationFrame(simRafId); simRafId = null }
})

simVideo.addEventListener('play', () => {
    if (simRafId) cancelAnimationFrame(simRafId)
    simRafId = requestAnimationFrame(simLoop)
})
simVideo.addEventListener('pause', () => {
    if (simRafId) { cancelAnimationFrame(simRafId); simRafId = null }
})
simVideo.addEventListener('ended', () => {
    if (simRafId) { cancelAnimationFrame(simRafId); simRafId = null }
})

// ── Camera loop ──────────────────────────────────────────────────────────────
let camRafId  = null
let camStream = null
let camStarted = false

function camLoop() {
    drawVideoFrame(camVideo, camCtx)
    camRafId = requestAnimationFrame(camLoop)
}

camVideo.addEventListener('play', () => {
    document.getElementById('camStatus').style.display = 'none'
    if (camRafId) cancelAnimationFrame(camRafId)
    camRafId = requestAnimationFrame(camLoop)
})

// Pick the main rear camera (1× lens) — same logic as game.html.
// Probes all devices, filters "back" cameras, sorts by the number in the label,
// takes the lowest-numbered (camera 0 = main 1× lens, not ultrawide).
async function startCamera() {
    const statusEl = document.getElementById('camStatus')
    statusEl.textContent = 'Starting camera…'
    statusEl.style.display = 'block'

    if (camStream) camStream.getTracks().forEach(t => t.stop())

    // Step 1: open any camera to unlock device labels
    const initStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false
    })
    initStream.getTracks().forEach(t => t.stop())

    // Step 2: enumerate and probe each camera
    const devices = await navigator.mediaDevices.enumerateDevices()
    const allCams = devices.filter(d => d.kind === 'videoinput')

    const camInfos = []
    for (const cam of allCams) {
        try {
            const s = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: cam.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false
            })
            const settings = s.getVideoTracks()[0].getSettings()
            s.getTracks().forEach(t => t.stop())
            camInfos.push({
                deviceId: cam.deviceId,
                label: cam.label || `Camera ${camInfos.length}`,
                w: settings.width, h: settings.height
            })
        } catch {
            camInfos.push({
                deviceId: cam.deviceId,
                label: cam.label || `Camera ${camInfos.length}`,
                w: 0, h: 0
            })
        }
    }

    // Step 3: pick lowest-numbered rear camera (main 1× lens)
    const rearCams = camInfos.filter(c => c.label.toLowerCase().includes('back'))
    rearCams.sort((a, b) => {
        const na = parseInt(a.label.match(/\d+/)?.[0] ?? '99')
        const nb = parseInt(b.label.match(/\d+/)?.[0] ?? '99')
        return na - nb
    })
    const target = rearCams[0] || camInfos[0]

    // Step 4: open chosen camera at 1920×1080
    camStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: target.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
    })
    camVideo.srcObject = camStream
    await camVideo.play()
}

// ── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab

        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')

        document.querySelectorAll('.screen').forEach(s => s.style.display = 'none')
        document.getElementById(tab + 'Screen').style.display =
            tab === 'cam' ? 'block' : 'flex'

        if (tab === 'cam' && !camStarted) {
            camStarted = true
            startCamera().catch(err => {
                const statusEl = document.getElementById('camStatus')
                statusEl.textContent = 'Camera error: ' + err.message
                statusEl.style.display = 'block'
            })
        }
    })
})
