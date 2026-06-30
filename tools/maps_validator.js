// Maps validator — extracts MAPS + FREE_MAPS from copper-beta.html and
// runs BFS-based connectivity & fairness checks. Read-only.
//
// Usage:   node tools/maps_validator.js
// Returns: exit code 0 if all maps pass, 1 if any map fails a hard rule.

"use strict";

const fs = require("fs");
const path = require("path");

const HTML_PATH = path.resolve(__dirname, "..", "copper-beta.html");

function extractArrayLiteral(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error("marker not found: " + marker);
  const open = src.indexOf("[", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  throw new Error("unbalanced brackets in " + marker);
}

function loadMaps() {
  const HTML = fs.readFileSync(HTML_PATH, "utf8");
  return {
    FREE_MAPS: eval(extractArrayLiteral(HTML, "const FREE_MAPS =")),
    MAPS:      eval(extractArrayLiteral(HTML, "const MAPS =")),
  };
}

const KEY = (x, y) => x + "," + y;
const inBounds = (g, x, y) => y>=0 && y<g.length && x>=0 && x<g[0].length;
const isWalk = (g, x, y) => inBounds(g, x, y) && g[y][x] === ".";

function bfs(g, sx, sy) {
  const dist = new Map();
  if (!isWalk(g, sx, sy)) return dist;
  dist.set(KEY(sx, sy), 0);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    const d = dist.get(KEY(x, y));
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (!isWalk(g, nx, ny)) continue;
      if (dist.has(KEY(nx, ny))) continue;
      dist.set(KEY(nx, ny), d + 1);
      q.push([nx, ny]);
    }
  }
  return dist;
}

function degree(g, x, y) {
  let d = 0;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]])
    if (isWalk(g, x+dx, y+dy)) d++;
  return d;
}

function components(g) {
  const seen = new Set();
  const sizes = [];
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      if (!isWalk(g, x, y) || seen.has(KEY(x, y))) continue;
      const d = bfs(g, x, y);
      for (const k of d.keys()) seen.add(k);
      sizes.push(d.size);
    }
  }
  return sizes;
}

function countDeadEnds(g) {
  let n = 0;
  for (let y = 0; y < g.length; y++)
    for (let x = 0; x < g[0].length; x++)
      if (isWalk(g, x, y) && degree(g, x, y) === 1) n++;
  return n;
}

function cyclesCount(g) {
  let V = 0, E = 0;
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      if (!isWalk(g, x, y)) continue;
      V++;
      if (isWalk(g, x+1, y)) E++;
      if (isWalk(g, x, y+1)) E++;
    }
  }
  const C = components(g).length;
  return { V, E, C, cycles: E - V + C };
}

function routeDiversity(g, sx, sy, tx, ty) {
  const d1 = bfs(g, sx, sy);
  if (!d1.has(KEY(tx, ty))) return { reachable:false, primary:Infinity, alts:0, interior:0 };
  const path = [[tx, ty]];
  let cx = tx, cy = ty;
  while (cx !== sx || cy !== sy) {
    const d = d1.get(KEY(cx, cy));
    let stepped = false;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!isWalk(g, nx, ny)) continue;
      if (d1.get(KEY(nx, ny)) === d - 1) {
        path.push([nx, ny]); cx = nx; cy = ny; stepped = true; break;
      }
    }
    if (!stepped) break;
  }
  path.reverse();
  const primary = d1.get(KEY(tx, ty));
  let alts = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const [bx, by] = path[i];
    const blocked = new Set([KEY(bx, by)]);
    const dist = new Map();
    dist.set(KEY(sx, sy), 0);
    const q = [[sx, sy]];
    let found = false;
    while (q.length) {
      const [x, y] = q.shift();
      const dd = dist.get(KEY(x, y));
      if (x === tx && y === ty) { found = true; break; }
      if (dd > primary + 12) continue;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (!isWalk(g, nx, ny)) continue;
        if (blocked.has(KEY(nx, ny))) continue;
        if (dist.has(KEY(nx, ny))) continue;
        dist.set(KEY(nx, ny), dd + 1);
        q.push([nx, ny]);
      }
    }
    if (found) alts++;
  }
  return { reachable:true, primary, alts, interior: path.length - 2 };
}

function earlyChokes(g, sx, sy, radius = 4, threshold = 40) {
  const dP = bfs(g, sx, sy);
  const list = [];
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      if (!isWalk(g, x, y)) continue;
      const d = dP.get(KEY(x, y));
      if (d === undefined || d === 0 || d > radius) continue;
      const newG = g.map(r => r.split(""));
      newG[y][x] = "#";
      const newGrid = newG.map(r => r.join(""));
      const dP2 = bfs(newGrid, sx, sy);
      let cuts = 0;
      for (const k of dP.keys()) {
        if (k === KEY(x, y)) continue;
        if (!dP2.has(k)) cuts++;
      }
      if (cuts > threshold) list.push({ x, y, cuts });
    }
  }
  return list;
}

