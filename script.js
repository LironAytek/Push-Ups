/* ==================================================================
   FILE 3 OF 3 : script.js  (the logic of the app)
   ------------------------------------------------------------------
   What happens, in order:
     1. Ask the user for the push-up goal (a prompt, BEFORE the page loads)
     2. When the page is ready: load the AI pose model (MoveNet)
     3. User presses "Start" -> camera opens -> short countdown
     4. Every frame: find body points -> measure the ELBOW ANGLE
     5. Elbow bends (DOWN) then straightens (UP) = 1 push-up counted
     6. Update number, progress bar, beep/vibrate. Stop at the goal.

   Sections:
     A. CONFIG          <- the numbers you will most likely want to tweak
     B. Goal prompt
     C. State & element lookups
     D. Small helpers
     E. Camera
     F. Pose detection loop
     G. Push-up counting logic
     H. Drawing the skeleton
     I. UI updates
     J. Buttons
     K. Start-up
   ================================================================== */


/* ==================================================================
   A. CONFIG  -  change values here, no need to touch the rest
   ================================================================== */
const CONFIG = {
  /* ---- Goal prompt ---- */
  PROMPT_TEXT:    'How many push-ups is your target?',
  DEFAULT_TARGET: 20,     // pre-filled number in the prompt
  MAX_TARGET:     500,    // highest number accepted

  /* ---- Counting sensitivity ---- */
  // Elbow angle in degrees: 180 = arm fully straight, ~90 = bent at a right angle.
  DOWN_ANGLE: 100,        // elbow must bend BELOW this to count as "down".
                          //   -> raise (e.g. 110) if shallow push-ups are not counted
                          //   -> lower (e.g. 90)  to demand deeper push-ups
  UP_ANGLE:   155,        // elbow must straighten ABOVE this to count as "up".
                          //   -> lower (e.g. 145) if you cannot fully lock out
  MIN_REP_MS: 500,        // ignore "reps" faster than this (blocks double counts)
  SMOOTHING_FRAMES: 4,    // averages the last N angles to remove jitter (1 = off)
  MIN_KEYPOINT_SCORE: 0.3,// 0..1, how sure the AI must be about a body point

  /* ---- Body position check ---- */
  // true  = only count when the body is roughly horizontal (a real push-up
  //         position, camera to the SIDE of you). Stops arm-curl false counts.
  // false = count any elbow bending (works from other camera angles).
  REQUIRE_HORIZONTAL_BODY: true,
  MAX_BODY_TILT_DEG: 50,  // how far from horizontal the body may be

  /* ---- Start & finish ---- */
  START_DELAY_SECONDS: 5, // countdown after pressing Start, to get into position
  STOP_AT_TARGET: true,   // stop counting once the goal is reached
  BEEP_ON_REP: true,      // short beep per rep (long beep at the goal)
  VIBRATE_ON_REP: true,   // phone vibration (not supported on iPhone Safari)
  KEEP_SCREEN_AWAKE: true,// ask the phone not to sleep while counting

  /* ---- Camera ---- */
  START_FACING: 'user',   // 'user' = front camera, 'environment' = back camera
  MIRROR_FRONT_CAMERA: true, // selfie-style mirror for the front camera
  CAMERA_WIDTH:  640,     // lower = faster on old phones
  CAMERA_HEIGHT: 480,

  /* ---- AI model ---- */
  MODEL_TYPE: 'lightning',// 'lightning' = faster (phones) | 'thunder' = more accurate

  /* ---- Skeleton drawing (set DRAW_SKELETON:false to hide it) ---- */
  DRAW_SKELETON: true,
  SKELETON_LINE_COLOR:  '#3ddc84',
  SKELETON_POINT_COLOR: '#ffffff',
  SKELETON_LINE_WIDTH:  3,

  /* ---- Texts shown to the user (translate them here!) ---- */
  TEXT: {
    loadingModel:  'Loading model...',
    modelReady:    'Ready. Press Start.',
    openingCamera: 'Opening camera...',
    getReady:      'Get into push-up position...',
    counting:      'Go! Counting...',
    goalReached:   'Goal reached! Great work!',
    noBody:        'Cannot see you. Move back so your whole body fits.',
    noArm:         'Cannot see your arm clearly. Turn sideways to the camera.',
    notHorizontal: 'Waiting for push-up position (body horizontal)...',
    stopped:       'Stopped. Press Start to continue.',
    cameraError:   'Camera error: ',
    needHttps:     'The camera only works on HTTPS or localhost. See README.txt.',
    modelError:    'Could not load the AI model. Check your internet connection and reload.'
  },

  SHOW_DEBUG: false        // shows live angle + stage at the bottom of the page
};


