// Models for places that grow out of the skill library, plus the beach.
// Built in local space with the same Builder as world3d.js: front faces +z (toward the plaza),
// footprint inside a 1.8 radius. Colours come from the place's own accent.
import * as THREE from './vendor/three.module.min.js';
import { getLocale } from './i18n.js?v=growth4-20261022';
const TAU = Math.PI * 2;

function shade(hex, amount) {
  const color = new THREE.Color(hex);
  const hsl = {}; color.getHSL(hsl);
  color.setHSL(hsl.h, Math.min(1, hsl.s * (amount < 0 ? 1 : 0.7)), Math.max(0, Math.min(1, hsl.l + amount)));
  return `#${color.getHexString()}`;
}

export function placeStyle(scene, fallback) {
  const accent = scene?.features?.accent;
  if (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)) return { accent, label: shade(accent, 0.18) };
  return fallback;
}

export function placeArchetype(scene) {
  if ((scene?.sceneType) === 'beach') return 'beach';
  // council3: a public work under construction shows its site (scaffold) until it is built.
  if (scene?.features?.origin === 'public_works' && scene?.features?.publicWork?.stage === 'building') return 'construction';
  const archetype = scene?.features?.archetype;
  return typeof archetype === 'string' ? archetype : null;
}

function pad(b, color = '#cbbf9f') { b.cyl(1.75, 1.85, 0.12, 9, color, 0, 0, 0, { cast: false }); }

function hall(b, accent, r) {
  pad(b);
  b.box(2.5, 0.12, 1.3, '#e4dccb', 0, 0.12, 0.85, { cast: false });
  b.box(2.3, 1.15, 1.45, '#f1ebdd', 0, 0.12, -0.35);
  for (let i = 0; i < 5; i += 1) b.cyl(0.08, 0.09, 0.95, 8, '#fbf7ee', -0.9 + i * 0.45, 0.24, 0.62);
  b.box(2.4, 0.14, 0.5, '#efe6d2', 0, 1.19, 0.55);
  b.gable(2.5, 0.42, 0.55, shade(accent, -0.08), 0, 1.33, 0.56);
  const dome = r() < 0.5;
  if (dome) {
    b.cyl(0.55, 0.6, 0.35, 12, '#efe6d2', 0, 1.27, -0.4);
    b.add(new THREE.SphereGeometry(0.58, 14, 7, 0, TAU, 0, Math.PI / 2), accent, 0, 1.62, -0.4);
    b.cyl(0.02, 0.02, 0.4, 5, '#6d5a3a', 0, 2.15, -0.4);
  } else {
    b.gable(2.4, 0.55, 1.5, accent, 0, 1.27, -0.35);
  }
  b.door(0, 0.24, 0.31, '#5a3e2a', 0.4, 0.62);
  b.windowsRow(3, 1.0, 0.6, 0, 0.24, 0.4, { sideX: 1.16 });
  b.windowsRow(3, 1.0, 0.6, 0, 0.24, 0.4, { sideX: -1.16 });
  b.sign(accent, 1.45, 0.1, 1.35);
}

function tower(b, accent, r) {
  pad(b, '#c9c4b8');
  const floors = 3 + Math.floor(r() * 3);
  b.box(1.5, 0.45 * floors, 1.3, '#dfe4ea', -0.25, 0.12, -0.35);
  for (let f = 0; f < floors; f += 1) {
    b.windowsRow(3, 0.9, 0.28 + f * 0.45, 0.31, 0.24, 0.26);
    b.box(1.54, 0.04, 1.34, shade(accent, 0.1), -0.25, 0.12 + (f + 1) * 0.45 - 0.02, -0.35, { cast: false });
  }
  b.box(1.6, 0.1, 1.4, accent, -0.25, 0.12 + 0.45 * floors, -0.35);
  b.cyl(0.02, 0.025, 0.6, 5, '#8c949c', 0.2, 0.22 + 0.45 * floors, -0.6);
  const beacon = b.sphere(0.05, b.m.beacon, 0.2, 0.86 + 0.45 * floors, -0.6, { cast: false, dynamic: true });
  beacon.userData.beacon = true;
  b.box(0.9, 0.7, 0.9, '#eef1f4', 0.95, 0.12, 0.05);
  b.box(0.95, 0.06, 0.95, accent, 0.95, 0.82, 0.05);
  b.door(0.95, 0.12, 0.51, shade(accent, -0.2), 0.3, 0.48);
  b.sign(accent, -1.35, 0.1, 1.2);
}

function lab(b, accent, r) {
  pad(b, '#d3d0c6');
  b.box(2.1, 0.95, 1.4, '#f4f6f7', 0, 0.12, -0.35);
  b.box(1.7, 0.6, 0.05, b.m.glass, -0.1, 0.3, 0.36, { cast: false });
  b.box(1.76, 0.05, 0.08, accent, -0.1, 0.92, 0.37);
  b.box(2.16, 0.08, 1.46, shade(accent, -0.15), 0, 1.07, -0.35);
  b.door(0.82, 0.12, 0.36, accent, 0.3, 0.5);
  const dish = new THREE.Group(); dish.position.set(-0.55, 1.15, -0.55); dish.userData.dynamic = true; dish.userData.spin = 0.25;
  b.group.add(dish);
  b.add(new THREE.CylinderGeometry(0.04, 0.06, 0.3, 6), '#a8b0b8', 0, 0.15, 0, { parent: dish });
  b.add(new THREE.SphereGeometry(0.32, 12, 6, 0, TAU, 0, Math.PI / 2), '#e9edf0', 0, 0.42, 0, { parent: dish, rx: -0.9 });
  b.box(0.5, 0.25, 0.5, b.m.glass, 0.5, 1.15, -0.5, { cast: false });
  for (let i = 0; i < 3; i += 1) b.box(0.5, 0.03, 0.3, '#2c3e50', -1.0 + i * 0.4, 0.15, 1.2, { rx: -0.5, cast: false });
  b.sign(accent, 1.35, 0.1, 1.15);
}

