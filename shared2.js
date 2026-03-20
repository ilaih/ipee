// shared2.js — Canvas constants and video frame drawing (shared by all pages)

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