/* ==================================================================
   B. GOAL PROMPT
   Runs IMMEDIATELY when this file loads (it is in <head>), which is
   before the page content and the AI model are loaded.
   ================================================================== */
function askForTarget() {
  let message = CONFIG.PROMPT_TEXT;
  while (true) {
    const answer = window.prompt(message, String(CONFIG.DEFAULT_TARGET));
    const number = Number.parseInt(answer, 10);
    if (Number.isInteger(number) && number > 0 && number <= CONFIG.MAX_TARGET) {
      return number;
    }
    // Cancel or invalid text: ask again (the goal is required).
    message = 'Please enter a whole number between 1 and ' + CONFIG.MAX_TARGET + '.\n\n' + CONFIG.PROMPT_TEXT;
  }
}


/* ==================================================================
   C. STATE & ELEMENT LOOKUPS
   ================================================================== */
const state = {
  target:      askForTarget(), // <- the prompt happens here
  count:       0,
  stage:       'unknown',      // 'unknown' | 'up' | 'down'
  counting:    false,          // true only after the countdown, until goal
  running:     false,          // camera + detection active
  facing:      CONFIG.START_FACING,
  detector:    null,
  stream:      null,
  rafId:       null,
  session:     0,              // changes each Start/Stop (cancels old countdowns)
  angleBuffer: [],
  lastRepTime: 0,
  wakeLock:    null,
  audioCtx:    null,
  skeletonPairs: []
};

// Elements are looked up once the page is ready (see section K).
const el = {};
function findElements() {
  el.stage    = document.getElementById('js-stage');
  el.video    = document.getElementById('js-video');
  el.canvas   = document.getElementById('js-overlay');
  el.ctx      = el.canvas.getContext('2d');
  el.message  = document.getElementById('js-message');
  el.count    = document.getElementById('js-count');
  el.target   = document.getElementById('js-target');
  el.bar      = document.getElementById('js-progress-bar');
  el.status   = document.getElementById('js-status');
  el.debug    = document.getElementById('js-debug');
  el.start    = document.getElementById('js-start');
  el.reset    = document.getElementById('js-reset');
  el.switchCam= document.getElementById('js-switch-camera');
  el.change   = document.getElementById('js-change-target');
}


/* ==================================================================
   D. SMALL HELPERS
   ================================================================== */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Angle (degrees) at point B formed by the lines B->A and B->C.
// For an elbow: A = shoulder, B = elbow, C = wrist.
function angleBetween(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!mag) return null;
  const cos = clamp((abx * cbx + aby * cby) / mag, -1, 1);
  return Math.acos(cos) * 180 / Math.PI;
}

// Short beep using the browser's audio (no sound file needed).
function beep(frequency = 880, durationMs = 90) {
  if (!CONFIG.BEEP_ON_REP || !state.audioCtx) return;
  try {
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.frequency.value = frequency;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start();
    osc.stop(state.audioCtx.currentTime + durationMs / 1000);
  } catch (e) { /* sound is optional, ignore errors */ }
}

function vibrate(pattern) {
  if (CONFIG.VIBRATE_ON_REP && navigator.vibrate) navigator.vibrate(pattern);
}


