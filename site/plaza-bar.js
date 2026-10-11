// Plaza "COIN HOF": a Seoul-style crypto drinking corner in the square.
// A two-storey hof (pub) covered in stacked neon signs, a Korean-exchange style tiled price wall on its
// facade (real quotes only, see market-screen.js), red-orange pojangmacha tents with steel tables and
// plastic stools in front, soju crates, and festoon bulbs between the plaza lamps.
// Purely decorative apart from the price wall. All signage is English only (no Hangul).
import { createExchangeWall } from './market-screen.js';

const TAU = Math.PI * 2;
const NEON = { pink: '#ff4fa3', cyan: '#3ee8ff', violet: '#a46bff', amber: '#ffb347', green: '#5dffa0', red: '#ff4d5e', yellow: '#ffe14d' };
const FONT = "'Geist', 'DM Sans', system-ui, sans-serif";

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function glowPass(ctx, color, draw) {
  for (const [blur, alpha, stroke] of [[34, 0.9, color], [14, 1, color], [0, 1, '#ffffff']]) {
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.globalAlpha = alpha; draw(stroke); ctx.restore();
  }
}

function canvasTexture(THREE, canvas) {
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
}

// Horizontal neon board with a dark backing plate.
function neonSignTexture(THREE, text, color, { width = 512, height = 160, size = 96, frame = true, plate = 'rgba(10,6,20,0.86)', ink } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = plate; roundRect(ctx, 4, 4, width - 8, height - 8, 22); ctx.fill();
  if (frame) glowPass(ctx, color, (stroke) => { ctx.strokeStyle = stroke; ctx.lineWidth = stroke === '#ffffff' ? 2 : 6; roundRect(ctx, 14, 14, width - 28, height - 28, 16); ctx.stroke(); });
  ctx.font = `800 ${size}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let fit = size; while (ctx.measureText(text).width > width - 60 && fit > 20) { fit -= 4; ctx.font = `800 ${fit}px ${FONT}`; }
  glowPass(ctx, ink || color, (stroke) => { ctx.fillStyle = stroke; ctx.fillText(text, width / 2, height / 2 + 4); });
  return canvasTexture(THREE, canvas);
}

// Vertical street sign: letters stacked top to bottom on a coloured light box, like the signs that climb
// Seoul shop fronts.
function verticalSignTexture(THREE, text, color, { width = 160, letter = 128, box = '#0c0a16', ink } = {}) {
  const letters = [...text], height = letters.length * letter + 60;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = box; roundRect(ctx, 4, 4, width - 8, height - 8, 18); ctx.fill();
  glowPass(ctx, color, (stroke) => { ctx.strokeStyle = stroke; ctx.lineWidth = stroke === '#ffffff' ? 2 : 6; roundRect(ctx, 14, 14, width - 28, height - 28, 12); ctx.stroke(); });
  ctx.font = `800 ${Math.round(letter * 0.78)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  letters.forEach((ch, i) => glowPass(ctx, ink || color, (stroke) => { ctx.fillStyle = stroke; ctx.fillText(ch, width / 2, 30 + letter * (i + 0.5) + 4); }));
  return canvasTexture(THREE, canvas);
}

// Neon line icons on a transparent background.
function iconTexture(THREE, kind, color) {
  const size = 256, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const stroke = (path) => glowPass(ctx, color, (c) => { ctx.strokeStyle = c; ctx.lineWidth = c === '#ffffff' ? 3 : 9; path(); ctx.stroke(); });
  if (kind === 'rocket') {
    ctx.translate(128, 128); ctx.rotate(-0.6); ctx.translate(-128, -128);
    stroke(() => { ctx.beginPath(); ctx.moveTo(128, 22); ctx.bezierCurveTo(176, 62, 176, 150, 156, 182); ctx.lineTo(100, 182); ctx.bezierCurveTo(80, 150, 80, 62, 128, 22); });
    stroke(() => { ctx.beginPath(); ctx.arc(128, 96, 18, 0, TAU); });
    stroke(() => { ctx.beginPath(); ctx.moveTo(100, 150); ctx.lineTo(72, 196); ctx.lineTo(102, 182); ctx.moveTo(156, 150); ctx.lineTo(184, 196); ctx.lineTo(154, 182); });
    glowPass(ctx, NEON.amber, (c) => { ctx.strokeStyle = c; ctx.lineWidth = c === '#ffffff' ? 3 : 9; ctx.beginPath(); ctx.moveTo(110, 194); ctx.quadraticCurveTo(128, 250, 146, 194); ctx.stroke(); });
  } else if (kind === 'bull') {
    stroke(() => {
      ctx.beginPath();
      ctx.moveTo(40, 70); ctx.quadraticCurveTo(60, 110, 96, 104);     // left horn
      ctx.moveTo(216, 70); ctx.quadraticCurveTo(196, 110, 160, 104);  // right horn
      ctx.moveTo(96, 100); ctx.quadraticCurveTo(128, 88, 160, 100);   // brow
      ctx.lineTo(166, 150); ctx.quadraticCurveTo(160, 206, 128, 214); ctx.quadraticCurveTo(96, 206, 90, 150); ctx.closePath();
    });
    stroke(() => { ctx.beginPath(); ctx.arc(112, 136, 6, 0, TAU); ctx.moveTo(150, 136); ctx.arc(144, 136, 6, 0, TAU); });
    stroke(() => { ctx.beginPath(); ctx.ellipse(128, 190, 22, 14, 0, 0, TAU); });
  } else if (kind === 'beer') {
    stroke(() => { ctx.beginPath(); ctx.moveTo(70, 70); ctx.lineTo(80, 214); ctx.lineTo(166, 214); ctx.lineTo(176, 70); });
    stroke(() => { ctx.beginPath(); ctx.moveTo(176, 100); ctx.quadraticCurveTo(226, 110, 222, 150); ctx.quadraticCurveTo(218, 180, 170, 180); });
    glowPass(ctx, '#fff6d6', (c) => { ctx.strokeStyle = c; ctx.lineWidth = c === '#ffffff' ? 3 : 9; ctx.beginPath(); ctx.moveTo(62, 70); ctx.quadraticCurveTo(90, 36, 124, 58); ctx.quadraticCurveTo(156, 34, 184, 70); ctx.stroke(); });
  } else if (kind === 'chart') {
    stroke(() => { ctx.beginPath(); ctx.moveTo(36, 200); ctx.lineTo(96, 150); ctx.lineTo(136, 172); ctx.lineTo(214, 66); });
    stroke(() => { ctx.beginPath(); ctx.moveTo(176, 62); ctx.lineTo(218, 62); ctx.lineTo(218, 104); });
  }
  return canvasTexture(THREE, canvas);
}

function glowTexture(THREE) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d'), g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

// facing: the yaw of the default camera; the hof's front and the tents turn toward it.
export function createPlazaBar(THREE, { lampAngles = [], lampRadius = 3.85, lampHeight = 1.27, facing = -0.55 } = {}) {
  const group = new THREE.Group(); group.name = 'plaza-coin-hof';
  const disposables = [];
  const keep = (thing) => { disposables.push(thing); return thing; };
  const std = (color, extra = {}) => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.6, flatShading: true, ...extra }));
  const glowMap = keep(glowTexture(THREE));
  const glows = [], signs = [];
  const mesh = (geometry, material, x = 0, y = 0, z = 0, parent = group, cast = true) => {
    keep(geometry); const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (w, h, d, material, x, y, z, parent) => mesh(new THREE.BoxGeometry(w, h, d), material, x, y + h / 2, z, parent);
  const glowAt = (x, y, z, size, color, parent = group) => {
    const material = keep(new THREE.SpriteMaterial({ map: glowMap, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.2 }));
    const sprite = new THREE.Sprite(material); sprite.position.set(x, y, z); sprite.scale.set(size, size, 1); parent.add(sprite); glows.push(sprite); return sprite;
  };
  // a textured plane facing local +z
  function plate(texture, width, x, y, z, parent, { color, yaw = 0, glow = 1.25, height } = {}) {
    keep(texture);
    const aspect = texture.image.height / texture.image.width;
    const material = keep(new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false }));
    const plane = new THREE.Mesh(keep(new THREE.PlaneGeometry(width, height ?? width * aspect)), material);
    plane.position.set(x, y, z); plane.rotation.y = yaw; parent.add(plane);
    signs.push(material);
    if (color && glow) glowAt(x + Math.sin(yaw) * 0.08, y, z + Math.cos(yaw) * 0.08, width * glow, color, parent);
    return plane;
  }

  // camera-facing frame: f points from the square's centre toward the default camera, r to its right
  const f = [Math.sin(facing), Math.cos(facing)], r = [Math.cos(facing), -Math.sin(facing)];
  const at = (front, right) => [f[0] * front + r[0] * right, f[1] * front + r[1] * right];

  // shared props: bottles, glasses, steel, plastic
  const pole = std('#3b3b46'), steel = std('#cfd3dc', { metalness: 0.75, roughness: 0.28 });
  const stoolBlue = std('#2f6fe0'), stoolRed = std('#e2343f');
  const soju = std('#2fbf71', { transparent: true, opacity: 0.88, emissive: '#1f8f52', emissiveIntensity: 0.5, roughness: 0.15 });
  const beer = std('#f0a52a', { emissive: '#ff9a1f', emissiveIntensity: 0.6, roughness: 0.2 });
  const chicken = std('#c97a2c', { roughness: 0.9 }), dish = std('#f4f1ea');
  const crate = std('#1f9a55', { roughness: 0.7 });
  const bulbWarm = keep(new THREE.MeshStandardMaterial({ color: '#ffe0a0', emissive: '#ffcf70', emissiveIntensity: 2, flatShading: true }));
  const bottleGeo = keep(new THREE.CylinderGeometry(0.035, 0.04, 0.17, 7)), neckGeo = keep(new THREE.CylinderGeometry(0.014, 0.02, 0.06, 6));
  const glassGeo = keep(new THREE.CylinderGeometry(0.035, 0.03, 0.09, 7));
  let seed = 11; const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  function bottle(x, y, z, parent) {
    mesh(bottleGeo, soju, x, y + 0.085, z, parent, false); mesh(neckGeo, soju, x, y + 0.2, z, parent, false);
  }

  // --- the hof ---------------------------------------------------------------------------------------
  // Turned a little so its sign-covered left wall shows to the default camera as well as the screen.
  const hof = new THREE.Group(); hof.name = 'coin-hof';
  const TURN = 0.45;
  const [hx, hz] = at(-1.0, -0.35);
  hof.position.set(hx, 0, hz); hof.rotation.y = facing + TURN; hof.scale.setScalar(1.25); group.add(hof);
  const W = 3.0, D = 2.4, G1 = 1.05, G2 = 1.72, FRONT = D / 2, LEFT = -W / 2;
  const upperY = 0.08 + G1 + 0.07, roofY = upperY + G2;
  const wallLow = std('#8a5a3a'), wallHigh = std('#9a503a'), slab = std('#4f3b2e'), trim = std('#6b4a36');
  box(W + 0.16, 0.08, D + 0.16, slab, 0, 0, 0, hof);                                  // plinth
  // ground floor: open-fronted bar (back wall, side walls, ceiling)
  box(W, G1, 0.12, wallLow, 0, 0.08, -D / 2 + 0.06, hof);
  for (const side of [-1, 1]) box(0.12, G1, D, wallLow, side * (W / 2 - 0.06), 0.08, 0, hof);
  box(W + 0.06, 0.07, D + 0.06, slab, 0, 0.08 + G1, 0, hof);                           // floor line
  box(W, G2, D, wallHigh, 0, upperY, 0, hof);                                          // upper floor
  box(W + 0.08, 0.12, D + 0.08, trim, 0, roofY, 0, hof);                               // parapet cap
  // warm interior: glowing back wall, shelves of bottles, counter with bottles and glasses
  const interior = keep(new THREE.MeshStandardMaterial({ color: '#ffcf8a', emissive: '#ff9f45', emissiveIntensity: 0.9, flatShading: true }));
  mesh(new THREE.PlaneGeometry(W - 0.26, G1 - 0.1), interior, 0, 0.08 + G1 / 2, -D / 2 + 0.125, hof, false);
  const shelf = std('#5a3a26');
  for (const sy of [0.62, 0.92]) {
    box(W - 0.5, 0.03, 0.16, shelf, 0, sy, -D / 2 + 0.2, hof);
    for (let i = 0; i < 16; i += 1) {
      const bx = -(W - 0.6) / 2 + (i * (W - 0.6)) / 15;
      if (i % 4 === 3) mesh(glassGeo, beer, bx, sy + 0.075, -D / 2 + 0.2, hof, false); else bottle(bx, sy + 0.03, -D / 2 + 0.2, hof);
    }
  }
  box(1.0, G1, 0.12, wallLow, -W / 2 + 0.5, 0.08, FRONT - 0.06, hof);                  // closed left bay
  box(W - 0.4, 0.55, 0.32, std('#c08550', { emissive: '#ff8a30', emissiveIntensity: 0.55 }), 0, 0.08, FRONT - 0.3, hof);                  // counter
  box(W - 0.34, 0.04, 0.38, std('#a8794f', { roughness: 0.35 }), 0, 0.63, FRONT - 0.3, hof);
  for (let i = 0; i < 9; i += 1) {
    const bx = -(W - 0.7) / 2 + (i * (W - 0.7)) / 8;
    if (i % 3 === 1) mesh(glassGeo, beer, bx, 0.72, FRONT - 0.3, hof, false); else bottle(bx, 0.67, FRONT - 0.3, hof);
  }
  for (const px of [-0.5, 0.4, 1.2]) glowAt(px, 0.85, FRONT - 0.2, 1.3, '#ffc070', hof);
  // warm light spilling out of the open bar
  mesh(new THREE.PlaneGeometry(W - 0.3, D - 0.3), interior, 0, 0.09, 0, hof, false).rotation.x = -Math.PI / 2;
  const barLight = new THREE.PointLight('#ffb060', 2.4, 4.5, 1.6); barLight.position.set(0.3, 0.85, FRONT - 0.35); hof.add(barLight);
  // warm striped awning over the open bar, wood posts at the opening
  const awning = std('#e2672e', { emissive: '#ff6a22', emissiveIntensity: 0.25 });
  const awn = box(W - 0.9, 0.05, 0.24, awning, 0.45, G1 - 0.04, FRONT + 0.1, hof); awn.rotation.x = 0.35;
  for (const px of [-W / 2 + 1.0, W / 2 - 0.06]) box(0.1, G1, 0.1, trim, px, 0.08, FRONT - 0.02, hof);
  // roof clutter: AC units, water tank
  const metal = std('#a7acb8', { metalness: 0.5, roughness: 0.4 });
  for (const [ax, az] of [[-1.0, -0.4], [-0.35, -0.5], [0.5, -0.55]]) {
    box(0.46, 0.32, 0.36, metal, ax, roofY + 0.12, az, hof);
    mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 10), std('#4a4f5c'), ax, roofY + 0.45, az, hof, false);
  }
  mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 10), std('#b9bec8', { metalness: 0.4, roughness: 0.45 }), 1.05, roofY + 0.37, -0.45, hof);

  // tiled exchange wall across the whole upper front
  const wall = createExchangeWall(THREE, { width: W * 0.92 });
  const wallY = upperY + 0.04 + wall.height / 2;
  wall.group.position.set(0, wallY, FRONT + 0.07); hof.add(wall.group);
  const wallTop = wallY + wall.height / 2;
  // crown: COIN HOF, 24H above it, bull beside it
  plate(neonSignTexture(THREE, 'COIN HOF', NEON.cyan, { width: 640, height: 170, size: 112, ink: NEON.yellow }), 1.75, 0.1, wallTop + 0.3, FRONT + 0.06, hof, { color: NEON.cyan });
  plate(neonSignTexture(THREE, '24H', NEON.pink, { width: 300, height: 170, size: 112, ink: NEON.yellow }), 0.7, 0.1, wallTop + 0.82, FRONT + 0.04, hof, { color: NEON.pink });
  plate(iconTexture(THREE, 'bull', NEON.red), 0.85, 1.32, wallTop + 0.36, FRONT + 0.04, hof, { color: NEON.red, glow: 1.1 });

  // the left wall: signs in clear vertical zones (back column / centre stack / front column), no overlap
  const sideX = LEFT - 0.04;
  const sideSign = (texture, width, u, y, color, height, depth = 0.02) =>
    plate(texture, width, sideX - depth, y, u, hof, { color, glow: 0.55, height, yaw: -Math.PI / 2 + 0.38 });
  const H2 = G2 - 0.12;                       // usable height of the upper floor
  // roof: big COIN HOF board along the top edge
  sideSign(neonSignTexture(THREE, 'COIN HOF', NEON.cyan, { width: 640, height: 200, size: 124, ink: NEON.pink }), 1.7, 0, roofY + 0.36, NEON.cyan, 0.53);
  // back column: tall vertical BEER
  sideSign(verticalSignTexture(THREE, 'BEER', NEON.cyan, { ink: NEON.pink }), 0.32, -0.88, upperY + 0.06 + H2 / 2, NEON.cyan, H2);
  // front column: tall vertical GAZUA
  sideSign(verticalSignTexture(THREE, 'GAZUA', NEON.yellow, { ink: NEON.pink }), 0.32, 0.88, upperY + 0.06 + H2 / 2, NEON.yellow, H2);
  // centre stack: four boards, evenly spaced, each in its own band
  const boards = [['SOJU', NEON.pink, NEON.yellow], ['CHIMAEK', NEON.amber, NEON.yellow], ['HODL', NEON.green, NEON.yellow], ['TO THE MOON', NEON.pink, NEON.cyan]];
  const band = H2 / boards.length;
  boards.forEach(([label, color, ink], i) => {
    sideSign(neonSignTexture(THREE, label, color, { width: 640, height: 190, size: label.length > 8 ? 92 : 112, ink }), 1.15, 0, roofY - 0.12 - band * (i + 0.5), color, band * 0.78);
  });
  // ground floor: 24H column at the back, OPEN / BEER boards in the middle
  sideSign(verticalSignTexture(THREE, '24H', NEON.yellow, { ink: NEON.cyan }), 0.28, -0.8, 0.08 + G1 / 2, NEON.yellow, G1 - 0.2);
  sideSign(neonSignTexture(THREE, 'OPEN', NEON.green, { width: 420, height: 170, size: 104, ink: NEON.yellow }), 0.75, 0.1, 0.08 + G1 * 0.72, NEON.green, 0.3);
  sideSign(neonSignTexture(THREE, 'CHICKEN', NEON.amber, { width: 520, height: 170, size: 96, ink: NEON.pink }), 0.75, 0.1, 0.08 + G1 * 0.32, NEON.amber, 0.28);
  // the rocket and a small rocket over the bar
  plate(iconTexture(THREE, 'rocket', NEON.violet), 0.95, LEFT - 0.95, upperY + 0.55, 0.1, hof, { color: NEON.violet, glow: 1.1, yaw: -TURN - 0.3 });
  plate(iconTexture(THREE, 'rocket', NEON.violet), 0.42, -1.05, 0.78, FRONT + 0.02, hof, { color: NEON.violet, glow: 0.9 });
  plate(iconTexture(THREE, 'beer', NEON.amber), 0.36, 1.05, 1.0, -D / 2 + 0.14, hof, { color: NEON.amber, glow: 0.9 });
  // projecting blade sign on the right corner
  {
    const texture = keep(verticalSignTexture(THREE, 'HOF', NEON.amber, { box: '#1a0d06' }));
    for (const side of [1, -1]) plate(texture, 0.3, W / 2 + 0.2 + (side < 0 ? -0.004 : 0), upperY + 0.5, FRONT - 0.1, hof, { color: NEON.amber, glow: 1.2, height: 0.62, yaw: side * Math.PI / 2 });
    box(0.42, 0.03, 0.03, trim, W / 2 + 0.12, upperY + 0.82, FRONT - 0.1, hof);
  }

  // --- drinkers: low-poly patrons on the stools (decorative, not residents) --------------------------
  // --- pojangmacha stalls, steel tables, plastic stools ---------------------------------------------
  const stallLamps = [];
  const tarp = std('#e8562a', { emissive: '#ff5a1f', emissiveIntensity: 0.3, side: THREE.DoubleSide, roughness: 0.8 });
  // round stainless table with four plastic stools, soju, beer, fried chicken, and drinkers on some stools
  function tableSet(parent, x, z, drinkers = 2) {
    const set = new THREE.Group(); set.position.set(x, 0, z); set.rotation.y = rand() * TAU; set.scale.setScalar(1.25); parent.add(set);
    mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 16), steel, 0, 0.44, 0, set);
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 6), steel, 0, 0.22, 0, set);
    mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.02, 10), steel, 0, 0.01, 0, set);
    const seats = [0, 1, 2, 3].map((i) => (i / 4) * TAU + 0.4);
    seats.forEach((a, i) => mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.25, 8), i % 2 ? stoolBlue : stoolRed, Math.cos(a) * 0.48, 0.125, Math.sin(a) * 0.48, set));
    mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.02, 12), dish, 0.05, 0.47, 0.02, set, false);
    for (let k = 0; k < 4; k += 1) mesh(new THREE.IcosahedronGeometry(0.035, 0), chicken, 0.05 + (rand() - 0.5) * 0.1, 0.5, 0.02 + (rand() - 0.5) * 0.1, set, false);
    bottle(-0.14, 0.455, 0.1, set); bottle(-0.1, 0.455, -0.14, set); bottle(0.16, 0.455, 0.12, set);
    mesh(glassGeo, beer, 0.18, 0.5, -0.1, set, false); mesh(glassGeo, beer, -0.2, 0.5, -0.02, set, false);
    return set;
  }
  // tall stacks of soju / beer crates
  const crateBlue = std('#2563eb', { roughness: 0.7 });
  function crates(root, x0, z0, count = 4) {
    const parent = new THREE.Group(); parent.position.set(x0, 0, z0); parent.scale.setScalar(1.25); root.add(parent); const x = 0, z = 0;
    for (let col = 0; col < 2; col += 1) for (let i = 0; i < count - col; i += 1) {
      const ox = col * 0.28, oy = i * 0.155, mat = (i + col) % 3 === 2 ? crateBlue : crate;
      box(0.26, 0.15, 0.2, mat, x + ox, oy, z, parent);
      if (i === count - col - 1) for (let k = 0; k < 3; k += 1) mesh(neckGeo, soju, x - 0.08 + k * 0.08 + ox, oy + 0.17, z, parent, false);
    }
  }
  // pojangmacha stall: orange tarp box, gabled roof, lit sign, open front with a counter of bottles
  function buildStall(label, color, signFace = 'front') {
    const stall = new THREE.Group();
    const w = 1.15, d = 0.85, h = 0.95;
    for (const [px, pz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) mesh(new THREE.CylinderGeometry(0.022, 0.022, h, 5), pole, px, h / 2, pz, stall);
    box(w, h, 0.02, tarp, 0, 0, -d / 2, stall);                                           // back
    for (const side of [-1, 1]) box(0.02, h * 0.62, d, tarp, side * w / 2, 0, 0, stall);   // low side walls
    box(w, h * 0.45, 0.02, tarp, 0, 0, d / 2, stall);                                     // low front
    const lamp = keep(new THREE.MeshStandardMaterial({ color: '#ffe2b0', emissive: '#ffb468', emissiveIntensity: 1, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    stallLamps.push(lamp);
    for (const side of [-1, 1]) mesh(new THREE.PlaneGeometry(d, h * 0.38), lamp, side * w / 2, h * 0.81, 0, stall, false).rotation.y = Math.PI / 2;
    const roof = keep(new THREE.BufferGeometry());
    const v = [-w / 2 - 0.07, h, -d / 2 - 0.07, w / 2 + 0.07, h, -d / 2 - 0.07, 0, h + 0.3, 0, -w / 2 - 0.07, h, d / 2 + 0.07, w / 2 + 0.07, h, d / 2 + 0.07];
    roof.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    roof.setIndex([0, 2, 1, 3, 4, 2, 0, 3, 2, 1, 2, 4]); roof.computeVertexNormals();
    const roofMesh = new THREE.Mesh(roof, tarp); roofMesh.castShadow = true; stall.add(roofMesh);
    box(w - 0.06, 0.06, 0.2, std('#f3ece0'), 0, h * 0.45, d / 2 - 0.1, stall);          // counter ledge
    for (let i = 0; i < 5; i += 1) {
      const bx = -0.4 + i * 0.2, y = h * 0.45 + 0.06;
      if (i % 2) mesh(glassGeo, beer, bx, y + 0.05, d / 2 - 0.1, stall, false); else bottle(bx, y, d / 2 - 0.1, stall);
    }
    mesh(new THREE.IcosahedronGeometry(0.05, 0), bulbWarm, 0, h + 0.05, 0.1, stall, false);
    glowAt(0, h - 0.1, 0.1, 1.2, '#ffb070', stall);
    const tex = neonSignTexture(THREE, label, color, { width: 520, height: 150, size: 88, ink: '#ffffff' });
    if (signFace === 'front') plate(tex, 0.8, 0, h * 0.62, d / 2 + 0.03, stall, { color, glow: 1.1 });
    else { const side = signFace === 'left' ? -1 : 1; plate(tex, 0.7, side * (w / 2 + 0.03), h * 0.62, 0, stall, { color, glow: 1.1, yaw: side * Math.PI / 2 }); }
    return stall;
  }
  const yard = new THREE.Group(); group.add(yard);
  // stalls: left (sign on its left face), front-right (sign in front), right (sign on its right face)
  for (const [label, color, front, right, face, turn] of [['SOJU', NEON.cyan, 2.35, -2.45, 'left', 0.55], ['CHEERS', NEON.cyan, 2.75, 1.55, 'front', -0.3], ['GRILL', NEON.cyan, 0.45, 2.85, 'right', -0.45]]) {
    const stall = buildStall(label, color, face); const [x, z] = at(front, right);
    stall.position.set(x, 0, z); stall.rotation.y = facing + turn; stall.scale.setScalar(1.3); yard.add(stall);
  }
  // a small orange tent tucked behind, left of the hof
  { const tent = buildStall('BAR', NEON.amber, 'front'); const [x, z] = at(-1.6, -2.85); tent.position.set(x, 0, z); tent.rotation.y = facing + 0.6; tent.scale.setScalar(0.9); yard.add(tent); }
  // crate stacks beside the stalls
  for (const [front, right, n] of [[3.2, -1.55, 4], [3.2, 0.35, 4], [-0.2, -2.35, 3], [1.2, 2.55, 3]]) { const [cx, cz] = at(front, right); crates(yard, cx, cz, n); }
  // tables crowd the front of the hof, with drinkers
  for (const [front, right, people] of [[0.75, -1.35, 0], [1.55, -2.0, 0], [1.85, -1.0, 0], [0.95, 1.2, 0], [1.85, 0.95, 0], [-0.75, -2.45, 0], [-0.95, 2.35, 0]]) {
    const [x, z] = at(front, right); tableSet(yard, x, z, people);
  }

  // --- festoon bulbs between the plaza lamps, plus two strings from the hof roof -------------------
  const bulbColors = ['#ffd27a', '#ff7aa8', '#7ae8ff', '#ffd27a', '#b18cff'];
  const bulbMats = bulbColors.map((color) => keep(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4, flatShading: true })));
  const bulbGeo = keep(new THREE.IcosahedronGeometry(0.045, 0));
  const wireMat = keep(new THREE.LineBasicMaterial({ color: '#6d6278', transparent: true, opacity: 0.7 }));
  const bulbs = [];
  function festoon(a, b, sag, steps = 18, offset = 0) {
    const points = [];
    for (let s = 0; s <= steps; s += 1) {
      const k = s / steps;
      points.push(new THREE.Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k - Math.sin(k * Math.PI) * sag, a.z + (b.z - a.z) * k));
    }
    group.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(points)), wireMat));
    points.forEach((p, s) => {
      if (s === 0 || s === steps) return;
      const bulb = new THREE.Mesh(bulbGeo, bulbMats[(offset + s) % bulbMats.length]);
      bulb.position.copy(p).y -= 0.04; group.add(bulb); bulbs.push(bulb);
    });
  }
  const sorted = [...lampAngles].sort((a, b) => a - b);
  const lampPoint = (a) => new THREE.Vector3(Math.cos(a) * lampRadius, lampHeight, Math.sin(a) * lampRadius);
  sorted.forEach((a0, i) => festoon(lampPoint(a0), lampPoint(sorted[(i + 1) % sorted.length]), 0.38, 18, i * 18));
  // from the hof's front roof corners to the two lamps nearest the camera
  {
    hof.updateMatrixWorld(true);
    const corner = (x) => new THREE.Vector3(x, upperY, FRONT).applyMatrix4(hof.matrixWorld);
    const byCamera = [...sorted].sort((a, b) => (Math.cos(b) * f[0] + Math.sin(b) * f[1]) - (Math.cos(a) * f[0] + Math.sin(a) * f[1])).slice(0, 2);
    const rightOf = (a) => Math.cos(a) * r[0] + Math.sin(a) * r[1];
    byCamera.sort((a, b) => rightOf(a) - rightOf(b));
    if (byCamera.length === 2) {
      festoon(corner(-W / 2 + 0.05), lampPoint(byCamera[0]), 0.45, 22, 3);
      festoon(corner(W / 2 - 0.05), lampPoint(byCamera[1]), 0.45, 22, 7);
    }
  }

  let night = 0;
  const flickerSign = signs[5] || signs[0]; // GAZUA
  return {
    group,
    board: wall,
    // kept for API compatibility with the layout pass; tents are placed at build time
    placeStalls() {},
    setNight(value) {
      night = Math.max(0, Math.min(1, value));
      interior.emissiveIntensity = 0.35 + night * 1.2;
      tarp.emissiveIntensity = 0.12 + night * 0.5;
      for (const m of stallLamps) m.emissiveIntensity = 0.3 + night * 1.6;
      for (const material of bulbMats) material.emissiveIntensity = 0.6 + night * 2.6;
      bulbWarm.emissiveIntensity = 0.8 + night * 2.5;
      for (const material of signs) material.opacity = 1;
      for (const sprite of glows) sprite.material.opacity = 0.03 + night * 0.75;
      wall.setNight(night);
    },
    tick(time, reducedMotion = false) {
      if (reducedMotion) return;
      const t = time / 1000;
      bulbs.forEach((bulb, i) => { const k = 0.75 + 0.25 * Math.sin(t * 2.2 - i * 0.55); bulb.scale.setScalar(k); });
      // the GAZUA sign sputters now and then, like a tired neon tube
      const flick = Math.sin(t * 17) > 0.985 || (t % 9 > 8.8);
      if (flickerSign) flickerSign.opacity = flick ? 0.3 : 1;
    },
    dispose() { wall.dispose(); for (const item of disposables) item.dispose?.(); }
  };
}