function yard(b, accent, r) {
  pad(b, '#bdb39c');
  b.box(1.9, 1.0, 1.3, shade(accent, 0.2), -0.1, 0.12, -0.5);
  b.add(new THREE.CylinderGeometry(0.66, 0.66, 1.95, 12, 1, false, 0, Math.PI), shade(accent, -0.15), -0.1, 1.12, -0.5, { rz: Math.PI / 2, ry: 0 });
  b.box(0.8, 0.75, 0.05, '#6c6f74', -0.3, 0.12, 0.16);
  for (let i = 0; i < 5; i += 1) {
    const s = 0.24 + r() * 0.14;
    b.box(s, s, s, ['#b4864f', '#a07040', '#c79a5c'][i % 3], 0.9 + (i % 2) * 0.32, 0.12 + (i > 2 ? s : 0), 0.4 + (i % 3) * 0.28, { ry: r() * 0.5 });
  }
  b.cyl(0.05, 0.06, 1.8, 6, accent, 1.25, 0.12, -0.9);
  b.box(1.3, 0.06, 0.06, accent, 0.7, 1.9, -0.9);
  b.cyl(0.01, 0.01, 0.6, 4, '#3a3a3a', 0.2, 1.3, -0.9);
  b.box(0.18, 0.12, 0.18, '#5a5a5a', 0.2, 1.2, -0.9);
  b.sign(accent, -1.35, 0.1, 1.2);
}

function atelier(b, accent, r) {
  pad(b);
  b.box(1.9, 1.15, 1.4, '#f6efe6', 0, 0.12, -0.35);
  for (let i = 0; i < 4; i += 1) b.box(0.42, 0.95, 0.04, b.m.window, -0.69 + i * 0.46, 0.2, 0.36, { cast: false });
  b.add(new THREE.BoxGeometry(2.0, 0.08, 1.6), shade(accent, -0.1), 0, 1.42, -0.35, { rx: -0.22 });
  b.box(0.5, 0.4, 0.04, accent, -0.2, 1.4, -0.95, { rx: 0.3 });
  b.box(0.3, 0.6, 0.3, '#e8e2d6', 1.15, 0.12, 0.95);
  b.sphere(0.24, accent, 1.15, 0.95, 0.95, {}, 0);
  b.box(0.05, 0.7, 0.05, '#7b5536', -1.1, 0.12, 1.15, { rx: 0.15 });
  b.box(0.42, 0.34, 0.03, '#fdf8ee', -1.1, 0.55, 1.08, { rx: 0.15 });
  b.box(0.3, 0.12, 0.035, accent, -1.1, 0.62, 1.1, { rx: 0.15, cast: false });
  b.door(0.7, 0.12, 0.37, shade(accent, -0.25), 0.3, 0.55);
  b.sign(accent, 1.45, 0.1, 0.2);
}

function school(b, accent, r) {
  pad(b);
  b.box(2.3, 1.0, 1.3, '#f0dcc4', 0, 0.12, -0.4);
  b.gable(2.45, 0.5, 1.45, '#9b3d33', 0, 1.12, -0.4);
  b.box(0.6, 1.9, 0.6, '#ead2b6', 0, 0.12, 0.1);
  b.pyramid(0.48, 0.55, 4, accent, 0, 2.02, 0.1);
  b.cyl(0.17, 0.17, 0.03, 16, '#fbf6ec', 0, 1.65, 0.41, { rx: Math.PI / 2, cast: false });
  b.box(0.02, 0.12, 0.02, '#333', 0, 1.65, 0.43, { cast: false });
  b.door(0, 0.12, 0.41, '#5a3626', 0.32, 0.55);
  b.windowsRow(2, 1.5, 0.5, 0.26, 0.3, 0.34);
  b.cyl(0.02, 0.02, 1.4, 5, '#9aa0a6', -1.35, 0.12, 0.9);
  b.box(0.4, 0.26, 0.02, accent, -1.14, 1.25, 0.9, { cast: false });
  b.sign(accent, 1.4, 0.1, 1.25);
}

