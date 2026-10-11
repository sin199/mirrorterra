// Plaza market boards: the COIN HOF exchange wall (and the older floor-standing board) showing BTC and
// ETH with their real hourly candlesticks.
// Prices come only from /public/market-ticker, which relays real exchange quotes. When the feed is
// unavailable the board says so instead of showing any number.
export const MARKET_TICKER_URL = '/public/market-ticker';

const W = 1280, H = 800;
const UP = '#ff4d5e', DOWN = '#3d8bff', FLAT = '#c9c4dc';
const VIOLET = '#8b5cf6', TEAL = '#2dd4bf';
const FONT = "'Geist', 'DM Sans', system-ui, sans-serif";
const MONO = "'DM Mono', ui-monospace, monospace";

function money(value, quote) {
  if (!Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 2 : 4;
  const text = value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return quote === 'USD' ? `$${text}` : `${text}`;
}

function percent(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function clock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function tone(change) {
  if (!Number.isFinite(change) || Math.abs(change) < 0.005) return FLAT;
  return change > 0 ? UP : DOWN;
}

function compact(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: value >= 1000 ? 0 : 2 });
}

function hourLabel(ms) {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getHours()).padStart(2, '0')}:00`;
}

// Real hourly candlesticks; nothing is drawn for a bar the feed did not deliver.
function drawCandles(ctx, candles, last, box) {
  const { x, y, w, h } = box, labels = box.labels !== false, axis = labels ? 118 : 0, plotW = w - axis, top = y + 10, bottom = y + h - (labels ? 34 : 10);
  ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(x, y, plotW, h - (labels ? 24 : 0));
  const bars = (candles || []).filter((bar) => bar && [bar.o, bar.h, bar.l, bar.c].every(Number.isFinite));
  if (bars.length < 2) {
    ctx.fillStyle = '#8a86a0'; ctx.font = `500 26px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText('Waiting for hourly candles', x + plotW / 2, y + h / 2);
    return;
  }
  let max = Math.max(...bars.map((bar) => bar.h)), min = Math.min(...bars.map((bar) => bar.l));
  if (Number.isFinite(last)) { max = Math.max(max, last); min = Math.min(min, last); }
  const pad = (max - min || max * 0.001) * 0.08; max += pad; min -= pad;
  const yOf = (value) => bottom - ((value - min) / (max - min)) * (bottom - top);
  // grid + price axis
  ctx.font = `500 21px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i += 1) {
    const value = min + ((max - min) * i) / 4, gy = yOf(value);
    ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x, Math.round(gy), plotW, 1);
    if (labels) { ctx.fillStyle = '#6f6a88'; ctx.fillText(compact(value), x + plotW + 12, gy); }
  }
  const slot = plotW / bars.length, body = Math.max(3, slot * 0.62);
  bars.forEach((bar, i) => {
    const cx = x + slot * (i + 0.5), color = bar.c >= bar.o ? UP : DOWN;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(cx - 1), yOf(bar.h), 2, Math.max(1, yOf(bar.l) - yOf(bar.h)));
    const y0 = yOf(Math.max(bar.o, bar.c)), y1 = yOf(Math.min(bar.o, bar.c));
    ctx.fillRect(cx - body / 2, y0, body, Math.max(2, y1 - y0));
  });
  // hour labels
  ctx.fillStyle = '#6f6a88'; ctx.textAlign = 'center'; ctx.font = `500 19px ${MONO}`;
  if (labels) for (const i of [0, Math.floor(bars.length / 2), bars.length - 1]) ctx.fillText(hourLabel(bars[i].t), x + slot * (i + 0.5), y + h - 12);
  // last price line + tag
  if (Number.isFinite(last)) {
    const ly = yOf(last), color = last >= bars[0].o ? UP : DOWN;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([8, 7]);
    ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + plotW, ly); ctx.stroke(); ctx.setLineDash([]);
    if (labels) {
      ctx.fillStyle = color; ctx.fillRect(x + plotW + 4, ly - 15, axis - 6, 30);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.font = `700 21px ${MONO}`; ctx.fillText(compact(last), x + plotW + 12, ly + 1);
    }
  }
}

export function drawMarketBoard(ctx, snapshot) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b0818'); bg.addColorStop(1, '#070b14');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.022)';
  for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);
  const frame = ctx.createLinearGradient(0, 0, W, 0);
  frame.addColorStop(0, VIOLET); frame.addColorStop(1, TEAL);
  ctx.strokeStyle = frame; ctx.lineWidth = 10; ctx.strokeRect(5, 5, W - 10, H - 10);

  const status = snapshot?.status || 'offline';
  const assets = status === 'offline' ? [] : (snapshot?.assets || []);
  const quote = snapshot?.quote || 'USD';

  ctx.textBaseline = 'middle';
  ctx.font = `600 30px ${MONO}`; ctx.fillStyle = '#b9b2d6'; ctx.textAlign = 'left';
  ctx.fillText('MIRRORTERRA · MARKET', 40, 50);
  ctx.textAlign = 'center'; ctx.fillStyle = '#6f6a88'; ctx.font = `500 24px ${MONO}`;
  ctx.fillText('1H CANDLES · LAST 24H', W / 2 + 60, 50);
  const badge = status === 'live' ? ['LIVE', '#2ee59d'] : status === 'stale' ? ['DELAYED', '#f5b93d'] : ['OFFLINE', '#8a86a0'];
  ctx.textAlign = 'right'; ctx.font = `700 30px ${MONO}`; ctx.fillStyle = badge[1];
  ctx.fillText(badge[0], W - 40, 50);
  ctx.beginPath(); ctx.arc(W - 54 - ctx.measureText(badge[0]).width, 50, 9, 0, Math.PI * 2); ctx.fill();

  if (!assets.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#e8e4f7'; ctx.font = `600 72px ${FONT}`;
    ctx.fillText('Live feed unavailable', W / 2, H / 2 - 24);
    ctx.fillStyle = '#8a86a0'; ctx.font = `500 32px ${FONT}`;
    ctx.fillText('No prices shown until a real quote arrives', W / 2, H / 2 + 44);
  }

  assets.slice(0, 2).forEach((asset, index) => {
    const top = 92 + index * 324, color = tone(asset.change24hPct);
    if (index) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(40, top - 12, W - 80, 2); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f4f1ff'; ctx.font = `800 60px ${FONT}`; ctx.fillText(asset.symbol, 40, top + 50);
    ctx.fillStyle = '#8a86a0'; ctx.font = `500 24px ${MONO}`;
    ctx.fillText(`/${quote}`, 40 + ctx.measureText(asset.symbol).width * 2.3 + 10, top + 56);
    ctx.fillStyle = color; ctx.font = `700 58px ${MONO}`; ctx.fillText(money(asset.price, quote), 40, top + 128);
    const arrow = asset.change24hPct > 0.005 ? '▲ ' : asset.change24hPct < -0.005 ? '▼ ' : '';
    const label = asset.changeBasis === 'utc-day' ? 'today' : '24h';
    ctx.font = `600 32px ${MONO}`; ctx.fillText(`${arrow}${percent(asset.change24hPct)} ${label}`, 40, top + 190);
    ctx.fillStyle = '#8a86a0'; ctx.font = `500 24px ${MONO}`;
    ctx.fillText(`H ${compact(asset.high24h)}`, 40, top + 244);
    ctx.fillText(`L ${compact(asset.low24h)}`, 220, top + 244);
    drawCandles(ctx, asset.candles, asset.price, { x: 430, y: top, w: 810, h: 296 });
  });

  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = '#8a86a0'; ctx.font = `500 24px ${MONO}`;
  const source = snapshot?.source ? `${snapshot.source} · ${quote}` : 'no source';
  const when = snapshot?.asOf ? `updated ${clock(snapshot.asOf)}` : '';
  ctx.fillText(source, 40, H - 34);
  ctx.textAlign = 'right'; ctx.fillText(when, W - 40, H - 34);
  ctx.restore();
}

// Floor-standing LED wall: plinth, two legs and a double-sided screen, turned to `yaw`.
export function createMarketScreen(THREE, { position = [0, 0, 0], yaw = 0, width = 3.5, bottom = 0.78 } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  const group = new THREE.Group(); group.position.set(position[0], 0, position[2]); group.rotation.y = yaw;
  const boardHeight = width * (H / W), centerY = bottom + boardHeight / 2;
  const frameMaterial = new THREE.MeshStandardMaterial({ color: '#1d1830', roughness: 0.45, metalness: 0.5, flatShading: true });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: '#8b5cf6', emissive: '#8b5cf6', emissiveIntensity: 1.2, flatShading: true });
  const geometries = [];
  const add = (geometry, material, x, y, z) => {
    geometries.push(geometry); const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
  };
  add(new THREE.BoxGeometry(width + 0.2, 0.22, 0.62), frameMaterial, 0, 0.11, 0);              // plinth
  for (const z of [-0.31, 0.31]) add(new THREE.BoxGeometry(width + 0.2, 0.035, 0.03), trimMaterial, 0, 0.2, z); // neon edge strips
  for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.16, bottom - 0.2, 0.2), frameMaterial, side * width * 0.32, 0.22 + (bottom - 0.22) / 2, 0);
  add(new THREE.BoxGeometry(width + 0.18, boardHeight + 0.18, 0.16), frameMaterial, 0, centerY, 0); // casing
  for (const z of [-0.085, 0.085]) add(new THREE.BoxGeometry(width + 0.18, 0.03, 0.02), trimMaterial, 0, centerY + boardHeight / 2 + 0.09, z);
  const faceMaterial = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const faceGeometry = new THREE.PlaneGeometry(width, boardHeight); geometries.push(faceGeometry);
  const front = new THREE.Mesh(faceGeometry, faceMaterial); front.position.set(0, centerY, 0.082); group.add(front);
  const back = new THREE.Mesh(faceGeometry, faceMaterial); back.position.set(0, centerY, -0.082); back.rotation.y = Math.PI; group.add(back);
  const glows = [0.9, -0.9].map((z) => { const light = new THREE.PointLight('#8b5cf6', 0.5, 5, 2); light.position.set(0, centerY, z); group.add(light); return light; });
  let snapshot = null;
  const redraw = () => { drawMarketBoard(ctx, snapshot); texture.needsUpdate = true; };
  redraw();
  return {
    group,
    top: bottom + boardHeight + 0.09,
    update(next) { snapshot = next && typeof next === 'object' ? next : null; redraw(); },
    redraw,
    setNight(night) {
      for (const light of glows) light.intensity = 0.3 + night * 1.3;
      trimMaterial.emissiveIntensity = 0.8 + night * 2.2;
    },
    dispose() {
      texture.dispose(); faceMaterial.dispose(); frameMaterial.dispose(); trimMaterial.dispose();
      for (const geometry of geometries) geometry.dispose();
    }
  };
}

// ---- Exchange wall (COIN HOF facade) ------------------------------------------------------------
// A Korean-exchange style tiled board: one large BTC tile, an ETH tile, a status tile and a ticker
// strip, red up / blue down. Same rule as the board above: real quotes only, otherwise "unavailable".
const XW = 1600, XH = 960;

// Panel wall: a 3 x 2 grid of LED panels with dark bezels. BTC's hourly chart spans the left 2 x 2;
// the right column carries ETH, the BTC quote, and the feed status.
export function drawExchangeWall(ctx, snapshot) {
  ctx.save();
  ctx.clearRect(0, 0, XW, XH);
  const panel = ctx.createLinearGradient(0, 0, 0, XH);
  panel.addColorStop(0, '#1b2b4d'); panel.addColorStop(1, '#13203d');
  ctx.fillStyle = panel; ctx.fillRect(0, 0, XW, XH);
  const status = snapshot?.status || 'offline';
  const assets = status === 'offline' ? [] : (snapshot?.assets || []);
  const quote = snapshot?.quote || 'USD';
  const btc = assets.find((a) => a.symbol === 'BTC'), eth = assets.find((a) => a.symbol === 'ETH');
  const badge = status === 'live' ? ['LIVE', '#2ee59d'] : status === 'stale' ? ['DELAYED', '#f5b93d'] : ['OFFLINE', '#8a86a0'];
  const colW = XW / 3, rowH = XH / 2, leftW = colW * 2, rx = leftW, cell = XH / 3;
  // faint LED grid on every panel
  ctx.fillStyle = 'rgba(140,170,255,0.05)';
  for (let gx = 0; gx < XW; gx += 160) ctx.fillRect(gx, 0, 2, XH);
  for (let gy = 0; gy < XH; gy += 160) ctx.fillRect(0, gy, XW, 2);

  if (!assets.length) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#e8e4f7'; ctx.font = `700 76px ${FONT}`;
    ctx.fillText('Live feed unavailable', leftW / 2, XH / 2 - 30);
    ctx.fillStyle = '#8a86a0'; ctx.font = `500 34px ${FONT}`;
    ctx.fillText('No prices until a real quote arrives', leftW / 2, XH / 2 + 40);
  }
  const small = (asset, x, y) => {
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `700 30px ${MONO}`;
    ctx.fillStyle = '#c9d4f5'; ctx.fillText(asset.symbol, x, y);
    ctx.fillStyle = tone(asset.change24hPct); ctx.fillText(`${money(asset.price, quote)}  ${percent(asset.change24hPct)}`, x + 86, y);
  };
  // big tile: BTC hourly candles over the left 2 x 2 panels
  if (btc) {
    small(btc, 40, 52);
    drawCandles(ctx, btc.candles, btc.price, { x: 40, y: 96, w: leftW - 70, h: XH - 150, labels: false });
    ctx.fillStyle = badge[1]; ctx.font = `600 24px ${MONO}`; ctx.textAlign = 'left';
    ctx.fillText(`● ${badge[0]}  ${snapshot?.source || ''} · 1H`, 40, XH - 30);
  }
  // right column: ETH 24h, BTC last 8h, ETH last 8h (all real bars)
  const tiles = [[eth, eth?.candles], [btc, btc?.candles?.slice(-8)], [eth, eth?.candles?.slice(-8)]];
  tiles.forEach(([asset, candles], i) => {
    const y = i * cell;
    if (!asset) return;
    ctx.save(); ctx.font = `600 24px ${MONO}`; ctx.fillStyle = '#93a4d8'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${asset.symbol} ${i ? '8H' : '24H'}`, rx + 30, y + 40); ctx.restore();
    drawCandles(ctx, candles, asset.price, { x: rx + 30, y: y + 64, w: colW - 60, h: cell - 90, labels: false });
  });
  // panel bezels: 3 columns x 2 rows on the left, three tiles on the right
  ctx.fillStyle = '#03050b';
  const bez = 16;
  for (let i = 0; i <= 3; i += 1) ctx.fillRect(Math.min(XW - bez, Math.max(0, i * colW - bez / 2)), 0, bez, XH);
  for (let j = 0; j <= 2; j += 1) ctx.fillRect(0, Math.min(XH - bez, Math.max(0, j * rowH - bez / 2)), leftW, bez);
  for (let j = 0; j <= 3; j += 1) ctx.fillRect(rx, Math.min(XH - bez, Math.max(0, j * cell - bez / 2)), colW, bez);
  ctx.restore();
}

