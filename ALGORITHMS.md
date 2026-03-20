# ipee v2 — Algorithm & Architecture Reference

---

## Project Purpose

**ipee** is a real-time augmented-reality game played in a mobile browser.
The player holds their phone above a toilet, points the rear camera downward,
and physically aims their urine stream at a 💣 bomb target displayed on the
live camera feed. The app detects where the stream ends (its tip) in real time
and scores hit time while the tip is inside the bomb's hit circle.

No native app. No server processing. No wearables. Everything runs in the browser
at 30 fps using `requestAnimationFrame` + `getImageData` on the phone's main thread.

### Why it's hard

- **Stream is nearly invisible** — thin (3–10 px wide), semi-transparent, same color
  as water and white porcelain.
- **Signal is motion, not color** — only reliable signal is pixel change between frames.
- **Phone moves constantly** — camera shake creates widespread false motion; the bowl
  must be actively tracked so shake can be separated from real stream motion.
- **Splash and body noise** — when the stream hits water it explodes into a wide area;
  body motion near the player creates large false-positive regions. Multiple filter
  layers suppress this.

---

## File Map

| File | Role |
|------|------|
| `shared2.js` | Canvas setup, video crop, calibration ellipse, bomb overlay, settings panel, GO flash |
| `tracker2.js` | 8-candidate NCC patch tracking, 5-second countdown selection, weighted-drift centroid |
| `stream2.js` | Frame diff motion detection, gate-based trajectory validation, hit scoring, log |
| `sim2.html` | Simulation UI — load video file, play/pause/restart |
| `cam2.html` | Live camera UI — fullscreen canvas, auto camera selection |
| `server.js` | Static HTTPS server (Let's Encrypt certs or plain HTTP fallback) |

---

## Canvas

Fixed **360 × 640 px** (9:16 portrait). All detection runs on this resolution.

### Video crop (`drawVideoFrame` — `shared2.js`)

The phone camera delivers either landscape (1920×1080) or portrait (1080×1920) frames.

**Landscape source** — center-crop the portrait 9:16 slice:
```
srcW = frameHeight × (360/640)
srcX = (frameWidth − srcW) / 2
drawImage(video, srcX, 0, srcW, frameHeight, 0, 0, 360, 640)
```

**Portrait source** — zoom-crop from center (`ZOOM = 1.1`):
```
srcW = frameWidth  / ZOOM
srcH = frameHeight / ZOOM
srcX = (frameWidth  − srcW) / 2
srcY = (frameHeight − srcH) / 2
drawImage(video, srcX, srcY, srcW, srcH, 0, 0, 360, 640)
```

---

## Calibration Ellipse (`shared2.js`)

At startup the user sees a draggable ellipse overlay and places it on the toilet bowl border.
Default position: `x=144, y=414, rx=128, ry=131`.

**Interaction:**
- 1-finger drag → move centre
- 2-finger pinch → resize rx (horizontal spread) and ry (vertical spread) independently

On **OK press**, calibration is locked (`calibDone = true`). The ellipse centre and radii
are then used as the geometric reference for all downstream algorithms.

---

## Bowl Tracker — NCC Patch Tracking (`tracker2.js`)

### Purpose

The camera is hand-held and wobbles constantly. Without compensation, every frame would
show the bowl at a slightly different pixel position, making stable gate detection
impossible. The tracker locks onto the physical toilet bowl by matching texture patches
frame-to-frame and computing how much the bowl has shifted (drift).

### Candidate placement (8 trackers)

On OK press, 8 candidate trackers are placed around the calibration ellipse:

| Group | Labels | Position |
|-------|--------|----------|
| Outer | O0–O3 | On the ellipse border: O0=top, O1=bottom-right (45°), O2=left, O3=right |
| Inner | I0–I3 | At `innerDist = 0.6 × min(rx, ry)` from centre: I0=top, I1=bottom-right (45°), I2=left, I3=right |

The 45° diagonal placement for O1/I1 avoids the bowl water surface (bottom-centre) which
has noisy, unreliable texture.

### Reference patch capture

For each candidate, a **grayscale 36×36 px patch** (half-size `BOWL_PATCH_HALF=18`) is
captured from the current canvas frame and stored as the reference. The patch is normalised
(subtract mean, divide by std) to make it invariant to absolute brightness.

### Per-frame NCC tracking

Every frame, each active tracker searches for the best match to its reference patch using
**Normalized Cross-Correlation (NCC)**:

```
NCC(cx, cy) = Σ[ normRef[i] × (candidate[i] − mean) ]
              ─────────────────────────────────────────
                         N × std_candidate
```

Result ∈ [−1, 1]. Value 1 = identical texture.

**Adaptive search radius** — starts small, expands only when match quality is low:

| Stage | Radius | Step | Trigger |
|-------|--------|------|---------|
| 1 | ±30 px | 2 px | always |
| 2 | ±70 px | 3 px | NCC < 0.6 |
| 3 | ±120 px | 4 px | NCC < 0.4 |

**Quality gate:** if best NCC < `BOWL_NCC_MIN` (0.30) → hold last known position.

### 5-second countdown selection

All 8 trackers run during the countdown and accumulate average NCC quality scores.
At 5 s: the **top 3 outer + top 2 inner = 5 active trackers** are selected
(`OUTER_COUNT=3`, `INNER_COUNT=2`). This selection naturally picks the trackers on the
most stable, textured bowl surfaces.

### Weighted-drift centroid (`getEstimatedCenter`)

The active 5 trackers vote on how much the bowl has moved since calibration:

```
drift_i   = current_position_i − start_position_i
weight_i  = quality_i (NCC score)
estCenter = refCenter + Σ(weight_i × drift_i) / Σ(weight_i)
```

Low-quality trackers are automatically down-weighted. Result: a smooth, stable estimate
of the bowl centre's current pixel position even under significant camera shake.

### Tracker dot colours (debug)

Fill colour indicates NCC quality; stroke colour indicates group:
- Fill **cyan** — NCC ≥ 0.60 (good lock)
- Fill **orange** — NCC ≥ 0.30 (marginal)
- Fill **red** — holding last position (quality too low)
- Stroke **yellow** — outer group tracker
- Stroke **magenta** — inner group tracker

---

## Bomb Overlay (`shared2.js`)

### Purpose

The 💣 emoji is the player's target. It is "glued" to a point on the physical toilet bowl,
so it moves with the bowl when the camera shakes — it must not drift off the bowl surface.

### Initialisation (`initBomb`)

At OK press, the bomb's initial position is set to:
```
_bombInitial = { x: calibEllipse.x + bombDeltaX,
                 y: calibEllipse.y + bombDeltaY }
```
where `bombDeltaX/Y` are user-configured offsets (settings sliders) **captured once at
OK press** into `_bombDeltaX/Y`. Live slider changes after OK have no effect until recalibration.

### Per-frame update (`updateBomb`)

1. Get the weighted-drift centroid from the tracker (`getEstimatedCenter()`).
2. Compute raw bomb position = `ellipseCentre + fixed delta`:
   ```
   rawX = est.x + _bombDeltaX
   rawY = est.y + _bombDeltaY
   ```
3. Apply **adaptive EMA smoothing** to suppress jitter while staying responsive to real movement:
   ```
   speed = √(ddx² + ddy²)
   alpha = clamp(ALPHA_MIN + speed/SPEED_SCALE × (ALPHA_MAX − ALPHA_MIN),
                 ALPHA_MIN, ALPHA_MAX)
   bombPos += alpha × (raw − bombPos)
   ```
   Constants: `ALPHA_MIN=0.04`, `ALPHA_MAX=0.40`, `SPEED_SCALE=25px`.

4. Update `calibEllipse.x/y` to track the **bowl centre** (bomb minus the delta), so the
   ellipse visual and rim exclusion always align with the bowl regardless of bomb offset:
   ```
   calibEllipse.x = bombPos.x − _bombDeltaX
   calibEllipse.y = bombPos.y − _bombDeltaY
   ```

---

## Stream Detection (`stream2.js`)

### Overview

The detection pipeline runs every unique video frame:
1. Frame-difference → classify motion pixels through three detectors
2. Rim exclusion → discard rim-noise pixels
3. Corridor filter → discard off-trajectory pixels (when enabled)
4. Width filter → reject diffuse body/leg motion (IDLE state only)
5. Track stream tip (leading edge)
6. Live-update gate crossing positions
7. State machine → advance stream state
8. Hit scoring → accumulate hit time if tip is in hit circle

### Dedup guard

```js
const timeMsInt = Math.round(timeMs)
if (timeMsInt === _lastTimeMs) return
_lastTimeMs = timeMsInt
```
`rAF` fires at 60 fps but video is typically 30 fps. `video.currentTime * 1000` is a
float that can return slightly different values for the same video frame; rounding to the
nearest ms makes the guard robust. Without it, the same pixels would be diffed against
themselves → zero motion every other frame → alternating full/empty detection.

---

### Algorithm 1 — Gate / Zone Geometry

All detection zones are **circles centred on `bombPos`**, scaled by `calibEllipse.ry`:

| Zone | Y position | X limit | Role |
|------|-----------|---------|------|
| Outer gate | `by + ry × outerRRatio` ± `ry × 0.2` band | ±`outerR` | Stream arriving |
| Between zone | between inner top and outer bottom | ±`outerR` | Stream in corridor |
| Inner gate | `by + ry × innerRRatio` ± `ry × 0.2` band | ±`innerR` | Stream close to bomb |
| Hit zone | `hypot(x−bx, y−by) < hitR` | — | Stream at bomb |
| Exit zone | `y < by − ry × EXIT_ABOVE_RATIO` | — | Stream past bomb (overshoot) |

Default ratios: `outerRRatio=0.5`, `innerRRatio=0.3`, `hitRRatio=0.1`, `EXIT_ABOVE_RATIO=0.5`.
Gate band height = `ry × GATE_BAND_H_RATIO` (0.4), gate X half-width = `rx × GATE_X_HALF_RATIO` (1.2).

The **scan window** runs from `exitTopY` to `H−1` (the full canvas bottom). Extending the
scan to the bottom allows detecting streams that enter from far below the bowl when the
ellipse is placed high in the frame.

---

### Algorithm 2 — Three-Detector Motion Classification

For each pixel in the scan window, it must pass at least one of three detectors:

**Detector A — RGB sum diff (always active):**
```
|R₂−R₁| + |G₂−G₁| + |B₂−B₁| ≥ motionThreshold × 3
```
Catches any significant colour change between frames.

**Detector B — Chrominance warmth shift (optional):**
```
(R₂−B₂) − (R₁−B₁) > chromaThreshold   AND   R₂+G₂+B₂ > 180
```
Detects the yellow/warm tint of urine appearing on a bright (white porcelain) background.
Catches streams that are too thin to trip detector A alone.

**Detector C — Adaptive brightness (optional):**
```
|Y₂−Y₁| × 255 / (Y₁ + 48) > adaptThreshold
```
Normalises brightness change by local luminance. Catches streams under backlit or
high-contrast conditions where absolute diff is small relative to the background.

---

### Algorithm 3 — Rim Exclusion

The toilet bowl's ceramic rim is bright, high-contrast, and very close to the detection zone.
Any camera shake causes it to jitter and produce thousands of false motion pixels right where
the stream needs to be detected.

Rim exclusion discards pixels whose **normalised ellipse distance** from the **bowl centre**
(`calibEllipse.x/y`) falls in the exclusion band:

```
ndx = (x − calibEllipse.x) / rx
ndy = (y − calibEllipse.y) / ry
nd  = √(ndx² + ndy²)
if nd ∈ [RIM_INNER_D, RIM_OUTER_D] → discard
```

Default: `RIM_INNER_D=0.9`, `RIM_OUTER_D=2.5` — excludes a band from just inside the
ellipse out to 2.5× its size.

**Important:** rim exclusion uses the **bowl centre** (`calibEllipse.x/y`), NOT `bombPos`.
When the bomb is offset from the ellipse centre, the exclusion band must stay aligned with
the physical rim, not the bomb. This is the only algorithm that uses the ellipse centre
rather than the bomb position.

---

### Algorithm 4 — Directional Corridor Filter (optional)

Once both gate crossings are known (`_outerEntry` + `_innerEntry`, i.e. in `INNER_SEEN`
state), the stream's trajectory is established. A rectangular corridor aligned with that
trajectory rejects off-axis motion (body, splash, bowl noise) that enters the gate bands
at the wrong X position.

**Corridor geometry:**
- **P1** = outer entry point: `(bx + _outerEntry.relX, by + outerR)`
- **P2** = top of outer circle: `(bx, by − outerR)`
- **u** = direction unit vector = (P2 − P1) / |P2 − P1|
- **n** = perpendicular unit vector = (−u.y, u.x)

A pixel at (x, y) is **inside the corridor** if:
```
|v · n| ≤ corridorWidth / 2        (perpendicular distance)
0 ≤ v · u ≤ len                    (falls between P1 and P2)
```
where v = (x − P1.x, y − P1.y).

The corridor geometry is precomputed once per frame (before the pixel loop) to avoid
`sqrt` calls inside the inner loop.

In the debug overlay, the corridor is drawn as a dashed cyan rotated rectangle.

---

### Algorithm 5 — Width Filter (Body Motion Rejection)

A stream is narrow (~3–15 px wide). A person's leg, arm, or torso moving in frame covers
tens or hundreds of pixels of width. The width filter distinguishes them:

1. Bin motion pixels in the **approach corridor below the outer gate** (`y > outerYMax`)
   into 6px-tall horizontal strips. The bowl interior above the outer gate is excluded
   from binning — toilet water ripples there create spuriously wide bins.
2. For each bin with ≥ 2 pixels: check if `max(x) − min(x) > BIN_WIDTH_MAX` (20px).
3. If more than `BIN_WIDTH_RATIO` (50%) of bins are wide → **reject the entire frame**.

**IDLE-only:** the width filter only fires when the state machine is in `IDLE`. In
`OUTER_SEEN` / `INNER_SEEN` / `MISS`, a stream has already been detected and wide motion
is legitimate splash/ripple — blocking it would starve `_innerLastMs` and expire the state.

On rejection, all `_db*` counts are zeroed, the motion buffer is cleared, and a
`widthFiltered=1` flag is written to the log.

---

### Algorithm 6 — Stream Tip Detection

The **tip** is the leading edge of the stream — the topmost point (minimum Y) reached by
the stream this frame. `_dbTipY` is reset to `Infinity` at the start of every processed
frame. It is updated only for pixels in the non-exit zone:

```js
if (y >= exitTopY && y < _dbTipY) { _dbTipY = y; _dbTipX = x }
```

As the stream advances toward the bomb:
- Tip at outer gate Y → stream arriving
- Tip at inner gate Y → stream close to bomb
- Tip inside hit circle → scoring

**Tip dot** is drawn only when the state machine is `OUTER_SEEN` or `INNER_SEEN`:
- **Green** — tip inside hit circle (scoring)
- **Red** — INNER_SEEN but tip outside hit circle (overshot or not yet in zone)
- **White** — OUTER_SEEN or other non-scoring state
- **Purple** — stream active but no tip found this frame (parked on exit line)

---

### Algorithm 7 — State Machine

The state machine enforces that stream detections follow a physically plausible trajectory:
outer gate → inner gate → hit zone. Random noise cannot skip directly to a hit.

```
IDLE → OUTER_SEEN → INNER_SEEN → MISS → IDLE
              ↘ (timeout/fail)  ↘ (timeout)
               → IDLE            → IDLE
```

**IDLE → OUTER_SEEN:** outer gate fires `≥ OUTER_MIN_PX` (3) pixels → create `_outerEntry`.

**OUTER_SEEN → INNER_SEEN:** inner gate fires `≥ INNER_MIN_PX` (3) pixels AND trajectory
check passes → create `_innerEntry`.

**Trajectory check:** extrapolate a line from the outer centroid through the inner centroid
projected to `bombPos.y`. If the projected X is within `±dirTolerance` (25px) of `bombPos.x`,
the stream is aimed at the bomb — transition allowed.
*Fallback:* when `|innerR − outerR| < ry × 0.15` (gates nearly coincident, amplification
unstable), use the inner centroid X directly instead of extrapolating.

**OUTER_SEEN expire:** outer gate silent for `TRAVEL_MAX_MS` (700ms) → null entries, IDLE.

**INNER_SEEN timeout:** inner gate silent for `ALIGNED_TIMEOUT` (300ms) → null entries, IDLE.

**INNER_SEEN exit:** exit zone fires `≥ EXIT_MIN_PX` (4) pixels after `exitGraceMs` (150ms)
grace period → MISS. Grace period prevents splash from immediately triggering MISS.

**MISS expire:** after `MISS_HOLD_MS` (200ms) → null entries, IDLE.

**Live gate position tracking (independent of state):**
Even while holding the current state, gate entry positions are refreshed every frame
the gate fires. The trajectory line always reflects where the stream currently is, not
where it was when the state was entered.

---

### Algorithm 8 — Hit Scoring (`updateHit`)

```
isHit = (state == INNER_SEEN) AND (tip is inside hit circle)
```

The **tip** must be physically inside the hit circle — not just any pixel from the stream
body. This prevents scoring when the stream overshoots the bomb: the stream body may still
pass through the hit circle, but the tip (leading edge) has already gone past.

While `isHit` is true:
- `hitStartTime = Date.now()` (first hit frame)
- `totalHitMs += Date.now() − hitStartTime` accumulates continuously

When `isHit` becomes false:
- Finalise the current hit interval into `totalHitMs`

Displayed as `Hit: X.Xs` in the top-left corner.

---

## Settings Panel (`shared2.js`)

All parameters are live-tunable from the in-app settings panel without reloading.
Exception: `bombDeltaX/Y` — only the values present at OK press are used.

| Setting | Default | Effect |
|---------|---------|--------|
| Outer Circle (×ry) | 0.5 | Outer gate radius |
| Inner Circle (×ry) | 0.3 | Inner gate radius |
| Aim Tolerance (px) | 25 | Max deviation for trajectory check |
| Hit Zone (×ry) | 0.1 | Scoring circle radius around bomb |
| Exit Grace (ms) | 150 | Delay before exit zone triggers MISS |
| Bomb Offset X/Y (px) | 0 | Offset of bomb from ellipse centre (captured at OK press) |
| Enable Corridor Filter | on | Reject pixels outside the outer→inner trajectory corridor |
| Corridor Width (px) | 30 | Full width of the directional corridor |
| Enable Rim Exclusion | on | Discard pixels in the normalised rim band |
| Show Rim Band | on | Draw orange dashed ellipses at RIM_INNER_D / RIM_OUTER_D |
| Motion Threshold | 40 | Min per-channel pixel diff to count as motion (Detector A) |
| Frame Skip | 1 | Process every Nth frame |
| Yellow Detector | on | Chrominance warmth shift detector (Detector B) |
| Yellow Threshold | 12 | Min chroma shift to trigger Detector B |
| Adaptive Brightness | on | Normalised brightness detector (Detector C) |
| Adaptive Threshold | 18 | Min normalised brightness diff for Detector C |
| Tracking Ellipse + Dots | on | Draw NCC tracker dots and ellipse outline |
| Motion Points (green) | on | Draw 2×2 dots at each surviving motion pixel |
| Stream Debug Overlay | on | Draw gate circles, trajectory line, entry dots |
| Rim Band (debug) | on | Draw rim exclusion ellipses |
| Enable Frame Logging | off | Write per-frame CSV (main log) |
| Enable Detector Log | off | Write per-frame CSV with geometry + tip columns |

---

## Two Modes

### Simulation (`sim2.html`)

Used for algorithm development and parameter tuning. Load any recorded video, play/pause/
restart freely. The full debug overlay (green motion pixels, gate circles, trajectory line,
rim exclusion ellipses, tip dot) makes every algorithm step visible.

Flow:
1. Load video → press Play
2. Video runs 0.2 s → auto-pauses (captures a real frame for calibration)
3. User places ellipse on bowl border → presses OK
4. `initCandidateTrackers` + 5-second countdown → tracker selection → `showGo()`
5. Video resumes → full detection loop runs

### Live Camera (`cam2.html`)

Used for actual gameplay on a phone.

Flow:
1. Page loads → `startCamera()` probes all devices, picks the lowest-numbered "back" camera
   (main 1× lens, avoids ultrawide) at 1920×1080
2. Camera streams to hidden `<video>` element
3. On play: rAF loop starts with calibration overlay visible
4. User places ellipse → presses OK → same tracker + detection flow as simulation

---

## Log Formats

### Main log (`enableLogging`)

Written at video end. Columns:
```
frame, videoTimeMs, state,
outerPx, betweenPx, innerPx, hitPx, exitPx,
widthFiltered,
outerDotX, outerDotY, innerDotX, innerDotY
```

**Metadata comment lines** (before data rows):
```
# ellipse: x=144 y=414 rx=128 ry=131
# seed: videoTimeMs=4988.0
```

`outerDotX/Y` and `innerDotX/Y` are the absolute canvas positions of the outer/inner
gate crossing dots — empty when the respective entry doesn't exist.

### Detector log (`enableDetLog`)

Always-on geometry log for debugging. Includes per-frame ellipse and bomb positions,
gate geometry, pixel counts, and stream tip coordinates. Columns:
```
frame, videoTimeMs, state,
ex, ey, erx, ery,          ← calibEllipse (bowl rim centre + radii)
bx, by,                    ← bombPos
outerR, outerY,            ← outer gate radius and Y position
innerR, innerY,            ← inner gate radius and Y position
outerPx, betweenPx, innerPx, hitPx, exitPx,
tipX, tipY,                ← stream tip pixel (empty if no tip this frame)
widthFiltered              ← 1 = frame rejected by width filter
```