function arena(b, accent, r) {
  b.cyl(1.8, 1.85, 0.08, 20, '#8bbf6a', 0, 0, 0, { cast: false });
  b.add(new THREE.RingGeometry(1.25, 1.62, 28).rotateX(-Math.PI / 2), shade(accent, 0.05), 0, 0.09, 0, { cast: false });
  b.box(0.04, 0.02, 2.2, '#ffffff', 0, 0.09, 0, { cast: false });
  for (const side of [-1, 1]) {
    b.box(0.06, 0.6, 0.06, '#f2f2f2', side * 0.95, 0.08, -0.25);
    b.box(0.06, 0.6, 0.06, '#f2f2f2', side * 0.95, 0.08, 0.25);
    b.box(0.06, 0.06, 0.56, '#f2f2f2', side * 0.95, 0.66, 0);
  }
  for (let i = 0; i < 3; i += 1) b.box(1.8, 0.12, 0.3, i % 2 ? '#d9d3c7' : accent, 0, 0.08 + i * 0.13, -1.45 + i * 0.12);
  b.cyl(0.03, 0.03, 1.6, 5, '#8c949c', 1.5, 0.08, -1.0);
  b.box(0.3, 0.18, 0.02, accent, 1.66, 1.5, -1.0, { cast: false });
  b.sign(accent, -1.55, 0.1, 1.0);
}

function depot(b, accent, r) {
  pad(b, '#b8b2a6');
  b.box(2.2, 1.0, 1.3, '#c9ced3', 0, 0.12, -0.5);
  b.box(2.26, 0.1, 1.36, shade(accent, -0.1), 0, 1.12, -0.5);
  for (let i = 0; i < 2; i += 1) {
    b.box(0.8, 0.75, 0.05, '#7d858d', -0.5 + i * 1.0, 0.12, 0.16);
    for (let k = 0; k < 4; k += 1) b.box(0.8, 0.02, 0.06, '#5c636a', -0.5 + i * 1.0, 0.25 + k * 0.17, 0.18, { cast: false });
  }
  for (let i = 0; i < 2; i += 1) {
    const x = -0.6 + i * 1.15, z = 0.95, color = i ? accent : shade(accent, 0.25);
    b.box(0.75, 0.25, 0.4, color, x, 0.17, z);
    b.box(0.4, 0.2, 0.36, '#cfe6ef', x - 0.08, 0.42, z);
    for (const dx of [-0.25, 0.25]) for (const dz of [-0.2, 0.2]) b.cyl(0.09, 0.09, 0.06, 8, '#222', x + dx, 0.16, z + dz, { rz: Math.PI / 2 });
  }
  b.sign(accent, 1.45, 0.1, 1.35);
}

function market(b, accent, r) {
  pad(b, '#d2c7ac');
  for (let i = 0; i < 3; i += 1) {
    const x = -1.05 + i * 1.05, z = 0.1 + (i === 1 ? -0.35 : 0);
    b.box(0.85, 0.45, 0.55, '#a77b52', x, 0.12, z);
    for (let k = 0; k < 4; k += 1) b.box(0.21, 0.04, 0.7, k % 2 ? '#fbf3e4' : (i === 1 ? shade(accent, -0.15) : accent), x - 0.32 + k * 0.21, 1.05, z + 0.05, { rx: 0.25 });
    for (const dx of [-0.38, 0.38]) b.cyl(0.025, 0.025, 0.95, 5, '#6d4c33', x + dx, 0.12, z + 0.3);
    for (let k = 0; k < 4; k += 1) b.sphere(0.07, ['#e2513f', '#f5c443', '#6fbf5f', '#f08a3c'][(k + i) % 4], x - 0.27 + k * 0.18, 0.64, z + 0.1, { cast: false });
  }
  b.box(1.4, 0.9, 0.9, '#efe2c8', 0.2, 0.12, -1.0);
  b.gable(1.5, 0.4, 1.0, accent, 0.2, 1.02, -1.0);
  b.sign(accent, 1.5, 0.1, 1.1);
}

function clinic(b, accent, r) {
  pad(b, '#d6d3cc');
  b.box(2.2, 1.1, 1.4, '#fbfbfa', 0, 0.12, -0.35);
  b.box(2.26, 0.1, 1.46, '#e3e6e8', 0, 1.22, -0.35);
  b.box(0.36, 0.12, 0.04, accent, 0, 0.98, 0.37, { cast: false });
  b.box(0.12, 0.36, 0.04, accent, 0, 0.86, 0.37, { cast: false });
  b.windowsRow(2, 1.3, 0.5, 0.36, 0.3, 0.34);
  b.box(0.8, 0.06, 0.6, accent, 0, 0.82, 0.62);
  b.cyl(0.025, 0.025, 0.7, 5, '#d0d4d8', -0.36, 0.12, 0.88);
  b.cyl(0.025, 0.025, 0.7, 5, '#d0d4d8', 0.36, 0.12, 0.88);
  b.door(0, 0.12, 0.36, '#c6dbe6', 0.45, 0.58);
  b.box(0.9, 0.04, 0.9, '#5a6670', 1.2, 1.32, -0.6, { cast: false });
  b.sign(accent, -1.4, 0.1, 1.2);
}

