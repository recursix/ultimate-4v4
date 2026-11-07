// UltiGame: one live 4v4 possession in the browser (or Node), with engine-guided AI players.
// Physics mirror rl/game.py and sim.js. Players: 0-3 offense (O1..O4), 4-7 defense; D(i+1) guards O(i+1).
// x along the 30 m field (offense attacks +x, goal line at 27), y across 18 m, force flick (mark on low-y side).
(function (root) {
  'use strict';
  const isNode = typeof window === 'undefined';
  const SIM = isNode ? require('./sim.js') : root.UltiSim;
  const ENG = isNode ? require('./engine.js') : root.UltiEngine;

  const FIELD = { L: 30, W: 18, ez: 3, brick: 2 };
  const L = FIELD.L, W = FIELD.W, GOAL_X = L - FIELD.ez;
  const SUB = 0.05, DECIDE = 0.5, STALL = 8;
  let LOOK = 1.2; const TAU = 0.85, TAU_BRAKE = 0.3, TAU_SPRINT = SIM.P.tauSprint;   // explosive first steps when sprinting
  const PIDS = ['O1', 'O2', 'O3', 'O4', 'D1', 'D2', 'D3', 'D4'];
  const LABELS = { O1: 'H1', O2: 'H2', O3: 'C1', O4: 'C2', D1: 'D1', D2: 'D2', D3: 'D3', D4: 'D4' };
  const PLAY = { field: FIELD, labels: LABELS, defense: 'person', stall: STALL };
  const CATCH_RADIUS = 1.5;
  // Patience: early in the count a rec thrower only throws a clearly open look; the bar drops as the stall climbs.
  let PATIENCE = { p0: 0.95, slope: 0.06, floor: 0.55 };
  const patience = stall => Math.max(PATIENCE.floor, PATIENCE.p0 - PATIENCE.slope * stall);
  let RISK = 0.4; const PRIOR_W = 0.15, HOLD_GAIN = 0.04;   // rec handlers avoid risky throws (risk weight), and unusual ones (prior)
  const USER_HOLD = 1.0;   // seconds an offensive player you moved keeps your spot (a defender stays parked until the next throw)
  // Energy: sprinting above cruise speed drains a burst bucket; jogging or standing refills it.
  const VTOP = SIM.P.vmax, VCRUISE = 4.5, VJOG = 3.4, BURST = 2.2, REGEN = 5.0;
  // Layouts: a dive reaches LAY_REACH past normal catching range, the player is down for LAY_DOWN seconds.
  const LAY_REACH = 1.6, LAY_DOWN = 1.4, LAY_COST = 0.2;
  // Bodies: players can't pass through each other. AI runners steer around anyone in their path (not their own
  // matchup); contact pushes both apart and costs the momentum they had into each other.
  // A defender screened off while guarding their player (within PICK_NEAR m) calls a pick.
  const GAME_TO = 7;      // first to 7 points wins
  const SETUP_MAX = 12;   // longest line-up between points before the disc goes in anyway
  const BODY = 0.9, AVOID = 2.2, PICK_NEAR = 3.5, PICK_COOL = 3;

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const mul = (a, k) => [a[0] * k, a[1] * k];
  const len = a => Math.hypot(a[0], a[1]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const unit = a => { const l = len(a); return l < 1e-6 ? [0, 0] : [a[0] / l, a[1] / l]; };
  const clampF = (p, m = 0.3) => [Math.max(m, Math.min(L - m, p[0])), Math.max(m, Math.min(W - m, p[1]))];
  const clone = o => JSON.parse(JSON.stringify(o));

  // xorshift32, with the seed scrambled first (small or nearby seeds gave nearly identical first draws)
  function rng(seed) { let s = seed >>> 0; s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0; s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0; s = (s ^ (s >>> 16)) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  function create(setup, opts) {
    opts = opts || {};
    const s = {
      t: 0, pos: PIDS.map(p => setup.pos[p].slice()), vel: PIDS.map(() => [0, 0]), tgt: PIDS.map(p => setup.pos[p].slice()),
      vmax: PIDS.map(() => 6.9), holder: +setup.holder.slice(1) - 1, stall: setup.stall || 0,
      flight: null, done: null, nextDecision: 0, seed: opts.seed || 7, dice: opts.dice || 'expected',
      macro: PIDS.map(() => ({ kind: 'set', label: '', target: null, since: 0 })),
      dstyle: PIDS.map(() => 'under'), log: [], lastSearch: null, evalNow: null,
      energy: PIDS.map(() => 1), down: PIDS.map(() => 0), lay: PIDS.map(() => null), jog: false,
      flipped: false, score: [0, 0], poss: 1,   // flipped: team B has the disc (the frame is mirrored so offense still attacks +x)
    };
    s.macro[s.holder] = { kind: 'hold', label: 'holds the disc', target: null, since: 0 };
    s.rand = rng(s.seed);
    return s;
  }
  function snapshot(s) { const c = clone(Object.assign({}, s, { rand: null, flight: s.flight && Object.assign({}, s.flight, { th: null }) })); c._flightTh = s.flight && s.flight.th; return c; }
  function restore(c) { const s = clone(Object.assign({}, c, { _flightTh: null })); if (s.flight) s.flight.th = c._flightTh; s.rand = rng(Math.floor(c.t * 1000) + c.seed); delete s._flightTh; return s; }

  // top speed right now: the full sprint while there is burst left, cruise speed when it is empty
  const capOf = (s, i) => VCRUISE + (VTOP - VCRUISE) * Math.min(1, s.energy[i] / 0.25);
  // speed the AI wants: sprint for cuts, catches and reactions, cruise to clear, jog to reset (and recover)
  function effort(s, i) {
    if (s.setup) return VJOG;   // walking to the line-up between points
    if (i < 4) {
      const k = s.macro[i].kind;
      if ((s.flight && s.flight.recv === i) || ['under', 'deep', 'in', 'up', 'dump-back', 'dump-up', 'catch'].includes(k)) return VTOP;
      return k === 'clear' ? VCRUISE : VJOG;
    }
    const o = i - 4;
    if (s.holder === o || s.flight) return VTOP;
    if (len(s.vel[o]) > VCRUISE - 0.5 || dist(s.pos[i], s.tgt[i]) > 3) return VTOP;
    return VJOG + 0.6;
  }
  function energyStep(s, i, dt) {
    const v = len(s.vel[i]);
    if (v > VCRUISE) s.energy[i] = Math.max(0, s.energy[i] - dt * (v - VCRUISE) / (VTOP - VCRUISE) / BURST);
    else s.energy[i] = Math.min(1, s.energy[i] + dt * (1 - v / VCRUISE) / REGEN);
  }
  function layOut(s, i, P) {
    const dir = unit(sub(P, s.pos[i]));
    s.down[i] = LAY_DOWN; s.lay[i] = { dir, t0: s.t }; s.energy[i] = Math.max(0, s.energy[i] - LAY_COST);
    s.pos[i] = add(s.pos[i], mul(dir, Math.min(LAY_REACH, dist(s.pos[i], P)))); s.vel[i] = mul(dir, 1.5);
  }
  // ---- the disc in the air ----
  // trajectory parameter for a time since release (tAt is monotonic)
  function sAtTime(th, te) {
    if (!th.tAt) return Math.min(1, te / th.flight);
    let lo = 0, hi = 1;
    for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (th.tAt(m) < te) lo = m; else hi = m; }
    return hi;
  }
  // [x, y, h] of the disc at trajectory parameter u (an off-target throw drifts toward its miss point)
  function discAt(f, u) {
    const p = f.th.at ? f.th.at(u) : [f.A[0] + (f.B[0] - f.A[0]) * u, f.A[1] + (f.B[1] - f.A[1]) * u, 1.2];
    return f.miss ? [p[0] + (f.miss[0] - f.B[0]) * u, p[1] + (f.miss[1] - f.B[1]) * u, p[2]] : p;
  }
  // how far a defender reaches for a disc at height h (same numbers as sim.js)
  function reachAt(h, mark, te) {
    const P = SIM.P;
    if (mark) return h <= P.markH ? P.markReach + (h <= 1.0 ? 0.3 : 0) : -1;
    if (h <= 1.5) return P.arm;
    if (h <= P.standH) return P.arm * 0.7;
    if (h <= P.jumpH && te > 0.5) return 0.4;
    return -1;
  }
  const CONTEST = SIM.P.contest + SIM.P.hands;   // the last metres before the catch are a contest, settled in resolve() (same zone as sim.js)
  // Each defender gets one try at the disc, rolled at their closest approach to it. The gap to the disc
  // (beyond their reach; a dive adds SIM.P.layout for a low disc after 0.5 s, as in the throw model)
  // sets the chance: right through them ~99%, the edge of their reach 50%, 30 cm short ~4%.
  const GAP_SOFT = 0.2;   // only for skipping hopeless rolls
  function flightDefense(s) {
    const f = s.flight, te = s.t - f.t0, B = f.miss || f.B, end = te >= f.dur - 1e-9;
    // start just after the release (the disc in the thrower's hand can't be blocked; the throw model
    // likewise starts its samples a few centimetres out)
    const u0 = Math.max(sAtTime(f.th, Math.max(0, te - SUB)), 0.3 / Math.max(1, f.th.len || 1)), u1 = Math.max(u0, sAtTime(f.th, Math.min(te, f.dur)));
    const P0 = discAt(f, u0), P1 = discAt(f, u1);
    f.near = f.near || [];
    for (let d = 4; d < 8; d++) {
      if (f.tried[d] || s.down[d] > 0) continue;
      const mark = d === f.mark && dist(P1, f.A) < 4;
      let cur = null;
      if (te >= (mark ? 0.05 : 0.15)) {                                  // hands need a moment to react
        const seg = sub(P1, P0), sl = seg[0] * seg[0] + seg[1] * seg[1];
        const k = sl < 1e-9 ? 1 : Math.max(0, Math.min(1, ((s.pos[d][0] - P0[0]) * seg[0] + (s.pos[d][1] - P0[1]) * seg[1]) / sl));
        const Q = [P0[0] + seg[0] * k, P0[1] + seg[1] * k, P0[2] + (P1[2] - P0[2]) * k];
        const r = reachAt(Q[2], mark, te);
        if (r >= 0 && dist(Q, B) >= CONTEST) {
          const dive = !mark && Q[2] <= 1.5 && te > 0.5 ? SIM.P.layout : 0;
          cur = { gap: dist(s.pos[d], Q) - r - dive, Q, r, dd: dist(s.pos[d], Q), te };
        }
      }
      const best = f.near[d];
      if (cur && (!best || cur.gap < best.gap)) { f.near[d] = cur; if (!end) continue; }
      if (!best && !(cur && end)) continue;
      // the disc is past this defender (or out of their zone): one roll at the closest approach
      const B0 = f.near[d]; if (!B0 || B0.gap > 3 * GAP_SOFT + 0.4) { if (B0 && !cur) f.near[d] = null; continue; }
      f.tried[d] = 1;
      // same scale as the throw model: the gap as the time to cover it from a standstill, over a 0.1 s logistic
      // inside their reach: the deeper, the surer (sim.js inReach); a disc that comes at them before they can
      // react (reactD after the release, the mark is already set) gets that much leeway
      const react = Math.max(0, (mark ? SIM.P.reactMark : SIM.P.reactD) - B0.te);
      const m = (B0.gap > 0 ? SIM.tRunFrom(B0.gap, 0, 0, SIM.P.tauSprint) : SIM.P.inReach * B0.gap) + react, p = 1 / (1 + Math.exp(m / 0.1));
      if (s.dbg) s.dbg.push({ d: PIDS[d], mark, gap: +B0.gap.toFixed(2), dd: +B0.dd.toFixed(2), r: B0.r, pBlock: +p.toFixed(2), pred: +f.p.toFixed(2), pe: +(f.th.pe||0).toFixed(2), bId: f.th.bId, early: +f.th.early.toFixed(2), type: f.th.type, side: f.th.side, te: +te.toFixed(2), Hd: f.A.map(v=>+v.toFixed(1)), M: s.pos[d].map(v=>+v.toFixed(1)), Q: B0.Q.map(v=>+v.toFixed(1)) });
      const win = s.dice === 'random' ? s.rand() < p : p >= 0.5;
      const dived = B0.dd > B0.r + 0.3;
      if (dived) layOut(s, d, B0.Q);
      if (win) {
        // knocked down, or caught: the deeper inside their reach, the likelier they catch it (a mark or a dive mostly knocks it down)
        const pC = mark ? 0.08 : dived ? 0.12 : Math.max(0.12, Math.min(0.55, 0.12 - 0.8 * B0.gap));
        const caught = s.dice === 'random' ? s.rand() < pC : pC >= 0.5;
        const nm = LABELS[PIDS[d]];
        if (caught) return interception(s, d, `${nm} ${dived ? 'lays out and intercepts it' : 'intercepts it'}`, B0.Q);
        return turnover(s, `${nm} ${dived ? 'lays out and blocks it' : mark ? 'gets a hand block' : 'gets a hand on it'}`, B0.Q);
      }
      if (B0.gap < 0.3) s.log.push({ t: s.t, text: dived ? `${LABELS[PIDS[d]]} lays out for the block and just misses.` : `${LABELS[PIDS[d]]} gets a finger on it, but it gets through.` });
    }
  }
  // Where a defender can cut the disc off: the earliest point of the remaining flight they can reach in time.
  function interceptPoint(s, d) {
    const f = s.flight, te = s.t - f.t0, B = f.miss || f.B, cap = capOf(s, d), V = s.vel[d];
    const u0 = sAtTime(f.th, te);
    for (let k = 1; k <= 10; k++) {
      const u = u0 + (1 - u0) * k / 10, P = discAt(f, u);
      if (dist(P, B) < CONTEST) break;
      const r = reachAt(P[2], false, 1); if (r < 0) continue;
      const tDisc = (f.th.tAt ? f.th.tAt(u) : u * f.dur) - te;
      const g = dist(s.pos[d], P), dir = g > 1e-6 ? [(P[0] - s.pos[d][0]) / g, (P[1] - s.pos[d][1]) / g] : [0, 0];
      const vp = Math.max(0, V[0] * dir[0] + V[1] * dir[1]);
      if (Math.max(0, 0.3 - te) + SIM.tRunFrom(Math.max(0, g - r - LAY_REACH * 0.5), vp, cap, SIM.P.tauSprint) <= tDisc) return [P[0], P[1]];
    }
    return null;
  }

  // defenders as the throw model sees them: moving, maybe tired, maybe still on the ground
  function defsOf(s, A) {
    const defPos = {}; for (let i = 0; i < 4; i++) defPos['D' + (i + 1)] = s.pos[4 + i];
    const mk = SIM.markOf(A, defPos);
    return [4, 5, 6, 7].map(i => ({ id: PIDS[i], pos: s.pos[i], mark: PIDS[i] === mk, vel: s.vel[i], vmax: capOf(s, i), delay: Math.max(0, s.down[i]) }));
  }
  // a defender you placed stays parked until the next throw; an offensive player for USER_HOLD seconds
  const userHeld = (s, i) => s.macro[i].kind === 'user' && (i >= 4 ? s.holder >= 0 : s.t - s.macro[i].since < USER_HOLD);

  const discPoint = s => s.holder >= 0 ? s.pos[s.holder] : s.flight.B;
  const value = (s, pos, vel, holder, stall) => ENG.ready() ? ENG.value(pos || s.pos, vel || s.vel, holder == null ? s.holder : holder, Math.min(7.5, stall == null ? s.stall : stall)) : 0.5;

  function evalNow(s) {
    if (s.done) return s.done.reason === 'goal' ? 1 : 0;   // a Callahan is 0 for the offense
    if (s.holder >= 0) return value(s);
    const f = s.flight, r = f.recv;
    const pos = s.pos.map((p, i) => i === r ? f.B.slice() : p), vel = s.vel.map((v, i) => i === r ? [0, 0] : v);
    const after = f.B[0] >= GOAL_X ? 1 : value(s, pos, vel, r, 0);
    return f.p * after;
  }

  // ---------------------------------------------------------------------------------------------
  // Offense: macro options per player, scored with the value net
  // ---------------------------------------------------------------------------------------------
  function roles(s) {
    const Hd = discPoint(s);
    let dump = -1, bx = 1e9;
    for (let i = 0; i < 4; i++) if (i !== s.holder && !(s.flight && s.flight.recv === i) && s.pos[i][0] < bx) { bx = s.pos[i][0]; dump = i; }
    return { Hd, dump };
  }
  function setSpot(s, i, Hd) {
    let rank = 0;
    for (let j = 0; j < 4; j++) if (j !== i && j !== s.holder && s.pos[j][0] < s.pos[i][0] && roles(s).dump !== j) rank++;
    const depth = rank === 0 ? 8 : 14;
    return [Math.max(4, Math.min(28, Hd[0] + depth)), Math.max(2.5, Math.min(15.5, s.pos[i][1]))];
  }
  function dumpHome(Hd) { const y = Hd[1] - 3.5 < 1 ? Hd[1] + 3.5 : Hd[1] - 3.5; return clampF([Hd[0] - 3, y]); }

  function offenseOptions(s, i) {
    const Hd = discPoint(s), O = s.pos[i], { dump } = roles(s), opts = [];
    const push = (kind, label, T) => opts.push({ kind, label, target: clampF(T, 0.6) });
    if (i === dump) {
      push('set', 'sit as the dump', dumpHome(Hd));
      const sideY = Hd[1] - 5.5 < 0.8 ? Hd[1] + 5.5 : Hd[1] - 5.5;
      push('dump-back', 'dump: back and away', [Hd[0] - 2, sideY]);
      push('dump-up', 'dump: up the line', [Hd[0] + 4, Hd[1] - 4 < 0.8 ? Hd[1] + 4 : Hd[1] - 4]);
    } else {
      push('set', 'hold the stack spot', setSpot(s, i, Hd));
      push('under', 'cut under (open side)', [Hd[0] + 5.5, Hd[1] + 4]);
      push('deep', 'cut deep', [Math.min(Hd[0] + 16, 29.3), O[1] + (O[1] > 9 ? 1 : -1)]);
      push('in', 'cut into the middle', [Hd[0] + 7.5, 9]);
      push('up', 'cut up the line', [Math.min(O[0] + 6, 29.3), O[1]]);
      push('clear', 'clear out', [Math.min(Hd[0] + 11, 28.5), O[1] > 9 ? 3.5 : 14.5]);
    }
    return opts;
  }

  // Value of player i arriving at T: the guarding defender chases with a 0.3 s reaction.
  function scoreArrival(s, i, T) {
    const O = s.pos[i], d = 4 + i, D = s.pos[d];
    const tc = SIM.tRunFrom(dist(O, T), 0, capOf(s, i));
    const pos = s.pos.map(p => p.slice()), vel = s.vel.map(v => v.slice());
    pos[i] = T; vel[i] = mul(unit(sub(T, O)), Math.min(5, dist(O, T) / Math.max(tc, 0.3)));
    const chase = Math.max(0, tc - 0.3), toT = dist(D, T) - 1.0;
    if (toT > 0) pos[d] = add(D, mul(unit(sub(T, D)), Math.min(toT, SIM.dRun(chase))));
    vel[d] = mul(unit(sub(T, D)), 4);
    return { v: value(s, pos, vel, s.holder, s.stall + tc), tc };
  }

  function rankOffense(s, i) {
    if (s.holder < 0) return [];
    return offenseOptions(s, i).map(o => Object.assign(o, scoreArrival(s, i, o.target))).sort((a, b) => b.v - a.v);
  }

  // ---------------------------------------------------------------------------------------------
  // Defense: positioning styles, chosen to lower the offense's value
  // ---------------------------------------------------------------------------------------------
  function styleTarget(s, i, style) {
    const o = i - 4, O = s.pos[o], Hd = discPoint(s), uvec = sub(Hd, O), u = unit(uvec);
    if (s.holder === o) return add(O, [0.7, -1.0]);
    if (s.flight && s.flight.recv === o) return add(s.flight.B, mul(unit(sub(O, s.flight.B)), 0.8));
    switch (style) {
      case 'front': return add(O, add(mul(u, 1.8), [0, 0.3]));
      case 'deep': return add(O, [1.3, 0.3]);
      case 'poach': return add(O, mul(uvec, 0.38));
      default: return add(O, mul(unit(add(u, [0, 0.6])), 1.2));
    }
  }
  const STYLE_LABEL = { intercept: 'goes for the block', under: 'plays under, open side', front: 'fronts', deep: 'plays deep side', poach: 'poaches into the lane', mark: 'marks (force flick)', chase: 'chases the catch' };

  function rankDefense(s, i) {
    if (s.holder < 0) return [];
    const o = i - 4;
    if (s.holder === o) return [{ kind: 'mark', label: STYLE_LABEL.mark, target: styleTarget(s, i, 'mark'), v: value(s) }];
    const far = dist(s.pos[o], discPoint(s)) > 11;
    const styles = ['under', 'front', 'deep'].concat(far ? ['poach'] : []);
    return styles.map(st => {
      const T = styleTarget(s, i, st), pos = s.pos.map(p => p.slice());
      pos[i] = T;
      return { kind: st, label: STYLE_LABEL[st], target: T, v: value(s, pos) };
    }).sort((a, b) => a.v - b.v);
  }

  // ---------------------------------------------------------------------------------------------
  // Thrower
  // ---------------------------------------------------------------------------------------------
  function searchThrows(s) {
    if (s.holder < 0 || !ENG.ready()) return null;
    const node = { pos: {}, disc: PIDS[s.holder] };
    PIDS.forEach((p, i) => node.pos[p] = s.pos[i]);
    const vel = {}; PIDS.forEach((p, i) => vel[p] = s.vel[i]);
    return ENG.search(SIM, PLAY, ENG.stateOf(node, vel, Math.min(7.5, s.stall)), { max: 5, angles: 8, defs: defsOf(s, s.pos[s.holder]) });
  }

  // pull toward regular play: rec handlers avoid low-percentage throws and unusual throw types
  function rankThrows(lines) {
    lines.forEach(l => { l.reg = l.q - RISK * (1 - l.p) + PRIOR_W * Math.log(l.prior || 1); });
    return lines.sort((a, b) => b.reg - a.reg);
  }
  function placed(s, i) { if (s.setup) { s.setup.spots[i] = s.pos[i].slice(); s.setup.hold = true; return; } if (i !== s.holder) s.macro[i] = { kind: 'user', label: 'where you put them', target: s.pos[i].slice(), since: s.t }; }
  function think(s, ctrl) { if (s.done) return; decide(s, ctrl); s.nextDecision = s.t + DECIDE; s.evalNow = evalNow(s); }

  // "Hold" = the best throw half a second from now: everyone keeps moving, the disc stays put.
  function holdRollout(s) {
    const c = { t: s.t, pos: s.pos.map(p => p.slice()), vel: s.vel.map(v => v.slice()), tgt: s.tgt.map(p => p.slice()), vmax: s.vmax,
      holder: s.holder, stall: s.stall, flight: null, macro: s.macro, dstyle: s.dstyle, energy: s.energy.slice(), down: s.down.slice(), lay: s.lay.slice() };
    for (let k = 0; k < Math.round(DECIDE / SUB); k++) { targets(c, -1); physics(c, SUB, -1, null); c.t += SUB; c.stall += SUB; }
    return c;
  }
  // Lead a running receiver: aim each throw type at where they will be when it arrives.
  function leadLines(s, i, n) {
    const out = [], A = s.pos[s.holder], P = s.pos[i], V = s.vel[i], defs = defsOf(s, A);
    const PRIOR = { flat: 1, push: 1, float: .97, io: .92, oi: .92, high: .95, hammer: .9, scoober: .9, blade: .85, huck: .95 };
    for (const type of SIM.TYPE_ORDER) for (const side of [1, -1]) {
      // the catch spot depends on the flight time, which depends on the spot: one fixed-point step is enough
      const tf = SIM.trajectory(type, A, add(P, mul(V, 0.6)), side).flight;
      const B = clampF(add(P, mul(V, tf)), 0.4);
      const r = SIM.evalThrow({ A, B, defs, field: FIELD }, type, side); if (!r || !r.inBounds) continue;
      let v1 = 1;
      if (!r.goal) {
        const pos = s.pos.map((p, j) => j === i ? B.slice() : clampF(add(p, mul(s.vel[j], r.flight))));
        const vel = s.vel.map((v, j) => j === i ? [0, 0] : v.slice());
        v1 = value(s, pos, vel, i, 0);
      }
      out.push({ kind: 'throw', to: PIDS[i], B, lead: Math.round(dist(P, B)), throw: r, p: r.p, vAfter: v1, q: r.p * v1, prior: PRIOR[type] });
    }
    out.sort((a, b) => b.q - a.q);
    return out.slice(0, n || 2);
  }
  // Add lead throws for every running receiver (and for the player being dragged, whose path the
  // engine's fixed grid of lead spots can't follow). Keep one line per receiver and area.
  function addLeads(s, lines, ctrl) {
    let all = lines.filter(l => !(ctrl >= 0 && ctrl < 4 && ctrl !== s.holder && PIDS.indexOf(l.to) === ctrl));
    for (let i = 0; i < 4; i++) if (i !== s.holder && (i === ctrl || len(s.vel[i]) > 2.5) && !(s.down[i] > 0)) all = all.concat(leadLines(s, i));
    all.sort((a, b) => b.q - a.q);
    const out = [];
    for (const l of all) if (!out.some(o => o.to === l.to && dist(o.B, l.B) < 2.5)) out.push(l);
    return out.slice(0, 6);
  }
  function analyseThrower(s, ctrl) {
    const now = searchThrows(s); if (!now) return null;
    now.lines = rankThrows(addLeads(s, now.lines, ctrl));
    const c = holdRollout(s), later = searchThrows(c);
    const laterLines = later ? rankThrows(addLeads(c, later.lines, ctrl)) : [];
    now.later = laterLines[0] || null;
    now.holdQ = now.later ? now.later.reg : 0;      // value of holding = best throw available in 0.5 s
    now.bestNow = now.lines[0] ? now.lines[0].reg : 0;
    return now;
  }

  function release(s, line) {
    const t = line.throw, r = PIDS.indexOf(line.to);
    // Only the throw itself is rolled here (rec throwers miss sometimes). Blocks, interceptions and
    // contests are played out in the air: see flightDefense() and the catch in resolve().
    const rel = t.rel != null ? t.rel : t.p;
    const ok = s.dice === 'random' ? s.rand() < rel : rel >= 0.5;
    const defPos = {}; for (let i = 0; i < 4; i++) defPos['D' + (i + 1)] = s.pos[4 + i];
    s.flight = { from: s.holder, recv: r, B: line.B.slice(), A: s.pos[s.holder].slice(), t0: s.t, dur: t.flight, p: t.p, ok, name: t.name, th: t, q: line.q,
      mark: PIDS.indexOf(SIM.markOf(s.pos[s.holder], defPos)), tried: [], stall0: s.stall };
    if (!ok) {   // off target: lands out of the receiver's reach, a little to one side
      const f = s.flight, u = unit(sub(f.B, f.A)), side = s.rand() < 0.5 ? 1 : -1;
      f.miss = clampF(add(f.B, add(mul([-u[1], u[0]], side * 3.2), mul(u, 0.8))), 0);
    }
    for (let i = 4; i < 8; i++) if (s.macro[i].kind === 'user') s.macro[i] = { kind: 'under', label: STYLE_LABEL.under, since: s.t };
    s.log.push({ t: s.t, text: `${LABELS[PIDS[s.holder]]} throws ${/^[aeiou]/.test(t.name) ? 'an' : 'a'} ${t.name} to ${LABELS[line.to]} (${Math.round(t.p * 100)}% to complete)` });
    s.macro[s.holder] = { kind: 'set', label: 'just threw', target: null, since: s.t };
    s.macro[r] = { kind: 'catch', label: 'goes to the catch', target: line.B.slice(), since: s.t };
    s.holder = -1;
  }

  function throwTo(s, B) {
    // the user (as thrower) throws to a point: best throw to the nearest receiver who can get there
    if (s.holder < 0) return null;
    const A = s.pos[s.holder];
    let best = null;
    for (let r = 0; r < 4; r++) {
      if (r === s.holder) continue;
      const dR = dist(s.pos[r], B); if (dR > 7) continue;
      const res = SIM.bestThrow({ A, B, defs: defsOf(s, A), field: FIELD }); if (!res) continue;
      const t = res.all.find(x => SIM.tRun(dR) + 0.1 <= x.flight + 0.2) || res.best;
      if (!best || t.p > best.throw.p) best = { to: PIDS[r], B: B.slice(), throw: t, q: t.p };
    }
    if (best) release(s, best);
    return best;
  }

  // ---------------------------------------------------------------------------------------------
  // Decisions every 0.5 s
  // ---------------------------------------------------------------------------------------------
  let sideHook = null;
  const setSideHook = f => { sideHook = f; };
  function decide(s, ctrl) {
    if (s.setup) return;   // nobody decides anything until the disc is in
    const pick = ranked => { // minimal randomness: choose among options within 0.3 points of the best
      if (!ranked.length) return null;
      const close = ranked.filter(o => Math.abs(o.v - ranked[0].v) < 0.003);
      return close[Math.floor(s.rand() * close.length)];
    };
    if (s.holder >= 0) {
      if (sideHook) sideHook(s, 'off');   // head-to-head tests: each team can think with its own net
      // offense movers
      let cutting = -1;
      for (let i = 0; i < 4; i++) if (i !== s.holder && ['under', 'deep', 'in', 'up'].includes(s.macro[i].kind)) cutting = i;
      for (let i = 0; i < 4; i++) {
        if (i === s.holder || i === ctrl) continue;
        const m = s.macro[i];
        if (m.kind === 'user') { if (userHeld(s, i)) continue; s.macro[i] = { kind: 'set', label: 'holds the stack spot', target: null, since: s.t - 1 }; }
        const busy = ['under', 'deep', 'in', 'up', 'dump-back', 'dump-up', 'clear'].includes(m.kind);
        if (busy) {
          const arrived = m.target && dist(s.pos[i], m.target) < 0.9;
          if (arrived || s.t - m.since > 2.8) {
            const c = offenseOptions(s, i).find(o => o.kind === 'clear');   // none when this player is now the dump
            if (c && ['under', 'deep', 'in', 'up'].includes(m.kind)) {
              s.macro[i] = { kind: 'clear', label: 'clears out of the lane', target: c.target, since: s.t };
            } else s.macro[i] = { kind: 'set', label: 'resets', target: null, since: s.t };
          }
          continue;
        }
        let opts = rankOffense(s, i);
        if (cutting >= 0 && cutting !== i) opts = opts.filter(o => !['under', 'deep', 'in', 'up'].includes(o.kind));
        if (s.t - m.since < 0.8) opts = opts.filter(o => o.kind === 'set' || o.kind.startsWith('dump'));
        const setV = (opts.find(o => o.kind === 'set') || { v: -1 }).v;
        const best = pick(opts);
        if (best && best.kind !== 'set' && best.v > setV + 0.004) {
          s.macro[i] = { kind: best.kind, label: best.label, target: best.target, since: s.t, v: best.v };
          if (['under', 'deep', 'in', 'up'].includes(best.kind)) cutting = i;
        } else if (m.kind !== 'set') s.macro[i] = { kind: 'set', label: 'holds the stack spot', target: null, since: s.t };
      }
      // defense styles
      if (sideHook) sideHook(s, 'def');
      for (let i = 4; i < 8; i++) {
        if (i === ctrl) continue;
        if (userHeld(s, i)) continue;
        const best = pick(rankDefense(s, i));
        if (best) { s.dstyle[i] = best.kind; s.macro[i] = { kind: best.kind, label: best.label, target: null, since: s.t }; }
      }
      // thrower
      if (sideHook) sideHook(s, 'off');
      if (s.holder !== ctrl && s.stall >= LOOK && !(s.down[s.holder] > 0)) {
        const res = analyseThrower(s, ctrl);
        s.lastSearch = res;
        if (res && res.lines.length) {
          const ranked = res.lines;
          const close = ranked.filter(l => ranked[0].reg - l.reg < 0.004);
          const line = close[Math.floor(s.rand() * close.length)];
          // throw now unless waiting half a second gives a clearly better throw (a cut still developing);
          // the wait has to pay HOLD_GAIN, because the defense can recover in the meantime
          const worth = line.reg >= 0.2 && line.reg >= res.holdQ - HOLD_GAIN && line.p >= patience(s.stall);
          if (worth || (s.stall >= 6.5 && line.p > 0.3)) release(s, line);
          else if (s.stall >= 6.5) release(s, ranked.slice().sort((a, b) => b.p - a.p)[0]);
        }
      } else if (s.holder === ctrl) s.lastSearch = analyseThrower(s, ctrl);
    } else {
      for (let i = 4; i < 8; i++) if (i !== ctrl) {
        const o = i - 4;
        s.macro[i] = s.flight.recv === o ? { kind: 'chase', label: STYLE_LABEL.chase, since: s.t } : s.macro[i];
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Targets + physics for one substep
  // ---------------------------------------------------------------------------------------------
  function targets(s, ctrl) {
    if (s.setup) {
      const st = s.setup, h = st.handler;
      for (let i = 0; i < 8; i++) if (i !== ctrl) s.tgt[i] = st.spots[i].slice();
      // the handler waits a couple of metres from the disc, and goes to it once everyone is set
      if (h != null && h !== ctrl && s.flight && s.flight.pickup) {
        const P = st.disc, away = unit(sub(s.pos[h], P));
        s.tgt[h] = st.go ? P.slice() : clampF(add(P, mul(len(away) ? away : [1, 0], 2)), 0.4);
      }
      return;
    }
    const { Hd } = roles(s);
    for (let i = 0; i < 8; i++) {
      if (i === ctrl) continue;
      if (i < 4) {
        const m = s.macro[i];
        if (i === s.holder) { s.tgt[i] = s.pos[i].slice(); continue; }
        if (s.flight && s.flight.recv === i) { s.tgt[i] = s.flight.B.slice(); continue; }
        if (userHeld(s, i)) { s.tgt[i] = m.target.slice(); continue; }
        if (m.target && m.kind !== 'set') { s.tgt[i] = m.target.slice(); continue; }
        s.tgt[i] = roles(s).dump === i ? dumpHome(Hd) : setSpot(s, i, Hd);
      } else {
        if (userHeld(s, i)) { s.tgt[i] = s.macro[i].target.slice(); continue; }
        // go for the D once they've read the throw (SIM.P.reactD after the release, as in the throw model)
        if (s.flight && s.flight.th && !s.flight.tried[i] && !(s.down[i] > 0) && i !== s.flight.mark && s.t - s.flight.t0 >= SIM.P.reactD) {   // go for the D if it's reachable (the mark only reaches)
          const X = interceptPoint(s, i);
          if (X) { s.tgt[i] = X; if (s.macro[i].kind !== 'intercept') s.macro[i] = { kind: 'intercept', label: 'goes for the block', since: s.t }; continue; }
        }
        const style = s.flight && s.flight.recv === i - 4 ? 'chase' : s.holder === i - 4 ? 'mark' : (s.dstyle[i] || 'under');
        const T = styleTarget(s, i, style);
        const keep = style === 'mark' || style === 'chase' ? 0 : 0.87;
        s.tgt[i] = [keep * s.tgt[i][0] + (1 - keep) * T[0], keep * s.tgt[i][1] + (1 - keep) * T[1]];
      }
    }
  }

  function physics(s, dt, ctrl, ctrlTo) {
    for (let i = 0; i < 8; i++) {
      if (s.down[i] > 0) {   // on the ground after a layout: slide to a stop, then get up
        s.down[i] = Math.max(0, s.down[i] - dt); if (!s.down[i]) s.lay[i] = null;
        s.vel[i] = mul(s.vel[i], Math.exp(-dt / 0.12)); s.pos[i] = add(s.pos[i], mul(s.vel[i], dt));
        energyStep(s, i, dt); continue;
      }
      if (i === ctrl && ctrlTo) {
        const v = mul(sub(ctrlTo, s.pos[i]), 1 / dt);
        s.vel[i] = v; s.pos[i] = ctrlTo.slice(); energyStep(s, i, dt); continue;
      }
      if (i === s.holder && !s.setup) { s.vel[i] = [0, 0]; energyStep(s, i, dt); continue; }
      if (i === ctrl) { // controlled but standing still
        s.vel[i] = mul(s.vel[i], Math.exp(-dt / TAU_BRAKE)); s.pos[i] = add(s.pos[i], mul(s.vel[i], dt)); energyStep(s, i, dt); continue;
      }
      const d = sub(s.tgt[i], s.pos[i]), dl = len(d), want = effort(s, i), sprint = want >= VTOP;
      const dir = steer(s, i, unit(d), dl);
      // cuts are run through at full speed (the cut ends on arrival and the clear brakes); a sprint to a
      // catch or a reaction slows only at the very end; everything else eases in over 2.5 m
      const thru = i < 4 && ['under', 'deep', 'in', 'up', 'dump-back', 'dump-up'].includes(s.macro[i].kind);
      const vdes = mul(dir, Math.min(capOf(s, i), want) * (thru ? 1 : Math.min(1, dl / (sprint ? 1.2 : 2.5))));
      const braking = len(vdes) < len(s.vel[i]) - 0.3 || vdes[0] * s.vel[i][0] + vdes[1] * s.vel[i][1] < 0;
      const k = 1 - Math.exp(-dt / (braking ? TAU_BRAKE : sprint ? TAU_SPRINT : TAU));
      s.vel[i] = add(s.vel[i], mul(sub(vdes, s.vel[i]), k));
      s.pos[i] = [Math.max(-1, Math.min(L + 1, s.pos[i][0] + s.vel[i][0] * dt)), Math.max(-1, Math.min(W + 1, s.pos[i][1] + s.vel[i][1] * dt))];
      energyStep(s, i, dt);
    }
    collide(s, ctrl);
  }

  // Steer around players in the way: anyone ahead within AVOID m and less than a body and a half off the line
  // pushes the heading sideways (around the side they're already on). Own matchup and the downed are ignored.
  function steer(s, i, dir, dl) {
    if (dl < 0.3) return dir;
    let ax = 0, ay = 0;
    for (let j = 0; j < 8; j++) {
      if (j === i || j === (i + 4) % 8) continue;
      const r = sub(s.pos[j], s.pos[i]), dj = len(r);
      if (dj > AVOID || dj > dl + 0.5) continue;
      const ahead = r[0] * dir[0] + r[1] * dir[1]; if (ahead <= 0) continue;
      const lat = [r[0] - dir[0] * ahead, r[1] - dir[1] * ahead], ll = len(lat), wid = BODY * 1.5;
      if (ll >= wid) continue;
      const away = ll > 0.05 ? mul(lat, -1 / ll) : (i % 2 ? [-dir[1], dir[0]] : [dir[1], -dir[0]]);
      const k = (1 - ll / wid) * (1 - dj / AVOID) * 2.2;
      ax += away[0] * k; ay += away[1] * k;
    }
    return ax || ay ? unit([dir[0] + ax, dir[1] + ay]) : dir;
  }
  // Contact: separate overlapping players. The thrower is planted (pivot); the player you drag pushes harder.
  function collide(s, ctrl) {
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      const r = sub(s.pos[j], s.pos[i]), dj = len(r), over = BODY - dj;
      if (over <= 0) continue;
      const n = dj > 1e-4 ? mul(r, 1 / dj) : [Math.cos(i + j), Math.sin(i + j)];
      let wi = i === s.holder ? 0 : i === ctrl ? 0.3 : 1, wj = j === s.holder ? 0 : j === ctrl ? 0.3 : 1;
      if (!wi && !wj) continue;
      const sum = wi + wj; wi /= sum; wj /= sum;
      s.pos[i] = add(s.pos[i], mul(n, -over * wi)); s.pos[j] = add(s.pos[j], mul(n, over * wj));
      const vr = (s.vel[j][0] - s.vel[i][0]) * n[0] + (s.vel[j][1] - s.vel[i][1]) * n[1];
      if (vr < 0) { s.vel[i] = add(s.vel[i], mul(n, vr * wi)); s.vel[j] = add(s.vel[j], mul(n, -vr * wj)); }
      if (pass === 0) checkPick(s, i, j, ctrl), checkPick(s, j, i, ctrl);
    }
  }
  // Defender d in contact with attacker j (not their own) while guarding: are they being screened off?
  function checkPick(s, d, j, ctrl) {
    if (d < 4 || j >= 4 || j === d - 4 || s.done || s.down[d] > 0) return;
    if (s.pickAt && s.pickAt[d] != null && s.t - s.pickAt[d] < PICK_COOL) return;
    if (s.pendingPick) return;
    if (s.setup || (s.flight && s.flight.pickup)) return;                // no picks while the disc is being picked up
    const o = d - 4, gap = dist(s.pos[d], s.pos[o]); if (gap > PICK_NEAR || gap < 1.3) return;
    if (len(s.vel[o]) < 2.5) return;                                      // it only costs them when their player is running
    const want = d === ctrl ? unit(s.vel[d]) : unit(sub(s.tgt[d], s.pos[d]));
    const into = unit(sub(s.pos[j], s.pos[d]));
    if (want[0] * into[0] + want[1] * into[1] < 0.3) return;
    const toO = unit(sub(s.pos[o], s.pos[d]));
    if (toO[0] * into[0] + toO[1] * into[1] < 0.4) return;               // the screen has to be between them and their player
    if (d !== ctrl && dist(s.tgt[d], s.pos[d]) < 0.8) return;
    s.pickAt = s.pickAt || PIDS.map(() => null); s.pickAt[d] = s.t;
    s.pendingPick = { d, j };
  }
  // Pick rules (rec version of WFDF 17.9): play stops, the defender walks back to their player.
  // Disc in the air: play continues; caught by the picked defender's player -> back to the thrower.
  function applyPick(s) {
    const pk = s.pendingPick; if (!pk) return; s.pendingPick = null;
    if (s.done || (s.holder < 0 && !s.flight)) return;   // the possession just ended: nothing to stop
    const name = i => LABELS[PIDS[i]], d = pk.d, o = d - 4;
    if (s.flight && !s.flight.pickup) { if (!s.flight.pick) { s.flight.pick = pk; s.log.push({ t: s.t, text: `${name(d)} calls pick on ${name(pk.j)}, the disc is in the air: play on.` }); } return; }
    s.log.push({ t: s.t, text: `${name(d)} calls pick: ${name(pk.j)} screened them off ${name(o)}. Play stops, ${name(d)} goes back.` });
    restartAfterPick(s, d);
  }
  // A real stoppage (WFDF 17.9 / USAU 17.I.4): everyone stops where they are, the obstructed defender walks
  // back to their player, then the disc is checked in. The stall resumes at the count reached plus one.
  function restartAfterPick(s, d) {
    const o = d - 4, style = s.holder === o ? 'mark' : (s.dstyle[d] || 'under');
    const spots = s.pos.map(p => clampF(p));
    spots[d] = clampF(styleTarget(s, d, style));
    s.setup = { kind: 'pick', spots, t0: s.t, handler: null, go: true, picked: d };
    if (s.holder >= 0) s.stall = Math.min(STALL - 2, Math.floor(s.stall) + 1);
    s.dstyle[d] = style === 'mark' ? s.dstyle[d] : style;
    for (let i = 0; i < 8; i++) if (i !== s.holder) s.macro[i] = { kind: 'set', label: i === d ? `goes back to ${LABELS[PIDS[o]]}` : 'stops for the pick', target: null, since: s.t };
    s.flash = { t: s.t, i: d, text: 'PICK' };
  }

  function resolve(s) {
    if (s.setup) {   // between points: line up, then the handler picks up the disc and presents it
      const st = s.setup, h = st.handler, name = i => LABELS[PIDS[i]];
      if (s.flight && s.flight.pickup) {
        if (!st.go && !st.hold) {
          const ready = s.pos.every((p, i) => i === h || (dist(p, st.spots[i]) < 0.6 && len(s.vel[i]) < 1.2));
          if (ready || s.t - st.t0 > SETUP_MAX) setupGo(s);
        }
        if ((st.go || st.hold) && dist(s.pos[h], st.disc) < 0.45) {
          s.holder = h; s.pos[h] = st.disc.slice(); s.vel[h] = [0, 0]; s.flight = null;
          s.macro[h] = { kind: 'hold', label: 'presents the disc', target: null, since: s.t };
          st.checkAt = s.t + 0.8;
          s.log.push({ t: s.t, text: `${name(h)} picks up the disc and presents it.` });
        }
        return;
      }
      if (st.kind === 'pick' && st.checkAt == null && !st.hold) {   // the defender is back (or 4 s): check the disc in
        const back = dist(s.pos[st.picked], st.spots[st.picked]) < 0.6 && s.vel.every(v => len(v) < 1.5);
        if (back || s.t - st.t0 > 4) { st.checkAt = s.t + 0.6; s.log.push({ t: s.t, text: `${name(st.picked)} is back. ${name(s.holder)} checks the disc in (stall ${Math.floor(s.stall)}).` }); }
      }
      if (!st.hold && st.checkAt != null && s.t >= st.checkAt) discIn(s);
      return;
    }
    if (s.holder >= 0) {
      s.stall += SUB;
      if (s.stall >= STALL) { s.done = { reason: 'stall', text: 'Stalled out: turnover.', at: s.pos[s.holder].slice() }; s.log.push({ t: s.t, text: 'Stall ' + STALL + ': turnover.' }); }
      return;
    }
    const f = s.flight, name = i => LABELS[PIDS[i]];
    if (f.pickup) {   // after a turnover: the nearest player walks to the disc and picks it up
      if (dist(s.pos[f.recv], f.B) > 0.45) return;
      const r = f.recv;
      s.holder = r; s.pos[r] = f.B.slice(); s.vel[r] = [0, 0]; s.stall = 0; s.flight = null; s.lastSearch = null;
      s.macro[r] = { kind: 'hold', label: 'holds the disc', target: null, since: s.t };
      s.nextDecision = s.t + SUB;
      s.log.push({ t: s.t, text: `${name(r)} picks up the disc.` });
      return;
    }
    if (f.th) { flightDefense(s); if (!s.flight) return; }
    if (s.t - f.t0 < f.dur) return;
    const r = f.recv, B = f.miss || f.B, dR = dist(s.pos[r], B);
    let there = dR <= CATCH_RADIUS, laid = false;
    if (!there && dR <= CATCH_RADIUS + LAY_REACH && !(s.down[r] > 0)) {
      // a dive: about half of them come up with it
      laid = true; layOut(s, r, B);
      there = s.dice === 'random' ? s.rand() < 0.5 : dR <= CATCH_RADIUS + LAY_REACH / 2;
    }
    // Contest at the catch, mirroring the throw model: a defender in front of the catch spot (toward the
    // thrower) uses their full reach, one beside or behind has to reach around the receiver (0.5 m).
    // The chance fades with the time it would take to close the remaining gap.
    if (there && !f.miss) {
      const h = f.th && f.th.at ? f.th.at(1)[2] : 1.2, u = unit(sub(B, f.A));
      let best = null;
      for (let d = 4; d < 8; d++) {
        if (s.down[d] > 0) continue;
        const reach = reachAt(h, false, 1); if (reach < 0) continue;
        const proj = (s.pos[d][0] - B[0]) * u[0] + (s.pos[d][1] - B[1]) * u[1];
        const front = proj < -0.3, gap = dist(s.pos[d], B) - (front ? reach : Math.min(reach, 0.5));
        const m = gap > 0 ? SIM.tRunFrom(gap, 0, 0, SIM.P.tauSprint) : gap / 3, pD = 1 / (1 + Math.exp((m + 0.05) / 0.15));
        if (!best || pD > best.pD) best = { d, pD, front };
      }
      if (best && best.pD > 0.05) {
        const win = s.dice === 'random' ? s.rand() < best.pD : best.pD >= 0.5;
        if (win) {   // in front at the catch: often a clean interception, otherwise a deflection
          const held = best.front && (s.dice === 'random' ? s.rand() < 0.55 : false);
          return held ? interception(s, best.d, `${name(best.d)} steps in front and takes it`, B) : turnover(s, `${name(best.d)} ${best.front ? 'steps in front and knocks it down' : 'gets a hand on it at the catch'}`, B);
        }
        if (best.pD > 0.25) s.log.push({ t: s.t, text: `${name(r)} wins the contest with ${name(best.d)}.` });
      }
    }
    // Too fast from too close: the receiver couldn't read it (sim.js pk, from the flight time)
    if (f.ok && there && !f.miss && f.th && f.th.pk != null && f.th.pk < 0.999) {
      const drop = s.dice === 'random' ? s.rand() > f.th.pk : f.th.pk < 0.5;
      if (drop) return turnover(s, `${name(r)} drops it: too fast from too close to read`, B);
    }
    if (f.ok && there && !f.miss && f.pick && f.pick.d - 4 === r) {   // caught by the picked defender's player: back to the thrower
      const th = f.from;
      s.holder = th; s.pos[th] = f.A.slice(); s.stall = Math.min(STALL - 2, (f.stall0 || 0) + 1); s.flight = null; s.lastSearch = null;
      s.macro[th] = { kind: 'hold', label: 'holds the disc', target: null, since: s.t };
      for (let i = 4; i < 8; i++) if (['chase', 'intercept'].includes(s.macro[i].kind)) { s.macro[i] = { kind: 'under', label: STYLE_LABEL.under, since: s.t }; s.dstyle[i] = 'under'; }
      s.log.push({ t: s.t, text: `${name(r)} catches it, but there was a pick on the play: the disc goes back to ${name(th)} (stall ${Math.floor(s.stall)}).` });
      restartAfterPick(s, f.pick.d);
      return;
    }
    if (f.ok && there && !f.miss) {
      const keep = s.pos[r].slice();
      s.holder = r; s.pos[r] = laid ? keep : B.slice(); s.vel[r] = laid ? s.vel[r] : [0, 0]; s.stall = 0; s.flight = null; s.lastSearch = null;
      for (let i = 4; i < 8; i++) if (['chase', 'intercept'].includes(s.macro[i].kind)) { s.macro[i] = { kind: 'under', label: STYLE_LABEL.under, since: s.t }; s.dstyle[i] = 'under'; }
      s.nextDecision = s.t + SUB;   // everyone re-reads the field right after the catch
      s.macro[r] = { kind: 'hold', label: 'holds the disc', target: null, since: s.t };
      if (B[0] >= GOAL_X) { s.log.push({ t: s.t, text: `${name(r)} ${laid ? 'lays out for it in the endzone' : 'catches it in the endzone'}. Goal!` }); scorePoint(s, s.flipped ? 1 : 0, 'goal', `${name(f.from)} to ${name(r)}`, B); }
      else s.log.push({ t: s.t, text: laid ? `${name(r)} lays out and makes the catch!` : `${name(r)} catches it.` });
      if (f.pick && !s.done) { s.log.push({ t: s.t, text: `Play stops for the pick: ${name(f.pick.d)} goes back to ${name(f.pick.d - 4)}.` }); restartAfterPick(s, f.pick.d); }
    } else {
      const why = f.miss ? `the throw sails wide of ${name(r)}` : laid ? `${name(r)} lays out but can't hold on` : !there ? `${name(r)} wasn't there to catch it` : 'the defense gets a hand on it';
      turnover(s, why, B);
    }
  }
  // A point: the score, the point log (for the scoreboard), and the end of the game at GAME_TO.
  function scorePoint(s, team, how, text, P) {
    s.score = s.score || [0, 0]; s.points = s.points || [];
    s.score[team]++;
    s.points.push({ t: s.t, team, how, text, score: s.score.slice() });
    const over = s.score[team] >= GAME_TO;
    s.done = { reason: how, text, at: P && P.slice(), team, gameOver: over };
    if (over) s.log.push({ t: s.t, text: `${team ? 'Blue' : 'Orange'} wins ${s.score[team]}-${s.score[1 - team]}!` });
  }
  // A defender who catches the disc in the endzone the offense attacks scores right there: a Callahan.
  function interception(s, d, why, P) {
    if (P[0] >= GOAL_X && P[1] >= 0 && P[1] <= W) {
      const team = s.flipped ? 0 : 1, text = `Callahan! ${LABELS[PIDS[d]]} intercepts it in the endzone`;
      s.log.push({ t: s.t, text: text + `: point for ${team ? 'Blue' : 'Orange'}.` });
      if (s.flight) s.flight.dead = P.slice();
      s.flight = null;
      return scorePoint(s, team, 'callahan', text + '.', P);
    }
    return turnover(s, why, P);
  }
  function turnover(s, why, P) {
    s.done = { reason: 'turnover', text: 'Turnover: ' + why + '.', at: P && P.slice() };
    s.log.push({ t: s.t, text: 'Turnover: ' + why + '.' });
    if (s.flight) s.flight.dead = P && P.slice();
    s.flight = null;
  }

  // Keep playing after a possession ends. The teams swap roles: players 0-3 are always the offense and the
  // frame is mirrored (x -> L - x, y -> W - y), so the new offense also attacks +x and still forces flick.
  // After a turnover the nearest new attacker walks to the disc; after a goal the scored-on team gets a
  // fresh restart from its own endzone.
  const mirror = p => [L - p[0], W - p[1]];
  function nextPossession(s) {
    if (!s.done || s.done.gameOver) return false;
    const was = s.done, swap = a => a.map((_, j) => a[(j + 4) % 8]);
    // after a Callahan the team that threw it gets the disc back (they were scored on): no swap
    const keep = was.reason === 'callahan';
    s.poss = (s.poss || 1) + 1; s.score = s.score || [0, 0];
    if (!keep) {
      s.flipped = !s.flipped;
      s.pos = swap(s.pos).map(mirror); s.vel = swap(s.vel).map(v => [-v[0], -v[1]]); s.tgt = swap(s.tgt).map(mirror);
      s.energy = swap(s.energy); s.down = swap(s.down);
      s.lay = swap(s.lay).map(l => l && Object.assign({}, l, { dir: [-l.dir[0], -l.dir[1]] }));
    }
    s.done = null; s.flight = null; s.lastSearch = null; s.stall = 0;
    s.macro = PIDS.map((_, i) => i < 4 ? { kind: 'set', label: 'sets up', target: null, since: s.t } : { kind: 'under', label: STYLE_LABEL.under, since: s.t });
    s.dstyle = PIDS.map(() => 'under');
    const team = s.flipped ? 'Blue' : 'Orange';
    if (was.reason === 'goal' || keep) {
      // Between points: everyone walks to a line-up for the restart (drag anyone to change it). The point
      // starts when the disc is checked in: everyone set, or SETUP_MAX seconds.
      // The disc stays on the ground where the goal was caught; the new offense starts from there.
      // (a Callahan was caught in the endzone they attack: they bring it in from their own goal line instead)
      let P = keep ? [FIELD.ez, was.at ? was.at[1] : W / 2] : was.at ? mirror(was.at) : [1.5, W / 2];
      P = [Math.max(0.5, Math.min(GOAL_X - 0.5, P[0])), Math.max(0.5, Math.min(W - 0.5, P[1]))];
      const sc = randomSetup(Math.floor(s.t * 100) + s.seed, P);
      // the nearest attacker is the handler; the others take the remaining formation spots, nearest first
      let r = 0; for (let i = 1; i < 4; i++) if (dist(s.pos[i], P) < dist(s.pos[r], P)) r = i;
      const roleOf = []; roleOf[r] = 0;
      const free = [1, 2, 3], left = [0, 1, 2, 3].filter(i => i !== r);
      while (left.length) {
        let best = null;
        for (const i of left) for (const k of free) { const d = dist(s.pos[i], sc.pos[PIDS[k]]); if (!best || d < best.d) best = { i, k, d }; }
        roleOf[best.i] = best.k; left.splice(left.indexOf(best.i), 1); free.splice(free.indexOf(best.k), 1);
      }
      const spots = PIDS.map((_, i) => i < 4 ? sc.pos[PIDS[roleOf[i]]].slice() : sc.pos[PIDS[roleOf[i - 4] + 4]].slice());
      s.setup = { spots, t0: s.t, handler: r, disc: P.slice(), go: false };
      s.holder = -1;
      s.flight = { pickup: true, setup: true, from: -1, recv: r, B: P.slice(), A: P.slice(), t0: s.t, dur: 0, p: 1, ok: true, name: 'pickup', th: null, tried: [], mark: -1 };
      s.macro[r] = { kind: 'set', label: 'waits by the disc', target: null, since: s.t };
      for (let i = 0; i < 8; i++) if (i !== r) s.macro[i] = { kind: 'set', label: 'walks to their spot', target: null, since: s.t };
      s.setup.after = keep ? 'callahan' : 'goal';
      s.log.push({ t: s.t, text: `${team}'s disc ${keep ? 'on their goal line after the Callahan' : 'where the goal was caught'} (${s.score[0]}-${s.score[1]}). Everyone lines up.` });
    } else {
      let P = was.at ? mirror(was.at) : [L / 2, W / 2];
      P = [Math.max(FIELD.ez, Math.min(GOAL_X - 0.5, P[0])), Math.max(0.4, Math.min(W - 0.4, P[1]))];   // out of bounds: back in at the line
      let r = 0, bt = 1e9;
      for (let i = 0; i < 4; i++) { const tt = SIM.tRun(dist(s.pos[i], P)) + Math.max(0, s.down[i]); if (tt < bt) { bt = tt; r = i; } }
      s.holder = -1;
      s.flight = { pickup: true, from: -1, recv: r, B: P, A: P.slice(), t0: s.t, dur: 0, p: 1, ok: true, name: 'pickup', th: null, tried: [], mark: -1 };
      s.macro[r] = { kind: 'catch', label: 'picks up the disc', target: P.slice(), since: s.t };
      s.log.push({ t: s.t, text: `${team} takes over, attacking the other way.` });
    }
    s.nextDecision = s.t;
    s.evalNow = evalNow(s);
    return true;
  }

  // everyone's set (or you said so): the handler walks to the disc
  function setupGo(s) {
    const st = s.setup; if (!st || st.go) return;
    st.go = true;
    if (s.flight && s.flight.pickup) { s.macro[st.handler] = { kind: 'set', label: 'goes to the disc', target: null, since: s.t }; s.log.push({ t: s.t, text: `Everyone's set: ${LABELS[PIDS[st.handler]]} goes to the disc.` }); }
  }
  function discIn(s) {
    if (!s.setup) return;
    if (s.holder < 0) { setupGo(s); s.setup.hold = false; return; }   // not picked up yet: go get it first
    const pick = s.setup.kind === 'pick';
    s.setup = null; if (!pick) s.stall = 0; s.vel = s.vel.map(() => [0, 0]); s.nextDecision = s.t;
    if (!pick) s.energy = s.energy.map(e => Math.min(1, e + 0.3));
    s.macro = PIDS.map((_, i) => i === s.holder ? { kind: 'hold', label: 'holds the disc', target: null, since: s.t } : i < 4 ? { kind: 'set', label: '', target: null, since: s.t - 1 } : { kind: 'under', label: STYLE_LABEL.under, since: s.t });
    s.log.push({ t: s.t, text: 'Disc in: play on!' });
  }

  // Advance the game by dt seconds. ctrl: index of the user's player (or -1). ctrlPath(u) -> position at fraction u.
  function advance(s, dt, ctrl, ctrlPath) {
    let done = 0;
    const steps = Math.max(1, Math.round(dt / SUB));
    for (let k = 1; k <= steps && !s.done; k++) {
      if (s.t >= s.nextDecision - 1e-6) { decide(s, ctrl); s.nextDecision = s.t + DECIDE; }
      targets(s, ctrl);
      physics(s, SUB, ctrl, ctrlPath ? ctrlPath(k / steps) : null);
      s.t = Math.round((s.t + SUB) * 1000) / 1000;
      resolve(s);
      if (s.pendingPick) applyPick(s);
      done++;
    }
    s.evalNow = evalNow(s);
    return done;
  }

  // ---------------------------------------------------------------------------------------------
  // Scenarios
  // ---------------------------------------------------------------------------------------------
  const SCENARIOS = {
    restart: { title: 'Restart from our endzone', holder: 'O1', pos: { O1: [2.6, 10.5], O2: [3.4, 6.2], O3: [11.5, 10], O4: [18.5, 6.5], D1: [3.3, 9.3], D2: [4.4, 6.9], D3: [10.6, 11.0], D4: [17.6, 7.4] } },
    ho: { title: 'Midfield 2-2 box', holder: 'O1', pos: { O1: [8, 5.5], O2: [8, 12.5], O3: [18, 4.5], O4: [18.5, 13], D1: [8.7, 4.4], D2: [8.9, 12.0], D3: [17.2, 5.3], D4: [17.7, 13.7] } },
    sideline: { title: 'Trapped on the sideline', holder: 'O1', pos: { O1: [13, 16], O2: [9.5, 11.5], O3: [19, 14.5], O4: [19.5, 7.5], D1: [13.6, 14.8], D2: [10.3, 12.2], D3: [19.5, 15.2], D4: [18.7, 8.2] } },
    endzone: { title: 'Endzone: disc 6 m out', holder: 'O1', pos: { O1: [21, 9], O2: [17.5, 6.5], O3: [27, 9.5], O4: [24.5, 16.2], D1: [21.7, 7.9], D2: [18.4, 7.1], D3: [25.9, 10.0], D4: [24.2, 15.2] } },
  };

  const setRisk = v => { RISK = v; };
  // A built-in start with some variety: attackers shift up to ~2.5 m, each defender keeps its spot
  // relative to its player (plus a little). Same seed, same start.
  function varied(setup, seed) {
    const rand = rng(seed * 9973 + 17), j = a => (rand() * 2 - 1) * a, pos = {};
    for (let i = 0; i < 4; i++) {
      const o = PIDS[i], p = setup.pos[o], hold = o === setup.holder;
      const q = clampF([p[0] + j(hold ? 2 : 2.5), p[1] + j(hold ? 1.5 : 2)], 0.8);
      if (hold) q[0] = Math.min(q[0], GOAL_X - 2);
      pos[o] = q;
      const d = PIDS[i + 4], off = sub(setup.pos[d], p);
      pos[d] = clampF(add(q, add(off, [j(0.35), j(0.35)])), 0.4);
    }
    return Object.assign({}, setup, { pos });
  }
  // A fresh formation anywhere on the field: disc somewhere in play, a dump behind, two cutters in a
  // stack downfield (sometimes split), defenders on the open side of their player and a mark on the force.
  function randomSetup(seed, H0) {
    const rand = rng(seed * 7919 + 3), U = (a, b) => a + rand() * (b - a);
    const H = H0 ? H0.slice() : [U(3, 20), U(2, 16)];
    const mid = H[1] < 9 ? 1 : -1;                       // the dump sits toward the middle
    const O2 = clampF([H[0] - U(2, 4), H[1] + mid * U(3, 5)], 1);
    const split = rand() < 0.35, sy = U(6, 12);
    const O3 = clampF([Math.min(H[0] + U(7, 10), 26), split ? U(3, 7) : sy + U(-1, 1)], 1);
    const O4 = clampF([Math.min(H[0] + U(12, 17), 28), split ? U(11, 15) : sy + U(-1, 1)], 1);
    const pos = { O1: H, O2, O3, O4 };
    pos.D1 = clampF(add(H, [0.7, -1.0]), 0.4);
    for (const [o, d] of [['O2', 'D2'], ['O3', 'D3'], ['O4', 'D4']]) {
      const u = unit(add(unit(sub(H, pos[o])), [0, 0.6]));
      pos[d] = clampF(add(pos[o], mul(u, U(0.9, 1.6))), 0.4);
    }
    return { title: 'Random spot', holder: 'O1', pos, stall: 0 };
  }

  const setPatience = o => { Object.assign(PATIENCE, o); }, setLook = v => { LOOK = v; };
  const api = { setSideHook, setPatience, setLook, GAME_TO, setupGo, discIn, nextPossession, varied, randomSetup, HOLD_GAIN, setRisk, VTOP, VCRUISE, VJOG, capOf, RISK, PRIOR_W, rankThrows, think, placed, FIELD, PIDS, LABELS, PLAY, SCENARIOS, STALL, create, advance, snapshot, restore, evalNow, rankOffense, rankDefense, searchThrows, throwTo, release, discPoint, value };
  if (isNode) module.exports = api; else root.UltiGame = api;
})(typeof window !== 'undefined' ? window : globalThis);
