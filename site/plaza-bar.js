// Plaza "COIN HOF": a Seoul-style crypto drinking corner in the square.
// A two-storey hof (pub) covered in stacked neon signs, a Korean-exchange style tiled price wall on its
// facade (real quotes only, see market-screen.js), red-orange pojangmacha tents with steel tables and
// plastic stools in front, soju crates, and festoon bulbs between the plaza lamps.
// Purely decorative apart from the price wall. All signage is English only (no Hangul).
import { createExchangeWall } from './market-screen.js?v=growth4-20261022';

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

// Warm pub interior seen through floor-to-ceiling glass (no people: residents only).
function glazedInteriorTexture(THREE, { width = 768, height = 512 } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const wall = ctx.createLinearGradient(0, 0, 0, height);
  wall.addColorStop(0, '#5a3020'); wall.addColorStop(0.55, '#c9773a'); wall.addColorStop(1, '#8a4a26');
  ctx.fillStyle = wall; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#3a2116'; ctx.fillRect(0, height * 0.82, width, height * 0.18);           // floor
  ctx.fillStyle = '#6b3d22';
  for (let x = 0; x < width; x += 48) ctx.fillRect(x, height * 0.82, 3, height * 0.18);
  // back-bar shelves with bottles
  for (const sy of [0.36, 0.52]) {
    ctx.fillStyle = '#4a2a18'; ctx.fillRect(width * 0.08, height * sy, width * 0.84, 8);
    for (let x = width * 0.1; x < width * 0.9; x += 22) {
      ctx.fillStyle = ['#2fbf71', '#f0a52a', '#9fd8ff', '#2fbf71'][Math.floor(x / 22) % 4];
      ctx.fillRect(x, height * sy - 30, 9, 30); ctx.fillRect(x + 2.5, height * sy - 40, 4, 10);
    }
  }
  // booths and round tables
  for (let i = 0; i < 4; i += 1) {
    const cx = width * (0.16 + i * 0.23);
    ctx.fillStyle = '#7a2a22'; roundRect(ctx, cx - 62, height * 0.64, 124, height * 0.18, 10); ctx.fill();
    ctx.fillStyle = '#d9b48a'; ctx.beginPath(); ctx.ellipse(cx, height * 0.7, 46, 10, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2b1a12'; ctx.fillRect(cx - 4, height * 0.7, 8, height * 0.12);
    ctx.fillStyle = '#f0a52a'; ctx.fillRect(cx - 18, height * 0.66, 9, 14); ctx.fillStyle = '#2fbf71'; ctx.fillRect(cx + 8, height * 0.655, 8, 18);
  }
  // pendant lamps with warm pools
  for (let i = 0; i < 5; i += 1) {
    const cx = width * (0.1 + i * 0.2);
    const g = ctx.createRadialGradient(cx, height * 0.2, 4, cx, height * 0.2, 150);
    g.addColorStop(0, 'rgba(255,214,140,0.95)'); g.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = g; ctx.fillRect(cx - 150, 0, 300, height * 0.8);
    ctx.strokeStyle = '#2b1a12'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height * 0.16); ctx.stroke();
    ctx.fillStyle = '#ffe2a8'; ctx.beginPath(); ctx.moveTo(cx - 18, height * 0.2); ctx.lineTo(cx - 8, height * 0.15); ctx.lineTo(cx + 8, height * 0.15); ctx.lineTo(cx + 18, height * 0.2); ctx.fill();
  }
  // glass sheen
  const sheen = ctx.createLinearGradient(0, 0, width, height);
  sheen.addColorStop(0, 'rgba(180,230,255,0.18)'); sheen.addColorStop(0.4, 'rgba(180,230,255,0)'); sheen.addColorStop(0.6, 'rgba(180,230,255,0.1)'); sheen.addColorStop(1, 'rgba(180,230,255,0)');
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, width, height);
  return canvasTexture(THREE, canvas);
}

