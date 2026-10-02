import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

const MODEL = './public/model/Thunderblade.glb';

// Shared showroom material. Kept at module scope so no showroom helper can
// fail because of JavaScript function-scope differences or stale builds.
const blackMat = new THREE.MeshStandardMaterial({
  color: 0x050606,
  roughness: 0.36,
  metalness: 0.28
});

/*
 * ============================================================
 * FORMULA STUDENT XR CONFIGURATION
 * ============================================================
 *
 * The GLB is real-world scale in meters.
 *
 * XR_START_DISTANCE:
 *   Distance from the user to the centered car origin.
 *   4.5 m gives a useful initial full-car view.
 *
 * XR_START_HEIGHT:
 *   Keeps the circuit floor aligned with the user's physical floor.
 */
const XR_START_DISTANCE = 5.5;
const DISPLAY_CAR_SCALE = 2.0;
const XR_START_HEIGHT = 0;

/*
 * The car is placed on the virtual circuit.
 * The procedural environment is deliberately separate from
 * the GLB so the same car file remains untouched.
 */
const TRACK_RADIUS = 10;
const TRACK_WIDTH = 5;
const RUNOFF_RADIUS = 16;

let scene, camera, renderer, controls, carRoot;
let teleportCursor, cursorInner, cursorValid = false;
let groundPlane, groundVisual;
let xrActive = false, desktopMode = false;
let xrSession = null;
let navigationMode = 'teleport';
let pinchAiming = false;
let lastTeleport = 0;

let modelBox = new THREE.Box3();
let modelCenter = new THREE.Vector3();
let modelSize = new THREE.Vector3();

let initialCarPosition = new THREE.Vector3();
let initialCarQuaternion = new THREE.Quaternion();
let initialCarScale = new THREE.Vector3(1,1,1);

let lastSurfaceNormal = new THREE.Vector3(0,1,0);

const raycaster = new THREE.Raycaster();
const clock = new THREE.Clock();

const gazeOrigin = new THREE.Vector3();
const gazeDirection = new THREE.Vector3();
const hitNormal = new THREE.Vector3();
const targetPoint = new THREE.Vector3();

const $ = id => document.getElementById(id);

const loading = $('loading');
const menu = $('menu');
const enterButton = $('enterImmersive');
const desktopButton = $('exploreDesktop');
const hud = $('hud');
const desktopHelp = $('desktopHelp');
const infoPanel = $('infoPanel');
const navModePanel = $('navModePanel');

init();

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070909);
  scene.fog = new THREE.Fog(0x070909, 24, 55);

  camera = new THREE.PerspectiveCamera(
    65,
    innerWidth / innerHeight,
    0.05,
    1000
  );

  camera.position.set(0, 2.0, 7);

  scene.add(new THREE.HemisphereLight(0x8fa2a8, 0x090b0b, 0.85));

  const key = new THREE.DirectionalLight(0xffead0, 2.8);
  key.position.set(-7, 10, 7);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xb8d9e8, 1.55);
  fill.position.set(8, 6, 4);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffb36b, 2.0);
  rim.position.set(0, 8, -10);
  scene.add(rim);

  const showroomSpot = new THREE.SpotLight(0xffffff, 18, 24, Math.PI / 6, 0.55, 1.5);
  showroomSpot.position.set(-3.5, 8.5, 4.5);
  showroomSpot.target.position.set(0, 0, 0);
  scene.add(showroomSpot, showroomSpot.target);

  const showroomSpot2 = new THREE.SpotLight(0xffd2a6, 14, 22, Math.PI / 7, 0.6, 1.5);
  showroomSpot2.position.set(5, 7, -4);
  showroomSpot2.target.position.set(0, 0.4, 0);
  scene.add(showroomSpot2, showroomSpot2.target);

  /*
   * Hidden fallback floor used by desktop and XR navigation.
   */
  groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide
    })
  );

  groundPlane.rotation.x = -Math.PI / 2;
  scene.add(groundPlane);

  groundVisual = new THREE.Mesh(
    new THREE.CircleGeometry(260, 96),
    new THREE.MeshStandardMaterial({
      color: 0x263029,
      roughness: 1
    })
  );

  groundVisual.rotation.x = -Math.PI / 2;
  groundVisual.position.y = -0.01;
  scene.add(groundVisual);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance'
  });

  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  renderer.xr.enabled = true;

  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 2;
  controls.maxDistance = 100;

  createTeleportCursor();
  setupUI();
  setupXR();
  loadCar();

  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('pointermove', onDesktopPointerMove);
  renderer.domElement.addEventListener('pointerdown', onDesktopClick);

  renderer.setAnimationLoop(render);
}

