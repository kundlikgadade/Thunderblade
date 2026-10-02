import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

const MODEL = './public/model/Thunderblade.glb';

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
const XR_START_DISTANCE = 4.5;
const XR_START_HEIGHT = 0;

/*
 * The car is placed on the virtual circuit.
 * The procedural environment is deliberately separate from
 * the GLB so the same car file remains untouched.
 */
const TRACK_RADIUS = 38;
const TRACK_WIDTH = 10;
const RUNOFF_RADIUS = 58;

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
  scene.background = new THREE.Color(0x9eb8c5);
  scene.fog = new THREE.Fog(0x9eb8c5, 80, 260);

  camera = new THREE.PerspectiveCamera(
    65,
    innerWidth / innerHeight,
    0.05,
    1000
  );

  camera.position.set(0, 2.0, 7);

  scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x243026, 2.1));

  const sun = new THREE.DirectionalLight(0xfff2d6, 3.0);
  sun.position.set(60, 100, 40);
  scene.add(sun);

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
  renderer.toneMappingExposure = 1.1;
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
  new GLTFLoader().load(
    MODEL,
    gltf => {
      carRoot = gltf.scene;

      modelBox.setFromObject(carRoot);
      modelBox.getCenter(modelCenter);
      modelBox.getSize(modelSize);

      /*
       * Center the car horizontally and put its lowest point
       * on the virtual circuit surface.
       */
      carRoot.position.x -= modelCenter.x;
      carRoot.position.z -= modelCenter.z;
      carRoot.position.y -= modelBox.min.y;

      carRoot.updateMatrixWorld(true);

      initialCarPosition.copy(carRoot.position);
      initialCarQuaternion.copy(carRoot.quaternion);
      initialCarScale.copy(carRoot.scale);

      scene.add(carRoot);

      createFormulaStudentEnvironment();

      camera.position.set(0, 1.9, Math.max(modelSize.z * 2.8, 7));
      controls.target.set(0, Math.min(modelSize.y * 0.55, 0.8), 0);
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
      console.error(err);
      loading.classList.add('hidden');
      $('error').classList.remove('hidden');
      $('errorText').textContent =
        'The Thunderblade model could not be loaded. Keep public/model/Thunderblade.glb intact and run through HTTP/HTTPS.';
    }
  );
}