function stage(b, accent, r) {
  b.cyl(1.85, 1.9, 0.08, 20, '#cdbf9f', 0, 0, 0, { cast: false });
  b.box(2.0, 0.35, 1.0, '#7b5a3e', 0, 0.08, -0.8);
  b.add(new THREE.CylinderGeometry(1.1, 1.1, 2.1, 16, 1, true, -Math.PI / 2, Math.PI), shade(accent, -0.2), 0, 1.45, -0.95, { rz: 0, rx: 0, ry: Math.PI, scale: [1, 1, 0.55] });
  b.box(0.12, 1.3, 0.12, accent, -1.0, 0.43, -0.4);
  b.box(0.12, 1.3, 0.12, accent, 1.0, 0.43, -0.4);
  b.box(2.2, 0.12, 0.14, accent, 0, 1.73, -0.4);
  for (let row = 0; row < 3; row += 1) for (let i = 0; i < 5; i += 1) {
    b.box(0.28, 0.12, 0.2, row % 2 ? '#d9534f' : '#b3413e', -0.8 + i * 0.4, 0.08 + row * 0.06, 0.45 + row * 0.38);
  }
  for (const x of [-1.25, 1.25]) {
    b.cyl(0.03, 0.03, 1.4, 5, '#4a4a4a', x, 0.08, 0.2);
    b.sphere(0.09, b.m.lamp, x, 1.52, 0.2, { cast: false });
  }
  b.sign(accent, 1.5, 0.1, 1.3);
}

// A sandy cove: umbrellas, loungers, a lifeguard tower, a volleyball net, a bonfire ring and a pier
// that runs out to sea (local -z faces the water).
function beach(b, accent, r) {
  b.add(new THREE.CircleGeometry(2.6, 24).rotateX(-Math.PI / 2), '#ecd9a6', 0, 0.02, -0.3, { cast: false });
  const colors = ['#e2513f', '#f5c443', '#3fa7c9', '#ffffff', '#6fbf5f'];
  for (const [x, z, k] of [[-1.5, 0.3, 0], [-0.4, 0.75, 1], [0.8, 0.35, 2], [1.6, -0.4, 4], [-1.1, -0.8, 3]]) {
    b.cyl(0.025, 0.025, 1.0, 5, '#f4f1ea', x, 0.02, z);
    b.pyramid(0.55, 0.28, 8, colors[k], x, 0.95, z);
    b.box(0.32, 0.06, 0.7, k % 2 ? '#f6f3ea' : '#3f8fbf', x + 0.38, 0.12, z + 0.05, { ry: 0.3 });
    b.box(0.32, 0.05, 0.26, k % 2 ? '#f6f3ea' : '#3f8fbf', x + 0.4, 0.2, z - 0.25, { ry: 0.3, rx: -0.6 });
  }
  // lifeguard tower
  for (const dx of [-0.25, 0.25]) for (const dz of [-0.25, 0.25]) b.cyl(0.03, 0.03, 1.2, 5, '#f2f2f2', 2.0 + dx, 0.02, 0.9 + dz);
  b.box(0.65, 0.4, 0.65, '#e2513f', 2.0, 1.2, 0.9);
  b.gable(0.8, 0.25, 0.8, '#ffffff', 2.0, 1.6, 0.9);
  b.box(0.06, 0.04, 1.0, '#f2f2f2', 2.0, 0.5, 1.45, { rx: 0.9 });
  // volleyball net
  b.cyl(0.025, 0.025, 0.9, 5, '#8c949c', -0.3, 0.02, -1.6);
  b.cyl(0.025, 0.025, 0.9, 5, '#8c949c', 1.0, 0.02, -1.6);
  b.box(1.3, 0.22, 0.01, '#f4f4f4', 0.35, 0.68, -1.6, { cast: false });
  b.sphere(0.07, '#f5c443', 0.1, 0.18, -1.3, { cast: false });
  // bonfire ring with logs and flame
  for (let i = 0; i < 8; i += 1) { const a = (i / 8) * TAU; b.sphere(0.07, '#8b8a7a', -1.9 + Math.cos(a) * 0.28, 0.06, 1.15 + Math.sin(a) * 0.28, { cast: false }); }
  b.add(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 5), '#6e4a2c', -1.9, 0.1, 1.15, { rz: Math.PI / 2, ry: 0.5 });
  b.add(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 5), '#6e4a2c', -1.9, 0.1, 1.15, { rz: Math.PI / 2, ry: -0.6 });
  const flame = b.add(new THREE.ConeGeometry(0.13, 0.32, 6), b.m.lamp, -1.9, 0.28, 1.15, { cast: false, dynamic: true });
  flame.userData.bob = true;
  // surfboards
  for (let i = 0; i < 3; i += 1) b.add(new THREE.BoxGeometry(0.16, 0.9, 0.04), colors[(i + 2) % 5], -2.15 + i * 0.22, 0.45, -0.2, { rz: 0.12 });
  // pier out over the water
  for (let i = 0; i < 9; i += 1) b.box(0.7, 0.05, 0.42, '#a07a52', 0.35, 0.18, -2.3 - i * 0.44, { cast: false });
  for (let i = 0; i < 5; i += 1) for (const dx of [-0.32, 0.32]) b.cyl(0.04, 0.04, 0.9, 5, '#7a5a3a', 0.35 + dx, -0.7, -2.2 - i * 0.9);
  b.cyl(0.03, 0.03, 0.8, 5, '#7a5a3a', 0.1, 0.2, -5.8);
  b.sphere(0.08, b.m.lamp, 0.1, 1.04, -5.8, { cast: false });
  b.sign(accent, 1.3, 0.02, 1.6);
}