function createTeleportCursor() {
  teleportCursor = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.68, 48),
    new THREE.MeshBasicMaterial({
      color: 0x39d98a,
      transparent: true,
      opacity: .95,
      side: THREE.DoubleSide,
      depthTest: false
    })
  );

  teleportCursor.rotation.x = -Math.PI / 2;
  teleportCursor.renderOrder = 50;
  teleportCursor.visible = false;
  scene.add(teleportCursor);

  cursorInner = new THREE.Mesh(
    new THREE.CircleGeometry(.45, 48),
    new THREE.MeshBasicMaterial({
      color: 0x39d98a,
      transparent: true,
      opacity: .16,
      side: THREE.DoubleSide,
      depthTest: false
    })
  );

  cursorInner.rotation.x = -Math.PI / 2;
  teleportCursor.add(cursorInner);
}

function setupXR() {
  const vrButton = VRButton.createButton(renderer, {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'bounded-floor', 'dom-overlay'],
    domOverlay: { root: document.body }
  });

  vrButton.id = 'realXRButton';
  vrButton.style.display = 'none';
  document.body.appendChild(vrButton);

  renderer.xr.addEventListener('sessionstart', () => {
    xrActive = true;
    desktopMode = false;
    controls.enabled = false;

    menu.classList.add('hidden');
    hud.classList.remove('hidden');
    desktopHelp.classList.add('hidden');
    navModePanel.classList.remove('hidden');
    infoPanel.classList.add('hidden');

    navigationMode = 'teleport';
    setModeUI();

    resetExperience(true);

    xrSession = renderer.xr.getSession();

    xrSession.addEventListener('selectstart', onXRSelectStart);
    xrSession.addEventListener('selectend', onXRSelectEnd);
    xrSession.addEventListener('select', onXRSelect);
  });

  renderer.xr.addEventListener('sessionend', () => {
    xrActive = false;
    pinchAiming = false;
    xrSession = null;
    controls.enabled = true;

    hud.classList.add('hidden');
    navModePanel.classList.add('hidden');
    teleportCursor.visible = false;
    menu.classList.remove('hidden');
  });

  if (navigator.xr?.isSessionSupported) {
    navigator.xr.isSessionSupported('immersive-vr').then(ok => {
      enterButton.disabled = !ok;
      enterButton.textContent = ok
        ? 'Enter Immersive Experience'
        : 'Immersive mode requires Vision Pro';
    }).catch(() => {
      enterButton.disabled = true;
      enterButton.textContent = 'Immersive mode requires Vision Pro';
    });
  } else {
    enterButton.disabled = true;
    enterButton.textContent = 'Immersive mode requires Vision Pro';
  }
}

