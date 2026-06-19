import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader }   from 'three/addons/loaders/STLLoader.js';

/* ============================================================
   Globales Setup
   ============================================================ */
const canvas   = document.getElementById('scene');
const viewport = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setClearColor(0x05080d, 1);

const scene = new THREE.Scene();
scene.fog   = new THREE.FogExp2(0x05080d, 0.015);

const camera = new THREE.PerspectiveCamera(
  55, viewport.clientWidth/viewport.clientHeight, 0.1, 1000
);
camera.position.set(25, 18, 35);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0,0,0);

/* ============================================================
   Licht
   ============================================================ */
scene.add(new THREE.AmbientLight(0x404a5a, 1.2));

const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(20, 30, 20);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x3ea6ff, 0.8);
rimLight.position.set(-20, 10, -20);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0x00e0ff, 0.4);
fillLight.position.set(0, -20, 10);
scene.add(fillLight);

/* ============================================================
   Boden / Grid (optional, dezent)
   ============================================================ */
const grid = new THREE.GridHelper(120, 60, 0x1a2533, 0x111820);
grid.position.y = -15;
scene.add(grid);

/* ============================================================
   Windkanal-Hülle (visueller Rahmen)
   ============================================================ */
const tunnelGeo = new THREE.BoxGeometry(30, 20, 80);
const tunnelEdges = new THREE.EdgesGeometry(tunnelGeo);
const tunnelMat  = new THREE.LineBasicMaterial({ color:0x1f3a55, transparent:true, opacity:0.5 });
const tunnel     = new THREE.LineSegments(tunnelEdges, tunnelMat);
scene.add(tunnel);

/* ============================================================
   STL-Modell
   ============================================================ const stlGroup = new THREE.Group();
scene.add(stlGroup);

let stlMesh = null;

function loadSTLGeometry(geometry){
  // Altes Modell entfernen
  if (stlMesh){
    stlGroup.remove(stlMesh);
    stlMesh.geometry.dispose();
    stlMesh.material.dispose();
  }

  // Zentrieren & skalieren
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size   = new THREE.Vector3();
  bb.getSize(size);
  const center = new THREE.Vector3();
  bb.getCenter(center);

  geometry.translate(-center.x, -center.y, -center.z);

  // Auf vernünftige Größe normalisieren (max 12 Einheiten)
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale  = 12 / maxDim;
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color:0x8a96a8,
    metalness:0.3,
    roughness:0.55,
    flatShading:false,
  });

  stlMesh = new THREE.Mesh(geometry, mat);
  stlGroup.add(stlMesh);

  // Bounding Info für Shader-Ablenkung
  const newBB = new THREE.Box3().setFromObject(stlMesh);
  shaderUniforms.uModelMin.value.copy(newBB.min);
  shaderUniforms.uModelMax.value.copy(newBB.max);
  shaderUniforms.uHasModel.value = 1.0;
}

/* ============================================================
   Partikel-System (GPU-basiert)
   ============================================================ */
const PARTICLE_BOUNDS = { x:15, y:10, z:40 };

const shaderUniforms = {
  uTime:        { value: 0 },
  uWindSpeed:   { value: 1.5 },
  uSpread:      { value: 8.0 },
  uModelMin:    { value: new THREE.Vector3(-100,-100,-100) },
  uModelMax:    { value: new THREE.Vector3( 100, 100, 100) },
  uHasModel:    { value: 0.0 },
  uDeflect:     { value: 1.0 },
};

