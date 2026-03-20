// stream2.js — Two-circle pee-stream detection for the ipee game.
//
// Stream travels from HIGH Y (bottom of screen, player) to LOW Y (top, bowl).
// Two horizontal gates detect the stream at different distances below the bomb:
//
//   OUTER gate  (bombPos.y + ry × outerRRatio):
//       First crossing — stream appears here coming from the player.
//
//   INNER gate  (bombPos.y + ry × innerRRatio):
//       Second crossing — stream approaching the bomb.
//
// Trajectory validation:
//   Line from outer crossing point P1 through inner crossing point P2, extrapolated
//   to bomb Y, must be within ±dirTolerance of bombPos.x → INNER_SEEN state.
//
//
// Rim exclusion:
//   Pixels at normalised ellipse distance RIM_INNER_D–RIM_OUTER_D (≈ the porcelain
//   rim) are excluded before any detection.  Try RIM_INNER_D = 0.68 if real edge
//   hits are being lost.
//
// State machine:  IDLE → OUTER_SEEN → INNER_SEEN → (hit accumulates / MISS)
//
// Public API:
//   initStream()           — reset all state; call from initBomb()
//   updateStream(pixels)   — call every frame
//   updateHit()            — call every frame after updateStream()
//   drawStreamOverlay(ctx) — call every frame after drawBomb()

// ── Entrance Detection ────────────────────────────────────────────────────────
const GATE_BAND_H_RATIO    = 0.4   // gate band height   = ry × this
const GATE_X_HALF_RATIO    = 1.2   // gate X half-width  = rx × this
const OUTER_MIN_PX         = 3     // min motion pixels to register outer gate
const INNER_MIN_PX         = 3     // min motion pixels to register inner gate
const TRAVEL_MAX_MS        = 700   // ms outer entry stays valid

// ── Hit Detection ─────────────────────────────────────────────────────────────
const HIT_MIN_PX           = 2     // min pixels in hit zone to register hit
const ALIGNED_TIMEOUT      = 300   // ms without inner gate before leaving INNER_SEEN
const MISS_HOLD_MS         = 200   // ms to hold MISS state

// ── Rim Exclusion ─────────────────────────────────────────────────────────────
const RIM_INNER_D          = 0.9  // normalised ellipse dist — inner exclusion boundary
                                   // → try 0.68 if real edge-hits are being lost
const RIM_OUTER_D          = 5.5  // normalised ellipse dist — outer exclusion boundary

// ── Motion / Body Filter ──────────────────────────────────────────────────────
const BIN_H                = 6     // px — Y bin height for width filter
const BIN_WIDTH_MAX        = 20    // px — max bin spread to be stream-like
const BIN_WIDTH_RATIO      = 0.5   // max fraction of wide bins; above = body motion

// ── Parabola fitting (retained for future use) ────────────────────────────────
function _solveLinear3(A, B) {
    const M = A.map((row, i) => [...row, B[i]])
    for (let col = 0; col < 3; col++) {
        let maxRow = col
        for (let row = col + 1; row < 3; row++)
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
        ;[M[col], M[maxRow]] = [M[maxRow], M[col]]
        if (Math.abs(M[col][col]) < 1e-10) return null
        for (let row = col + 1; row < 3; row++) {
            const f = M[row][col] / M[col][col]
            for (let j = col; j <= 3; j++) M[row][j] -= f * M[col][j]
        }
    }
    const x = [0, 0, 0]
    for (let i = 2; i >= 0; i--) {
        x[i] = M[i][3]
        for (let j = i + 1; j < 3; j++) x[i] -= M[i][j] * x[j]
        x[i] /= M[i][i]
    }
    return x
}

function _fitParabola(pts) {
    if (pts.length < 3) return null
    let sy4=0, sy3=0, sy2=0, sy1=0, sxy2=0, sxy1=0, sxy0=0
    const n = pts.length
    for (const p of pts) {
        const y=p.y, x=p.x
        sy4+=y*y*y*y; sy3+=y*y*y; sy2+=y*y; sy1+=y
        sxy2+=x*y*y;  sxy1+=x*y;  sxy0+=x
    }
    const coef = _solveLinear3(
        [[sy4,sy3,sy2],[sy3,sy2,sy1],[sy2,sy1,n]],
        [sxy2,sxy1,sxy0]
    )
    return coef ? { a:coef[0], b:coef[1], c:coef[2] } : null
}