function setupUI() {
  enterButton.addEventListener('click', () => $('realXRButton')?.click());

  desktopButton.addEventListener('click', () => {
    desktopMode = true;
    menu.classList.add('hidden');
    hud.classList.remove('hidden');
    desktopHelp.classList.remove('hidden');
    $('locationName').textContent = 'Desktop: point at a surface and click';
  });

  $('teleportMode').addEventListener('click', () => {
    navigationMode = 'teleport';
    setModeUI();
  });

  $('flyMode').addEventListener('click', () => {
    navigationMode = 'fly';
    setModeUI();
  });

  $('resetExperience').addEventListener('click', () => resetExperience(false));
  $('exitExperience').addEventListener('click', exitExperience);

  $('infoToggle').addEventListener('click', () => {
    $('infoTitle').textContent = 'Navigation';
    $('infoText').textContent = navigationMode === 'teleport'
      ? 'Teleport mode: pinch to aim at the circuit surface. A valid landing surface is highlighted. Release the pinch to move there.'
      : 'Fly mode: pinch and hold to aim, then release to move forward through the circuit environment in the direction of the pinch target.';
    infoPanel.classList.remove('hidden');
  });

  $('closeInfo').addEventListener('click', () => infoPanel.classList.add('hidden'));
}

function setModeUI() {
  $('teleportMode').classList.toggle('active', navigationMode === 'teleport');
  $('flyMode').classList.toggle('active', navigationMode === 'fly');

  $('locationName').textContent = navigationMode === 'teleport'
    ? 'Teleport: pinch to aim, release to move'
    : 'Fly: pinch to aim, release to fly';

  $('modeHint').textContent = navigationMode === 'teleport'
    ? 'Teleport: pinch to aim, release to move'
    : 'Fly: pinch to aim, release to fly';

  teleportCursor.visible = false;
}

function loadCar() {
  // The Thunderblade GLB uses KHR_draco_mesh_compression.
  // Configure Three.js with the matching Draco decoder before loading it.
  const dracoLoader = new DRACOLoader();
  // The GLB is Draco-compressed. Let DRACOLoader choose the supported
  // decoder automatically instead of forcing WebAssembly. This is more
  // compatible across desktop browsers and Apple Vision Pro.
  dracoLoader.setDecoderPath(
    'https://www.gstatic.com/draco/versioned/decoders/1.5.7/'
  );
  dracoLoader.preload();

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  loader.load(
    MODEL,
    gltf => {
      // Keep a dedicated navigation root separate from the visual car.
      // This prevents the showroom/platform from inheriting the car's 2.25x
      // display scale and lets us place the tires precisely on the platform.
      const carModel = gltf.scene;

      modelBox.setFromObject(carModel);
      modelBox.getCenter(modelCenter);
      modelBox.getSize(modelSize);

      // Normalize the imported model around the origin.
      carModel.position.x -= modelCenter.x;
      carModel.position.z -= modelCenter.z;
      carModel.position.y -= modelBox.min.y;

      carRoot = new THREE.Group();
      carRoot.name = 'ThunderbladeNavigationRoot';
      carRoot.add(carModel);

      // Enlarge only the Formula Student car. The showroom remains at its
      // authored size because it is now a sibling inside the root, not a
      // child of the scaled car model.
      carModel.scale.setScalar(DISPLAY_CAR_SCALE);
      // Platform top is approximately y=0.025 in world space. Lift the
      // normalized car by that amount so the lowest tire/body point rests
      // on the platform instead of intersecting it.
      carModel.position.y += 0.025;
      carModel.updateMatrixWorld(true);

      initialCarPosition.copy(carRoot.position);
      initialCarQuaternion.copy(carRoot.quaternion);
      initialCarScale.copy(carRoot.scale);

      scene.add(carRoot);

      createFormulaStudentEnvironment();

      camera.position.set(0, 1.8, Math.max(modelSize.z * DISPLAY_CAR_SCALE * 1.9, 5.2));
      controls.target.set(0, Math.min(modelSize.y * DISPLAY_CAR_SCALE * 0.50, 0.9), 0);
      controls.update();

      loading.classList.add('hidden');
      enterButton.disabled = false;
    },

    xhr => {
      if (xhr.total) {
        $('loadProgress').textContent =
          Math.round(xhr.loaded / xhr.total * 100) + '%';
      }
    },

    err => {
      console.error('Thunderblade GLB load error:', err);
      loading.classList.add('hidden');
      $('error').classList.remove('hidden');
      const message = err?.message || String(err);
      $('errorText').textContent =
        `Model loading failed: ${message}. Make sure the site is running over HTTP/HTTPS and that the Draco decoder can be reached.`;
    }
  );
}

