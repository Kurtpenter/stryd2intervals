// ==UserScript==
// @name         Stryd to Intervals.icu Workout Exporter
// @namespace    https://github.com/Kurtpenter/stryd2intervals
// @version      2.3.0
// @description  Converts Stryd workouts into Intervals.icu builder format using absolute CP Watts.
// @author       Andrea Curtoni
// @match        https://*.stryd.com/powercenter/*
// @match        https://stryd.com/powercenter/*
// @icon         https://www.stryd.com/favicon.ico
// @downloadURL  https://github.com/Kurtpenter/stryd2intervals/raw/refs/heads/main/stryd_to_intervals.user.js
// @updateURL    https://github.com/Kurtpenter/stryd2intervals/raw/refs/heads/main/stryd_to_intervals.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // --- State ---
  let currentWorkout = null;
  let currentWorkoutId = null;
  let cachedCP = GM_getValue('stryd_user_cp', null);
  let previewModal = null;
  let toastEl = null;

  // --- 1. Automatic Token Sniffer ---
  function saveToken(token) {
    if (!token || typeof token !== 'string') return;
    const clean = token.trim();
    if (clean && clean !== GM_getValue('stryd_auth_token', '')) {
      GM_setValue('stryd_auth_token', clean);
    }
  }

  function hookAuth() {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (!win) return;

    // Fetch Interceptor
    const origFetch = win.fetch;
    if (typeof origFetch === 'function') {
      win.fetch = function (...args) {
        try {
          const config = args[1];
          if (config?.headers) {
            let auth = null;
            if (typeof config.headers.get === 'function') {
              auth = config.headers.get('Authorization') || config.headers.get('authorization');
            } else if (typeof config.headers === 'object') {
              auth = config.headers['Authorization'] || config.headers['authorization'];
            }
            if (auth) saveToken(auth);
          }
        } catch (e) {}
        return origFetch.apply(this, args);
      };
    }

    // XHR Interceptor
    if (win.XMLHttpRequest) {
      const origSetHeader = win.XMLHttpRequest.prototype.setRequestHeader;
      win.XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
        if (header && header.toLowerCase() === 'authorization') {
          saveToken(value);
        }
        return origSetHeader.apply(this, arguments);
      };
    }
  }

  // --- 2. Route Matcher ---
  // Matches exclusively: .../athletes/{athleteId}/calendar/entries/workouts/{workoutId}
  function getRouteParams() {
    const match = location.pathname.match(/\/athletes\/([\w-]+)\/calendar\/entries\/workouts\/(\d+)/);
    return match ? { athleteId: match[1], workoutId: match[2] } : null;
  }

  // --- 3. Unified API Client ---
  function apiGet(url) {
    const token = GM_getValue('stryd_auth_token', '');
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        headers: {
          'accept': 'application/json, text/plain, */*',
          'origin': 'https://www.stryd.com',
          'referer': 'https://www.stryd.com/',
          ...(token ? { 'authorization': token.startsWith('Bearer') ? token : `Bearer: ${token}` } : {})
        },
        onload: function (res) {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('Failed to parse API response'));
            }
          } else if (res.status === 401 || res.status === 403) {
            reject(new Error(`Authentication required (${res.status}). Please refresh page.`));
          } else {
            reject(new Error(`Stryd API Error: HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('Network error calling Stryd API.'))
      });
    });
  }

  async function getCP(athleteId) {
    if (cachedCP && cachedCP > 0) return cachedCP;
    try {
      const userData = await apiGet(`https://api.stryd.com/b/api/v1/users/${athleteId}`);
      const cp = Math.round(userData?.training_info?.critical_power || 0);
      if (cp > 0) {
        cachedCP = cp;
        GM_setValue('stryd_user_cp', cp);
        return cp;
      }
    } catch (e) {}
    return 250; // Fallback default if profile CP is missing
  }

  // --- 4. Intervals.icu Syntax Generator ---
  function convertStrydToIntervals(workoutData, cp) {
    if (!workoutData) return '';
    const workout = workoutData.workout || workoutData.data || workoutData;
    const title = workout.title || 'Stryd Workout';
    const desc = workout.desc || '';
    const blocks = workout.blocks || [];

    const lines = [];

    // Title
    lines.push(`# ${title.trim()}`);
    lines.push('');

    // Description / Notes
    if (desc && desc.trim()) {
      lines.push(desc.trim());
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    // Blocks
    blocks.forEach((block) => {
      const repeat = block.repeat || 1;
      const segments = block.segments || [];
      if (!segments.length) return;

      if (repeat > 1) {
        if (lines.length > 0 && lines[lines.length - 1] !== '') {
          lines.push('');
        }
        const blockName = (block.name || block.title || '').trim();
        lines.push(blockName ? `${blockName} ${repeat}x` : `${repeat}x`);
        segments.forEach((seg) => lines.push(formatSegment(seg, cp)));
        lines.push('');
      } else {
        segments.forEach((seg) => lines.push(formatSegment(seg, cp)));
      }
    });

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n') + '\n';
  }

  function formatSegment(seg, cp) {
    const cue = formatCue(seg);
    const duration = formatDuration(seg);
    const target = formatTarget(seg, cp);
    const cadence = formatCadence(seg);

    const parts = ['-'];
    if (cue) parts.push(cue);
    if (duration) parts.push(duration);
    if (target) parts.push(target);
    if (cadence) parts.push(cadence);

    return parts.join(' ');
  }

  function formatCue(seg) {
    if (seg.desc && seg.desc.trim()) return seg.desc.trim();

    const ic = (seg.intensity_class || '').toLowerCase();
    let base = 'Run';
    if (ic === 'warmup' || ic === 'warm_up') base = 'Warmup';
    else if (ic === 'cooldown' || ic === 'cool_down') base = 'Cooldown';
    else if (ic === 'rest' || ic === 'recovery') base = 'Recover';

    if ((seg.intensity_type || '').toLowerCase() === 'rpe' && seg.rpe_selected) {
      return `${base} (RPE ${seg.rpe_selected})`;
    }
    return base;
  }

  function formatDuration(seg) {
    const type = (seg.duration_type || '').toLowerCase();

    // Distance
    if (type === 'distance' || (!type && seg.duration_distance > 0)) {
      const dist = seg.duration_distance;
      const unit = (seg.distance_unit_selected || 'meter').toLowerCase();
      if (unit.startsWith('meter') || unit === 'm') {
        return (dist >= 1000 && dist % 1000 === 0) ? `${dist / 1000}km` : `${dist}mtr`;
      }
      if (unit.startsWith('kilo') || unit === 'km') return `${dist}km`;
      if (unit.startsWith('mile') || unit === 'mi') return `${dist}mi`;
      return `${dist}mtr`;
    }

    // Time
    let h = seg.duration_time?.hour || 0;
    let m = seg.duration_time?.minute || 0;
    let s = seg.duration_time?.second || 0;

    if (!h && !m && !s && typeof seg.duration === 'number' && seg.duration > 0) {
      let tot = Math.round(seg.duration);
      h = Math.floor(tot / 3600);
      tot %= 3600;
      m = Math.floor(tot / 60);
      s = tot % 60;
    }

    let res = '';
    if (h > 0) res += `${h}h`;
    if (m > 0) res += `${m}m`;
    if (s > 0) res += `${s}s`;
    return res || '0s';
  }

  function formatTarget(seg, cp) {
    const type = (seg.intensity_type || '').toLowerCase();

    if (type === 'percentage') {
      const p = seg.intensity_percent;
      if (p) {
        const { min, max, value } = p;
        if (cp && cp > 0) {
          if (min != null && max != null && min !== max) {
            return `${Math.round(cp * (min / 100))}-${Math.round(cp * (max / 100))}w`;
          }
          if (min != null && min > 0 && !max) {
            return `${Math.round(cp * (min / 100))}w`;
          }
          if (value != null && value > 0) {
            return `${Math.round(cp * (value / 100))}w`;
          }
        }
        if (min != null && max != null && min !== max) return `${min}-${max}%`;
        if (value != null && value > 0) return `${value}%`;
      }
      return 'freeride';
    }

    if (type === 'rpe') return 'freeride';
    if (type === 'zone') return `Z${seg.zone_selected || 1}`;

    if (type === 'ramp') {
      const p = seg.intensity_percent;
      if (p?.min != null && p?.max != null) {
        if (cp && cp > 0) {
          return `ramp ${Math.round(cp * (p.min / 100))}w-${Math.round(cp * (p.max / 100))}w`;
        }
        return `ramp ${p.min}%-${p.max}%`;
      }
      return 'freeride';
    }

    if (type === 'target' || type === 'power') {
      const target = seg.pdc_target || seg.target_power;
      if (target > 0) return `${Math.round(target)}w`;
      if (seg.intensity_percent?.value && cp > 0) {
        return `${Math.round(cp * (seg.intensity_percent.value / 100))}w`;
      }
      return 'freeride';
    }

    return 'freeride';
  }

  function formatCadence(seg) {
    if (seg.cadence_target && seg.cadence_target > 0) return `${Math.round(seg.cadence_target)}rpm`;
    if (seg.cadence_min && seg.cadence_max) return `${Math.round(seg.cadence_min)}-${Math.round(seg.cadence_max)}rpm`;
    return '';
  }

  // --- 5. Clipboard Helper ---
  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        return true;
      }
    } catch (e) {}
    try {
      navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- 6. UI & Modal ---
  function showToast(message, isError = false) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'stryd-intervals-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.background = isError ? '#D32F2F' : '#2E7D32';
    toastEl.classList.add('stryd-toast-show');
    setTimeout(() => toastEl?.classList.remove('stryd-toast-show'), 3500);
  }

  function createStyles() {
    if (document.getElementById('stryd-intervals-styles')) return;
    const style = document.createElement('style');
    style.id = 'stryd-intervals-styles';
    style.textContent = `
      #stryd-intervals-widget {
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        z-index: 2147483647 !important;
        display: flex !important;
        background: #1e1e1e !important;
        border: 2px solid #ff5722 !important;
        border-radius: 28px !important;
        box-shadow: 0 6px 20px rgba(0,0,0,0.6) !important;
        padding: 4px !important;
      }
      .stryd-btn-preview {
        background: linear-gradient(135deg, #ff5722, #e64a19) !important;
        color: #fff !important;
        border: none !important;
        cursor: pointer !important;
        padding: 8px 16px !important;
        border-radius: 20px !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        transition: transform 0.1s !important;
      }
      .stryd-btn-preview:hover { transform: translateY(-1px) !important; }
      .stryd-btn-preview:active { transform: translateY(1px) !important; }

      #stryd-intervals-toast {
        position: fixed !important;
        bottom: 84px !important;
        right: 24px !important;
        z-index: 2147483647 !important;
        padding: 12px 18px !important;
        color: #fff !important;
        font-size: 13px !important;
        border-radius: 8px !important;
        box-shadow: 0 4px 14px rgba(0,0,0,0.5) !important;
        opacity: 0 !important;
        transform: translateY(10px) !important;
        transition: all 0.25s ease !important;
        pointer-events: none !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      }
      #stryd-intervals-toast.stryd-toast-show { opacity: 1 !important; transform: translateY(0) !important; }

      #stryd-preview-overlay {
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        width: 100vw !important; height: 100vh !important;
        background: rgba(0,0,0,0.75) !important;
        backdrop-filter: blur(4px) !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important; justify-content: center !important;
        opacity: 0 !important; pointer-events: none !important;
        transition: opacity 0.2s ease !important;
      }
      #stryd-preview-overlay.stryd-modal-show { opacity: 1 !important; pointer-events: auto !important; }
      .stryd-modal-card {
        background: #1c1c1e !important;
        border: 1px solid #333 !important;
        border-radius: 12px !important;
        width: 90% !important; max-width: 700px !important; max-height: 88vh !important;
        display: flex !important; flex-direction: column !important;
        box-shadow: 0 12px 40px rgba(0,0,0,0.7) !important;
        color: #eee !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        overflow: hidden !important;
      }
      .stryd-modal-header {
        padding: 14px 18px !important;
        background: #252528 !important;
        display: flex !important; align-items: center !important; justify-content: space-between !important;
        border-bottom: 1px solid #333 !important;
      }
      .stryd-modal-title { font-size: 15px !important; font-weight: 700 !important; color: #ff5722 !important; }
      .stryd-modal-close { background: transparent !important; border: none !important; color: #aaa !important; font-size: 20px !important; cursor: pointer !important; }
      .stryd-modal-cp-bar {
        padding: 10px 18px !important; background: #212124 !important;
        display: flex !important; align-items: center !important; justify-content: space-between !important;
        border-bottom: 1px solid #333 !important; font-size: 13px !important;
      }
      .stryd-cp-input {
        background: #121214 !important; border: 1px solid #555 !important; color: #ffab91 !important;
        border-radius: 6px !important; padding: 4px 8px !important; font-size: 13px !important; font-weight: 700 !important;
        width: 60px !important; text-align: center !important;
      }
      .stryd-modal-body { padding: 14px 18px !important; flex: 1 !important; display: flex !important; flex-direction: column !important; }
      .stryd-modal-textarea {
        width: 100% !important; flex: 1 !important; min-height: 320px !important;
        background: #121214 !important; color: #e0e0e0 !important; border: 1px solid #333 !important;
        border-radius: 8px !important; padding: 12px !important;
        font-family: Consolas, Monaco, "SFMono-Regular", monospace !important;
        font-size: 13px !important; line-height: 1.5 !important; resize: none !important; box-sizing: border-box !important;
      }
      .stryd-modal-footer {
        padding: 12px 18px !important; background: #252528 !important;
        display: flex !important; justify-content: flex-end !important; border-top: 1px solid #333 !important;
      }
      .stryd-btn-copy-modal {
        background: linear-gradient(135deg, #ff5722, #e64a19) !important;
        color: #fff !important; border: none !important; cursor: pointer !important;
        padding: 8px 16px !important; border-radius: 6px !important; font-weight: 600 !important; font-size: 13px !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function unmountWidget() {
    document.getElementById('stryd-intervals-widget')?.remove();
    document.getElementById('stryd-preview-overlay')?.remove();
    previewModal = null;
    currentWorkout = null;
    currentWorkoutId = null;
  }

  function mountWidget() {
    if (!document.body || document.getElementById('stryd-intervals-widget')) return;
    createStyles();

    // Create Action Button
    const widget = document.createElement('div');
    widget.id = 'stryd-intervals-widget';
    widget.innerHTML = `
      <button id="stryd-btn-preview" class="stryd-btn-preview" title="Preview Intervals.icu format">
        <span>⚡ Intervals.icu Preview</span>
      </button>
    `;
    document.body.appendChild(widget);
    document.getElementById('stryd-btn-preview').addEventListener('click', handlePreviewClick);

    // Create Modal
    previewModal = document.createElement('div');
    previewModal.id = 'stryd-preview-overlay';
    previewModal.innerHTML = `
      <div class="stryd-modal-card">
        <div class="stryd-modal-header">
          <span class="stryd-modal-title">⚡ Intervals.icu Workout Format (CP Watts)</span>
          <button class="stryd-modal-close" id="stryd-modal-close-btn">&times;</button>
        </div>
        <div class="stryd-modal-cp-bar">
          <span>Critical Power:</span>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="number" id="stryd-cp-input" class="stryd-cp-input" min="50" max="800" />
            <span>Watts</span>
            <button id="stryd-cp-recalc-btn" style="background:#333;color:#eee;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;">Recalculate</button>
          </div>
        </div>
        <div class="stryd-modal-body">
          <textarea class="stryd-modal-textarea" id="stryd-modal-text" spellcheck="false"></textarea>
        </div>
        <div class="stryd-modal-footer">
          <button class="stryd-btn-copy-modal" id="stryd-modal-copy-btn">📋 Copy to Clipboard</button>
        </div>
      </div>
    `;
    document.body.appendChild(previewModal);

    document.getElementById('stryd-modal-close-btn').addEventListener('click', () => {
      previewModal?.classList.remove('stryd-modal-show');
    });
    previewModal.addEventListener('click', (e) => {
      if (e.target === previewModal) previewModal?.classList.remove('stryd-modal-show');
    });

    document.getElementById('stryd-modal-copy-btn').addEventListener('click', () => {
      const text = document.getElementById('stryd-modal-text').value;
      if (copyText(text)) {
        showToast('✓ Copied to clipboard! Ready to paste into Intervals.icu');
        previewModal?.classList.remove('stryd-modal-show');
      }
    });

    document.getElementById('stryd-cp-recalc-btn').addEventListener('click', () => {
      const val = parseInt(document.getElementById('stryd-cp-input').value, 10);
      if (val > 0 && currentWorkout) {
        cachedCP = val;
        GM_setValue('stryd_user_cp', val);
        document.getElementById('stryd-modal-text').value = convertStrydToIntervals(currentWorkout, val);
        showToast(`✓ Recalculated with CP = ${val}W`);
      }
    });
  }

  async function handlePreviewClick() {
    const route = getRouteParams();
    if (!route) return;

    showToast('⏳ Loading workout & CP...');
    try {
      const [cp, workoutData] = await Promise.all([
        getCP(route.athleteId),
        (currentWorkout && currentWorkoutId === route.workoutId)
          ? currentWorkout
          : apiGet(`https://api.stryd.com/b/api/v1/users/workouts/${route.workoutId}${location.search}`)
      ]);
      currentWorkout = workoutData;
      currentWorkoutId = route.workoutId;

      document.getElementById('stryd-modal-text').value = convertStrydToIntervals(workoutData, cp);
      document.getElementById('stryd-cp-input').value = cp || '';
      previewModal?.classList.add('stryd-modal-show');
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // --- 7. Pure URL-Gated UI Sync ---
  function syncUI() {
    const route = getRouteParams();
    if (!route) {
      unmountWidget();
      return;
    }

    // On workout page: reset cached data if workout ID changed
    if (route.workoutId !== currentWorkoutId) {
      currentWorkout = null;
      currentWorkoutId = null;
    }

    if (!document.getElementById('stryd-intervals-widget')) {
      mountWidget();
    }
  }

  const origPushState = history.pushState;
  history.pushState = function () {
    const ret = origPushState.apply(this, arguments);
    setTimeout(syncUI, 80);
    return ret;
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    const ret = origReplaceState.apply(this, arguments);
    setTimeout(syncUI, 80);
    return ret;
  };

  window.addEventListener('popstate', syncUI);
  setInterval(syncUI, 500);

  hookAuth();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncUI);
  } else {
    syncUI();
  }

  // --- 8. Testing & Debug Interface ---
  function runTests() {
    console.group('%c🧪 Stryd to Intervals.icu Test Suite', 'color: #ff5722; font-weight: bold; font-size: 13px;');

    // Test 1: 6x 1-minute CP Fartlek
    const testFartlek = {
      workout: {
        title: 'LR w 6x 1:00 "CP" fartlek',
        desc: 'Do not overpower the one minute fartlek segments.\n\n**Purpose:**\n- Build fatigue resistance\n- Improve aerobic fitness\n- Provide some stimulus near CP (Critical Power: 250W)',
        blocks: [
          {
            repeat: 1,
            segments: [
              {
                duration_type: 'time',
                duration_time: { hour: 0, minute: 27, second: 0 },
                intensity_class: 'warmup',
                intensity_type: 'percentage',
                intensity_percent: { value: 75, min: 70, max: 80 }
              }
            ]
          },
          {
            name: 'Fartlek',
            repeat: 6,
            segments: [
              {
                duration_type: 'time',
                duration_time: { hour: 0, minute: 1, second: 0 },
                intensity_class: 'work',
                intensity_type: 'percentage',
                intensity_percent: { value: 100, min: 97, max: 103 }
              },
              {
                duration_type: 'time',
                duration_time: { hour: 0, minute: 2, second: 0 },
                intensity_class: 'rest',
                intensity_type: 'percentage',
                intensity_percent: { value: 73, min: 65, max: 80 }
              }
            ]
          },
          {
            repeat: 1,
            segments: [
              {
                duration_type: 'time',
                duration_time: { hour: 0, minute: 5, second: 0 },
                intensity_class: 'cooldown',
                intensity_type: 'percentage',
                intensity_percent: { value: 75, min: 70, max: 80 }
              }
            ]
          }
        ]
      }
    };

    const cp = 250;
    const output = convertStrydToIntervals(testFartlek, cp);

    let pass = true;
    function check(assertion, label) {
      if (assertion) {
        console.log(`%c✓ PASS:%c ${label}`, 'color: #4caf50; font-weight: bold;', 'color: inherit;');
      } else {
        pass = false;
        console.error(`✗ FAIL: ${label}`);
      }
    }

    check(output.includes('# LR w 6x 1:00 "CP" fartlek'), 'Title formatted as heading 1');
    check(output.includes('---'), 'Notes separator divider present');
    check(output.includes('- Warmup 27m 175-200w'), 'Warmup duration (27m) and CP power range (175-200w)');
    check(output.includes('Fartlek 6x'), 'Named repeat set formatted with 6x multiplier');
    check(output.includes('- Run 1m 243-258w'), 'Work interval duration (1m) and CP power range (243-258w)');
    check(output.includes('- Recover 2m 163-200w'), 'Recovery duration (2m) and CP power range (163-200w)');
    check(output.includes('- Cooldown 5m 175-200w'), 'Cooldown duration (5m) and CP power range (175-200w)');

    if (pass) {
      console.log('%c🎉 All assertions passed successfully!', 'color: #4caf50; font-weight: bold; font-size: 12px;');
    } else {
      console.warn('⚠️ Some assertions failed. Output was:\n' + output);
    }

    console.groupEnd();
    return pass;
  }

  // Expose to unsafeWindow / window for browser DevTools console
  const targetWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (targetWin) {
    targetWin.StrydToIntervals = {
      convert: convertStrydToIntervals,
      runTests: runTests
    };
  }

  // Auto-run if URL query contains ?run_tests
  if (location.search.includes('run_tests')) {
    setTimeout(runTests, 200);
  }
})();