/* ==================================================================
   E. CAMERA
   ================================================================== */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(CONFIG.TEXT.needHttps);
  }
  stopCamera();

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: state.facing,
      width:  { ideal: CONFIG.CAMERA_WIDTH },
      height: { ideal: CONFIG.CAMERA_HEIGHT }
    }
  });

  el.video.srcObject = state.stream;
  await new Promise((resolve) => {
    if (el.video.readyState >= 1) return resolve();
    el.video.onloadedmetadata = () => resolve();
  });
  await el.video.play();

  // Mirror only the front camera (like a selfie mirror).
  el.stage.classList.toggle('is-mirrored',
    CONFIG.MIRROR_FRONT_CAMERA && state.facing === 'user');

  if (CONFIG.KEEP_SCREEN_AWAKE && 'wakeLock' in navigator) {
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  el.video.srcObject = null;
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}


/* ==================================================================
   F. POSE DETECTION LOOP
   ================================================================== */
async function loadModel() {
  // Prefer the GPU (WebGL); fall back automatically if unavailable.
  try { await tf.setBackend('webgl'); } catch (e) { /* use default backend */ }
  await tf.ready();

  const modelType = CONFIG.MODEL_TYPE === 'thunder'
    ? poseDetection.movenet.modelType.SINGLEPOSE_THUNDER
    : poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING;

  state.detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    { modelType }
  );
  state.skeletonPairs = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);
}

async function detectLoop() {
  if (!state.running) return;

  if (el.video.readyState >= 2) {
    try {
      const poses = await state.detector.estimatePoses(el.video, { flipHorizontal: false });
      handlePose(poses && poses[0] ? poses[0] : null);
    } catch (e) {
      console.error('Detection error:', e);
    }
  }
  state.rafId = requestAnimationFrame(detectLoop);
}

function handlePose(pose) {
  drawSkeleton(pose);

  if (!pose) {
    state.angleBuffer = [];
    if (state.counting) setStatus(CONFIG.TEXT.noBody);
    return;
  }

  const result = measureElbow(pose);
  if (!result) {
    state.angleBuffer = [];
    if (state.counting) setStatus(CONFIG.TEXT.noArm);
    debug('angle: --');
    return;
  }

  // Smooth the angle over the last few frames.
  state.angleBuffer.push(result.angle);
  if (state.angleBuffer.length > CONFIG.SMOOTHING_FRAMES) state.angleBuffer.shift();
  const smooth = state.angleBuffer.reduce((s, v) => s + v, 0) / state.angleBuffer.length;
  debug('angle: ' + Math.round(smooth) + '\u00B0  |  stage: ' + state.stage);

  if (!state.counting) return;

  if (CONFIG.REQUIRE_HORIZONTAL_BODY && !result.horizontal) {
    setStatus(CONFIG.TEXT.notHorizontal);
    return;
  }
  setStatus(CONFIG.TEXT.counting);
  updateReps(smooth);
}


/* ==================================================================
   G. PUSH-UP COUNTING LOGIC
   ================================================================== */

// Picks the arm the AI sees best (when the phone is at your side, usually
// only one arm is clearly visible) and returns its elbow angle.
function measureElbow(pose) {
  const kp = {};
  pose.keypoints.forEach((p) => { kp[p.name] = p; });

  const sides = ['left', 'right'].map((side) => {
    const shoulder = kp[side + '_shoulder'];
    const elbow    = kp[side + '_elbow'];
    const wrist    = kp[side + '_wrist'];
    const hip      = kp[side + '_hip'];
    if (!shoulder || !elbow || !wrist) return null;

    const confidence = Math.min(shoulder.score, elbow.score, wrist.score);
    if (confidence < CONFIG.MIN_KEYPOINT_SCORE) return null;

    const angle = angleBetween(shoulder, elbow, wrist);
    if (angle === null) return null;

    return { angle, confidence, horizontal: isBodyHorizontal(shoulder, hip) };
  }).filter(Boolean);

  if (!sides.length) return null;
  sides.sort((a, b) => b.confidence - a.confidence);
  return sides[0];
}