function createFormulaStudentEnvironment() {
  /*
   * ============================================================
   * THUNDERBLADE RACE SHOWROOM
   * ============================================================
   *
   * A compact indoor exhibition space inspired by a premium
   * motorsport / engineering showroom. The car stays at real
   * 1:1 scale and sits on a raised circular presentation plinth.
   */
  const environment = new THREE.Group();
  environment.name = 'ThunderbladeShowroom';

  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x242827,
    roughness: 0.72,
    metalness: 0.08
  });

  const platformMat = new THREE.MeshStandardMaterial({
    color: 0x111313,
    roughness: 0.38,
    metalness: 0.48
  });

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x111516,
    roughness: 0.62,
    metalness: 0.12
  });

  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x202526,
    roughness: 0.55,
    metalness: 0.2
  });

  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x5b3525,
    roughness: 0.5,
    metalness: 0.18
  });

  const amberMat = new THREE.MeshBasicMaterial({
    color: 0xffb45c,
    transparent: true,
    opacity: 0.95
  });

  const coolMat = new THREE.MeshBasicMaterial({
    color: 0x8ec7df,
    transparent: true,
    opacity: 0.85
  });

  // Compact polished showroom floor. The hidden navigation plane remains
  // available, while this visible floor is the actual teleport surface.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 18),
    floorMat
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.22;
  environment.add(floor);

  // Subtle floor reflection panels.
  for (let i = -2; i <= 2; i++) {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(3.7, 0.012, 0.025),
      new THREE.MeshBasicMaterial({ color: 0x3b4140, transparent: true, opacity: 0.42 })
    );
    strip.position.set(i * 3.7, -0.205, -5.8);
    environment.add(strip);
  }

  // Raised circular display platform. Top remains at y=0 so the original
  // real-world car placement stays correct.
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(3.05, 3.18, 0.24, 96),
    platformMat
  );
  platform.position.y = -0.12;
  environment.add(platform);

  const platformTop = new THREE.Mesh(
    new THREE.CylinderGeometry(2.82, 2.82, 0.025, 96),
    blackMat
  );
  platformTop.position.y = 0.012;
  environment.add(platformTop);

  // Warm luminous ring around the plinth.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.95, 0.055, 10, 128),
    amberMat
  );
  ring.position.y = -0.02;
  ring.rotation.x = Math.PI / 2;
  environment.add(ring);

  const ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(3.15, 0.035, 10, 128),
    new THREE.MeshBasicMaterial({ color: 0xffd29a, transparent: true, opacity: 0.5 })
  );
  ring2.position.y = -0.11;
  ring2.rotation.x = Math.PI / 2;
  environment.add(ring2);

  // Rear wall and side walls.
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(22, 7.5, 0.35),
    wallMat
  );
  backWall.position.set(0, 3.55, -7.7);
  environment.add(backWall);

  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(0.35, 7.5, 15.4),
    wallMat
  );
  leftWall.position.set(-10.8, 3.55, 0);
  environment.add(leftWall);

  const rightWall = leftWall.clone();
  rightWall.position.x = 10.8;
  environment.add(rightWall);

  // Dark upper ceiling.
  const ceiling = new THREE.Mesh(
    new THREE.BoxGeometry(22, 0.3, 15.4),
    blackMat
  );
  ceiling.position.y = 7.25;
  environment.add(ceiling);

  // Warm ceiling light rings.
  for (const radius of [2.2, 4.0, 5.8]) {
    const ceilingRing = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.028, 8, 128),
      amberMat
    );
    ceilingRing.position.y = 7.05;
    ceilingRing.rotation.x = Math.PI / 2;
    environment.add(ceilingRing);
  }

  // Vertical timber/metal slats, inspired by the reference showroom.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const slat = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, 5.6, 0.28),
        trimMat
      );
      slat.position.set(side * (7.3 + i * 0.32), 2.75, -7.48);
      environment.add(slat);
    }
  }

  // Thin architectural light bars on the back wall.
  for (const x of [-8.6, -4.2, 4.2, 8.6]) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(2.8, 0.035, 0.035),
      amberMat
    );
    bar.position.set(x, 1.7 + (Math.abs(x) % 2) * 1.1, -7.49);
    environment.add(bar);
  }

  // Large technical information panels.
  const leftDisplay = makeDisplayPanel(
    'THUNDERBLADE',
    'FORMULA STUDENT',
    'ENGINEERING  /  PERFORMANCE',
    0x0b1112
  );
  leftDisplay.position.set(-6.9, 3.1, -7.45);
  leftDisplay.scale.set(1.05, 1.05, 1.05);
  environment.add(leftDisplay);

  const rightDisplay = makeSpecPanel();
  rightDisplay.position.set(6.9, 3.05, -7.43);
  environment.add(rightDisplay);

  // Two smaller wall screens.
  const screen1 = makeTechnicalScreen('AERODYNAMICS', 'DOWNFORCE  /  EFFICIENCY');
  screen1.position.set(-3.2, 4.35, -7.48);
  environment.add(screen1);

  const screen2 = makeTechnicalScreen('VEHICLE SYSTEMS', 'CAD  /  SIMULATION  /  DATA');
  screen2.position.set(3.2, 4.35, -7.48);
  environment.add(screen2);

  // Trophy shelves at the sides.
  for (const side of [-1, 1]) {
    const shelf = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.10, 0.6),
      trimMat
    );
    shelf.position.set(side * 9.15, 2.3, -6.9);
    environment.add(shelf);

    for (let j = 0; j < 3; j++) {
      const trophy = makeTrophy();
      trophy.position.set(side * 9.15, 2.42, -7.0 + j * 0.16);
      trophy.scale.setScalar(0.72);
      environment.add(trophy);
    }
  }

  // Minimal showroom entry portal on the front side.
  const portal = new THREE.Mesh(
    new THREE.BoxGeometry(4.8, 4.5, 0.18),
    panelMat
  );
  portal.position.set(0, 2.15, 7.55);
  environment.add(portal);

  const portalGlow = new THREE.Mesh(
    new THREE.BoxGeometry(4.1, 0.04, 0.04),
    coolMat
  );
  portalGlow.position.set(0, 4.25, 7.43);
  environment.add(portalGlow);

  // Small floor markers around the display platform.
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * Math.PI * 2;
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.65, 0.018, 0.035),
      i % 2 ? coolMat : amberMat
    );
    marker.position.set(Math.cos(angle) * 5.15, -0.18, Math.sin(angle) * 5.15);
    marker.rotation.y = -angle;
    environment.add(marker);
  }

  groundVisual.visible = false;
  // The navigation root is unscaled, so the showroom stays at its authored
  // real-world size while only the car visual is enlarged.
  environment.scale.setScalar(1);
  carRoot.add(environment);
}