function createFormulaStudentEnvironment() {
  /*
   * ============================================================
   * FORMULA STUDENT TEST CIRCUIT
   * ============================================================
   *
   * Design:
   * - Dark asphalt circular test track
   * - Light concrete/grass runoff
   * - White/red track curbs
   * - Cones
   * - Tire barriers
   * - Pit wall / paddock area
   * - Distant low-poly hills
   * - Bright open sky
   *
   * The environment is parented to the car so all navigation
   * continues to move the virtual world around the user.
   */

  const environment = new THREE.Group();
  environment.name = 'FormulaStudentEnvironment';

  const asphaltMat = new THREE.MeshStandardMaterial({
    color: 0x252a29,
    roughness: 0.94,
    metalness: 0
  });

  const runoffMat = new THREE.MeshStandardMaterial({
    color: 0x59665b,
    roughness: 1
  });

  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xf1f1e9,
    roughness: .82
  });

  const redMat = new THREE.MeshStandardMaterial({
    color: 0xc93232,
    roughness: .82
  });

  const barrierMat = new THREE.MeshStandardMaterial({
    color: 0x141717,
    roughness: .92
  });

  const pitWallMat = new THREE.MeshStandardMaterial({
    color: 0xc7c9c5,
    roughness: .9
  });

  /*
   * Large surrounding ground.
   */
  const surroundingGround = new THREE.Mesh(
    new THREE.CircleGeometry(RUNOFF_RADIUS, 96),
    runoffMat
  );

  surroundingGround.rotation.x = -Math.PI / 2;
  surroundingGround.position.y = -0.035;
  environment.add(surroundingGround);

  /*
   * Main circular asphalt track.
   */
  const track = new THREE.Mesh(
    new THREE.RingGeometry(
      TRACK_RADIUS - TRACK_WIDTH / 2,
      TRACK_RADIUS + TRACK_WIDTH / 2,
      128
    ),
    asphaltMat
  );

  track.rotation.x = -Math.PI / 2;
  track.position.y = 0;
  environment.add(track);

  /*
   * Central infield.
   */
  const infield = new THREE.Mesh(
    new THREE.CircleGeometry(
      TRACK_RADIUS - TRACK_WIDTH / 2,
      96
    ),
    runoffMat
  );

  infield.rotation.x = -Math.PI / 2;
  infield.position.y = -0.015;
  environment.add(infield);

  /*
   * Track edge curbs.
   */
  addCurbs(
    environment,
    TRACK_RADIUS - TRACK_WIDTH / 2 - 0.55,
    1.05,
    96
  );

  addCurbs(
    environment,
    TRACK_RADIUS + TRACK_WIDTH / 2 + 0.55,
    1.05,
    96
  );

  /*
   * Starting grid.
   */
  const gridGroup = new THREE.Group();

  for (let row = 0; row < 6; row++) {
    for (let col = -1; col <= 1; col++) {
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(0.055, 2.0),
        whiteMat
      );

      line.rotation.x = -Math.PI / 2;

      line.position.set(
        col * 2.0,
        0.012,
        -8 - row * 3
      );

      gridGroup.add(line);
    }
  }

  environment.add(gridGroup);

  /*
   * Pit lane.
   */
  const pitLane = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 55),
    asphaltMat
  );

  pitLane.rotation.x = -Math.PI / 2;
  pitLane.position.set(18, 0.008, -10);
  environment.add(pitLane);

  /*
   * Pit wall.
   */
  const pitWall = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.85, 55),
    pitWallMat
  );

  pitWall.position.set(
    10.5,
    0.425,
    -10
  );

  environment.add(pitWall);

  /*
   * Pit garages / paddock structures.
   */
  for (let i = 0; i < 5; i++) {
    const garage = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(7, 3.2, 6),
      new THREE.MeshStandardMaterial({
        color: 0x26353a,
        roughness: .86
      })
    );

    body.position.y = 1.6;

    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(7.4, .18, 6.4),
      new THREE.MeshStandardMaterial({
        color: 0x101719,
        roughness: .9
      })
    );

    roof.position.y = 3.25;

    const opening = new THREE.Mesh(
      new THREE.PlaneGeometry(4.8, 2.5),
      new THREE.MeshBasicMaterial({
        color: 0x07100f
      })
    );

    opening.position.set(
      0,
      1.35,
      3.01
    );

    garage.add(
      body,
      roof,
      opening
    );

    garage.position.set(
      15.0,
      0,
      -27 + i * 7
    );

    environment.add(garage);
  }

  /*
   * Cones around the track.
   */
  const coneMat = new THREE.MeshStandardMaterial({
    color: 0xf27a24,
    roughness: .8
  });

  for (let i = 0; i < 24; i++) {
    const angle = i / 24 * Math.PI * 2;
    const radius = TRACK_RADIUS + 3.2;

    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(.16, .55, 16),
      coneMat
    );

    cone.position.set(
      Math.cos(angle) * radius,
      .275,
      Math.sin(angle) * radius
    );

    environment.add(cone);
  }

  /*
   * Tire barriers.
   */
  for (let i = 0; i < 18; i++) {
    const angle = i / 18 * Math.PI * 2;
    const radius = TRACK_RADIUS + 8;

    const tire = new THREE.Mesh(
      new THREE.TorusGeometry(
        .34,
        .11,
        10,
        20
      ),
      barrierMat
    );

    tire.rotation.x = Math.PI / 2;

    tire.position.set(
      Math.cos(angle) * radius,
      .34,
      Math.sin(angle) * radius
    );

    environment.add(tire);
  }

  /*
   * Distant hills.
   */
  const hillMat = new THREE.MeshStandardMaterial({
    color: 0x52675a,
    roughness: 1,
    flatShading: true
  });

  for (let i = 0; i < 20; i++) {
    const angle = i / 20 * Math.PI * 2;
    const radius = 105 + (i % 4) * 15;
    const width = 18 + (i % 4) * 6;
    const height = 9 + (i % 5) * 4;

    const hill = new THREE.Mesh(
      new THREE.ConeGeometry(width, height, 8),
      hillMat
    );

    hill.scale.z = .6;

    hill.position.set(
      Math.cos(angle) * radius,
      height / 2,
      Math.sin(angle) * radius
    );

    environment.add(hill);
  }

  /*
   * Sky dome.
   */
  const skyTexture = createSkyTexture();

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 48, 24),
    new THREE.MeshBasicMaterial({
      map: skyTexture,
      side: THREE.BackSide,
      depthWrite: false
    })
  );

  sky.renderOrder = -10;
  environment.add(sky);

  /*
   * Sun.
   */
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(10, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffe2a0,
      transparent: true,
      opacity: .7,
      depthWrite: false
    })
  );

  sunDisc.position.set(-100, 90, -120);
  sunDisc.lookAt(0, 20, 0);
  sunDisc.renderOrder = -5;
  environment.add(sunDisc);

  /*
   * Keep the legacy floor hidden.
   */
  groundVisual.visible = false;

  /*
   * Parent everything to the car so the existing navigation
   * logic continues to work without modification.
   */
  carRoot.add(environment);
}