const vertexShader = /* glsl */`
  uniform float uTime;
  uniform float uWindSpeed;
  uniform float uSpread;
  uniform vec3  uModelMin;
  uniform vec3  uModelMax;
  uniform float uHasModel;
  uniform float uDeflect;

  attribute float aSeed;
  attribute float aSize;

  varying float vSpeed;
  varying float vAlpha;

  // Hash für leichte Turbulenz
  float hash(float n){ return fract(sin(n)*43758.5453123); }

  // Schnelle Distanz zum AABB des Modells (approximativ)
  float distToBox(vec3 p, vec3 mn, vec3 mx){
    vec3 d = max(mn - p, p - mx);
    return length(max(d, 0.0));
  }

  void main(){
    // Position aus Seed rekonstruieren (stabile Verteilung)
    vec3 pos;
    pos.x = (hash(aSeed*1.13)      - 0.5) * 2.0 * uSpread;
    pos.y = (hash(aSeed*2.27 + .3) - 0.5) * 2.0 * uSpread * 0.66;
    pos.z = mod(
      (hash(aSeed*3.91 + .7) - 0.5) * 2.0 * ${PARTICLE_BOUNDS.z.toFixed(1)}
        + uTime * uWindSpeed * 18.0
        + aSeed * 50.0,
      ${PARTICLE_BOUNDS.z.toFixed(1)}
    ) - ${ (PARTICLE_BOUNDS.z/2).toFixed(1) };

    // Leichte Turbulenz (Y-Oszillation)
    float turb = sin(uTime*0.7 + aSeed*6.28) * 0.3;
    pos.y += turb;

    float speed = uWindSpeed;

    // === Ablenkung durch Modell (Zylinder-Näherung) ===
    if(uHasModel > 0.5 && uDeflect > 0.5){
      // Distanz zur Modell-AABB in XY
      vec3 localP = pos;
      float boxDist = distToBox(localP, uModelMin, uModelMax);

      // Wenn Partikel in der Nähe des Modells (in Z) und innerhalb/nahe AABB
      float inZ = step(uModelMin.z - 2.0, pos.z) * step(pos.z, uModelMax.z + 2.0);
      float proximity = 1.0 - smoothstep(0.0, 4.0, boxDist);

      if(inZ > 0.5 && proximity > 0.0){
        // Ablenkvektor: vom Zentrum weg in XY
        vec2 center = (uModelMin.xy + uModelMax.xy) * 0.5;
        vec2 outward = pos.xy - center;
        float d = length(outward);
        if(d < 0.001){ outward = vec2(1.0,0.0); d = 1.0; }
        outward /= d;

        // Push nach außen
        float push = proximity * 2.5;
        pos.xy += outward * push;

        // Geschwindigkeit ändert sich (Beschleunigung an den Seiten)
        speed *= (1.0 + proximity * 1.5);
      }
    }

    vSpeed = clamp(speed / 5.0, 0.0, 1.0);

    // Fade am vorderen/hinteren Rand
    float edgeFade = smoothstep(-${(PARTICLE_BOUNDS.z/2).toFixed(1)},
                                -${(PARTICLE_BOUNDS.z/2 - 4).toFixed(1)}, pos.z)
                   * smoothstep( ${(PARTICLE_BOUNDS.z/2).toFixed(1)},
                                  ${(PARTICLE_BOUNDS.z/2 - 4).toFixed(1)}, pos.z);
    vAlpha = edgeFade;

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPos;

    // Punktgröße mit perspektivischer Skalierung
    gl_PointSize = aSize * (300.0 / -mvPos.z);
  }
`;

const fragmentShader = /* glsl */`
  varying float vSpeed;
  varying float vAlpha;

  void main(){
    // Weicher Kreis
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c);
    if(d > 0.5) discard;

    float soft = smoothstep(0.5, 0.0, d);

    // Geschwindigkeits-Farbing: blau -> cyan -> weiß
    vec3 colSlow = vec3(0.12, 0.36, 1.0);
    vec3 colFast = vec3(0.0,  0.88, 1.0);
    vec3 colHot  = vec3(0.85, 0.95, 1.0);

    vec3 col = mix(colSlow, colFast, vSpeed);
    col      = mix(col, colHot, smoothstep(0.6, 1.0, vSpeed));

    // Leichter Glow
    float glow = pow(soft, 1.5);
    gl_FragColor = vec4(col, glow * vAlpha * 0.9);
  }
`;

let particleSystem = null;

function buildParticles(count){
  if (particleSystem){
    scene.remove(particleSystem);
    particleSystem.geometry.dispose();
    particleSystem.material.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);

  for(let i=0;i<count;i++){
    seeds[i] = Math.random() * 1000.0;
    sizes[i] = 1.0 + Math.random() * 2.5;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count*3), 3));
  geometry.setAttribute('aSeed',    new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: shaderUniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  particleSystem = new THREE.Points(geometry, material);
  scene.add(particleSystem);

  document.getElementById('particle-hud').textContent = count.toLocaleString('de-DE');
}

buildParticles(30000);

/* ============================================================
   File-Upload
   ============================================================ */
const fileInput   = document.getElementById('file-input');
const fileInfo    = document.getElementById('file-info');
const dropOverlay = document.getElementById('drop-overlay');
const stlLoader   = new STLLoader();

