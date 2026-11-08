// UltiEngine: value network + one-move search for the playbook board.
// V(state) = chance the possession scores, learned from simulated possessions (rl/train_value.py).
// Features must match rl/game.py:features() exactly (the first 39; energy inputs are JS-only).
(function (root) {
  'use strict';
  const L = 30, W = 18, STALL = 8;
  let NET = null;

  function load(json) { NET = json; return api; }
  const ready = () => !!NET;
  const silu = x => x / (1 + Math.exp(-x));

  function mlp(f) {
    const nin = NET.features || NET.layers[0].W[0].length;
    let h = f.length > nin ? f.slice(0, nin) : f;
    if (h.length < nin) { h = h.slice(); while (h.length < nin) h.push(1); }   // energy-aware net, no energy given: fresh
    const n = NET.layers.length;
    for (let li = 0; li < n; li++) {
      const l = NET.layers[li], o = new Float64Array(l.b.length);
      for (let r = 0; r < l.b.length; r++) {
        let s = l.b[r]; const w = l.W[r];
        for (let c = 0; c < h.length; c++) s += w[c] * h[c];
        o[r] = li < n - 1 ? silu(s) : s;
      }
      h = o;
    }
    return 1 / (1 + Math.exp(-h[0]));
  }

  // pos, vel: arrays of 8 [x,y] (O1..O4, D1..D4); holder 0..3; stall seconds
  // Energy (burst, reserve per player, 0..1) is context set by the game each step; nets trained with it
  // read 55 inputs (39 + 8 x [burst, reserve], same player order), older nets the first 39.
  let EN = null;
  const setEnergy = (burst, reserve) => { EN = burst ? [burst, reserve] : null; };
  function features(pos, vel, holder, stall, en) {
    en = en || EN;
    const H = pos[holder];
    const others = [0, 1, 2, 3].filter(i => i !== holder).sort((a, b) => pos[b][0] - pos[a][0]);
    const order = [holder].concat(others);
    const f = [H[0] / L, H[1] / W, stall / STALL];
    for (const o of others) f.push(pos[o][0] / L, pos[o][1] / W, vel[o][0] / 7, vel[o][1] / 7);
    for (const o of order) {
      const P = pos[o + 4], V = vel[o + 4], O = pos[o];
      f.push(P[0] / L, P[1] / W, V[0] / 7, V[1] / 7, (P[0] - O[0]) / 5, (P[1] - O[1]) / 5);
    }
    if (en) for (const o of order) f.push(en[0][o], en[1] ? en[1][o] : 1, en[0][o + 4], en[1] ? en[1][o + 4] : 1);
    return f;
  }
  const value = (pos, vel, holder, stall) => mlp(features(pos, vel, holder, stall));

  const PIDS = ['O1', 'O2', 'O3', 'O4', 'D1', 'D2', 'D3', 'D4'];
  const clampF = (p, f) => [Math.max(0.3, Math.min(f.L - 0.3, p[0])), Math.max(0.3, Math.min(f.W - 0.3, p[1]))];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Board state -> arrays. vel: optional {pid:[vx,vy]}
  function stateOf(node, vel, stall) {
    const pos = PIDS.map(p => node.pos[p].slice());
    const v = PIDS.map(p => (vel && vel[p]) ? vel[p].slice() : [0, 0]);
    const holder = typeof node.disc === 'string' && node.disc[0] === 'O' ? +node.disc[1] - 1 : -1;
    return { pos, vel: v, holder, stall: stall || 0 };
  }

  // One-move search: every throw to every receiver and lead spot, scored by
  // Q = P(complete) * V(after the catch). Turnovers count as 0 (possession over).
  function search(SIM, play, st, opts) {
    opts = opts || {};
    if (!NET || st.holder < 0) return null;
    const f = play.field, A = st.pos[st.holder];
    if (A[0] >= f.L - f.ez) return { goal: true, v0: 1, lines: [], hold: { kind: 'hold', q: 1 }, best: 1, close: [] };
    const v0 = value(st.pos, st.vel, st.holder, st.stall);
    const defPos = {}; for (let i = 0; i < 4; i++) defPos['D' + (i + 1)] = st.pos[4 + i];
    const mk = SIM.markOf(A, defPos);
    const defs = opts.defs || Object.entries(defPos).map(([id, pos]) => ({ id, pos, mark: id === mk }));
    const lines = [];
    for (let r = 0; r < 4; r++) {
      if (r === st.holder) continue;
      const R = st.pos[r];
      const nA = opts.angles || 12;
      for (const rad of [0, 2, 4, 6]) for (let k = 0; k < (rad ? nA : 1); k++) {
        const a = k * 2 * Math.PI / nA, B = [R[0] + rad * Math.cos(a), R[1] + rad * Math.sin(a)];
        if (B[0] < 0.3 || B[0] > f.L - 0.3 || B[1] < 0.3 || B[1] > f.W - 0.3) continue;
        const res = SIM.bestThrow({ A, B, defs, field: f });
        if (!res) continue;
        const arrive = rad ? 0.1 + SIM.tRun(rad) : 0;
        for (const t of res.all.slice(0, 3)) {
          if (arrive > t.flight + 0.1) continue;
          let v1;
          if (t.goal) v1 = 1;
          else {
            const pos = st.pos.map((p, i) => i === r ? B.slice() : clampF([p[0] + st.vel[i][0] * t.flight, p[1] + st.vel[i][1] * t.flight], f));
            const vel = st.vel.map((v, i) => i === r ? [0, 0] : v.slice());
            v1 = value(pos, vel, r, 0);
          }
          const prior = SIM.TYPES[t.type] ? ({ flat: 1, push: 1, float: .97, io: .92, oi: .92, high: .95, hammer: .9, scoober: .9, blade: .85, huck: .95 })[t.type] : 1;
          lines.push({ kind: 'throw', to: PIDS[r], B, lead: rad, throw: t, p: t.p, vAfter: v1, q: t.p * v1, prior });
        }
      }
    }
    // keep distinct lines: best per receiver and area (targets 3 m apart)
    lines.sort((a, b) => b.q - a.q);
    const out = [];
    for (const l of lines) {
      if (out.some(o => o.to === l.to && dist(o.B, l.B) < 5)) continue;
      out.push(l);
      if (out.length >= (opts.max || 5)) break;
    }
    // simplicity tie-break: within 2 points, prefer the more natural throw
    for (let i = 0; i + 1 < out.length; i++) {
      if (out[i].q - out[i + 1].q < 0.02 && out[i + 1].prior > out[i].prior) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
    const best = out.length ? out[0].q : 0;
    const hold = { kind: 'hold', q: v0 };
    return { v0, lines: out, hold, best, close: out.filter(l => best - l.q <= 0.05) };
  }

  // Value of moving one player to each 1 m cell (others fixed). For defenders, lower is better.
  function heat(play, st, pid) {
    if (!NET || st.holder < 0) return null;
    const i = PIDS.indexOf(pid); if (i < 0 || i === st.holder) return null;
    const f = play.field, cells = [];
    for (let x = 0.5; x < f.L; x += 1) for (let y = 0.5; y < f.W; y += 1) {
      const pos = st.pos.map((p, j) => j === i ? [x, y] : p);
      const vel = st.vel.map((v, j) => j === i ? [0, 0] : v);
      cells.push([x, y, value(pos, vel, st.holder, st.stall)]);
    }
    return { pid, cells, now: value(st.pos, st.vel, st.holder, st.stall), defense: pid[0] === 'D' };
  }

  const api = { load, ready, value, features, stateOf, search, heat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UltiEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
