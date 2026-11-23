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
  DOWN_ANGLE: 105,        // elbow must bend BELOW this to count as "down".
                          // Raise slightly for shallow reps; lower for deeper reps.
  UP_ANGLE:   155,        // elbow must straighten ABOVE this to count as "up".
  MIN_REP_MS: 500,        // ignore "reps" faster than this (blocks double counts)
  SMOOTHING_FRAMES: 6,    // average more frames to reduce noisy angle estimates
  MIN_KEYPOINT_SCORE: 0.25, // minimum confidence for shoulder, elbow and wrist
  DRAW_MIN_KEYPOINT_SCORE: 0.18, // draw faint but useful skeleton points at lower confidence
  POINT_SMOOTHING: 0.38,  // 0..1; higher follows each new frame more quickly

  /* ---- Body position check ---- */
  // Do not require a horizontal torso. The detector accepts front, side and
  // diagonal views; this is intentionally disabled for front-facing setups.
  REQUIRE_HORIZONTAL_BODY: false,
  MAX_BODY_TILT_DEG: 70,

  /* ---- Start & finish ---- */
  START_DELAY_SECONDS: 5, // countdown after pressing Start, to get into position
  STOP_AT_TARGET: true,   // stop counting once the goal is reached
  BEEP_ON_REP: true,      // short beep per rep (long beep at the goal)
  VIBRATE_ON_REP: true,   // phone vibration (not supported on iPhone Safari)
  KEEP_SCREEN_AWAKE: true,// ask the phone not to sleep while counting

  /* ---- Camera ---- */
  START_FACING: 'user',   // 'user' = front camera, 'environment' = back camera
  MIRROR_FRONT_CAMERA: true, // selfie-style mirror for the front camera
  CAMERA_WIDTH:  960,
  CAMERA_HEIGHT: 720,

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
    noArm:         'Arms not clear yet. Move back slightly and keep your shoulders, elbows and wrists in view.',
    notHorizontal: 'Move into a comfortable push-up position...',
    stopped:       'Stopped. Press Start to continue.',
    cameraError:   'Camera error: ',
    needHttps:     'The camera only works on HTTPS or localhost. See README.txt.',
    modelError:    'Could not load the AI model. Check your internet connection and reload.'
  },

  SHOW_DEBUG: false        // shows live angle + stage at the bottom of the page
};


/* ==================================================================
   B. GOAL PROMPT
   Runs when this file loads, after the page markup and AI libraries
   have been parsed but before the model initialization begins.
   ================================================================== */
function askForTarget() {
  let message = CONFIG.PROMPT_TEXT;
  while (true) {
    const answer = window.prompt(message, String(CONFIG.DEFAULT_TARGET));
    // Cancel uses the default goal instead of repeatedly reopening the prompt.
    if (answer === null) return CONFIG.DEFAULT_TARGET;
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
  skeletonPairs: [],
  smoothedKeypoints: Object.create(null),
  confettiParticles: [],
  confettiFrame: null,
  goalCelebrated: false
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
  el.confetti = document.getElementById('js-confetti');
  el.confettiCtx = el.confetti ? el.confetti.getContext('2d') : null;
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

// Measures both elbows when visible. This supports front-facing and side
// placements while remaining usable when only one arm is clearly detected.
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

    return {
      angle,
      confidence,
      horizontal: isBodyHorizontal(shoulder, hip),
      side
    };
  }).filter(Boolean);

  if (!sides.length) return null;
  sides.sort((a, b) => b.confidence - a.confidence);

  // A frontal view often shows both arms with similar confidence. Combining
  // both sides makes the estimate less dependent on one partially hidden arm.
  // If their angles disagree strongly, trust the clearest arm instead.
  if (sides.length >= 2 && Math.abs(sides[0].angle - sides[1].angle) <= 60) {
    const firstWeight = Math.pow(sides[0].confidence, 2);
    const secondWeight = Math.pow(sides[1].confidence, 2);
    const totalWeight = firstWeight + secondWeight;
    return {
      angle: (sides[0].angle * firstWeight + sides[1].angle * secondWeight) / totalWeight,
      confidence: (sides[0].confidence + sides[1].confidence) / 2,
      horizontal: sides[0].horizontal || sides[1].horizontal,
      side: 'both'
    };
  }

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
  if (state.goalCelebrated) return;
  state.goalCelebrated = true;
  document.body.classList.add('is-goal-reached');
  setStatus(CONFIG.TEXT.goalReached);
  launchConfetti();
  beep(660, 500);
  vibrate([200, 100, 200, 100, 400]);
  if (CONFIG.STOP_AT_TARGET) state.counting = false;
}


/* ==================================================================
   H. DRAWING THE SKELETON (on the transparent canvas over the video)
   ================================================================== */