// Body is "horizontal" when the line shoulder->hip is closer to flat than upright.
// If the hip is not visible we do not block counting.
function isBodyHorizontal(shoulder, hip) {
  if (!hip || hip.score < CONFIG.MIN_KEYPOINT_SCORE) return true;
  const dx = Math.abs(hip.x - shoulder.x);
  const dy = Math.abs(hip.y - shoulder.y);
  const tilt = Math.atan2(dy, dx) * 180 / Math.PI; // 0 = flat, 90 = standing
  return tilt <= CONFIG.MAX_BODY_TILT_DEG;
}

// The rep state machine:  up -> down -> up  = +1
function updateReps(angle) {
  if (angle < CONFIG.DOWN_ANGLE) {
    state.stage = 'down';
  } else if (angle > CONFIG.UP_ANGLE) {
    if (state.stage === 'down') {
      const now = performance.now();
      if (now - state.lastRepTime >= CONFIG.MIN_REP_MS) {
        state.lastRepTime = now;
        registerRep();
      }
    }
    state.stage = 'up';
  }
}

function registerRep() {
  state.count += 1;
  updateCounterUI(true);
  beep(880, 90);
  vibrate(60);

  if (state.count >= state.target) {
    goalReached();
  }
}

function goalReached() {
  document.body.classList.add('is-goal-reached');
  setStatus(CONFIG.TEXT.goalReached);
  beep(660, 500);
  vibrate([200, 100, 200, 100, 400]);
  if (CONFIG.STOP_AT_TARGET) state.counting = false;
}


/* ==================================================================
   H. DRAWING THE SKELETON (on the transparent canvas over the video)
   ================================================================== */

// The video is shown with object-fit: cover, so we must apply the same
// scaling and cropping to the AI's coordinates or the dots will be offset.
function mapPoint(p) {
  const cw = el.canvas.clientWidth,  ch = el.canvas.clientHeight;
  const vw = el.video.videoWidth,    vh = el.video.videoHeight;
  const scale = Math.max(cw / vw, ch / vh);
  return {
    x: p.x * scale + (cw - vw * scale) / 2,
    y: p.y * scale + (ch - vh * scale) / 2
  };
}

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  if (el.canvas.width !== Math.round(w * dpr) || el.canvas.height !== Math.round(h * dpr)) {
    el.canvas.width  = Math.round(w * dpr);
    el.canvas.height = Math.round(h * dpr);
  }
  el.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawSkeleton(pose) {
  fitCanvas();
  el.ctx.clearRect(0, 0, el.canvas.clientWidth, el.canvas.clientHeight);
  if (!CONFIG.DRAW_SKELETON || !pose || !el.video.videoWidth) return;

  const min = CONFIG.MIN_KEYPOINT_SCORE;
  el.ctx.lineWidth = CONFIG.SKELETON_LINE_WIDTH;
  el.ctx.strokeStyle = CONFIG.SKELETON_LINE_COLOR;

  state.skeletonPairs.forEach(([i, j]) => {
    const a = pose.keypoints[i], b = pose.keypoints[j];
    if (a.score < min || b.score < min) return;
    const pa = mapPoint(a), pb = mapPoint(b);
    el.ctx.beginPath();
    el.ctx.moveTo(pa.x, pa.y);
    el.ctx.lineTo(pb.x, pb.y);
    el.ctx.stroke();
  });

  el.ctx.fillStyle = CONFIG.SKELETON_POINT_COLOR;
  pose.keypoints.forEach((p) => {
    if (p.score < min) return;
    const m = mapPoint(p);
    el.ctx.beginPath();
    el.ctx.arc(m.x, m.y, 4, 0, Math.PI * 2);
    el.ctx.fill();
  });
}


/* ==================================================================
   I. UI UPDATES
   ================================================================== */