function addCurbs(parent, radius, width, segments) {
  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xf1f1e9,
    roughness: .82
  });

  const redMat = new THREE.MeshStandardMaterial({
    color: 0xc93232,
    roughness: .82
  });

  const segmentLength = 2.2;

  for (let i = 0; i < segments; i++) {
    const angle = i / segments * Math.PI * 2;
    const material = i % 2 === 0 ? redMat : whiteMat;

    const curb = new THREE.Mesh(
      new THREE.BoxGeometry(
        width,
        .07,
        segmentLength
      ),
      material
    );

    curb.position.set(
      Math.cos(angle) * radius,
      .035,
      Math.sin(angle) * radius
    );

    curb.rotation.y = -angle;

    parent.add(curb);
  }
}

function createSkyTexture() {
  const canvas = document.createElement('canvas');

  canvas.width = 512;
  canvas.height = 256;

  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(
    0,
    0,
    0,
    canvas.height
  );

  gradient.addColorStop(0, '#31688c');
  gradient.addColorStop(.36, '#74a5b8');
  gradient.addColorStop(.68, '#d9c39d');
  gradient.addColorStop(.84, '#d8b083');
  gradient.addColorStop(1, '#7c8069');

  ctx.fillStyle = gradient;
  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  for (let i = 0; i < 10; i++) {
    const x = (i * 91) % canvas.width;
    const y = 65 + (i % 4) * 24;
    const w = 60 + (i % 5) * 28;
    const h = 10 + (i % 3) * 5;

    const cloud = ctx.createRadialGradient(
      x,
      y,
      0,
      x,
      y,
      w
    );

    cloud.addColorStop(
      0,
      'rgba(255,255,255,.18)'
    );

    cloud.addColorStop(
      1,
      'rgba(255,255,255,0)'
    );

    ctx.fillStyle = cloud;

    ctx.fillRect(
      x - w,
      y - h,
      w * 2,
      h * 2
    );
  }

  const texture =
    new THREE.CanvasTexture(canvas);

  texture.colorSpace =
    THREE.SRGBColorSpace;

  texture.wrapS =
    THREE.RepeatWrapping;

  texture.repeat.x = 2;

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

    const distance = 7;

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

  const distance = 6.0;

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
     * Place the car approximately 4.5 m
     * in front of the user.
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