function auditMap(m) {
  const g = m.grid;
  const W = g[0].length, H = g.length;
  const ps = m.playerStart, gs = m.ghostStart;
  const dP = bfs(g, ps.x, ps.y);
  const sameComp = dP.has(KEY(gs.x, gs.y));
  const distPG = sameComp ? dP.get(KEY(gs.x, gs.y)) : -1;
  const comps = components(g);
  const dead = countDeadEnds(g);
  const cyc = cyclesCount(g);
  const route = routeDiversity(g, ps.x, ps.y, gs.x, gs.y);
  const chokes = earlyChokes(g, ps.x, ps.y, 4, 40);

  // diamond nodes — must be walkable & in player's component
  const badNodes = [];
  for (const dn of (m.diamondSpawnNodes || [])) {
    if (!isWalk(g, dn.x, dn.y) || !dP.has(KEY(dn.x, dn.y))) badNodes.push(dn);
  }

  let isolated = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isWalk(g, x, y) && !dP.has(KEY(x, y))) isolated++;

  return {
    id: m.id, name: m.name, W, H, ps, gs,
    pWalk: isWalk(g, ps.x, ps.y),
    gWalk: isWalk(g, gs.x, gs.y),
    sameComp, distPG,
    pDeg: degree(g, ps.x, ps.y),
    gDeg: degree(g, gs.x, gs.y),
    components: comps.length,
    componentSizes: comps,
    isolated,
    deadEnds: dead,
    cycles: cyc.cycles,
    V: cyc.V, E: cyc.E,
    earlyChokes: chokes,
    route,
    badNodes,
  };
}

// Hard rules (validator fails if any of these break)
function evaluate(a) {
  const fails = [];
  if (!a.pWalk) fails.push("player spawn on wall");
  if (!a.gWalk) fails.push("ghost spawn on wall");
  if (!a.sameComp) fails.push("player & ghost in different components");
  if (a.components > 1) fails.push("multiple walkable components: " + a.componentSizes.join(","));
  if (a.isolated > 0) fails.push("isolated tiles from player: " + a.isolated);
  if (a.pDeg < 2) fails.push("player spawn degree < 2 (got " + a.pDeg + ")");
  if (a.gDeg < 2) fails.push("ghost spawn degree < 2 (got " + a.gDeg + ")");
  if (a.distPG < 12) fails.push("BFS dist P->G < 12 (got " + a.distPG + ")");
  if (a.earlyChokes.length) fails.push("early choke(s) cutting >40 tiles: " + a.earlyChokes.map(c=>`(${c.x},${c.y})cut=${c.cuts}`).join(" "));

  // soft warnings (do not fail)
  const warns = [];
  // diamondSpawnNodes is legacy data — spawnDiamonds() picks from
  // getWalkableTiles() at runtime, so invalid nodes are cosmetic only.
  if (a.badNodes.length) warns.push("legacy diamondSpawnNodes on walls: " + JSON.stringify(a.badNodes));
  if (a.cycles < 8) warns.push("low cycle count: " + a.cycles);
  const ratio = a.route.interior > 0 ? a.route.alts / a.route.interior : 1;
  if (ratio < 0.30) warns.push("route diversity " + (ratio*100).toFixed(0) + "%");
  return { fails, warns };
}

function main() {
  const { FREE_MAPS, MAPS } = loadMaps();
  const all = [
    ...FREE_MAPS.map(m => ({ tag: "FREE", ...m })),
    ...MAPS.map(m => ({ tag: "PAID", ...m })),
  ];
  let bad = 0;
  console.log("MAPS VALIDATOR — " + all.length + " maps\n");
  for (const m of all) {
    const a = auditMap(m);
    const { fails, warns } = evaluate(a);
    const status = fails.length ? "FAIL" : (warns.length ? "WARN" : "OK");
    if (fails.length) bad++;
    console.log(`[${a.id}] ${status}  ${m.tag}  comp=${a.components} dist=${a.distPG} deg(P/G)=${a.pDeg}/${a.gDeg} dead=${a.deadEnds} cycles=${a.cycles} alts=${a.route.alts}/${a.route.interior}`);
    for (const f of fails) console.log("   FAIL: " + f);
    for (const w of warns) console.log("   warn: " + w);
  }
  console.log("\nResult: " + (bad === 0 ? "ALL PASS" : bad + " maps failed"));
  process.exit(bad === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { loadMaps, auditMap, evaluate, bfs, degree, components, cyclesCount, routeDiversity, earlyChokes };