// ── State ─────────────────────────────────────────────────────────────────────
let _prevPixels   = null      // Uint8ClampedArray — previous frame for diff
let _lastTimeMs   = -1        // video timeMs of the last processed frame (dedup guard)
let _smState      = 'IDLE'    // 'IDLE' | 'OUTER_SEEN' | 'INNER_SEEN' | 'MISS'
let _outerEntry   = null      // { relX, t } — outer gate centroid relative to bombPos.x
let _innerEntry   = null      // { relX }    — inner gate centroid relative to bombPos.x
let _innerLastMs  = 0         // timestamp of last inner gate trigger
// Entry positions are stored RELATIVE to bombPos so they track camera movement.
// Absolute coords: x = bombPos.x + entry.relX,  y = bombPos.y + outerR/innerR.
let hitStartTime = null
let totalHitMs   = 0

// Per-frame debug data
let _dbMotion    = []   // flat [x,y,...] motion after rim exclusion + width filter
let _dbOuterPx   = 0    // outer gate pixel count this frame
let _dbBetweenPx = 0    // pixels in corridor between outer and inner gates
let _dbInnerPx   = 0    // inner gate pixel count this frame
let _dbHitPx     = 0    // hit zone pixel count this frame
let _dbOuterCx   = 0    // outer gate X centroid
let _dbInnerCx   = 0    // inner gate X centroid
let _dbTipX      = 0    // X of stream tip (topmost surviving motion pixel)
let _dbTipY      = Infinity  // Y of stream tip — Infinity = no tip this frame
let _dbTipInHit  = false     // true when tip is inside the hit circle
let _frameNum    = 0    // processed-frame counter (log frame column)
let _curTimeMs   = 0    // video timeMs of current processed frame (log column)

// ── Logging ───────────────────────────────────────────────────────────────────
let _logSession = ''   // session ID (timestamp string)
let _logBuf     = []   // all rows accumulated this session
let _detBuf     = []   // always-on detector log (geometry + pixel counts every frame)

function _logRow(widthFiltered) {
    if (!settings.enableLogging) return
    // Dot absolute positions (empty string when dot not set)
    const bx = bombPos ? bombPos.x : 0
    const by = bombPos ? bombPos.y : 0
    const ry = calibEllipse.ry
    const outerR = ry * settings.outerRRatio
    const innerR = ry * settings.innerRRatio
    const outerDotX = _outerEntry ? Math.round(bx + _outerEntry.relX) : ''
    const outerDotY = _outerEntry ? Math.round(by + outerR)           : ''
    const innerDotX = _innerEntry ? Math.round(bx + _innerEntry.relX) : ''
    const innerDotY = _innerEntry ? Math.round(by + innerR)           : ''
    _logBuf.push([
        _frameNum, _curTimeMs.toFixed(1), _smState,
        _dbOuterPx, _dbBetweenPx, _dbInnerPx, _dbHitPx,
        widthFiltered ? 1 : 0,
        outerDotX, outerDotY, innerDotX, innerDotY,
    ].join(','))
}

// Download accumulated log as a CSV file in the browser.
function saveLog() {
    if (!settings.enableLogging || _logBuf.length === 0) return
    const csv  = 'frame,videoTimeMs,state,outerPx,betweenPx,innerPx,hitPx,widthFiltered,outerDotX,outerDotY,innerDotX,innerDotY\n'
               + _logBuf.join('\n') + '\n'
    const blob = new Blob([csv], { type: 'text/csv' })
    const a    = document.createElement('a')
    a.href     = URL.createObjectURL(blob)
    a.download = 'log_' + _logSession + '.csv'
    a.click()
    URL.revokeObjectURL(a.href)
}

