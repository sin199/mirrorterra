// island1: Lantern Isle, the strait, the ferry and the searchlights, drawn next to the main island.
// Reads payload.ferryIsland (absent when MIRRORTERRA_FERRY_ISLAND is off -> nothing is drawn) and the island
// scenes (features.islandType). The island starts empty (sand and trees); the pier, the landing, the boat and the
// island buildings appear as the residents build them. Searchlights in the strait are pure scenery.
// The central plaza (COIN/24H tower) is not touched by this module.
import { buildBoatModel, buildIslandModel } from './world-places3d.js?v=island1-20261024';

const TAU = Math.PI * 2;
const ISLAND_TYPES = new Set(['pier', 'ferry', 'resort', 'boardwalk', 'island_cafe']);
const SEARCHLIGHT_COLORS = ['#ff4fd8', '#4fd2ff', '#ffe14f', '#7dff6a', '#ff7a3d', '#a07bff'];
const ISLE_R = 5.6;          // radius of Lantern Isle (world units)
const STRAIT = 12;           // open water between the two shores
const PIER_LENGTH = 3.6;
const LANDING_LENGTH = 1.9;
const CROSSING = 75;
const DEPARTURES = [420, 600, 780, 960, 1140];

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}
function rng(seed) {
  let state = hash(seed) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) % 100000) / 100000; };
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Where the boat is at an absolute world minute (mirror of src/ferry-island.js boatState).
export function boatStateAt(minute, departures = DEPARTURES, crossing = CROSSING) {
  const m = Number(minute) || 0, dayStart = Math.floor(m / 1440) * 1440;
  for (const slot of [...departures].reverse()) {
    const d = dayStart + slot, arrive = d + crossing, back = arrive + 15, home = back + crossing;
    if (m < d) continue;
    if (m < arrive) return { state: 'outbound', progress: (m - d) / crossing };
    if (m < back) return { state: 'docked_island', progress: 1 };
    if (m < home) return { state: 'inbound', progress: (m - back) / crossing };
    return { state: 'docked_main', progress: 0 };
  }
  return { state: 'docked_main', progress: 0 };
}
export function tripPhaseAt(trip, minute) {
  const m = Number(minute) || 0;
  if (m < trip.departMinute) return 'waiting';
  if (m < trip.arriveIslandMinute) return 'outbound';
  if (m < trip.returnDepartMinute) return 'island';
  if (m < trip.returnArriveMinute) return 'inbound';
  return 'back';
}
export const isIslandSceneItem = (item) => ISLAND_TYPES.has(item?.features?.islandType);