function makeDisplayPanel(title, subtitle, detail, color) {
  const group = new THREE.Group();
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(4.5, 2.0),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
  );
  panel.rotation.y = Math.PI;
  group.add(panel);

  const texture = makeCanvasTexture(900, 400, ctx => {
    ctx.fillStyle = '#0b1112';
    ctx.fillRect(0, 0, 900, 400);
    ctx.strokeStyle = '#4a5557';
    ctx.lineWidth = 2;
    ctx.strokeRect(24, 24, 852, 352);
    ctx.fillStyle = '#f1f1ec';
    ctx.font = 'bold 58px Arial';
    ctx.fillText(title, 52, 120);
    ctx.fillStyle = '#d29a61';
    ctx.font = 'bold 25px Arial';
    ctx.fillText(subtitle, 55, 170);
    ctx.fillStyle = '#94a2a4';
    ctx.font = '19px Arial';
    ctx.fillText(detail, 55, 225);
    ctx.strokeStyle = '#d29a61';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(55, 275);
    ctx.lineTo(420, 275);
    ctx.stroke();
    ctx.fillStyle = '#6f7c7e';
    ctx.font = '16px monospace';
    ctx.fillText('CAD  •  CFD  •  FEA  •  TEST  •  TRACK', 55, 325);
  });
  panel.material.map = texture;
  panel.material.needsUpdate = true;
  return group;
}