// Rooftop billboard: a chicken-and-beer ad (no prices, no market numbers).
function billboardTexture(THREE, [headline, subline] = ['CHICKEN + BEER', 'HAPPY HOUR 6 - 9 PM'], { width = 1024, height = 400 } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#ffb21e'); bg.addColorStop(1, '#ff5a2a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  for (let i = -4; i < 12; i += 1) { ctx.beginPath(); ctx.moveTo(i * 120, height); ctx.lineTo(i * 120 + 60, height); ctx.lineTo(i * 120 + 260, 0); ctx.lineTo(i * 120 + 200, 0); ctx.fill(); }
  // beer mug
  ctx.fillStyle = '#ffd34d'; roundRect(ctx, 60, 120, 150, 210, 18); ctx.fill();
  ctx.fillStyle = '#fff8e6'; ctx.beginPath(); ctx.ellipse(135, 122, 88, 36, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 22; ctx.beginPath(); ctx.arc(215, 220, 46, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(90, 160, 16, 140);
  // drumstick
  ctx.fillStyle = '#b5561c'; ctx.beginPath(); ctx.ellipse(860, 190, 92, 70, -0.5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff3dc'; ctx.save(); ctx.translate(900, 260); ctx.rotate(-0.5); ctx.fillRect(0, -12, 90, 24);
  ctx.beginPath(); ctx.arc(95, -14, 16, 0, TAU); ctx.arc(95, 14, 16, 0, TAU); ctx.fill(); ctx.restore();
  // copy
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#2a0f06'; ctx.font = `900 92px ${FONT}`; ctx.fillText(headline, width / 2, 140);
  ctx.fillStyle = '#ffffff'; ctx.font = `800 58px ${FONT}`; ctx.fillText(subline, width / 2, 236);
  ctx.fillStyle = '#2a0f06'; roundRect(ctx, width / 2 - 170, 290, 340, 70, 35); ctx.fill();
  ctx.fillStyle = '#ffe14d'; ctx.font = `800 44px ${FONT}`; ctx.fillText('AT COIN HOF', width / 2, 326);
  ctx.strokeStyle = '#2a0f06'; ctx.lineWidth = 16; ctx.strokeRect(8, 8, width - 16, height - 16);
  return canvasTexture(THREE, canvas);
}

// Thin neon tube (a horizontal glowing stroke, used rotated for verticals).
function neonTubeTexture(THREE, color) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 32;
  const ctx = canvas.getContext('2d');
  glowPass(ctx, color, (stroke) => { ctx.strokeStyle = stroke; ctx.lineWidth = stroke === '#ffffff' ? 3 : 8; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(12, 16); ctx.lineTo(244, 16); ctx.stroke(); });
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
  // irregular plan: the back-right corner is cut on a long diagonal (a five-sided footprint), the upper
  // floor cantilevers out over the diagonal, and a skewed glass penthouse with a tilted roof sits on top
  const CUT = 1.1;                                                                     // size of the diagonal cut
  const plan = [[-W / 2, D / 2], [W / 2, D / 2], [W / 2, -D / 2 + CUT], [W / 2 - CUT, -D / 2], [-W / 2, -D / 2]];
  // grow (d > 0) or shrink a convex counter-clockwise (in x, -z) polygon by moving every edge out by d
  const offsetPlan = (pts, d) => pts.map((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
    const n = (u, v) => { const dx = v[0] - u[0], dz = v[1] - u[1], l = Math.hypot(dx, dz); return [-dz / l, dx / l]; };
    const n1 = n(a, p), n2 = n(p, b), k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    return [p[0] + ((n1[0] + n2[0]) / k) * d, p[1] + ((n1[1] + n2[1]) / k) * d];
  });
  const prism = (pts, h, material, y, parent = hof) => {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }); geometry.rotateX(-Math.PI / 2);
    return mesh(geometry, material, 0, y, 0, parent);
  };
  // the cantilevered upper floor: the diagonal face pushed out by OVER
  const OVER = 0.22;
  const upperPlan = plan.map(([x, z], i) => (i === 2 ? [x, z - OVER * Math.SQRT2] : i === 3 ? [x + OVER * Math.SQRT2, z] : [x, z]));
  prism(offsetPlan(plan, 0.08), 0.08, slab, 0);                                       // plinth
  // ground floor: open-fronted bar (left wall solid for the signs, the rest glass, see glassWall)
  box(0.12, G1, D, wallLow, -(W / 2 - 0.06), 0.08, 0, hof);                           // left wall (signs)
  prism(offsetPlan(upperPlan, 0.03), 0.07, slab, 0.08 + G1);                           // floor line
  prism(offsetPlan(upperPlan, -0.02), G2, wallHigh, upperY);                           // upper floor
  prism(offsetPlan(upperPlan, 0.04), 0.12, trim, roofY);                               // parapet cap
  // steel struts under the cantilever
  for (const t of [0.2, 0.8]) {
    const px = upperPlan[2][0] + (upperPlan[3][0] - upperPlan[2][0]) * t, pz = upperPlan[2][1] + (upperPlan[3][1] - upperPlan[2][1]) * t;
    const strut = box(0.05, 0.42, 0.05, std('#2c2a30', { metalness: 0.6, roughness: 0.35 }), px - 0.12, 0.08 + G1 - 0.4, pz + 0.12, hof);
    strut.rotation.y = Math.PI / 4; strut.rotation.x = -0.35;
  }
  // warm interior: glowing back wall, shelves of bottles, counter with bottles and glasses
  const interior = keep(new THREE.MeshStandardMaterial({ color: '#ffcf8a', emissive: '#ff9f45', emissiveIntensity: 0.9, flatShading: true }));
  mesh(new THREE.PlaneGeometry(W - CUT - 0.2, G1 - 0.1), interior, -CUT / 2, 0.08 + G1 / 2, -D / 2 + 0.125, hof, false);
  const shelf = std('#5a3a26');
  for (const sy of [0.62, 0.92]) {
    const sw = W - CUT - 0.5, sx0 = -W / 2 + 0.25;
    box(sw, 0.03, 0.16, shelf, sx0 + sw / 2, sy, -D / 2 + 0.2, hof);
    for (let i = 0; i < 10; i += 1) {
      const bx = sx0 + 0.05 + (i * (sw - 0.1)) / 9;
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
  prism(offsetPlan(plan, -0.14), 0.005, interior, 0.085).castShadow = false;
  const barLight = new THREE.PointLight('#ffb060', 2.4, 4.5, 1.6); barLight.position.set(0.3, 0.85, FRONT - 0.35); hof.add(barLight);
  // warm striped awning over the open bar, wood posts at the opening
  const awning = std('#e2672e', { emissive: '#ff6a22', emissiveIntensity: 0.25 });
  const awn = box(W - 0.9, 0.05, 0.24, awning, 0.45, G1 - 0.04, FRONT + 0.1, hof); awn.rotation.x = 0.35;
  for (const px of [-W / 2 + 1.0, W / 2 - 0.06]) box(0.1, G1, 0.1, trim, px, 0.08, FRONT - 0.02, hof);
  // roof clutter: AC units, water tank
  const metal = std('#a7acb8', { metalness: 0.5, roughness: 0.4 });
  for (const [ax, az] of [[0.35, -0.62], [0.55, 0.12]]) {
    box(0.46, 0.32, 0.36, metal, ax, roofY + 0.12, az, hof);
    mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 10), std('#4a4f5c'), ax, roofY + 0.45, az, hof, false);
  }
  mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 10), std('#b9bec8', { metalness: 0.4, roughness: 0.45 }), 1.08, roofY + 0.37, 0.42, hof);

  // tiled exchange wall across the whole upper front
  const wall = createExchangeWall(THREE, { width: W * 0.92 });
  const wallY = upperY + 0.04 + wall.height / 2;
  wall.group.position.set(0, wallY, FRONT + 0.07); hof.add(wall.group);
  const wallTop = wallY + wall.height / 2;
  // crown: COIN HOF, 24H above it, bull beside it
  plate(neonSignTexture(THREE, 'COIN HOF', NEON.cyan, { width: 640, height: 170, size: 112, ink: NEON.yellow }), 1.75, 0.1, wallTop + 0.3, FRONT + 0.06, hof, { color: NEON.cyan });
  plate(neonSignTexture(THREE, '24H', NEON.pink, { width: 300, height: 170, size: 112, ink: NEON.yellow }), 0.7, 0.1, wallTop + 0.82, FRONT + 0.04, hof, { color: NEON.pink });
  plate(iconTexture(THREE, 'bull', NEON.red), 0.85, 1.32, wallTop + 0.36, FRONT + 0.04, hof, { color: NEON.red, glow: 1.1 });

  // the back and right walls: floor-to-ceiling glass on both floors, neon trim and a rooftop billboard
  // built in a local frame: +x points out of the wall, z runs along it
  const glassWall = ({ yaw, cx, cz, L, upperSign, lowerSign, ad, bz = 0, tubes, over = 0 }) => {
    const face = new THREE.Group(); face.rotation.y = yaw; face.position.set(cx, 0, cz); hof.add(face);
    const RX = 0, UX = over;                                 // ground-floor plane, upper-floor plane (cantilever)
    const bw = L - 0.2;
    const glass = keep(new THREE.MeshStandardMaterial({ color: '#9fd6ea', transparent: true, opacity: 0.22, metalness: 0.6, roughness: 0.05, depthWrite: false }));
    const mullion = std('#2c2a30', { metalness: 0.6, roughness: 0.35 });
    // ground floor: real glass, the lit bar shows through
    mesh(new THREE.PlaneGeometry(L - 0.08, G1 - 0.04), glass, RX - 0.02, 0.08 + G1 / 2, 0, face, false).rotation.y = Math.PI / 2;
    // upper floor: warm interior behind glass
    const inside = keep(glazedInteriorTexture(THREE));
    const insideMat = keep(new THREE.MeshBasicMaterial({ map: inside, toneMapped: false }));
    mesh(new THREE.PlaneGeometry(L - 0.08, G2 - 0.08), insideMat, UX - 0.015, upperY + G2 / 2, 0, face, false).rotation.y = Math.PI / 2;
    mesh(new THREE.PlaneGeometry(L - 0.08, G2 - 0.08), glass, UX + 0.01, upperY + G2 / 2, 0, face, false).rotation.y = Math.PI / 2;
    glowAt(UX + 0.3, upperY + G2 * 0.55, 0, 2.2, '#ffb060', face).material.opacity = 0.12;
    // mullions: vertical every ~0.6, and sills/heads on both floors
    const panes = Math.max(2, Math.round(L / 0.5));
    for (let i = 0; i <= panes; i += 1) {
      const z = -L / 2 + 0.04 + (i * (L - 0.08)) / panes;
      box(0.05, G1, 0.05, mullion, RX, 0.08, z, face);
      box(0.05, G2, 0.05, mullion, UX + 0.01, upperY, z, face);
    }
    for (const y of [0.08, 0.08 + G1 - 0.04]) box(0.06, 0.04, L, mullion, RX + 0.005, y, 0, face);
    for (const y of [upperY, roofY - 0.04]) box(0.06, 0.04, L, mullion, UX + 0.005, y, 0, face);
    // neon: vertical tubes at both corners, a band between the floors
    const tube = (color, length, y, z, vertical, x = UX) => {
      const p = plate(neonTubeTexture(THREE, color), length, x + 0.05, y, z, face, { color, glow: 0, height: 0.07, yaw: Math.PI / 2 });
      if (vertical) p.rotation.z = Math.PI / 2;
      for (let k = 0; k < 3; k += 1) glowAt(x + 0.15, vertical ? y - length / 3 + (k * length) / 3 : y, vertical ? z : z - length / 3 + (k * length) / 3, 0.55, color, face);
      return p;
    };
    if (tubes[0]) tube(tubes[0], G2 - 0.06, upperY + G2 / 2, L / 2 - 0.04, true);
    if (tubes[1]) tube(tubes[1], G2 - 0.06, upperY + G2 / 2, -L / 2 + 0.04, true);
    tube(NEON.amber, L - 0.16, upperY - 0.02, 0, false, Math.max(RX, UX));
    // neon script boards hung inside the glass
    plate(neonSignTexture(THREE, upperSign[0], upperSign[1], { width: 520, height: 160, size: 96, ink: NEON.yellow, plate: 'rgba(10,6,20,0.55)' }), Math.min(0.9, L * 0.6), UX + 0.04, upperY + G2 * 0.78, -L * 0.15, face, { color: upperSign[1], glow: 0.7, yaw: Math.PI / 2 });
    plate(neonSignTexture(THREE, lowerSign[0], lowerSign[1], { width: 560, height: 160, size: 88, ink: NEON.yellow, plate: 'rgba(10,6,20,0.55)' }), Math.min(0.85, L * 0.6), RX + 0.04, 0.08 + G1 * 0.74, L * 0.15, face, { color: lowerSign[1], glow: 0.7, yaw: Math.PI / 2 });
    plate(iconTexture(THREE, 'beer', NEON.amber), 0.36, RX + 0.04, 0.08 + G1 * 0.7, -L * 0.34, face, { color: NEON.amber, glow: 0.8, yaw: Math.PI / 2 });
    if (!ad) return;
    // rooftop billboard on a steel frame
    const bh = 0.66, by = roofY + 0.2 + bh / 2;
    for (const z of [bz - bw * 0.36, bz + bw * 0.36]) box(0.05, by - roofY, 0.05, mullion, UX - 0.15, roofY + 0.06, z, face);
    box(0.06, bh + 0.08, bw + 0.08, mullion, UX - 0.12, by - bh / 2 - 0.04, bz, face);
    plate(billboardTexture(THREE, ad), bw, UX - 0.085, by, bz, face, { color: '#ffb347', glow: 0, height: bh, yaw: Math.PI / 2 });
    for (const z of [bz - bw * 0.33, bz, bz + bw * 0.33]) {
      box(0.18, 0.025, 0.025, mullion, UX - 0.02, by + bh / 2 + 0.04, z, face);
      mesh(new THREE.SphereGeometry(0.03, 8, 6), bulbWarm, UX + 0.06, by + bh / 2 + 0.02, z, face, false);
      glowAt(UX + 0.1, by + 0.1, z, 0.8, '#ffe0a0', face);
    }
  };
  // back wall, the long diagonal (hero glass + billboard, cantilevered), and the short right wall
  const diag = Math.hypot(CUT, CUT);
  glassWall({ yaw: Math.PI / 2, cx: -CUT / 2, cz: -D / 2, L: W - CUT, upperSign: ['LIVE BAR', NEON.pink], lowerSign: ['SOJU BEER', NEON.green],
    tubes: [null, NEON.cyan] });
  glassWall({ yaw: Math.PI / 4, cx: W / 2 - CUT / 2, cz: -D / 2 + CUT / 2, L: diag, over: OVER, upperSign: ['CHIMAEK', NEON.amber], lowerSign: ['OPEN 24H', NEON.cyan],
    ad: ['CHICKEN + BEER', 'HAPPY HOUR 6 - 9 PM'], tubes: [NEON.yellow, NEON.pink] });
  glassWall({ yaw: 0, cx: W / 2, cz: CUT / 2, L: D - CUT, upperSign: ['HODL', NEON.green], lowerSign: ['GRILL', NEON.amber], tubes: [null, null] });

  // skewed glass penthouse with a tilted, overhanging roof (breaks the box silhouette)
  {
    const ph = new THREE.Group(); ph.position.set(-0.45, roofY + 0.12, -0.35); ph.rotation.y = 0.32; hof.add(ph);
    const PW = 1.25, PD = 0.85, PH = 0.62;
    box(PW, PH, PD, wallHigh, 0, 0, 0, ph);
    const view = keep(new THREE.MeshBasicMaterial({ map: keep(glazedInteriorTexture(THREE, { width: 512, height: 256 })), toneMapped: false }));
    const pane = mesh(new THREE.PlaneGeometry(PD - 0.08, PH - 0.08), view, PW / 2 + 0.005, PH / 2, 0, ph, false); pane.rotation.y = Math.PI / 2;
    mesh(new THREE.PlaneGeometry(PW - 0.08, PH - 0.08), view, 0, PH / 2, -PD / 2 - 0.005, ph, false).rotation.y = Math.PI;
    const roof = box(PW + 0.5, 0.05, PD + 0.3, trim, 0.15, PH + 0.06, 0, ph); roof.rotation.z = 0.2;
    plate(neonTubeTexture(THREE, NEON.cyan), PW + 0.4, 0.15, PH + 0.02, PD / 2 + 0.16, ph, { color: NEON.cyan, glow: 0, height: 0.06 });
    glowAt(0.2, PH * 0.6, 0, 1.4, '#ffb060', ph).material.opacity = 0.12;
  }

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
  plate(iconTexture(THREE, 'beer', NEON.amber), 0.36, -0.9, 1.0, -D / 2 + 0.14, hof, { color: NEON.amber, glow: 0.9 });
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