// ---- council3 public works: road, bridge, park and a construction site -----------------------------
function road(b, accent, r) {
  b.box(3.4, 0.08, 1.1, '#6f6b66', 0, 0, 0, { cast: false });
  b.box(3.4, 0.02, 0.06, '#f2efe6', 0, 0.08, 0, { cast: false });
  for (const side of [-1, 1]) {
    b.box(3.4, 0.05, 0.16, '#cfc8b8', 0, 0.02, side * 0.62, { cast: false });
    for (let i = 0; i < 3; i += 1) {
      b.cyl(0.025, 0.03, 0.9, 6, '#4b4f55', -1.2 + i * 1.2, 0.05, side * 0.75);
      b.sphere(0.07, b.m.lamp, -1.2 + i * 1.2, 0.98, side * 0.75, { cast: false });
    }
  }
  b.sign(accent, 1.5, 0.05, 0.95);
}
function bridge(b, accent, r) {
  b.box(3.6, 0.06, 1.6, '#6a8fb0', 0, -0.04, 0, { cast: false });
  b.box(3.2, 0.1, 0.9, '#a58f72', 0, 0.3, 0);
  for (const x of [-1.0, 0, 1.0]) b.box(0.22, 0.34, 0.7, '#8c7a62', x, -0.04, 0);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i += 1) b.cyl(0.025, 0.025, 0.32, 5, shade(accent, -0.1), -1.5 + i * 0.5, 0.4, side * 0.42);
    b.box(3.1, 0.04, 0.05, accent, 0, 0.72, side * 0.42, { cast: false });
  }
  b.sign(accent, 1.7, 0.05, 0.9);
}
function park(b, accent, r) {
  b.cyl(1.8, 1.85, 0.08, 20, '#7fbf5f', 0, 0, 0, { cast: false });
  b.cyl(0.42, 0.46, 0.18, 16, '#d8d2c4', 0, 0.08, 0);
  b.cyl(0.3, 0.3, 0.05, 16, '#7fb6e0', 0, 0.26, 0, { cast: false });
  b.cyl(0.05, 0.07, 0.35, 8, '#d8d2c4', 0, 0.26, 0);
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * TAU + 0.3, x = Math.cos(a) * 1.25, z = Math.sin(a) * 1.25;
    b.cyl(0.05, 0.07, 0.45, 6, '#6b4a2f', x, 0.08, z);
    b.sphere(0.3 + r() * 0.12, ['#4f9b45', '#5fae4f', '#3f8a3a'][i % 3], x, 0.7, z);
  }
  for (const side of [-1, 1]) b.box(0.6, 0.06, 0.18, '#8a5a34', side * 0.75, 0.25, 0.65, { cast: false });
  b.sign(accent, 1.45, 0.05, 1.35);
}
// Construction site: a fenced pad, a frame that rises with progress, scaffolding and stacked material.
function construction(b, accent, r, scene) {
  const progress = Math.max(0, Math.min(100, Number(scene?.features?.publicWork?.progress) || 0));
  const level = Math.max(0.12, progress / 100);
  b.cyl(1.75, 1.85, 0.08, 12, '#b9a98c', 0, 0, 0, { cast: false });
  b.box(1.9, 1.2 * level, 1.2, '#e9e1cf', 0, 0.08, -0.2);
  for (const [x, z] of [[-1.05, 0.5], [1.05, 0.5], [-1.05, -0.9], [1.05, -0.9]]) b.box(0.06, 1.7, 0.06, '#9a7448', x, 0.08, z);
  for (const y of [0.6, 1.2]) {
    b.box(2.16, 0.04, 0.06, '#9a7448', 0, y, 0.5, { cast: false });
    b.box(2.16, 0.04, 0.06, '#9a7448', 0, y, -0.9, { cast: false });
  }
  for (let i = 0; i < 4; i += 1) b.box(0.9, 0.06, 0.16, '#c49a62', 1.25, 0.08 + i * 0.06, 0.95 - (i % 2) * 0.06, { ry: 0.25, cast: false });
  b.cyl(0.03, 0.03, 2.2, 5, '#e0b23c', -1.3, 0.08, -1.1);
  b.box(1.2, 0.05, 0.05, '#e0b23c', -0.75, 2.25, -1.1, { cast: false });
  for (let i = 0; i < 7; i += 1) b.box(0.42, 0.22, 0.03, i % 2 ? '#f2f2f2' : '#e05a4f', -1.3 + i * 0.43, 0.08, 1.45, { cast: false });
  b.sign(accent || '#e0b23c', 1.5, 0.05, 1.5);
}