// Always-on detector log — geometry + pixel counts, written regardless of enableLogging.
// Columns: frame, videoTimeMs, state,
//          ex/ey/erx/ery  (calibEllipse — bowl rim),
//          bx/by          (bombPos — bomb centre),
//          outerR/outerY  (outer gate radius & Y),
//          innerR/innerY  (inner gate radius & Y),
//          outerPx, betweenPx, innerPx, hitPx,
//          widthFiltered  (1 = frame rejected by width filter)
function _detRow(outerR, outerY, innerR, innerY,
                 outerPx, betweenPx, innerPx, hitPx, widthFiltered) {
    if (!settings.enableDetLog) return
    const bx = bombPos ? bombPos.x.toFixed(1) : 0
    const by = bombPos ? bombPos.y.toFixed(1) : 0
    _detBuf.push([
        _frameNum, _curTimeMs.toFixed(1), _smState,
        calibEllipse.x.toFixed(1), calibEllipse.y.toFixed(1),
        calibEllipse.rx.toFixed(1), calibEllipse.ry.toFixed(1),
        bx, by,
        outerR.toFixed(1), outerY.toFixed(1),
        innerR.toFixed(1), innerY.toFixed(1),
        outerPx, betweenPx, innerPx, hitPx,
        _dbTipY < Infinity ? Math.round(_dbTipX) : '',
        _dbTipY < Infinity ? Math.round(_dbTipY) : '',
        widthFiltered ? 1 : 0,
    ].join(','))
}

function saveDetLog() {
    if (!settings.enableDetLog || _detBuf.length === 0) return
    const csv = 'frame,videoTimeMs,state,ex,ey,erx,ery,bx,by,outerR,outerY,innerR,innerY,outerPx,betweenPx,innerPx,hitPx,tipX,tipY,widthFiltered\n'
              + _detBuf.join('\n') + '\n'
    const blob = new Blob([csv], { type: 'text/csv' })
    const a    = document.createElement('a')
    a.href     = URL.createObjectURL(blob)
    a.download = 'detlog_' + _logSession + '.csv'
    a.click()
    URL.revokeObjectURL(a.href)
}

function logFlushFinal() { saveLog(); saveDetLog(); saveTrackerLog() }

// ── Public API ────────────────────────────────────────────────────────────────

function resetHitTimer() {
    hitStartTime = null
    totalHitMs   = 0
}

function initStream() {
    _logSession  = (typeof getOrCreateUID === 'function') ? getOrCreateUID() : String(Date.now())
    _logBuf      = []
    // Write ellipse metadata as first comment line
    const e = calibEllipse
    _logBuf.push(`# ellipse: x=${Math.round(e.x)} y=${Math.round(e.y)} rx=${Math.round(e.rx)} ry=${Math.round(e.ry)}`)
    _detBuf      = []
    _prevPixels  = null
    _lastTimeMs  = -1
    _smState     = 'IDLE'
    _outerEntry  = null
    _innerEntry  = null
    _innerLastMs = 0
    hitStartTime = null
    totalHitMs   = 0
    _frameNum    = 0
    _curTimeMs   = 0
    _dbMotion    = []
    _dbOuterPx = _dbBetweenPx = _dbInnerPx = _dbHitPx = 0
    _dbOuterCx = _dbInnerCx = 0
    _dbTipX = 0; _dbTipY = Infinity; _dbTipInHit = false
}