// Flat LED wall for a facade: casing + one front face (the canvas above). Local +z is the viewing side.
export function createExchangeWall(THREE, { width = 2.4 } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = XW; canvas.height = XH;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  const height = width * (XH / XW);
  const group = new THREE.Group(); group.name = 'exchange-wall';
  const geometries = [];
  const casingMaterial = new THREE.MeshStandardMaterial({ color: '#3a3038', roughness: 0.5, metalness: 0.4, flatShading: true });
  const casingGeometry = new THREE.BoxGeometry(width + 0.12, height + 0.12, 0.1); geometries.push(casingGeometry);
  const casing = new THREE.Mesh(casingGeometry, casingMaterial); casing.castShadow = true; group.add(casing);
  const faceMaterial = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const faceGeometry = new THREE.PlaneGeometry(width, height); geometries.push(faceGeometry);
  const face = new THREE.Mesh(faceGeometry, faceMaterial); face.position.z = 0.052; group.add(face);
  const light = new THREE.PointLight('#5b8cff', 0.4, 6, 2); light.position.set(0, 0, 1.1); group.add(light);
  let snapshot = null;
  const redraw = () => { drawExchangeWall(ctx, snapshot); texture.needsUpdate = true; };
  redraw();
  return {
    group, width, height,
    update(next) { snapshot = next && typeof next === 'object' ? next : null; redraw(); },
    redraw,
    setNight(night) { light.intensity = 0.25 + night * 1.4; },
    dispose() { texture.dispose(); faceMaterial.dispose(); casingMaterial.dispose(); for (const g of geometries) g.dispose(); }
  };
}

export function startMarketScreenPolling(screen, { fetchImpl = globalThis.fetch, intervalMs = 15000, onChange } = {}) {
  let stopped = false, timer = 0, inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    inFlight = true;
    try {
      const response = await fetchImpl(MARKET_TICKER_URL, { cache: 'no-store' });
      screen.update(response.ok ? await response.json() : null);
    } catch {
      screen.update(null);
    } finally {
      inFlight = false; onChange?.();
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}