function updateCounterUI(animate) {
  el.count.textContent  = state.count;
  el.target.textContent = state.target;
  const pct = clamp(state.count / state.target * 100, 0, 100);
  el.bar.style.width = pct + '%';

  if (animate) { // restart the little "pop" animation (see .bump in style.css)
    el.count.classList.remove('bump');
    void el.count.offsetWidth;
    el.count.classList.add('bump');
  }
}

function setStatus(text)  { if (el.status.textContent !== text) el.status.textContent = text; }
function debug(text)      { if (CONFIG.SHOW_DEBUG) el.debug.textContent = text; }

function showMessage(text, isCountdown) {
  el.message.textContent = text;
  el.message.classList.toggle('is-countdown', !!isCountdown);
  el.message.classList.remove('is-hidden');
}
function hideMessage() { el.message.classList.add('is-hidden'); }


/* ==================================================================
   J. BUTTONS
   ================================================================== */
async function onStartStop() {
  // ---- STOP ----
  if (state.running) {
    stopSession();
    setStatus(CONFIG.TEXT.stopped);
    return;
  }

  // ---- START ----
  const session = ++state.session;
  el.start.disabled = true;
  showMessage(CONFIG.TEXT.openingCamera);

  // Audio must be created from a button press (browser rule).
  if (!state.audioCtx && (window.AudioContext || window.webkitAudioContext)) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();

  try {
    await startCamera();
  } catch (err) {
    showMessage(CONFIG.TEXT.cameraError + (err && err.message ? err.message : err));
    el.start.disabled = false;
    return;
  }

  state.running = true;
  el.start.textContent = 'Stop';
  el.start.disabled = false;
  state.stage = 'unknown';
  state.angleBuffer = [];
  detectLoop();

  // Countdown so the user can get into position.
  setStatus(CONFIG.TEXT.getReady);
  for (let i = CONFIG.START_DELAY_SECONDS; i > 0; i--) {
    showMessage(String(i), true);
    beep(520, 80);
    await sleep(1000);
    if (session !== state.session) return; // user pressed Stop meanwhile
  }
  hideMessage();

  if (state.count < state.target) {
    state.counting = true;
    setStatus(CONFIG.TEXT.counting);
  }
}

function stopSession() {
  state.session++;           // cancels a running countdown
  state.running = false;
  state.counting = false;
  cancelAnimationFrame(state.rafId);
  stopCamera();
  el.ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  el.start.textContent = 'Start';
  showMessage('Camera off');
}

function onReset() {
  state.count = 0;
  state.stage = 'unknown';
  state.angleBuffer = [];
  state.lastRepTime = 0;
  document.body.classList.remove('is-goal-reached');
  updateCounterUI(false);
  if (state.running && !el.message.classList.contains('is-countdown')) {
    state.counting = true;
    setStatus(CONFIG.TEXT.counting);
  }
}

async function onSwitchCamera() {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  if (state.running) {
    try { await startCamera(); } catch (err) {
      showMessage(CONFIG.TEXT.cameraError + (err && err.message ? err.message : err));
    }
  }
}

function onChangeTarget() {
  state.target = askForTarget();
  onReset();
}


/* ==================================================================
   K. START-UP  (runs when the page is ready)
   ================================================================== */
async function init() {
  findElements();
  updateCounterUI(false);
  showMessage(CONFIG.TEXT.loadingModel);
  setStatus(CONFIG.TEXT.loadingModel);

  el.start.addEventListener('click', onStartStop);
  el.reset.addEventListener('click', onReset);
  el.switchCam.addEventListener('click', onSwitchCamera);
  el.change.addEventListener('click', onChangeTarget);

  try {
    await loadModel();
  } catch (err) {
    console.error(err);
    showMessage(CONFIG.TEXT.modelError);
    setStatus(CONFIG.TEXT.modelError);
    return;
  }

  showMessage(CONFIG.TEXT.modelReady);
  setStatus(CONFIG.TEXT.modelReady);
  el.start.disabled = false;
}

// This file sits in <head>, so wait for the page before touching it.
// (The AI libraries are loaded at the end of <body>, before this event fires.)
document.addEventListener('DOMContentLoaded', init);