function makeTechnicalScreen(title, subtitle) {
  const group = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(2.65, 1.45, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x090c0d, roughness: .38, metalness: .25 })
  );
  group.add(frame);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(2.35, 1.15),
    new THREE.MeshBasicMaterial({ map: makeCanvasTexture(800, 400, ctx => {
      ctx.fillStyle = '#101718'; ctx.fillRect(0,0,800,400);
      ctx.strokeStyle = '#526163'; ctx.lineWidth = 2;
      for (let x=40; x<760; x+=90) { ctx.beginPath(); ctx.moveTo(x,40); ctx.lineTo(x,360); ctx.stroke(); }
      for (let y=60; y<360; y+=75) { ctx.beginPath(); ctx.moveTo(35,y); ctx.lineTo(765,y); ctx.stroke(); }
      ctx.strokeStyle = '#d39a63'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(55,315); ctx.bezierCurveTo(170,120,280,260,380,110); ctx.bezierCurveTo(500,20,600,210,740,70); ctx.stroke();
      ctx.fillStyle = '#f3f3ef'; ctx.font = 'bold 30px Arial'; ctx.fillText(title, 45, 55);
      ctx.fillStyle = '#91a0a2'; ctx.font = '17px Arial'; ctx.fillText(subtitle, 45, 82);
    }), side: THREE.DoubleSide })
  );
  screen.position.z = 0.045;
  group.add(screen);
  return group;
}

function makeSpecPanel() {
  const group = new THREE.Group();
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 2.55),
    new THREE.MeshBasicMaterial({ map: makeCanvasTexture(840, 510, ctx => {
      ctx.fillStyle = '#0b1011'; ctx.fillRect(0,0,840,510);
      ctx.strokeStyle = '#4d585a'; ctx.lineWidth = 2; ctx.strokeRect(18,18,804,474);
      ctx.fillStyle = '#f4f4ef'; ctx.font = 'bold 42px Arial'; ctx.fillText('THUNDERBLADE', 45, 70);
      ctx.fillStyle = '#d19a63'; ctx.font = 'bold 23px Arial'; ctx.fillText('VEHICLE SPECIFICATION', 46, 108);
      ctx.fillStyle = '#c1cbcc'; ctx.font = '20px monospace';
      const rows = [['LENGTH','2.85 m'],['WIDTH','1.48 m'],['HEIGHT','1.19 m'],['WHEELBASE','1.55 m'],['CLASS','FORMULA STUDENT']];
      rows.forEach((r,i)=>{ const y=165+i*55; ctx.fillStyle='#7e8a8c'; ctx.fillText(r[0],48,y); ctx.fillStyle='#f0f0eb'; ctx.fillText(r[1],390,y); });
    }), side: THREE.DoubleSide })
  );
  group.add(panel);
  return group;
}

function makeTrophy() {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xb87835, metalness: .75, roughness: .24 });
  const trophyBaseMat = new THREE.MeshStandardMaterial({
    color: 0x050606,
    roughness: 0.36,
    metalness: 0.28
  });
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(.18,.28,.32,24), gold);
  cup.position.y = .22;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(.07,.09,.18,20), gold);
  neck.position.y = .47;
  const base = new THREE.Mesh(new THREE.BoxGeometry(.36,.10,.25), trophyBaseMat);
  base.position.y = .08;
  g.add(cup, neck, base);
  return g;
}

function makeCanvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function getXRViewCamera() {
  return renderer.xr.getCamera(camera);
}

function updateXRTarget(forceShow = false) {
  if (!xrActive) return;

  const xrCamera = getXRViewCamera();

  xrCamera.getWorldPosition(gazeOrigin);
  xrCamera.getWorldDirection(gazeDirection);

  if (navigationMode === 'fly') {
    if (!pinchAiming && !forceShow) {
      teleportCursor.visible = false;
      return;
    }

    const distance = 5;

    targetPoint
      .copy(gazeOrigin)
      .addScaledVector(
        gazeDirection,
        distance
      );

    setCursor(targetPoint, true);

    return;
  }

  /*
   * Teleport:
   * only allow actual upward-facing track/runoff surfaces.
   */
  raycaster.set(
    gazeOrigin,
    gazeDirection
  );

  raycaster.far = 500;

  const hits = [];

  if (carRoot) {
    raycaster.intersectObject(
      carRoot,
      true,
      hits
    );
  }

  let validHit = null;

  for (const h of hits) {
    if (!h.face) continue;

    hitNormal
      .copy(h.face.normal)
      .transformDirection(
        h.object.matrixWorld
      );

    if (hitNormal.y < 0.55) continue;

    if (h.point.y < -0.5) continue;

    validHit = h;
    break;
  }

  if (validHit) {
    targetPoint.copy(validHit.point);
    lastSurfaceNormal.copy(hitNormal);
    setCursor(targetPoint, true);
    return;
  }

  /*
   * Fallback to the virtual circuit floor.
   */
  if (
    Math.abs(gazeDirection.y) > 0.015 &&
    gazeDirection.y < 0
  ) {
    const d =
      -gazeOrigin.y /
      gazeDirection.y;

    if (d > .7 && d < 500) {
      targetPoint
        .copy(gazeOrigin)
        .addScaledVector(
          gazeDirection,
          d
        );

      lastSurfaceNormal.set(0,1,0);

      setCursor(targetPoint, true);
      return;
    }
  }

  teleportCursor.visible = false;
  cursorValid = false;
}

function setCursor(point, valid) {
  cursorValid = valid;
  teleportCursor.visible = valid;
  teleportCursor.position.copy(point);

  const pulse =
    1 +
    Math.sin(
      performance.now() * .008
    ) * .07;

  teleportCursor.scale.setScalar(pulse);

  const color =
    valid ? 0x39d98a : 0xff5c6c;

  teleportCursor.material.color.setHex(color);
  cursorInner.material.color.setHex(color);
}

function onXRSelectStart(event) {
  if (!xrActive) return;

  pinchAiming = true;
  updateXRTarget(true);
}

function onXRSelect(event) {
  if (
    !xrActive ||
    performance.now() - lastTeleport < 350
  ) {
    return;
  }
}

function onXRSelectEnd(event) {
  if (!xrActive) return;

  pinchAiming = false;

  if (
    performance.now() -
    lastTeleport <
    650
  ) {
    return;
  }

  if (navigationMode === 'teleport') {
    if (cursorValid) {
      lastTeleport = performance.now();

      teleportToSurface(
        targetPoint,
        lastSurfaceNormal
      );
    }
  } else {
    flyForward();
  }

  teleportCursor.visible = false;
}

function teleportToSurface(point, normal) {
  if (!carRoot) return;

  const destination = point.clone();
  const verticalOffset = destination.y;

  const xrCamera = getXRViewCamera();
  const viewer = new THREE.Vector3();

  xrCamera.getWorldPosition(viewer);

  const dx = destination.x - viewer.x;
  const dz = destination.z - viewer.z;

  carRoot.position.x -= dx;
  carRoot.position.z -= dz;
  carRoot.position.y -= verticalOffset;
}