// THREE, scene, makeBuilder(group) -> Builder, materials (shared), glowMap, geometry helpers from world3d.
export function createFerryIsland({ THREE, scene, makeBuilder, materials, glowMap, coastRadius, islandZ, beachAngle, waterLevel }) {
  const root = new THREE.Group(); root.name = 'lantern-isle'; root.visible = false; scene.add(root);
  const terrainGroup = new THREE.Group(), buildGroup = new THREE.Group(), boatGroup = new THREE.Group(), lightGroup = new THREE.Group();
  root.add(terrainGroup, buildGroup, boatGroup, lightGroup);
  let geo = null, block = null, islandScenes = [], buildSignature = '', boat = null, boatSignature = '', deckY = 0.34;
  let night = 0, pierName = null, beams = [], terrainKey = '';
  const disposeGroup = (group) => {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((object) => { if (object.isMesh || object.isSprite) { object.geometry?.dispose?.(); if (object.material?.userData?.own) object.material.dispose(); } });
    }
  };

  // ---- geometry (relative to the current size of the main island) ------------------------------------------
  function shorePoint(angle, d) {
    const radius = coastRadius(angle) * d;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius * islandZ];
  }
  function layoutGeometry() {
    const pierAngle = beachAngle - 0.36, isleAngle = beachAngle - 0.24;
    const coast = shorePoint(isleAngle, 1);
    const coastLen = Math.hypot(coast[0], coast[1]) || 1;
    const dir = [coast[0] / coastLen, coast[1] / coastLen];
    const center = [coast[0] + dir[0] * (STRAIT + ISLE_R), coast[1] + dir[1] * (STRAIT + ISLE_R)];
    const pierBase = shorePoint(pierAngle, 0.975);
    let toIsle = [center[0] - pierBase[0], center[1] - pierBase[1]];
    let len = Math.hypot(toIsle[0], toIsle[1]) || 1; toIsle = [toIsle[0] / len, toIsle[1] / len];
    const pierTip = [pierBase[0] + toIsle[0] * (PIER_LENGTH + 0.2), pierBase[1] + toIsle[1] * (PIER_LENGTH + 0.2)];
    let back = [pierTip[0] - center[0], pierTip[1] - center[1]];
    len = Math.hypot(back[0], back[1]) || 1; back = [back[0] / len, back[1] / len];
    const landingBase = [center[0] + back[0] * ISLE_R * 0.9, center[1] + back[1] * ISLE_R * 0.9];
    const landingTip = [landingBase[0] + back[0] * (LANDING_LENGTH + 0.2), landingBase[1] + back[1] * (LANDING_LENGTH + 0.2)];
    const side = [-back[1], back[0]];
    // boat route: pier tip -> landing tip with a gentle curve; berths alongside the tips
    const berthMain = [pierTip[0] + toIsle[0] * 1.3 + side[0] * 0.2, pierTip[1] + toIsle[1] * 1.3 + side[1] * 0.2];
    const berthIsle = [landingTip[0] + back[0] * 1.3 - side[0] * 0.2, landingTip[1] + back[1] * 1.3 - side[1] * 0.2];
    const mid = [(berthMain[0] + berthIsle[0]) / 2 + side[0] * 1.8, (berthMain[1] + berthIsle[1]) / 2 + side[1] * 1.8];
    return { center, pierBase, pierTip, toIsle, back, side, landingBase, landingTip, berthMain, berthIsle, mid };
  }
  const noiseR = (angle) => ISLE_R * (1 + Math.sin(angle * 3 + 0.7) * 0.06 + Math.sin(angle * 5 + 2.1) * 0.04);
  function isleHeight(x, z) {
    if (!geo) return -1;
    const dx = x - geo.center[0], dz = z - geo.center[1];
    const d = Math.hypot(dx, dz) / noiseR(Math.atan2(dz, dx));
    const hill = (1 - smooth(0.0, 0.7, d)) * 0.55;
    return 0.12 + hill * 1.0 + smooth(0.55, 0.75, d) * -0.04 - smooth(0.92, 1.08, d) * 0.7;
  }
  function buildTerrain() {
    disposeGroup(terrainGroup);
    const rings = 18, segments = 64, positions = [], colors = [], index = [];
    const sand = new THREE.Color('#ead7a2'), grassA = new THREE.Color('#6fae55'), grassB = new THREE.Color('#5a9647'), c = new THREE.Color();
    positions.push(geo.center[0], isleHeight(...geo.center), geo.center[1]); colors.push(grassA.r, grassA.g, grassA.b);
    for (let ring = 1; ring <= rings; ring += 1) {
      const t = ring / rings, d = t * 1.1;
      for (let s = 0; s < segments; s += 1) {
        const a = (s / segments) * TAU, r = noiseR(a) * d;
        const x = geo.center[0] + Math.cos(a) * r, z = geo.center[1] + Math.sin(a) * r;
        positions.push(x, isleHeight(x, z), z);
        c.copy(grassB).lerp(grassA, (Math.sin(x * 1.7) * Math.cos(z * 1.3) + 1) / 2).lerp(sand, smooth(0.58, 0.72, d));
        colors.push(c.r, c.g, c.b);
      }
    }
    for (let s = 0; s < segments; s += 1) index.push(0, 1 + ((s + 1) % segments), 1 + s);
    for (let ring = 1; ring < rings; ring += 1) {
      const a = 1 + (ring - 1) * segments, b = 1 + ring * segments;
      for (let s = 0; s < segments; s += 1) { const s1 = (s + 1) % segments; index.push(a + s, a + s1, b + s, a + s1, b + s1, b + s); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(index); geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }); material.userData.own = true;
    const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; terrainGroup.add(mesh);
    // shallow water around the island
    const shallowMaterial = new THREE.MeshStandardMaterial({ color: '#bff3ea', transparent: true, opacity: 0.4, depthWrite: false,
      roughness: 0.4, flatShading: true });
    shallowMaterial.userData.own = true;
    const shallow = new THREE.Mesh(new THREE.RingGeometry(ISLE_R * 0.95, ISLE_R * 1.45, 48).rotateX(-Math.PI / 2), shallowMaterial);
    shallow.position.set(geo.center[0], waterLevel + 0.17, geo.center[1]); shallow.renderOrder = 1; terrainGroup.add(shallow);
    // palms and bushes (the island starts empty: just sand and trees)
    const b = makeBuilder(terrainGroup), r = rng('lantern-isle-trees');
    const keepClear = [...slotPoints().map((slot) => slot.pos), geo.landingBase];
    let placed = 0;
    for (let attempt = 0; attempt < 120 && placed < 22; attempt += 1) {
      const a = r() * TAU, d = Math.sqrt(r()) * 0.78, rr = noiseR(a) * d;
      const x = geo.center[0] + Math.cos(a) * rr, z = geo.center[1] + Math.sin(a) * rr;
      if (keepClear.some((p) => Math.hypot(p[0] - x, p[1] - z) < 1.7)) continue;
      const y = isleHeight(x, z), palm = d > 0.45 || r() < 0.4, h = 0.9 + r() * 0.7;
      if (palm) {
        b.add(new THREE.CylinderGeometry(0.05, 0.08, h, 5), '#8a6a45', x, y + h / 2, z, { rz: (r() - 0.5) * 0.3 });
        for (let k = 0; k < 5; k += 1) {
          const fa = (k / 5) * TAU + r();
          b.add(new THREE.ConeGeometry(0.12, 0.75, 4), ['#4f9b45', '#5fae4f', '#3f8a3a'][k % 3], x + Math.cos(fa) * 0.3, y + h + 0.02, z + Math.sin(fa) * 0.3,
            { rz: Math.cos(fa) * 1.25, rx: -Math.sin(fa) * 1.25, cast: true });
        }
      } else {
        b.add(new THREE.CylinderGeometry(0.06, 0.08, 0.4, 5), '#6b4a2f', x, y + 0.2, z);
        b.sphere(0.42 + r() * 0.2, ['#4f9b45', '#5fae4f', '#3f8a3a'][placed % 3], x, y + 0.7, z);
      }
      placed += 1;
    }
    // a few rocks and driftwood on the beach
    for (let i = 0; i < 6; i += 1) {
      const a = r() * TAU, rr = noiseR(a) * (0.8 + r() * 0.1);
      b.sphere(0.12 + r() * 0.12, '#8b8a7a', geo.center[0] + Math.cos(a) * rr, isleHeight(geo.center[0] + Math.cos(a) * rr, geo.center[1] + Math.sin(a) * rr) + 0.05, geo.center[1] + Math.sin(a) * rr, { cast: false });
    }
  }
  // Building slots on the island, in a frame facing the main island (f = toward the pier).
  function slotPoints() {
    const f = geo.back, p = geo.side, c = geo.center;
    const at = (along, across) => [c[0] + f[0] * along + p[0] * across, c[1] + f[1] * along + p[1] * across];
    return [
      { type: 'resort', pos: at(-0.4, -1.9), face: f },
      { type: 'boardwalk', pos: at(ISLE_R * 0.72, 2.0), face: f, along: p },
      { type: 'island_cafe', pos: at(1.3, 2.3), face: f }
    ];
  }

  // ---- searchlights (scenery) ----------------------------------------------------------------------------------
  const beamVertex = 'varying float vV; void main(){ vV = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const beamFragment = 'uniform vec3 color; uniform float opacity; varying float vV; void main(){ float a = opacity * pow(1.0 - vV, 1.35); gl_FragColor = vec4(color * a, a); }';
  function buildSearchlights() {
    disposeGroup(lightGroup); beams = [];
    const b = makeBuilder(lightGroup);
    const start = geo.berthMain, end = geo.berthIsle, side = geo.side;
    const count = SEARCHLIGHT_COLORS.length;
    for (let i = 0; i < count; i += 1) {
      const t = 0.12 + (i / (count - 1)) * 0.76, offset = (i % 2 ? 1 : -1) * (3.2 + (i % 3) * 1.1);
      const x = start[0] + (end[0] - start[0]) * t + side[0] * offset, z = start[1] + (end[1] - start[1]) * t + side[1] * offset;
      const color = SEARCHLIGHT_COLORS[i];
      // a small floating platform with the lamp housing
      b.cyl(0.42, 0.5, 0.22, 10, '#3f4a52', x, waterLevel - 0.02, z);
      b.cyl(0.36, 0.36, 0.06, 10, color, x, waterLevel + 0.2, z, { cast: false });
      b.box(0.24, 0.26, 0.24, '#20262c', x, waterLevel + 0.26, z);
      const pivot = new THREE.Group(); pivot.position.set(x, waterLevel + 0.5, z); pivot.rotation.order = 'YXZ'; lightGroup.add(pivot);
      const length = 26;
      const geometry = new THREE.CylinderGeometry(2.6, 0.12, length, 18, 1, true); geometry.translate(0, length / 2, 0);
      const material = new THREE.ShaderMaterial({ uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 0.1 } },
        vertexShader: beamVertex, fragmentShader: beamFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending });
      material.userData.own = true;
      const beam = new THREE.Mesh(geometry, material); beam.renderOrder = 3; beam.frustumCulled = false; pivot.add(beam);
      const glowMaterial = new THREE.SpriteMaterial({ map: glowMap, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.4 });
      glowMaterial.userData.own = true;
      const glow = new THREE.Sprite(glowMaterial); glow.position.set(x, waterLevel + 0.55, z); glow.scale.set(1.3, 1.3, 1); lightGroup.add(glow);
      beams.push({ pivot, material, glowMaterial, phase: i * 1.37, speed: 0.22 + (i % 3) * 0.07, tilt: 0.42 + (i % 4) * 0.08 });
    }
  }

  // ---- built parts ------------------------------------------------------------------------------------------
  const sceneOf = (type) => islandScenes.find((item) => item.features?.islandType === type) || null;
  const blockItem = (type) => (type === 'pier' ? block?.pier : type === 'ferry' ? block?.ferry : (block?.buildings || []).find((item) => item.type === type)) || null;
  function stageOf(type) {
    const item = blockItem(type), sceneItem = sceneOf(type);
    const stage = item?.stage || (sceneItem?.features?.publicWork?.stage === 'built' ? 'built' : sceneItem ? 'building' : null);
    const progress = Number(item?.progress ?? sceneItem?.features?.publicWork?.progress ?? 0);
    return { stage, progress, level: Number(item?.level ?? sceneItem?.features?.publicWork?.level ?? 1), name: item?.name || sceneItem?.name || null };
  }
  function placeGroup(pos, face) {
    const group = new THREE.Group(); group.position.set(pos[0], 0, pos[1]); group.rotation.y = Math.atan2(face[0], face[1]); buildGroup.add(group);
    return group;
  }
  function buildParts() {
    disposeGroup(buildGroup);
    const pier = stageOf('pier'), ferry = stageOf('ferry');
    pierName = pier.stage ? (pier.name || 'Cove Pier') : null;
    if (pier.stage) {
      const group = placeGroup(geo.pierBase, geo.toIsle); group.position.y = 0.02;
      buildIslandModel(makeBuilder(group), 'island_pier', '#b0814f', rng('pier'),
        { length: PIER_LENGTH, progress: pier.stage === 'built' ? 1 : Math.max(0.15, pier.progress / 100) });
    }
    if (ferry.stage === 'built') {
      const group = placeGroup(geo.landingBase, geo.back); group.position.y = 0.02;
      buildIslandModel(makeBuilder(group), 'island_landing', '#2f7fb8', rng('landing'), { length: LANDING_LENGTH });
    }
    for (const slot of slotPoints()) {
      const state = stageOf(slot.type);
      if (!state.stage) continue;
      const group = placeGroup(slot.pos, slot.face);
      group.position.y = Math.max(0.05, isleHeight(slot.pos[0], slot.pos[1]) - 0.02);
      const kind = state.stage === 'built' ? { resort: 'island_resort', boardwalk: 'island_boardwalk', island_cafe: 'island_cafe' }[slot.type] : 'island_site';
      buildIslandModel(makeBuilder(group), kind, { resort: '#e07a5f', boardwalk: '#c9a36b', island_cafe: '#3fa7a0' }[slot.type], rng(slot.type),
        { progress: state.progress / 100 });
    }
  }
  function syncBoat() {
    const ferry = stageOf('ferry');
    const cruise = ferry.stage === 'built' && (ferry.level >= 2 || block?.ferry?.cruise);
    const signature = `${ferry.stage}|${cruise ? 'cruise' : 'ferry'}`;
    if (signature === boatSignature) return;
    boatSignature = signature; disposeGroup(boatGroup); boat = null;
    if (!ferry.stage) return;
    boat = new THREE.Group(); boatGroup.add(boat);
    const hull = new THREE.Group(); boat.add(hull);
    deckY = buildBoatModel(makeBuilder(hull), cruise, cruise ? '#1f4f8a' : '#2f7fb8');
    boat.userData.cruise = cruise;
    if (ferry.stage !== 'built') {
      // the boat being built: on blocks beside the pier, hull only
      hull.scale.setScalar(0.4 + 0.6 * Math.max(0.1, ferry.progress / 100));
      boat.userData.building = true;
    }
  }
  function routePoint(t) {
    const a = geo.berthMain, m = geo.mid, c = geo.berthIsle, u = 1 - t;
    return [u * u * a[0] + 2 * u * t * m[0] + t * t * c[0], u * u * a[1] + 2 * u * t * m[1] + t * t * c[1]];
  }
  function boatPose(minute) {
    if (!boat) return null;
    if (boat.userData.building) {
      const p = [geo.pierBase[0] + geo.side[0] * 1.6 + geo.toIsle[0] * 0.6, geo.pierBase[1] + geo.side[1] * 1.6 + geo.toIsle[1] * 0.6];
      return { pos: p, yaw: Math.atan2(geo.toIsle[0], geo.toIsle[1]), y: 0.1, state: 'building' };
    }
    const state = boatStateAt(minute, block?.timetable?.departures || DEPARTURES, block?.timetable?.crossingMinutes || CROSSING);
    let t = 0, dir = 1;
    if (state.state === 'outbound') t = state.progress;
    else if (state.state === 'docked_island') t = 1;
    else if (state.state === 'inbound') { t = 1 - state.progress; dir = -1; }
    const eased = t * t * (3 - 2 * t);
    const p = routePoint(eased), q = routePoint(Math.min(1, Math.max(0, eased + 0.01 * dir)));
    let yaw = Math.atan2(q[0] - p[0], q[1] - p[1]);
    if (state.state === 'docked_main') yaw = Math.atan2(geo.toIsle[0], geo.toIsle[1]);
    if (state.state === 'docked_island') yaw = Math.atan2(geo.back[0], geo.back[1]);
    return { pos: p, yaw, y: waterLevel + 0.12, state: state.state };
  }

  // ---- residents ------------------------------------------------------------------------------------------
  // Residents on a ferry trip stand on the pier (waiting), on deck (crossing) or on the island beach (visiting);
  // residents strolling on the pier stand along its deck. Returns { pos, y, face } or null (normal layout).
  let tripByAgent = new Map();
  function residentPlacement(resident, minute, time) {
    if (!geo || !root.visible) return null;
    const trip = tripByAgent.get(resident.id);
    const phase = trip ? tripPhaseAt(trip, minute) : null;
    const order = hash(resident.id) % 16;
    if (phase === 'outbound' || phase === 'inbound') {
      const pose = boatPose(minute);
      if (!pose) return null;
      const cruise = boat?.userData.cruise;
      const lx = ((order % 3) - 1) * (cruise ? 0.38 : 0.26), lz = (cruise ? -0.2 : 0.55) - Math.floor(order / 3) * (cruise ? 0.42 : 0.3);
      const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
      const bob = Math.sin((time || 0) / 1000 * 1.6) * 0.03;
      return { pos: [pose.pos[0] + lx * c + lz * s, pose.pos[1] - lx * s + lz * c], y: pose.y + deckY + bob, face: pose.yaw };
    }
    if (phase === 'island') {
      const a = (order / 16) * Math.PI + Math.atan2(geo.side[1], geo.side[0]) - Math.PI / 2;
      const f = geo.back, rr = 1.4 + (order % 4) * 0.45;
      const x = geo.center[0] + f[0] * 2.4 + Math.cos(a) * rr, z = geo.center[1] + f[1] * 2.4 + Math.sin(a) * rr;
      return { pos: [x, z], y: Math.max(0.05, isleHeight(x, z)), face: Math.atan2(f[0], f[1]) };
    }
    if ((phase === 'waiting' || (pierName && resident.location === pierName)) && resident.currentStatus !== 'walking' && pierName) {
      const along = 0.9 + (order % 8) * 0.36, across = order % 2 ? 0.22 : -0.22;
      const x = geo.pierBase[0] + geo.toIsle[0] * along + geo.side[0] * across, z = geo.pierBase[1] + geo.toIsle[1] * along + geo.side[1] * across;
      return { pos: [x, z], y: 0.36, face: Math.atan2(geo.toIsle[0], geo.toIsle[1]) };
    }
    return null;
  }
  // A walking target frame for the pier (the shore end).
  function frameFor(place) {
    if (!geo || !pierName || place !== pierName) return null;
    const center = geo.pierBase, len = Math.hypot(center[0], center[1]) || 1, u = [center[0] / len, center[1] / len];
    return { center, u, p: [-u[1], u[0]], front: [center[0] - u[0] * 0.8, center[1] - u[1] * 0.8], angle: Math.atan2(u[1], u[0]), ring: -1, y: 0 };
  }

  return {
    isIslandScene: isIslandSceneItem,
    // Called whenever the main island's size changes (and on the first payload with a ferry block).
    setData(nextBlock, scenes = []) {
      block = nextBlock || null; islandScenes = scenes.filter(isIslandSceneItem);
      root.visible = Boolean(block);
      if (!block) { tripByAgent = new Map(); return; }
      const key = `${coastRadius(beachAngle).toFixed(3)}`;
      if (key !== terrainKey) { terrainKey = key; geo = layoutGeometry(); buildTerrain(); buildSearchlights(); buildSignature = ''; boatSignature = ''; }
      const signature = ['pier', 'ferry', 'resort', 'boardwalk', 'island_cafe'].map((type) => {
        const state = stageOf(type); return `${type}:${state.stage || ''}:${Math.floor(state.progress / 25)}:${state.level}`;
      }).join('|');
      if (signature !== buildSignature) { buildSignature = signature; buildParts(); }
      syncBoat();
      tripByAgent = new Map((block.trips || []).map((trip) => [trip.agentId, trip]));
    },
    relayout() { terrainKey = ''; if (block) this.setData(block, islandScenes); },
    setNight(value) { night = Math.max(0, Math.min(1, Number(value) || 0)); },
    animate(time, minute) {
      if (!root.visible || !geo) return;
      const t = time / 1000;
      for (const beam of beams) {
        beam.pivot.rotation.y = beam.phase + t * beam.speed;
        beam.pivot.rotation.x = beam.tilt + Math.sin(t * 0.5 + beam.phase) * 0.18;
        beam.material.uniforms.opacity.value = 0.05 + night * 0.42;
        beam.glowMaterial.opacity = 0.25 + night * 0.75;
      }
      const pose = boatPose(minute);
      if (pose && boat) {
        boat.position.set(pose.pos[0], pose.y + (pose.state === 'building' ? 0 : Math.sin(t * 1.6) * 0.03), pose.pos[1]);
        boat.rotation.y = pose.yaw;
        boat.rotation.z = pose.state === 'building' ? 0 : Math.sin(t * 1.1) * 0.025;
      }
    },
    residentPlacement,
    frameFor,
    activityLabel(resident, minute) {
      if (!root.visible || minute === null || minute === undefined) return null;
      const trip = tripByAgent.get(resident.id);
      const phase = trip ? tripPhaseAt(trip, minute) : null;
      const isle = block?.island?.name || 'Lantern Isle';
      if (phase === 'outbound') return { label: `Ferry to ${isle}`, kind: 'travel' };
      if (phase === 'inbound') return { label: 'Ferry back', kind: 'travel' };
      if (phase === 'island') return { label: `On ${isle}`, kind: 'socialize' };
      if (phase === 'waiting' && resident.currentStatus !== 'walking') return { label: 'Waiting for the ferry', kind: 'travel' };
      if (pierName && resident.location === pierName && resident.currentStatus === 'performing') return { label: 'On the pier', kind: 'care' };
      return null;
    },
    labelAnchors() {
      if (!root.visible || !geo) return [];
      const out = [{ key: 'isle', text: block?.island?.name || 'Lantern Isle', x: geo.center[0], y: 2.4, z: geo.center[1] }];
      return out;
    },
    pierName: () => pierName,
    groundAt: (x, z) => (geo ? isleHeight(x, z) : -1),
    debug: () => ({ geo, visible: root.visible, buildSignature, boatSignature, beams: beams.length })
  };
}