// ---- growth1 public buildings: library, hospital, harbor, apartment block --------------------------
function library(b, accent, r) {
  pad(b, '#d3cbb6');
  b.box(2.4, 0.16, 1.0, '#e6dfcf', 0, 0.12, 0.7, { cast: false });
  b.box(2.3, 1.25, 1.5, '#efe8d8', 0, 0.12, -0.4);
  for (let i = 0; i < 6; i += 1) b.cyl(0.07, 0.08, 1.05, 8, '#fbf7ee', -1.0 + i * 0.4, 0.28, 0.42);
  b.box(2.45, 0.16, 0.5, '#e9e0cc', 0, 1.33, 0.42);
  b.gable(2.5, 0.38, 0.55, shade(accent, -0.1), 0, 1.49, 0.42);
  b.box(2.36, 0.5, 1.56, shade(accent, -0.05), 0, 1.37, -0.4);
  for (let i = 0; i < 4; i += 1) b.box(0.32, 0.06, 0.05, ['#c0392b', '#2e86c1', '#27ae60', '#f1c40f'][i], -0.6 + i * 0.4, 0.72, 0.36, { cast: false });
  b.door(0, 0.28, 0.33, '#4a3426', 0.42, 0.66);
  b.windowsRow(3, 1.0, 0.62, 0, 0.28, 0.42, { sideX: 1.16 });
  b.windowsRow(3, 1.0, 0.62, 0, 0.28, 0.42, { sideX: -1.16 });
  b.sign(accent, 1.45, 0.1, 1.3);
}
function hospital(b, accent, r) {
  pad(b, '#d6d3cc');
  b.box(2.6, 1.0, 1.2, '#fbfbfa', 0, 0.12, -0.6);
  b.box(1.2, 2.0, 1.0, '#f4f6f7', 0, 0.12, -0.6);
  for (let f = 0; f < 4; f += 1) b.windowsRow(2, 0.8, 0.3 + f * 0.45, -0.08, 0.2, 0.26);
  b.windowsRow(4, 2.2, 0.45, 0.01, 0.22, 0.3);
  b.box(0.5, 0.14, 0.05, accent, 0, 1.75, -0.08, { cast: false });
  b.box(0.14, 0.5, 0.05, accent, 0, 1.57, -0.08, { cast: false });
  b.box(1.0, 0.06, 0.7, accent, 0, 0.82, 0.4);
  for (const x of [-0.45, 0.45]) b.cyl(0.025, 0.025, 0.7, 5, '#d0d4d8', x, 0.12, 0.7);
  b.door(0, 0.12, -0.08, '#c6dbe6', 0.5, 0.6);
  b.cyl(0.6, 0.6, 0.03, 16, '#5a6670', 0, 2.13, -0.6, { cast: false });
  b.box(0.36, 0.01, 0.08, '#f2f2f2', 0, 2.17, -0.6, { cast: false });
  b.box(0.08, 0.01, 0.36, '#f2f2f2', 0, 2.17, -0.6, { cast: false });
  b.sign(accent, -1.5, 0.1, 1.2);
}
function harbor(b, accent, r) {
  b.box(3.6, 0.06, 1.8, '#6a8fb0', 0, -0.04, -0.6, { cast: false });
  b.box(3.2, 0.14, 0.9, '#a58f72', 0, 0.12, 0.6);
  for (let i = 0; i < 5; i += 1) b.box(0.6, 0.06, 1.1, '#9c7b56', -1.4 + i * 0.7, 0.2, -0.75, { cast: false });
  for (let i = 0; i < 3; i += 1) b.box(0.6, 0.45, 0.45, ['#c0392b', '#2e86c1', '#e67e22'][i], -1.0 + i * 0.7, 0.26, 0.55);
  b.cyl(0.05, 0.05, 2.0, 6, '#e0b23c', 1.3, 0.26, 0.5);
  b.box(1.3, 0.06, 0.06, '#e0b23c', 0.75, 2.2, 0.5, { cast: false });
  b.box(0.7, 0.25, 0.32, shade(accent, 0.1), 0.2, -0.0, -1.1);
  b.gable(0.5, 0.2, 0.3, accent, 0.3, 0.25, -1.1);
  b.sign(accent, 1.6, 0.1, 1.2);
}
function apartment(b, accent, r) {
  pad(b, '#c9c4b8');
  const floors = 4;
  b.box(2.2, 0.48 * floors, 1.3, '#e8e2d6', 0, 0.12, -0.35);
  for (let f = 0; f < floors; f += 1) {
    b.windowsRow(4, 1.8, 0.3 + f * 0.48, 0.31, 0.24, 0.26);
    b.box(2.0, 0.04, 0.22, shade(accent, -0.05), 0, 0.12 + (f + 1) * 0.48 - 0.06, 0.4, { cast: false });
  }
  b.box(2.3, 0.1, 1.4, accent, 0, 0.12 + 0.48 * floors, -0.35);
  b.door(0, 0.12, 0.31, '#5a3e2a', 0.4, 0.55);
  b.sign(accent, 1.45, 0.1, 1.3);
}

const ARCHETYPES = { hall, tower, lab, yard, atelier, school, arena, depot, market, clinic, stage, beach, road, bridge, park, construction,
  library, hospital, harbor, apartment };

export function buildArchetypePlace(b, archetype, accent, r, scene = null) {
  const build = ARCHETYPES[archetype];
  if (!build) return false;
  build(b, accent, r, scene);
  return true;
}

export const PALM_COLORS = ['#4f9b45', '#5fae4f', '#3f8a3a'];

// ---- MirrorTerra Central Bank: the SYNC operating pool, shown as an institution at the world centre --
export const CENTRAL_BANK_STYLE = Object.freeze({ accent: '#d4a72c', label: '#f2d27a' });