function handleFile(file){
  if(!file){ return; }
  if(!file.name.toLowerCase().endsWith('.stl')){
    fileInfo.textContent = '⚠ Nur .stl-Dateien unterstützt';
    return;
  }
  fileInfo.textContent = `Lade "${file.name}" … (${(file.size/1024).toFixed(1)} KB)`;

  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const geometry = stlLoader.parse(e.target.result);
      loadSTLGeometry(geometry);
      fileInfo.textContent = `✓ ${file.name} · ${(file.size/1024).toFixed(1)} KB · ${geometry.attributes.position.count} Vertices`;
    }catch(err){
      console.error(err);
      fileInfo.textContent = '✗ Fehler beim Parsen der STL-Datei';
    }
  };
  reader.readAsArrayBuffer(file);
}

fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

// Drag & Drop
['dragenter','dragover'].forEach(ev =>
  viewport.addEventListener(ev, (e) => {
    e.preventDefault();
    dropOverlay.classList.add('active');
  })
);
['dragleave','drop'].forEach(ev =>
  viewport.addEventListener(ev, (e) => {
    e.preventDefault();
    if(ev === 'dragleave' && e.relatedTarget) return;
    dropOverlay.classList.remove('active');
  })
);
viewport.addEventListener('drop', (e) => {
  if(e.dataTransfer.files.length){
    handleFile(e.dataTransfer.files[0]);
  }
});

/* ============================================================
   UI-Controller
   ============================================================ */
function bindSlider(id, valId, uniformName, formatter = (v)=>v){
  const sl = document.getElementById(id);
  const va = document.getElementById(valId);
  sl.addEventListener('input', () => {
    const v = parseFloat(sl.value);
    if(uniformName) shaderUniforms[uniformName].value = v;
    va.textContent = formatter(v);
  });
}

bindSlider('wind-speed', 'wind-speed-val', 'uWindSpeed', v => v.toFixed(1));
bindSlider('spread',      'spread-val',     'uSpread',    v => v.toFixed(1));

document.getElementById('particle-count').addEventListener('input', (e) => {
  document.getElementById('particle-count-val').textContent = e.target.value;
});
document.getElementById('particle-count').addEventListener('change', (e) => {
  buildParticles(parseInt(e.target.value, 10));
});

document.getElementById('deflect').addEventListener('change', (e) => {
  shaderUniforms.uDeflect.value = e.target.checked ? 1.0 : 0.0;
});

document.getElementById('auto-rotate').addEventListener('change', (e) => {
  controls.autoRotate = e.target.checked;
  controls.autoRotateSpeed = 1.5;
});

/* ============================================================
   FPS-Messung
   ============================================================ */
const fpsEl = document.getElementById('fps');
let lastT = performance.now();
let frames = 0;
let fpsTimer = 0;

/* ============================================================
   Animation
   ============================================================ */
const clock = new THREE.Clock();

function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  shaderUniforms.uTime.value += dt;

  controls.update();
  renderer.render(scene, camera);

  // FPS
  frames++;
  fpsTimer += dt;
  if(fpsTimer >= 0.5){
    fpsEl.textContent = Math.round(frames / fpsTimer);
    frames = 0; fpsTimer = 0;
  }
}
animate();

/* ============================================================
   Resize
   ============================================================ */
window.addEventListener('resize', () => {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

/* ============================================================
   Demo-Modell (wird beim Start geladen, damit nicht leer ist)
   ============================================================ */
function createDemoModel(){
  // Ein einfacher Flügel / Profil als Demo
  const shape = new THREE.Shape();
  shape.moveTo(0,0);
  shape.bezierCurveTo(1, 1.2, 6, 1.4, 10, 0.4);
  shape.bezierCurveTo(11, 0.2, 11, -0.1, 10, -0.3);
  shape.bezierCurveTo(6, -0.6, 1, -0.4, 0, 0);

  const extrude = new THREE.ExtrudeGeometry(shape, {
    depth: 2.5,
    bevelEnabled:true,
    bevelThickness:0.15,
    bevelSize:0.15,
    bevelSegments:2,
  });
  extrude.rotateY(Math.PI/2);
  return extrude;
}

loadSTLGeometry(createDemoModel());
fileInfo.textContent = 'Demo-Modell (Flügelprofil) · lade eigene STL für eigene Simulation';
