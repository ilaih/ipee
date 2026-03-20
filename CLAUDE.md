# CLAUDE.md — ipee v2 codebase

## Files

| File | Role |
|------|------|
| `shared2.js` | Canvas constants (`W`, `H`, `ZOOM`) and `drawVideoFrame` — loaded first by all pages |
| `settings2.js` | `settings` object, settings panel UI, `openSettings` / `closeSettings` |
| `calib2.js` | Calibration ellipse state (`calibEllipse`, `calibDone`), `drawCalibOverlay`, `initCalibDrag` |
| `levels2.js` | `LEVELS`, bomb/level state, `initBomb`, `updateBomb`, `drawBomb`, `advanceBomb`, `recalib`, `showLevelIntro`, `showLevelSuccess` |
| `tracker2.js` | 8-candidate NCC tracking with 5s countdown selection; weighted-drift centroid position estimation |
| `stream2.js` | Stream tip detection and hit scoring — frame diff, entrance gate, corridor search, hit timer |
| `water2.js` | Toilet water surface detector — suppresses shimmer/splash in the bowl area |
| `sim2.html` | Simulation UI — load video file, play/pause/restart, Settings button in controls bar |
| `cam2.html` | Live camera UI — fullscreen canvas, auto camera selection, ⚙ settings gear top-right |
| `server2.js` | Express-like static server on port 3001 — serves `cam2.html` at `/`, uses Let's Encrypt certs if present, falls back to `certs/key.pem` / `certs/cert.pem`, then plain HTTP |

---

## Canvas

Fixed 360 × 640 px (9:16 portrait). `shared2.js` constants: `W = 360`, `H = 640`.

**`ZOOM`** constant (`shared2.js`, default `1.1`) — zoom multiplier applied to portrait sources. `1.0` = no zoom.

**`drawVideoFrame(video, ctx)`** — called every rAF tick. Behaviour differs by source orientation:

- **Landscape** (e.g. 1920×1080): center-crops the 9:16 portrait slice, no zoom applied:
```
srcW = frameHeight × (360/640)
srcX = (frameWidth − srcW) / 2
drawImage(video, srcX, 0, srcW, frameHeight, 0, 0, 360, 640)
```

- **Portrait** (e.g. phone delivering 1080×1920): crops from centre with `ZOOM` applied:
```
srcW = frameWidth  / ZOOM
srcH = frameHeight / ZOOM
srcX = (frameWidth  − srcW) / 2
srcY = (frameHeight − srcH) / 2
drawImage(video, srcX, srcY, srcW, srcH, 0, 0, 360, 640)
```

---

## Two modes

| Mode | File | Default route |
|------|------|---------------|
| Simulation | `sim2.html` | — |
| Live camera | `cam2.html` | `/` on port 3001 |

### Simulation flow (`sim2.html`)
1. User loads a video file
2. On first Play: video runs **0.2 s** → auto-pauses (gets a real frame on canvas)
3. User drags the red dot onto the water → presses **OK**
4. `onCalibOK`: captures canvas frame, calls `initCandidateTrackers` + `initBomb`, 5s countdown starts, `showGo()` fires automatically after selection
5. rAF loop runs continuously — keeps canvas live even while paused (for dot dragging)

### Camera flow (`cam2.html`)
1. Page loads → `startCamera()` runs automatically
2. Camera probes all devices, picks the lowest-numbered "back" camera (main 1× rear lens, not ultrawide), requests 1920×1080
3. On video play: rAF loop starts; calibration dot + instruction text are shown
4. User drags the red dot onto the water → presses **OK**
5. `onCalibOK`: captures live canvas frame, calls `initCandidateTrackers` + `initBomb`, 5s countdown starts

---

## Calibration ellipse (`shared2.js`)

`calibEllipse = { x: W*0.5, y: H*0.40, rx: 80, ry: 55 }` — draggable + resizable ellipse, shown until `calibDone = true`. Position and size are **preserved across resets** so the user doesn't need to re-place it each restart.

`redDot` is a legacy alias pointing to the same object.

**`drawCalibOverlay(ctx)`** — draws semi-transparent banner ("Place the ellipse on the toilet bowl border"), the filled ellipse, a centre dot, and four yellow cardinal handles as resize cues.