// A small neoclassical bank: plinth and steps, six columns, pediment with a gold coin, a flag.
// Local space, front faces +z; footprint about 2.0 x 1.5 before scaling.
export function buildCentralBank(b, accent = CENTRAL_BANK_STYLE.accent) {
  b.box(2.0, 0.14, 1.5, '#d9d3c5', 0, 0, -0.1, { cast: false });
  b.box(1.5, 0.07, 0.3, '#e8e2d4', 0, 0, 0.78, { cast: false });
  b.box(1.3, 0.07, 0.18, '#efe9dc', 0, 0.07, 0.72, { cast: false });
  b.box(1.7, 0.92, 0.95, '#f4f0e7', 0, 0.14, -0.3);
  for (let i = 0; i < 6; i += 1) {
    const x = -0.75 + i * 0.3;
    b.cyl(0.07, 0.07, 0.04, 10, '#e9e3d6', x, 0.14, 0.42, { cast: false });
    b.cyl(0.055, 0.065, 0.84, 10, '#fbf8f1', x, 0.18, 0.42);
  }
  b.box(1.92, 0.14, 1.35, '#ece6d8', 0, 1.02, -0.12);
  b.box(1.94, 0.04, 1.37, accent, 0, 1.16, -0.12, { cast: false });
  b.gable(1.92, 0.36, 1.35, '#e9e2d2', 0, 1.2, -0.12);
  b.cyl(0.13, 0.13, 0.03, 18, accent, 0, 1.3, 0.555, { rx: Math.PI / 2, cast: false });
  b.cyl(0.08, 0.08, 0.035, 18, '#f6e6a8', 0, 1.3, 0.565, { rx: Math.PI / 2, cast: false });
  b.door(0, 0.14, 0.18, '#2f3640', 0.36, 0.6);
  b.windowsRow(2, 1.0, 0.36, 0.18, 0.2, 0.42);
  b.cyl(0.018, 0.022, 0.9, 6, '#8c949c', 0.72, 1.2, -0.62);
  b.box(0.34, 0.2, 0.02, accent, 0.9, 1.84, -0.62, { cast: false });
}