// timeMs — video.currentTime × 1000 (sim) or Date.now() (cam).
// Using video time makes sim runs deterministic for the same video file.
// The dedup guard (timeMs === _lastTimeMs) ensures each unique video frame
// is processed exactly once even when rAF runs faster than the video framerate.
function updateStream(pixels, timeMs) {
    if (!calibDone || !bombPos) return

    // Skip duplicate rAF ticks that see the same video frame.
    // Round to nearest ms: video.currentTime*1000 is a float that can return
    // slightly different values (e.g. 6700.000 vs 6700.001) for the same frame,
    // causing exact === to miss duplicates → frame diffed against itself → zero motion.
    const timeMsInt = Math.round(timeMs)
    if (timeMsInt === _lastTimeMs) return
    _lastTimeMs = timeMsInt

    if (!_prevPixels) {
        _prevPixels = new Uint8ClampedArray(pixels)
        if (settings.enableLogging)
            _logBuf.push(`# seed: videoTimeMs=${timeMs.toFixed(1)}`)
        return
    }

    _frameNum++
    _curTimeMs = timeMs
    const now = timeMs
    const bx  = bombPos.x
    const by  = bombPos.y
    const rx  = calibEllipse.rx
    const ry  = calibEllipse.ry

    // ── Gate / zone geometry ──────────────────────────────────────────────────
    const outerR   = ry * settings.outerRRatio
    const innerR   = ry * settings.innerRRatio
    const hitR     = ry * settings.hitRRatio
    const gBandH   = ry * GATE_BAND_H_RATIO
    const gXHalf   = rx * GATE_X_HALF_RATIO
    const xMin     = Math.max(0,   Math.floor(bx - gXHalf))
    const xMax     = Math.min(W-1, Math.ceil (bx + gXHalf))
    const outerY    = by + outerR
    const outerYMin = outerY - gBandH / 2
    const outerYMax = Math.min(H-1, outerY + gBandH / 2)  // width-filter ceiling

    const innerY    = by + innerR
    const innerYMin = innerY - gBandH / 2
    const innerYMax = Math.min(H-1, innerY + gBandH / 2)

    const scanTop    = 0
    const scanBottom = H - 1

    // ── Corridor filter — precompute once per frame (avoids sqrt in inner loop) ─
    const _useCorr = settings.useCorridorFilter && !!_outerEntry && !!_innerEntry
    let _corrP1x = 0, _corrP1y = 0, _corrUx = 0, _corrUy = 0
    let _corrNx  = 0, _corrNy  = 0, _corrLen = 0, _corrHW  = 0
    if (_useCorr) {
        _corrP1x = bx + _outerEntry.relX;  _corrP1y = by + outerR
        const _cdx = bx - _corrP1x,  _cdy = (by - outerR) - _corrP1y
        _corrLen = Math.sqrt(_cdx*_cdx + _cdy*_cdy)
        if (_corrLen > 1) {
            _corrUx = _cdx / _corrLen;  _corrUy = _cdy / _corrLen
            _corrNx = -_corrUy;         _corrNy = _corrUx
            _corrHW = settings.corridorWidth / 2
        }
    }

    // ── Frame diff → classify motion pixels ──────────────────────────────────
    const threshold = settings.motionThreshold * 3
    const bins = {}
    let outerPx = 0, outerSumX = 0
    let betweenPx = 0
    let innerPx = 0, innerSumX = 0
    let hitPx = 0
    const motionBuf = []
    _dbTipY = Infinity; _dbTipX = 0   // reset per frame — find this frame's minimum Y
    let _waterFilteredPx = 0

    for (let y = scanTop; y <= scanBottom; y++) {
        for (let x = xMin; x <= xMax; x++) {
            const i    = (y * W + x) * 4
            const R1 = _prevPixels[i], G1 = _prevPixels[i+1], B1 = _prevPixels[i+2]
            const R2 = pixels[i],      G2 = pixels[i+1],      B2 = pixels[i+2]

            // A: RGB motion (existing)
            const passA = Math.abs(R2-R1) + Math.abs(G2-G1) + Math.abs(B2-B1) >= threshold

            // B: warmth/chrominance shift — yellow stream on white (bright area only)
            const passB = settings.useChromaDetect &&
                (R2 - B2) - (R1 - B1) > settings.chromaThreshold &&
                (R2 + G2 + B2) > 180

            // C: adaptive brightness — normalised by local brightness
            const Y1    = 0.299*R1 + 0.587*G1 + 0.114*B1
            const Y2    = 0.299*R2 + 0.587*G2 + 0.114*B2
            const passC = settings.useAdaptDetect &&
                Math.abs(Y2 - Y1) * 255 / (Y1 + 48) > settings.adaptThreshold

            if (!passA && !passB && !passC) continue

            // Rim exclusion — always centred on the bowl rim, not the bomb offset
            if (settings.useRimExclusion) {
                const ndx = (x - calibEllipse.x) / rx
                const ndy = (y - calibEllipse.y) / ry
                const nd  = Math.sqrt(ndx*ndx + ndy*ndy)
                if (nd >= RIM_INNER_D && nd <= RIM_OUTER_D) continue
            }

            // Directional corridor filter
            if (_useCorr && _corrLen > 1) {
                const vx = x - _corrP1x, vy = y - _corrP1y
                const perp  = Math.abs(vx * _corrNx + vy * _corrNy)
                const along = vx * _corrUx + vy * _corrUy
                if (perp > _corrHW || along < 0 || along > _corrLen) continue
            }

            // Water zone filter — suppress water shimmer/splash in all states,
            // but let pixels inside the hit zone through for scoring.
            if (isInWaterZone(x, y) && Math.hypot(x - bx, y - by) >= hitR) { _waterFilteredPx++; continue }

            // Bin for width filter — only the stream path (below bomb), not exit zone.
            // Exit-zone pixels (above bomb) can be wide bowl-surface motion and must not
            // trigger the width filter for frames where the stream is in the gate bands.
            // Width filter: only bin the approach corridor (by → outerYMax).
            // Extended scan goes to H-1 but player body below outerYMax must not
            // trigger the filter — only stream-path motion is relevant here.
            if (y > outerYMax) {
                const bk = Math.floor(y / BIN_H) * BIN_H
                if (!bins[bk]) bins[bk] = []
                bins[bk].push(x)
            }

            // Zone classification — x-range limited to each circle's own radius
            if (y >= outerYMin && Math.abs(x - bx) <= outerR) { outerPx++; outerSumX += x }
            if (y > innerYMax  && y < outerYMin  && Math.abs(x - bx) <= outerR) betweenPx++
            if (y >= innerYMin && y <= innerYMax && Math.abs(x - bx) <= innerR) { innerPx++; innerSumX += x }
            if (Math.hypot(x - bx, y - by) < hitR) hitPx++

            if (y < _dbTipY) { _dbTipY = y; _dbTipX = x }
            motionBuf.push(x, y)
        }
    }

    // Water filter console log — throttled to once per second
    if (_waterFilteredPx > 0) {
        const _wNow = Date.now()
        if (!updateStream._wLogAt || _wNow - updateStream._wLogAt >= 1000) {
            updateStream._wLogAt = _wNow
            console.log(`[water filter] frame ${_frameNum}  state=${_smState}  filtered=${_waterFilteredPx}px`)
        }
    }

    // ── Width filter: reject diffuse body/leg motion ──────────────────────────
    let totalBins = 0, wideBins = 0
    for (const bk in bins) {
        const xs = bins[bk]
        if (xs.length < 2) continue
        totalBins++
        if (Math.max(...xs) - Math.min(...xs) > BIN_WIDTH_MAX) wideBins++
    }
    // Bypass width filter when a stream is already in progress: the wide motion
    // is toilet-water splashing (legitimate), not body/leg intrusion.
    // Only reject in IDLE — that's the state we need to guard against false positives.
    const widthFilterFired = totalBins > 0 && wideBins / totalBins > BIN_WIDTH_RATIO
    if (widthFilterFired && _smState === 'IDLE') {
        _dbMotion = []; _dbOuterPx = _dbBetweenPx = _dbInnerPx = _dbHitPx = 0
        _dbTipX = 0; _dbTipY = Infinity
        _logRow(true)
        _detRow(outerR, outerY, innerR, innerY, 0, 0, 0, 0, true)
        _prevPixels.set(pixels)
        return
    }

    // Store for debug / state machine
    _dbMotion    = motionBuf
    _dbOuterPx   = outerPx;   _dbOuterCx = outerPx > 0 ? outerSumX / outerPx : 0
    _dbBetweenPx = betweenPx
    _dbInnerPx   = innerPx;   _dbInnerCx = innerPx > 0 ? innerSumX / innerPx : 0
    _dbHitPx   = hitPx

    // ── Live-track crossing positions every frame gates are firing (all states) ─
    // Decoupled from state transitions: the state machine controls entry lifecycle
    // (create / expire), but position is always refreshed while the gate fires.
    if (_outerEntry && outerPx >= OUTER_MIN_PX) {
        _outerEntry.relX = _outerEntry.relX * 0.6 + (_dbOuterCx - bx) * 0.4
        _outerEntry.t    = now   // keeps expiry clock fresh while stream is visible
    }
    if (_innerEntry && innerPx >= INNER_MIN_PX) {
        _innerEntry.relX = _dbInnerCx - bx
        _innerLastMs     = now
    }

    // ── State machine ─────────────────────────────────────────────────────────
    switch (_smState) {

    case 'IDLE':
        if (outerPx >= OUTER_MIN_PX) {
            _outerEntry = { relX: _dbOuterCx - bx, t: now }
            _smState    = 'OUTER_SEEN'
        }
        break

    case 'OUTER_SEEN':
        // Position already updated in live-track block above.
        // Expire if outer gate went silent too long.
        if (now - _outerEntry.t > TRAVEL_MAX_MS) {
            _outerEntry = null; _smState = 'IDLE'; break
        }
        if (innerPx >= INNER_MIN_PX) {
            const oAbsX = bx + _outerEntry.relX
            const dy    = innerR - outerR   // vertical distance between the two gates
            // When the gates are very close together (|dy| < 15% of ry) the standard
            // extrapolation multiplies any x-mismatch by outerR/|dy| which can be >>1,
            // making the tolerance check unreliable.  Fall back to a direct inner-x check.
            let passes = false
            if (Math.abs(dy) < ry * 0.15) {
                passes = Math.abs(_dbInnerCx - bx) <= settings.dirTolerance
            } else {
                const predictedX = oAbsX + (_dbInnerCx - oAbsX) * (-outerR) / dy
                passes = Math.abs(predictedX - bx) <= settings.dirTolerance
            }
            if (passes) {
                _innerEntry  = { relX: _dbInnerCx - bx }
                _innerLastMs = now
                _smState     = 'INNER_SEEN'
            } else {
                _outerEntry = null
                _smState    = 'IDLE'
            }
        }
        break

    case 'INNER_SEEN':
        // Both positions updated in live-track block above.
        if (now - _innerLastMs > ALIGNED_TIMEOUT) {
            _outerEntry = null; _innerEntry = null; _smState = 'IDLE'; break
        }
        break

    case 'MISS':
        if (now - _innerLastMs > MISS_HOLD_MS) {
            _outerEntry = null; _innerEntry = null; _smState = 'IDLE'
        }
        break
    }

    _logRow(false)
    _detRow(outerR, outerY, innerR, innerY, outerPx, betweenPx, innerPx, hitPx, false)
    _prevPixels.set(pixels)
}

