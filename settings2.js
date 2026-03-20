// settings2.js — Game settings state + settings panel UI

// ── Settings state ────────────────────────────────────────────────────────────
const settings = {
    // Motion Filter
    motionThreshold: 46,
    frameSkip:       1,
    // Entrance Detection
    outerRRatio:     0.8,
    innerRRatio:     0.5,
    dirTolerance:    25,
    // Hit Detection
    hitRRatio:       0.1,
    bombDeltaX:      50,   // px offset from ellipse centre (horizontal)
    bombDeltaY:      -50,  // px offset from ellipse centre (vertical)
    // Water Detector
    showWater:       false,
    useWaterFilter:  false,
    // Corridor Filter
    useCorridorFilter: true,
    corridorWidth:     30,
    // Rim Exclusion
    useRimExclusion:  true,
    showRimExclusion: true,
    // Debug
    showDebugStream:  true,
    showStreamPoints: true,
    showTrackers:     true,
    // Parallel detectors
    useChromaDetect:  true,
    chromaThreshold:  12,
    useAdaptDetect:   true,
    adaptThreshold:   18,
    // Logging
    enableLogging:    false,
    enableDetLog:     false,
    logTrackers:      false,
    // Onboarding
    skipOnboarding:   false,
}

// Restore saved settings on startup (consent-gated writes handled in _saveSettings)
try {
    const _saved = JSON.parse(localStorage.getItem('ipee_settings') || '{}')
    Object.assign(settings, _saved)
} catch (_) {}

function _saveSettings() {
    if (typeof _hasConsent === 'function' && !_hasConsent()) return
    localStorage.setItem('ipee_settings', JSON.stringify(settings))
}

// ── Settings panel (injected into body at DOMContentLoaded) ──────────────────
function _row(content) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;margin:7px 0">${content}</div>`
}
function _label(text) {
    return `<span style="flex:1;font-size:13px;color:#ccd">${text}</span>`
}
function _sectionHead(text) {
    return `<div style="color:#7788ff;font-size:11px;font-weight:bold;text-transform:uppercase;
        letter-spacing:0.6px;margin:14px 0 6px">${text}</div>`
}
function _slider(key, label, min, max, step=1) {
    return _row(`
        ${_label(label)}
        <input type="range" id="sp_${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}"
            style="width:110px;accent-color:#7788ff;margin:0 8px"
            oninput="settings['${key}']=+this.value;document.getElementById('sv_${key}').textContent=this.value;_saveSettings()">
        <span id="sv_${key}" style="width:36px;text-align:right;color:#aaf;font-weight:bold;font-size:13px">${settings[key]}</span>
    `)
}
function _check(key, label) {
    return _row(`
        ${_label(label)}
        <input type="checkbox" id="sp_${key}" ${settings[key] ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:#7788ff"
            onchange="settings['${key}']=this.checked;_saveSettings()">
    `)
}

function initSettingsPanel() {
    const panel = `
    <div id="settingsOverlay" style="display:none;position:fixed;inset:0;
        background:rgba(0,0,0,0.55);z-index:500"
        onclick="if(event.target===this)closeSettings()">
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
          background:rgba(8,8,24,0.98);border:1px solid #446;border-radius:14px;
          padding:20px 18px;width:min(92vw,320px);max-height:85vh;overflow-y:auto">

        ${_sectionHead('Entrance Detection')}
        ${_slider('outerRRatio','Outer Circle (×ry)',0.5,3.0,0.1)}
        ${_slider('innerRRatio','Inner Circle (×ry)',0.2,1.5,0.1)}
        ${_slider('dirTolerance','Aim Tolerance (px)',5,60)}

        ${_sectionHead('Hit Detection')}
        ${_slider('hitRRatio','Hit Zone (×ry)',0.1,1.0,0.1)}
        ${_slider('bombDeltaX','Bomb Offset X (px)',-100,100)}
        ${_slider('bombDeltaY','Bomb Offset Y (px)',-100,100)}

        ${_sectionHead('Motion Filter')}
        ${_slider('motionThreshold','Motion Threshold',5,80)}
        ${_slider('frameSkip','Frame Skip',1,5)}
        ${_check('useChromaDetect','Yellow Detector (chroma)')}
        ${_slider('chromaThreshold','Yellow Threshold',5,40)}
        ${_check('useAdaptDetect','Adaptive Brightness')}
        ${_slider('adaptThreshold','Adaptive Threshold',5,40)}

        ${_sectionHead('Corridor Filter')}
        ${_check('useCorridorFilter','Enable Corridor Filter')}
        ${_slider('corridorWidth','Corridor Width (px)',10,100,5)}
        ${_sectionHead('Rim Exclusion')}
        ${_check('useRimExclusion','Enable Rim Exclusion')}
        ${_check('showRimExclusion','Show Rim Band (debug)')}

        ${_sectionHead('Water Detector')}
        ${_check('showWater','Show Water Outline')}
        ${_check('useWaterFilter','Water Zone Filter')}

        ${_sectionHead('Debug')}
        ${_check('skipOnboarding','Skip Opening Screens')}
        ${_check('showTrackers','Tracking Ellipse + Dots')}
        ${_check('showStreamPoints','Motion Points (green)')}
        ${_check('showDebugStream','Stream Debug Overlay')}
        ${_check('enableLogging','Enable Frame Logging')}
        ${_check('enableDetLog','Enable Detector Log')}
        ${_check('logTrackers','Tracker Position Log')}

        <button onclick="recalib()" style="display:block;width:100%;margin-top:14px;
            padding:10px;background:#3a1a1a;color:#fcc;border:1px solid #844;
            border-radius:8px;font-size:14px;cursor:pointer">↺ Recalibrate</button>

        ${_sectionHead('Privacy')}
        <button onclick="
            if(confirm('Delete all saved data (settings, progress, stats)?')){
                ['ipee_uid','ipee_age_ok','ipee_score','ipee_settings','ipee_consent']
                    .forEach(k=>localStorage.removeItem(k));
                location.reload();
            }"
            style="display:block;width:100%;padding:8px;background:#cc2222;color:#fff;
                border:none;border-radius:6px;cursor:pointer;font-size:13px;margin-top:6px">
            Clear my data
        </button>

        <button onclick="closeSettings()" style="display:block;width:100%;margin-top:8px;
            padding:10px;background:#1a1a3a;color:#ccd;border:1px solid #446;
            border-radius:8px;font-size:14px;cursor:pointer">Close</button>
      </div>
    </div>`
    document.body.insertAdjacentHTML('beforeend', panel)
}

function openSettings()  { document.getElementById('settingsOverlay').style.display = 'block' }
function closeSettings() { document.getElementById('settingsOverlay').style.display = 'none'  }

document.addEventListener('DOMContentLoaded', initSettingsPanel)