**`initCalibDrag(canvas)`** — interaction model:

| Input | Zone | Action |
|-------|------|--------|
| Mouse down | Interior (d² < 0.64) | Drag centre |
| Mouse down | Border zone (0.64 ≤ d² < 1.44) | Resize rx (if horizontal) or ry (if vertical) |
| Touch 1 finger | anywhere | Drag centre |
| Touch 2 fingers | anywhere | Pinch: horizontal spread → rx, vertical spread → ry; midpoint → translate |

All coordinates are scaled from CSS pixels → canvas pixels via `getBoundingClientRect()`. Drag/resize is disabled once `calibDone` is true.

---

## NCC Patch Trackers (`tracker2.js`)

**8 candidates** placed on OK press; best 4 selected after a 5-second countdown.

| Group | Labels | Positions |
|-------|--------|-----------|
| Outer | O0–O3 | Top/bottom/left/right of calibEllipse border |
| Inner | I0–I3 | 75px (INNER_DIST) from ellipse centre in 4 directions |

During countdown all 8 run NCC tracking and accumulate average quality.
At 5s: top 2 from each group selected → 4 active trackers (≥1 outer, ≥1 inner).

**Position estimation — weighted-drift centroid:**
```
estCenter = refCenter + Σ(q_i × (curr_i − start_i)) / Σ(q_i)
```
All 4 active trackers vote; low-quality trackers auto-downweight. No jumps on tracker switch.

**Adaptive NCC search per tracker:**

| Stage | Radius | Step | Trigger |
|-------|--------|------|---------|
| 1 | ±30 px | 2 px | always |
| 2 | ±70 px | 3 px | NCC < 0.6 |
| 3 | ±120 px | 4 px | NCC < 0.4 |

Quality gate: if best NCC < `BOWL_NCC_MIN` (0.30) → hold last known position.

**`drawTrackerDots(ctx)`** — during countdown: all 8 + countdown number; after selection: active 4.
Colour: cyan ≥ 0.60 (good), orange ≥ 0.30 (marginal), red (holding).

**Public API:** `initCandidateTrackers(data)`, `updateTrackers(data)`, `drawTrackerDots(ctx)`,
`getEstimatedCenter()`, `isCountdownActive()`, `resetTrackers()`.

---

## Bomb overlay (`shared2.js`)

A 💣 emoji placed at the **`calibEllipse` centre** — the target the player aims at.
Appears glued to the scene — compensates for camera shake using tracker drift.

**`initBomb()`** — sets `_bombInitial = { x: calibEllipse.x, y: calibEllipse.y }` + `bombPos`, calls `initStream()`. tracker2.js countdown fires `showGo()` when selection completes.

**`updateBomb()`** — called every frame:
1. Calls `getEstimatedCenter()` from tracker2.js — returns weighted-drift centroid
2. `rawPos = estCenter` (bomb IS at ellipse centre)
3. Adaptive EMA smoothing:

```
ddx = rawX − bombPos.x
ddy = rawY − bombPos.y
speed = √(ddx² + ddy²)
alpha = clamp(ALPHA_MIN + speed/SPEED_SCALE × (ALPHA_MAX − ALPHA_MIN), ALPHA_MIN, ALPHA_MAX)
bombPos += alpha × (raw − bombPos)
```

Constants: `SPEED_SCALE = 25 px`, `ALPHA_MIN = 0.04`, `ALPHA_MAX = 0.40`.
Result: near-zero response to sub-pixel jitter; ramps smoothly for real camera movement.

---

## Stream detection (`stream2.js`)

Two-gate trajectory validation: stream must cross the outer circle, then the inner circle, with
a trajectory aimed at the bomb → INNER_SEEN state. Hit scores while INNER_SEEN and pixels land
in the hit zone.

### Gate geometry (all centred on `bombPos`)

| Gate | Y position | X limit | Purpose |
|------|-----------|---------|---------|
| Outer (blue) | `by + ry × outerRRatio` | `±outerR` | First crossing — stream arriving |
| Inner (yellow) | `by + ry × innerRRatio` | `±innerR` | Second crossing — stream close to bomb |
| Hit zone | `hypot < ry × hitRRatio` | — | Scores hit ms |
| Exit zone | `y < by − ry × EXIT_ABOVE_RATIO` | — | Motion past bomb = MISS |