// The preview uses object-fit: contain so the complete camera image remains
// visible. Apply the same letterboxing to the pose coordinates.
function mapPoint(p) {
  const cw = el.canvas.clientWidth, ch = el.canvas.clientHeight;
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!cw || !ch || !vw || !vh) return { x: 0, y: 0 };
  const scale = Math.min(cw / vw, ch / vh);
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
  const width = el.canvas.clientWidth;
  const height = el.canvas.clientHeight;
  el.ctx.clearRect(0, 0, width, height);
  if (!pose) state.smoothedKeypoints = Object.create(null);
  if (!CONFIG.DRAW_SKELETON || !pose || !el.video.videoWidth) return;

  // Smooth joint movement independently to make the overlay steadier without
  // delaying the actual rep counter.
  const points = pose.keypoints.map((point) => {
    if (point.score < CONFIG.DRAW_MIN_KEYPOINT_SCORE) return point;
    const key = point.name || String(point.id);
    const previous = state.smoothedKeypoints[key];
    const smoothed = previous
      ? {
          x: previous.x + (point.x - previous.x) * CONFIG.POINT_SMOOTHING,
          y: previous.y + (point.y - previous.y) * CONFIG.POINT_SMOOTHING
        }
      : { x: point.x, y: point.y };
    state.smoothedKeypoints[key] = smoothed;
    return { ...point, x: smoothed.x, y: smoothed.y };
  });

  const ctx = el.ctx;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = CONFIG.SKELETON_LINE_WIDTH + 1;
  ctx.strokeStyle = CONFIG.SKELETON_LINE_COLOR;
  ctx.shadowColor = CONFIG.SKELETON_LINE_COLOR;
  ctx.shadowBlur = 9;

  state.skeletonPairs.forEach(([i, j]) => {
    const a = points[i], b = points[j];
    if (!a || !b || a.score < CONFIG.DRAW_MIN_KEYPOINT_SCORE || b.score < CONFIG.DRAW_MIN_KEYPOINT_SCORE) return;
    const pa = mapPoint(a), pb = mapPoint(b);
    ctx.globalAlpha = clamp(Math.min(a.score, b.score) * 1.35, .22, .95);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  });

  ctx.shadowBlur = 5;
  points.forEach((point) => {
    if (!point || point.score < CONFIG.DRAW_MIN_KEYPOINT_SCORE) return;
    const mapped = mapPoint(point);
    const important = /shoulder|elbow|wrist|hip/.test(point.name || '');
    const radius = important ? 5 : 3.4;
    ctx.globalAlpha = clamp(point.score * 1.25, .35, 1);
    ctx.beginPath();
    ctx.arc(mapped.x, mapped.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = important ? '#ffffff' : '#d8fff0';
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = CONFIG.SKELETON_LINE_COLOR;
    ctx.stroke();
  });
  ctx.restore();
}


/* ==================================================================
   I. FINISH EFFECTS + SMALL PRESENTATION HELPERS
   ================================================================== */
function resizeConfettiCanvas() {
  if (!el.confetti || !el.confettiCtx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (el.confetti.width !== pixelWidth || el.confetti.height !== pixelHeight) {
    el.confetti.width = pixelWidth;
    el.confetti.height = pixelHeight;
  }
  el.confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function launchConfetti() {
  if (!el.confettiCtx || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (state.confettiFrame) cancelAnimationFrame(state.confettiFrame);
  const dimensions = resizeConfettiCanvas();
  if (!dimensions) return;

  const colors = ['#3ddc84', '#ffd54a', '#58a6ff', '#ff6b8a', '#ffffff', '#b28dff'];
  const originX = dimensions.width * .5;
  const originY = Math.min(dimensions.height * .48, 420);
  const count = 165;
  state.confettiParticles = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 8;
    return {
      x: originX + (Math.random() - .5) * 34,
      y: originY + (Math.random() - .5) * 22,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2.5,
      gravity: .12 + Math.random() * .13,
      size: 4 + Math.random() * 7,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - .5) * .22,
      color: colors[Math.floor(Math.random() * colors.length)],
      age: 0,
      life: 105 + Math.random() * 45
    };
  });

  const ctx = el.confettiCtx;
  function animateConfetti() {
    const size = resizeConfettiCanvas();
    if (!size) return;
    ctx.clearRect(0, 0, size.width, size.height);
    const remaining = [];

    state.confettiParticles.forEach((particle) => {
      particle.age += 1;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += particle.gravity;
      particle.vx *= .994;
      particle.rotation += particle.spin;
      if (particle.age < particle.life && particle.y < size.height + 30) remaining.push(particle);

      const alpha = clamp(1 - particle.age / particle.life, 0, 1);
      ctx.save();
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.fillRect(-particle.size / 2, -particle.size * .32, particle.size, particle.size * .64);
      ctx.restore();
    });

    state.confettiParticles = remaining;
    if (remaining.length) {
      state.confettiFrame = requestAnimationFrame(animateConfetti);
    } else {
      state.confettiFrame = null;
      ctx.clearRect(0, 0, size.width, size.height);
    }
  }
  state.confettiFrame = requestAnimationFrame(animateConfetti);
}

/* ==================================================================
   J. UI UPDATES
   ================================================================== */
function updateCounterUI(animate) {
  el.count.textContent  = state.count;
  el.target.textContent = state.target;
  const pct = clamp(state.count / state.target * 100, 0, 100);
  el.bar.style.width = pct + '%';
  const progress = el.bar.closest('.progress');
  if (progress) progress.setAttribute('aria-valuenow', String(Math.round(pct)));

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
   K. BUTTONS
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
  state.goalCelebrated = false;
  state.smoothedKeypoints = Object.create(null);
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
   L. START-UP  (runs when the page is ready)
   ================================================================== */
async function init() {
  runTypingEffect();
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

// The AI libraries are loaded immediately before this file, and all page
// elements are parsed before DOMContentLoaded fires.
document.addEventListener('DOMContentLoaded', init);

