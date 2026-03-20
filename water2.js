// ── Water Surface Detector ────────────────────────────────────────────────────
// Detects the toilet water pool from the reference frame at calibration.
// Uses the darkest pixels inside the bowl (inner ellipse) to find the water area.
//
// Public API:
//   initWaterDetector(pixels)  — call once at OK press (reference frame)
//   drawWater(ctx)             — call every frame inside calibDone block
//   resetWater()               — call at recalib / restart

let _waterDetected = false
let _waterRelCx = 0   // centre offset from calibEllipse.x
let _waterRelCy = 0   // centre offset from calibEllipse.y
let _waterRx    = 0   // water ellipse semi-radius horizontal
let _waterRy    = 0   // water ellipse semi-radius vertical

function resetWater() {
    _waterDetected = false
}

// Returns true if pixel (x, y) is inside the detected water rectangle.
// Used by stream2.js to skip water-zone pixels in IDLE (suppresses shimmer).
function isInWaterZone(x, y) {
    if (!_waterDetected || !settings.useWaterFilter) return false
    const ox = calibEllipse.x + _waterRelCx
    const oy = calibEllipse.y + _waterRelCy
    return x >= ox - _waterRx && x <= ox + _waterRx &&
           y >= oy - _waterRy && y <= oy + _waterRy
}

// ── initWaterDetector ─────────────────────────────────────────────────────────
// Takes the reference frame RGBA pixel array. Scans the inner 65% of the
// calibEllipse radii (well inside the rim). Threshold = 30th-percentile of
// luminance values — picks up the distinctly darker water pool.
// Fits a small ellipse to the bounding box of those dark pixels.
function initWaterDetector(pixels) {
    resetWater()
    if (!settings.showWater) return

    const cx = calibEllipse.x, cy = calibEllipse.y
    const rx = calibEllipse.rx, ry = calibEllipse.ry

    // Scan inner 65% of radii — water pool is well inside the rim
    const srx = rx * 0.65, sry = ry * 0.65

    const y0 = Math.max(0, Math.ceil(cy - sry))
    const y1 = Math.min(H - 1, Math.floor(cy + sry))

    // Collect all luminance values inside the inner ellipse
    const lums = []
    for (let y = y0; y <= y1; y++) {
        const yRel = y - cy
        const xHalf = srx * Math.sqrt(Math.max(0, 1 - (yRel / sry) * (yRel / sry)))
        const xL = Math.max(0,     Math.ceil(cx - xHalf))
        const xR = Math.min(W - 1, Math.floor(cx + xHalf))
        for (let x = xL; x <= xR; x++) {
            const i = (y * W + x) * 4
            lums.push(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2])
        }
    }

    if (lums.length < 50) {
        console.log('[water] too few pixels:', lums.length)
        return
    }

    // Threshold = 30th-percentile brightness — the distinctly darker water pixels
    const sorted = lums.slice().sort((a, b) => a - b)
    const threshold = sorted[Math.floor(sorted.length * 0.30)]
    console.log('[water] pixels:', lums.length, 'threshold:', threshold.toFixed(1),
                'min:', sorted[0].toFixed(1), 'max:', sorted[sorted.length-1].toFixed(1))

    // Find bounding box + centroid of dark pixels
    let minX = W, maxX = 0, minY = H, maxY = 0
    let sumX = 0, sumY = 0, count = 0

    for (let y = y0; y <= y1; y++) {
        const yRel = y - cy
        const xHalf = srx * Math.sqrt(Math.max(0, 1 - (yRel / sry) * (yRel / sry)))
        const xL = Math.max(0,     Math.ceil(cx - xHalf))
        const xR = Math.min(W - 1, Math.floor(cx + xHalf))
        for (let x = xL; x <= xR; x++) {
            const i = (y * W + x) * 4
            const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
            if (lum <= threshold) {
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
                sumX += x; sumY += y; count++
            }
        }
    }

    console.log('[water] dark px:', count, 'bbox:', minX, minY, '-', maxX, maxY)

    if (count < 10) return

    const waterCx = sumX / count
    const waterCy = sumY / count
    let hwx = (maxX - minX) / 2
    let hwy = (maxY - minY) / 2

    if (hwx < 2 || hwy < 2) return

    // Cap: water ≤ 15% of bowl ellipse area  (hwx × hwy ≤ rx × ry × 0.15)
    const maxProduct = rx * ry * 0.15
    if (hwx * hwy > maxProduct) {
        const scale = Math.sqrt(maxProduct / (hwx * hwy))
        hwx *= scale
        hwy *= scale
    }

    _waterRelCx    = waterCx - cx
    _waterRelCy    = waterCy - cy
    _waterRx       = Math.max(4, hwx)
    _waterRy       = Math.max(4, hwy)
    _waterDetected = true
    console.log('[water] detected  cx:', waterCx.toFixed(1), 'cy:', waterCy.toFixed(1),
                'rx:', _waterRx.toFixed(1), 'ry:', _waterRy.toFixed(1))
}

// ── drawWater ─────────────────────────────────────────────────────────────────
// Draws a 4-vertex diamond: top, right, bottom, left
function drawWater(ctx) {
    if (!settings.showWater || !_waterDetected) return

    const ox = calibEllipse.x + _waterRelCx
    const oy = calibEllipse.y + _waterRelCy

    ctx.save()
    ctx.beginPath()
    ctx.moveTo(ox - _waterRx,  oy - _waterRy)   // top-left
    ctx.lineTo(ox + _waterRx,  oy - _waterRy)   // top-right
    ctx.lineTo(ox + _waterRx,  oy + _waterRy)   // bottom-right
    ctx.lineTo(ox - _waterRx,  oy + _waterRy)   // bottom-left
    ctx.closePath()
    ctx.fillStyle   = 'rgba(0,120,255,0.15)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,200,255,0.85)'
    ctx.lineWidth   = 2
    ctx.stroke()
    ctx.restore()
}