function flyForward() {
  if (!carRoot) return;

  const xrCamera = getXRViewCamera();

  xrCamera.getWorldDirection(
    gazeDirection
  );

  const distance = 4.0;

  const move =
    gazeDirection
      .clone()
      .multiplyScalar(distance);

  carRoot.position.x -= move.x;
  carRoot.position.y -= move.y;
  carRoot.position.z -= move.z;
}

function resetExperience(recenterToCurrentView) {
  if (!carRoot) return;

  carRoot.position.copy(
    initialCarPosition
  );

  carRoot.quaternion.copy(
    initialCarQuaternion
  );

  carRoot.scale.copy(
    initialCarScale
  );

  carRoot.updateMatrixWorld(true);

  if (
    renderer.xr.isPresenting &&
    recenterToCurrentView
  ) {
    const xrCamera = getXRViewCamera();

    const viewer = new THREE.Vector3();
    const dir = new THREE.Vector3();

    xrCamera.getWorldPosition(viewer);
    xrCamera.getWorldDirection(dir);

    /*
     * Horizontal direction only.
     */
    dir.y = 0;

    if (dir.lengthSq() < .001) {
      dir.set(0,0,-1);
    }

    dir.normalize();

    /*
     * Place the car approximately 3 m
     * in front of the user, keeping the real-world model scale unchanged.
     */
    const center =
      viewer.clone()
        .addScaledVector(
          dir,
          XR_START_DISTANCE
        );

    center.y = XR_START_HEIGHT;

    carRoot.position.x = center.x;
    carRoot.position.y = center.y;
    carRoot.position.z = center.z;
  }

  setModeUI();
  teleportCursor.visible = false;
}

function onDesktopPointerMove(event) {
  if (!desktopMode || xrActive) return;

  const rect =
    renderer.domElement.getBoundingClientRect();

  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  raycaster.setFromCamera(ndc, camera);

  const hits = [];

  if (carRoot) {
    raycaster.intersectObject(
      carRoot,
      true,
      hits
    );
  }

  let best = null;

  const n = new THREE.Vector3();

  for (const h of hits) {
    if (!h.face) continue;

    n.copy(h.face.normal)
      .transformDirection(
        h.object.matrixWorld
      );

    if (
      n.y >= .38 &&
      h.point.y >= -.5
    ) {
      best = h;
      break;
    }
  }

  if (best) {
    setCursor(best.point, true);
    return;
  }

  const floorHit =
    raycaster.intersectObject(
      groundPlane,
      false
    )[0];

  if (floorHit) {
    setCursor(
      floorHit.point,
      true
    );
  } else {
    teleportCursor.visible = false;
  }
}

function onDesktopClick(event) {
  if (
    !desktopMode ||
    xrActive ||
    event.button !== 0 ||
    !teleportCursor.visible
  ) {
    return;
  }

  if (navigationMode === 'teleport') {
    teleportToSurface(
      teleportCursor.position,
      new THREE.Vector3(0,1,0)
    );
  } else {
    flyForward();
  }
}

function exitExperience() {
  const session =
    renderer.xr.getSession();

  if (session) {
    session.end();
  } else {
    desktopMode = false;

    hud.classList.add('hidden');
    desktopHelp.classList.add('hidden');
    teleportCursor.visible = false;
    menu.classList.remove('hidden');
  }
}

function onResize() {
  camera.aspect =
    innerWidth / innerHeight;

  camera.updateProjectionMatrix();

  renderer.setSize(
    innerWidth,
    innerHeight
  );
}

function render() {
  clock.getDelta();

  if (!xrActive) {
    controls.update();
  }

  if (
    xrActive &&
    pinchAiming
  ) {
    updateXRTarget();
  }

  renderer.render(
    scene,
    camera
  );
}