function updateHit() {
    if (!calibDone || !bombPos) return

    const hitR = calibEllipse.ry * settings.hitRRatio
    _dbTipInHit = _dbTipY < Infinity &&
        Math.hypot(_dbTipX - bombPos.x, _dbTipY - bombPos.y) < hitR
    const isHit = _smState === 'INNER_SEEN' && _dbTipInHit

    if (isHit) {
        if (hitStartTime === null) hitStartTime = Date.now()
    } else {
        if (hitStartTime !== null) { totalHitMs += Date.now() - hitStartTime; hitStartTime = null }
    }

    // Check if active bomb's hit goal is reached
    if (typeof advanceBomb === 'function') {
        const b = typeof _bombStates !== 'undefined' ? _bombStates[_bombIdx] : null
        if (b && !b.done) {
            const live = hitStartTime !== null ? Date.now() - hitStartTime : 0
            if (totalHitMs + live >= b.goalMs) advanceBomb()
        }
    }
}

function drawStreamOverlay(ctx) {
    if (!calibDone) return

    // ── Always: hit timer ─────────────────────────────────────────────────────
    const live = hitStartTime !== null ? Date.now() - hitStartTime : 0
    ctx.save()
    ctx.font = 'bold 15px Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.shadowColor = '#000'; ctx.shadowBlur = 6; ctx.fillStyle = '#fff'
    ctx.fillText('Hit: ' + ((totalHitMs + live) / 1000).toFixed(1) + 's', 8, 8)
    ctx.shadowBlur = 0; ctx.restore()

    // ── Motion pixels (green 2×2, after rim excl + width filter) ─────────────
    if (settings.showStreamPoints && _dbMotion.length > 0) {
        ctx.save(); ctx.fillStyle = 'rgba(0,255,80,0.75)'
        for (let i = 0; i < _dbMotion.length; i += 2)
            ctx.fillRect(_dbMotion[i], _dbMotion[i+1], 2, 2)
        ctx.restore()
    }

    // ── Stream tip dot (only while tracking a stream) ────────────────────────
    if (_smState === 'OUTER_SEEN' || _smState === 'INNER_SEEN') {
        ctx.save()
        ctx.shadowColor = '#000'; ctx.shadowBlur = 4
        if (_dbTipY < Infinity) {
            // Known tip: green = scoring, red = INNER_SEEN overshoot, white = other states
            ctx.fillStyle = _dbTipInHit              ? 'rgba(50,255,100,1)'
                          : _smState === 'INNER_SEEN' ? 'rgba(255,80,80,1)'
                          :                             'rgba(255,255,255,0.8)'
            ctx.beginPath(); ctx.arc(_dbTipX, _dbTipY, 5, 0, Math.PI * 2); ctx.fill()
        }
        ctx.restore()
    }

    // Rim exclusion band — independent of debug overlay
    if (settings.showRimExclusion) {
        const ex = calibEllipse.x, ey = calibEllipse.y
        const _rx = calibEllipse.rx, _ry = calibEllipse.ry
        ctx.save()
        ctx.strokeStyle = 'rgba(255,180,0,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.ellipse(ex, ey, _rx * RIM_INNER_D, _ry * RIM_INNER_D, 0, 0, Math.PI * 2); ctx.stroke()
        ctx.beginPath(); ctx.ellipse(ex, ey, _rx * RIM_OUTER_D, _ry * RIM_OUTER_D, 0, 0, Math.PI * 2); ctx.stroke()
        ctx.setLineDash([])
        ctx.restore()
    }

    if (!settings.showDebugStream) return

    const bx     = bombPos.x
    const by     = bombPos.y
    const rx     = calibEllipse.rx
    const ry     = calibEllipse.ry
    const outerR = ry * settings.outerRRatio
    const innerR = ry * settings.innerRRatio
    const hitR   = ry * settings.hitRRatio
    const gBandH = ry * GATE_BAND_H_RATIO
    const gXHalf = rx * GATE_X_HALF_RATIO
    const outerY = by + outerR
    const innerY = by + innerR
    ctx.save()

    // Outer circle — dashed cyan
    ctx.beginPath(); ctx.arc(bx, by, outerR, 0, Math.PI * 2)
    ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(0,210,255,0.45)'; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.setLineDash([])

    // Inner circle — dashed yellow
    ctx.beginPath(); ctx.arc(bx, by, innerR, 0, Math.PI * 2)
    ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,220,0,0.45)'; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.setLineDash([])

    // Hit zone ring — green when hitting, dashed white otherwise
    const isHitting = hitStartTime !== null
    ctx.beginPath(); ctx.arc(bx, by, hitR, 0, Math.PI * 2)
    ctx.strokeStyle = isHitting ? 'rgba(0,255,80,0.9)' : 'rgba(255,255,255,0.35)'
    ctx.lineWidth   = isHitting ? 2.5 : 1.5
    if (!isHitting) ctx.setLineDash([4, 4])
    ctx.stroke(); ctx.setLineDash([])


    // Corridor rectangle — drawn when filter is active and both entries are known
    if (settings.useCorridorFilter && _outerEntry && _innerEntry) {
        const p1x = bx + _outerEntry.relX, p1y = by + outerR
        const ddx = bx - p1x, ddy = (by - outerR) - p1y
        const cLen = Math.sqrt(ddx*ddx + ddy*ddy)
        if (cLen > 1) {
            const angle = Math.atan2(ddy, ddx)
            const hw = settings.corridorWidth / 2
            ctx.save()
            ctx.translate(p1x, p1y)
            ctx.rotate(angle)
            ctx.strokeStyle = 'rgba(100,220,255,0.55)'; ctx.lineWidth = 1.5
            ctx.setLineDash([5, 3])
            ctx.strokeRect(0, -hw, cLen, settings.corridorWidth)
            ctx.setLineDash([])
            ctx.restore()
        }
    }

    // Gate band fills (faint)
    ctx.fillStyle = 'rgba(0,210,255,0.07)'
    ctx.fillRect(bx - gXHalf, outerY - gBandH/2, gXHalf*2, gBandH)
    ctx.fillStyle = 'rgba(255,220,0,0.07)'
    ctx.fillRect(bx - gXHalf, innerY - gBandH/2, gXHalf*2, gBandH)

    // Gate centre lines — bright when active
    ctx.lineWidth = 1.5
    ctx.strokeStyle = _dbOuterPx >= OUTER_MIN_PX ? 'rgba(0,210,255,0.9)' : 'rgba(0,210,255,0.3)'
    ctx.beginPath(); ctx.moveTo(bx - gXHalf, outerY); ctx.lineTo(bx + gXHalf, outerY); ctx.stroke()

    ctx.strokeStyle = _dbInnerPx >= INNER_MIN_PX ? 'rgba(255,220,0,0.9)' : 'rgba(255,220,0,0.3)'
    ctx.beginPath(); ctx.moveTo(bx - gXHalf, innerY); ctx.lineTo(bx + gXHalf, innerY); ctx.stroke()

    ctx.restore()

    // Outer entry dot (cyan) — OUTER_SEEN or INNER_SEEN
    if (_outerEntry && (_smState === 'OUTER_SEEN' || _smState === 'INNER_SEEN')) {
        const oAbsX = bx + _outerEntry.relX
        const oAbsY = by + outerR
        ctx.save()
        ctx.beginPath(); ctx.arc(oAbsX, oAbsY, 6, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0,210,255,0.85)'; ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
        ctx.restore()
    }

    // Inner entry dot (yellow) — INNER_SEEN only
    if (_innerEntry && _smState === 'INNER_SEEN') {
        const iAbsX = bx + _innerEntry.relX
        const iAbsY = by + innerR
        ctx.save()
        ctx.beginPath(); ctx.arc(iAbsX, iAbsY, 6, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,220,0,0.85)'; ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
        ctx.restore()
    }

    // Trajectory line — outer → inner → projected to bomb Y
    if (_outerEntry && _innerEntry && _smState === 'INNER_SEEN') {
        const oAbsX = bx + _outerEntry.relX
        const oAbsY = by + outerR
        const iAbsX = bx + _innerEntry.relX
        const iAbsY = by + innerR
        const dy    = iAbsY - oAbsY   // = innerR - outerR
        const dx    = iAbsX - oAbsX
        const projX = dy !== 0 ? oAbsX + dx * (by - oAbsY) / dy : iAbsX
        ctx.save()
        ctx.strokeStyle = 'rgba(0,255,100,0.8)'; ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(oAbsX, oAbsY)
        ctx.lineTo(iAbsX, iAbsY)
        ctx.lineTo(projX, by)
        ctx.stroke()
        ctx.restore()
    }

    // State label — top-right, below countdown number
    const stateColor = { INNER_SEEN: '#00ff80', OUTER_SEEN: '#ffaa00', MISS: '#ff4444', IDLE: '#666666' }
    ctx.save()
    ctx.font = 'bold 12px Arial'; ctx.textAlign = 'right'; ctx.textBaseline = 'top'
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4
    ctx.fillStyle = stateColor[_smState] || '#888'
    ctx.fillText(_smState, W - 12, 62)
    ctx.shadowBlur = 0; ctx.restore()
}