### Pixel classification (`updateStream`)

1. **3-detector OR:** pixel passes if any of:
   - A — RGB sum diff ≥ `motionThreshold × 3`
   - B — chrominance warmth shift > `chromaThreshold` AND brightness > 180
   - C — adaptive brightness diff `|ΔY|×255/(Y+48)` > `adaptThreshold`
2. **Rim exclusion:** skip pixels at normalised ellipse distance `0.75–1.25`
3. **Width filter:** bin pixels below bomb by 6px Y-strips; if >50% of bins span >20px → body motion, discard frame
4. Classify passing pixels into outer gate, between-zone, inner gate, hit zone, exit zone

### Gate position tracking — live, independent of state

Both `_outerEntry.relX` and `_innerEntry.relX` are updated **every frame** their gate fires,
regardless of which state the machine is in:
```
if (_outerEntry && outerPx ≥ OUTER_MIN_PX)  → EMA-update relX + refresh .t
if (_innerEntry && innerPx ≥ INNER_MIN_PX)  → update relX + refresh _innerLastMs
```
The state machine only controls **lifecycle** (create / null entries); position tracking
is always live so the trajectory line reflects where the stream actually is.

### State machine

```
IDLE → OUTER_SEEN → INNER_SEEN → MISS → IDLE
```

- **IDLE → OUTER_SEEN:** `outerPx ≥ 3` → create `_outerEntry`
- **OUTER_SEEN → INNER_SEEN:** `innerPx ≥ 3` AND trajectory check passes → create `_innerEntry`
- **OUTER_SEEN expire:** outer gate silent > `TRAVEL_MAX_MS` (700 ms) → null `_outerEntry`, IDLE
- **OUTER_SEEN traj fail:** trajectory check fails → null `_outerEntry`, IDLE
- **INNER_SEEN timeout:** inner gate silent > `ALIGNED_TIMEOUT` (300 ms) → null both entries, IDLE
- **INNER_SEEN exit:** exit zone fires after grace period → MISS
- **MISS expire:** `MISS_HOLD_MS` (200 ms) → null both entries, IDLE

**Trajectory check (OUTER_SEEN → INNER_SEEN):** line from outer centroid through inner centroid
extrapolated to bomb Y must be within `±dirTolerance` of `bombPos.x`. When `|innerR−outerR| < ry×0.15`
(gates nearly coincident, amplification unstable) falls back to direct inner-centroid x check.

### Key constants

| Constant | Value | Description |
|----------|-------|-------------|
| `OUTER_MIN_PX` / `INNER_MIN_PX` | 3 | Min pixels to register a gate |
| `TRAVEL_MAX_MS` | 700 ms | Outer entry expiry |
| `ALIGNED_TIMEOUT` | 300 ms | Inner entry expiry |
| `MISS_HOLD_MS` | 200 ms | MISS state hold time |
| `EXIT_ABOVE_RATIO` | 0.5 | Exit zone top = `by − ry × 0.5` |
| `RIM_INNER_D` / `RIM_OUTER_D` | 0.75 / 1.25 | Rim exclusion band |
| `BIN_H` / `BIN_WIDTH_MAX` | 6 px / 20 px | Width-filter bin size / max spread |

---

## Settings panel (`shared2.js`)

`settings` object holds all tunable parameters (defaults below).

| Key | Default | Description |
|-----|---------|-------------|
| `motionThreshold` | 40 | Min per-channel pixel diff to count as motion |
| `trailDuration` | 1500 ms | How long stream points persist |
| `trackingDist` | 100 px | Max centroid jump per frame |
| `frameSkip` | 1 | Process every Nth frame |
| `showDebugStream` | false | Show corridor outline, entrance line, tip dot |

**`initSettingsPanel()`** — injects the modal HTML into `document.body` at `DOMContentLoaded`. Both HTML files just load `shared2.js` — no duplicate panel markup needed.

**`openSettings()`** / **`closeSettings()`** — called from each page's settings button.
- `sim2.html`: "Settings" button in the controls bar
- `cam2.html`: ⚙ button fixed at top-right, overlaid on the canvas