const SYNC_GROUP = /\B(?=(\d{3})+(?!\d))/g;
export function formatSyncRaw(raw, decimals = 6) {
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return null;
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 36) return null;
  const value = BigInt(raw), scale = 10n ** BigInt(places);
  const whole = (places ? value / scale : value).toString().replace(SYNC_GROUP, ',');
  const fraction = places ? (value % scale).toString().padStart(places, '0').replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction}` : whole;
}

const BANK_BOOKS_NOTE = 'SYNC is booked internally';
const BANK_ROLE_NOTE = 'Keeps the world\'s books: every resident\'s SYNC is booked here.';
const BANK_RECENT_ROWS = 10;
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const safeText = (value, fallback) => (typeof value === 'string' && value && !UUID_LIKE.test(value) ? value : fallback);
// Same style as the activity feed (app.js formatTime with date), in the viewer's own time zone.
function shortTime(value, timeZone) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(date);
}

// Pure: the info panel content for the bank, built only from the public bank summary.
// A row with a single entry is a section heading. The bank keeps the world's books: SYNC is
// booked internally; the operating pool figure is shown only as a labelled reference.
export function centralBankInfoRows(bank, { timeZone } = {}) {
  const title = bank?.name || 'MirrorTerra Central Bank';
  const books = bank?.conversion?.note || BANK_BOOKS_NOTE;
  const body = bank?.role || BANK_ROLE_NOTE;
  if (!bank || bank.available === false) {
    return { eyebrow: 'CENTRAL BANK · BOOKKEEPER', title, body: `${body} The books are temporarily unavailable.`,
      rows: [['SYNC', books]] };
  }
  const decimals = bank.token?.decimals ?? 6, symbol = bank.token?.symbol || 'SYNC';
  const amount = (raw) => { const text = formatSyncRaw(raw, decimals); return text === null ? 'unavailable' : `${text} ${symbol}`; };
  const rows = [];
  rows.push(['Governor', bank.governor?.name ? `${bank.governor.name} (resident)` : 'Unassigned']);
  if (bank.governor?.location) rows.push(['Governor now', bank.governor.atBank ? 'Keeping the books in the bank' : bank.governor.location]);
  rows.push(['Location', bank.location?.label || 'World centre']);
  rows.push(['SYNC', books]);
  const ledger = bank.ledger || {};
  if (ledger.available) {
    const totals = ledger.totals || {}, counts = ledger.counts || {};
    rows.push(['Ledger']);
    rows.push(['Total booked', `${amount(totals.bookedRaw || '0')} · ${totals.rewardCount || 0} rewards`]);
    rows.push(['Total pending', amount(totals.pendingRaw || '0')]);
    rows.push(['Internal trades', String(counts.internalTrades || 0)]);
    rows.push(['Internal transfers', String(counts.internalTransfers || 0)]);
    const residents = ledger.residents || [];
    rows.push([`Resident balances (${residents.length})`]);
    if (!residents.length) rows.push(['—', 'No balances booked yet']);
    residents.forEach((resident, index) => rows.push([`${index + 1}. ${safeText(resident.name, 'A resident')}`, amount(resident.balanceRaw || '0')]));
    const recent = (ledger.recent || []).slice(0, BANK_RECENT_ROWS);
    rows.push(['Recent entries']);
    if (!recent.length) rows.push(['—', 'No entries yet']);
    for (const entry of recent) {
      const from = entry.type === 'reward' ? 'Central Bank' : safeText(entry.from, 'A resident');
      const when = shortTime(entry.at, timeZone);
      rows.push([`${from} → ${safeText(entry.to, 'A resident')}`,
        [amount(entry.amountRaw), safeText(entry.reason, ''), when].filter(Boolean).join(' · ')]);
    }
  } else {
    rows.push(['Ledger', 'Temporarily unavailable']);
  }
  const council = bank.council || {};
  if (council.available) {
    const treasury = council.treasury || {}, taxes = council.taxes || {};
    rows.push(['Treasury & council']);
    rows.push(['Treasury', [amount(treasury.balanceRaw || '0'),
      treasury.reservedRaw && treasury.reservedRaw !== '0' ? `${amount(treasury.reservedRaw)} reserved for construction` : '',
      `free ${amount(treasury.freeRaw || '0')}`].filter(Boolean).join(' · ')]);
    rows.push(['Treasury pays', 'Only builders of public works, per milestone']);
    const flows = council.lastWorldDay;
    if (flows) rows.push(['Last world day', `In ${amount(flows.inflowRaw || '0')} · Out ${amount(flows.outflowRaw || '0')}`
      + ` · construction ${amount(flows.constructionRaw || '0')}`]);
    rows.push(['Taxes', `Sales ${safeText(taxes.sales, '0%')} · Income ${safeText(taxes.income, '0%')} · Idle ${safeText(taxes.wealth, '0%')}`]);
    for (const policy of (council.policies || []).slice(0, 4)) rows.push([safeText(policy.label, 'Policy'), safeText(policy.value, '—')]);
    const works = council.publicWorks || {};
    const projects = works.projects || [];
    rows.push([`Public works (${projects.length})`]);
    if (!projects.length) rows.push(['—', 'Nothing commissioned · waits for treasury revenue']);
    for (const project of projects.slice(0, 4)) {
      rows.push([safeText(project.name, 'Project'), project.status === 'bidding'
        ? [`tender · price ${amount(project.priceRaw || '0')}`, `${project.bids || 0} bids (${project.llmBids || 0} llm)`,
          project.lowestBidRaw ? `lowest ${amount(project.lowestBidRaw)}` : ''].filter(Boolean).join(' · ')
        : [`building · ${safeText(project.builder, 'a resident')}`, `${project.progress || 0}%`,
          `paid ${amount(project.paidRaw || '0')} of ${amount(project.contractPriceRaw || project.priceRaw || '0')}`,
          `${project.milestonesPaid || 0}/4 milestones`].join(' · ')]);
    }
    const built = works.completed || [];
    rows.push([`Built public works (${built.length})`]);
    if (!built.length) rows.push(['—', 'None yet']);
    for (const work of built.slice(0, 5)) {
      rows.push([safeText(work.name, 'Public work'), [`by ${safeText(work.builder, 'a resident')}`, amount(work.contractPriceRaw || '0'),
        work.level > 1 ? `level ${work.level}` : '', safeText(work.effect, '')].filter(Boolean).join(' · ')]);
    }
    const minds = works.deliberation?.lastWorldDay;
    if (minds) rows.push(['Council minds (last day)', `${minds.llm || 0} Luna decisions · ${minds.fallback || 0} fallback`]);
    const voteRows = (list = []) => {
      for (const vote of list.slice(0, 10)) rows.push([`· ${safeText(vote.name, 'A resident')} ${vote.stance === 'yes' ? 'yes' : 'no'}`,
        [vote.source === 'llm' ? 'llm' : 'fallback', safeText(vote.reason, '')].filter(Boolean).join(' · ')]);
    };
    const open = council.openProposals || [];
    rows.push([`Open proposals (${open.length})`]);
    if (!open.length) rows.push(['—', 'None open']);
    for (const [index, proposal] of open.slice(0, 3).entries()) {
      rows.push([safeText(proposal.title, 'Proposal'),
        [`${proposal.yes || 0} yes · ${proposal.no || 0} no · ${proposal.voted || 0}/${proposal.members || 10} voted`,
          `by ${safeText(proposal.proposer, 'a resident')} (${proposal.proposedBy === 'llm' ? 'llm' : 'fallback'})`,
          proposal.sources ? `llm ${proposal.sources.llm || 0} / fallback ${proposal.sources.fallback || 0}` : ''].filter(Boolean).join(' · ')]);
      if (index === 0) voteRows(proposal.votes);
    }
    const decisions = (council.decisions || []).slice(0, 5);
    rows.push(['Last decisions']);
    if (!decisions.length) rows.push(['—', 'None yet']);
    const outcome = { passed: 'Passed', rejected: 'Rejected', vetoed: 'Vetoed' };
    for (const [index, decision] of decisions.entries()) {
      rows.push([safeText(decision.title, 'Proposal'), [`${outcome[decision.outcome] || 'Decided'} ${decision.yes || 0}–${decision.no || 0}`,
        decision.sources ? `llm ${decision.sources.llm || 0} / fallback ${decision.sources.fallback || 0}` : ''].filter(Boolean).join(' · ')]);
      if (index === 0 && !open.length) voteRows(decision.votes);
    }
    const spends = (council.spends || []).slice(0, 5);
    rows.push(['Treasury payments']);
    if (!spends.length) rows.push(['—', 'None yet']);
    for (const spend of spends) {
      rows.push([`Treasury → ${safeText(spend.to, 'A resident')}`,
        [amount(spend.amountRaw), safeText(spend.kind, ''), shortTime(spend.at, timeZone)].filter(Boolean).join(' · ')]);
    }
  }
  const vault = bank.vault || {};
  if (vault.balanceRaw) rows.push(['Operating pool (reference)', `${amount(vault.balanceRaw)} · not in circulation`]);
  return { eyebrow: 'CENTRAL BANK · BOOKKEEPER', title, body, rows };
}
