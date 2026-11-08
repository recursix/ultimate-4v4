// UltiSim: a small 2D(+height) model of ultimate frisbee throws and movement.
// Shared by the playbook page (window.UltiSim) and the authoring scripts (require('./sim.js')).
// Coordinates in metres: x along the field (offense attacks +x), y across it (y grows "down" on screen).
// Right-handed throwers assumed: facing the throw, a release on the right side is a flick (forehand).
(function (root) {
  'use strict';

  // Physical assumptions. Numbers are rec/club estimates, kept in one place so they can be tuned.
  const P = {
    vmax: 7.2,        // top running speed, m/s (measured ultimate players: 6.4 to 7.2 m/s)
    tau: 0.62,        // acceleration time constant: v(t) = vmax(1 - e^(-t/tau)), 11.6 m/s^2 from a standstill (RESEARCH.md)
    tauSprint: 0.62,  // all-out reaction: same propulsion limit as the sandbox running model (A0 = vmax/tau)
    reactD: 0.3,      // downfield defender reaction to the release, s
    reactMark: 0.05,  // the mark is already set and reaching
    arm: 1.0,         // horizontal reach of arms for a low disc, m
    layout: 1.0,      // extra reach when there is time to lay out (low disc only)
    markReach: 1.3,   // the mark's reach for a low throw passing them (arm + a lunge; throwers pivot and fake)
    markH: 2.45,      // highest point the mark can touch without jumping
    standH: 2.3,      // standing reach of a downfield defender
    jumpH: 2.85,      // jumping reach (needs ~0.5 s to load)
    contest: 2.0,     // last metres before the catch count as a contest, not a block
    hands: 0.6,       // the receiver catches this far in front of their body
    body: 1.0,        // two players closer than this (centre to centre) are in each other's way
    stall: 8,         // default stall count (TUC indoor 4s uses 8, USAU 4v4 uses 7)
    readT: 0.30,      // a receiver needs about this long after the release to read a disc's flight
    readW: 0.06,      // how sharply catching gets harder below readT (logistic width, s)
    dropMax: 0.40,    // drop chance for a point-blank zinger
    inReach: 0.8,     // a disc inside a defender's reach: each metre inside counts as 0.8 s of time margin
    drag: 0.0156,     // flat-disc drag factor per metre (deceleration ~ drag * v^2)
  };

  // Throw catalogue. v: average speed (m/s). Heights in metres at release (h0), catch (h1) and apex(L).
  // bulge(L): sideways bend at mid-flight. off: how far from the body the release point sits.
  // rel(L): execution reliability for a rec player before any defender is considered.
  const TYPES = {
    flat:    { v0: 17, v: 15,  h0: 1.1, h1: 1.2, apex: () => 1.5,                bend: 0,  bulge: () => 0,                    off: 0.9, min: 1,  max: 28, rel: L => 0.97 - Math.max(0, L - 18) * 0.008, over: false },
    float:   { v: 6,   h0: 1.0, h1: 1.3, apex: L => 1.6 + 0.08 * L,          bend: 0,  bulge: () => 0,                    off: 0.6, min: 0,  max: 9,  rel: () => 0.97, over: false },
    push:    { v0: 9, v: 9,   h0: 1.0, h1: 1.1, apex: () => 1.2,                bend: 0,  bulge: () => 0,                    off: 0.7, min: 0,  max: 7,  rel: () => 0.98, over: false },
    io:      { v0: 15, v: 13,  h0: 1.1, h1: 1.2, apex: () => 1.5,                bend: -1, bulge: L => Math.min(3, 0.18 * L), off: 0.9, min: 6,  max: 26, rel: L => 0.80 - Math.max(0, L - 15) * 0.008, over: false },
    oi:      { v0: 15, v: 13,  h0: 1.1, h1: 1.2, apex: () => 1.5,                bend: 1,  bulge: L => Math.min(3.5, 0.2 * L), off: 1.0, min: 6,  max: 26, rel: L => 0.80 - Math.max(0, L - 15) * 0.008, over: false },
    high:    { v0: 15, v: 13,  h0: 2.2, h1: 1.8, apex: () => 2.6,                bend: 0,  bulge: () => 0,                    off: 0.5, min: 4,  max: 20, rel: () => 0.9, over: false },
    hammer:  { v: 8, h0: 2.3, h1: 1.5, apex: L => Math.min(7, 2.5 + 0.25 * L), bend: 0, bulge: () => 0,             off: 0.3, min: 7,  max: 26, rel: L => 0.74 - Math.max(0, L - 15) * 0.01, over: true, catch: 0.86 },
    scoober: { v: 9,   h0: 1.9, h1: 1.6, apex: () => 2.9,                bend: 0,  bulge: () => 0,                    off: 0.3, min: 2,  max: 12, rel: () => 0.78, over: true, catch: 0.92 },
    blade:   { v: 9,   h0: 2.4, h1: 1.0, apex: L => Math.min(6, 3 + 0.2 * L), bend: 0, bulge: () => 0,                off: 0.3, min: 8,  max: 24, rel: () => 0.62, over: true, catch: 0.84 },
    huck:    { v0: 19, v: 17,  h0: 1.3, h1: 1.7, apex: L => 2 + 0.12 * L,        bend: 0,  bulge: () => 0,                    off: 0.9, min: 16, max: 70, rel: L => 0.80 - Math.max(0, L - 18) * 0.01, over: false },
  };
  const TYPE_ORDER = ['flat', 'push', 'float', 'io', 'oi', 'high', 'hammer', 'scoober', 'blade', 'huck'];
  const TYPE_LABEL = { flat: 'Flat throw', push: 'Push pass', float: 'Touch pass (floaty)', io: 'Inside-out', oi: 'Around (outside-in)', high: 'High release', hammer: 'Hammer', scoober: 'Scoober', blade: 'Blade', huck: 'Huck' };

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const sig = x => 1 / (1 + Math.exp(-x));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Running from a standstill: v(t) = vmax(1 - e^(-t/tau)), so d(t) = vmax(t - tau(1 - e^(-t/tau))).
  function dRun(t) { return t <= 0 ? 0 : P.vmax * (t - P.tau * (1 - Math.exp(-t / P.tau))); }
  function tRun(d) {
    if (d <= 0) return 0;
    let lo = 0, hi = 2 + d / P.vmax * 2;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (dRun(m) < d) lo = m; else hi = m; }
    return hi;
  }
  // Same, for a runner already moving at v0 toward the point, with top speed vm (tired players are slower).
  function tRunFrom(d, v0, vm, tau) {
    if (d <= 0) return 0;
    vm = vm || P.vmax; v0 = Math.min(v0 || 0, vm); tau = tau || P.tau;
    const run = t => vm * t - (vm - v0) * tau * (1 - Math.exp(-t / tau));
    let lo = 0, hi = 2 + d / vm * 2;
    for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (run(m) < d) lo = m; else hi = m; }
    return hi;
  }

  // Quadratic path through an optional via point (matches the board's drawing).
  const ctrl = (p0, p2, v) => v ? [2 * v[0] - (p0[0] + p2[0]) / 2, 2 * v[1] - (p0[1] + p2[1]) / 2] : [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
  const bez = (p0, c, p2, t) => { const u = 1 - t; return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]]; };
  function pathAt(p0, p2, v, u) { return bez(p0, ctrl(p0, p2, v), p2, clamp(u, 0, 1)); }
  function pathLen(p0, p2, v) {
    const c = ctrl(p0, p2, v); let L = 0, prev = p0;
    for (let i = 1; i <= 16; i++) { const q = bez(p0, c, p2, i / 16); L += dist(prev, q); prev = q; }
    return L;
  }

  // Disc trajectory: returns {at(s) -> [x,y,h], flight, len, release}
  function trajectory(type, A, B, side) {
    const T = TYPES[type];
    const L = dist(A, B) || 0.01;
    const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
    const right = [-u[1], u[0]];
    const R0 = [A[0] + right[0] * side * T.off, A[1] + right[1] * side * T.off];
    const b = T.bulge(L) * (T.bend === 0 ? 0 : T.bend * side);
    const apex = T.apex(L);
    const at = s => {
      const lat = b * Math.sin(Math.PI * s);
      const x = R0[0] + (B[0] - R0[0]) * s + right[0] * lat;
      const y = R0[1] + (B[1] - R0[1]) * s + right[1] * lat;
      const h = (1 - s) * T.h0 + s * T.h1 + 4 * (apex - (T.h0 + T.h1) / 2) * s * (1 - s);
      return [x, y, h];
    };
    const len = L * (T.bend ? 1.06 : 1);
    const k = T.v0 ? P.drag * (T.bend ? 1.3 : 1) : 0;
    const tAt = s => 0.05 + (k ? (Math.exp(k * s * len) - 1) / (k * T.v0) : s * len / T.v);
    return { at, tAt, flight: tAt(1), len: L, release: R0 };
  }

  // Horizontal reach of a defender for a disc at height h, t seconds after release (-1 = can't touch).
  function reach(h, mark, t) {
    if (mark) return h <= P.markH ? P.markReach + (h <= 1.0 ? 0.3 : 0) : -1;
    if (h <= 1.5) return P.arm + (t > 0.5 ? P.layout : 0);
    if (h <= P.standH) return P.arm * 0.7;
    if (h <= P.jumpH && t > 0.5) return 0.4;
    return -1;
  }

  function throwName(type, side) {
    const hand = side > 0 ? 'flick' : 'backhand';
    switch (type) {
      case 'flat': return hand;
      case 'push': return 'push pass';
      case 'float': return 'floaty touch pass';
      case 'io': return 'inside-out ' + hand;
      case 'oi': return 'around ' + hand;
      case 'high': return 'high-release ' + hand;
      case 'huck': return hand + ' huck';
      default: return type;
    }
  }

  // Evaluate one throw. ctx: {A, B, defs:[{id,pos,mark}], field}. Returns null if out of range.
  // Defenders who reach the disc's path well before the catch block it; near the catch they contest it.
  // A defender behind the receiver (further along the throw) has to reach around the body, so less reach.
  function evalThrow(ctx, type, side) {
    const T = TYPES[type];
    const L = dist(ctx.A, ctx.B);
    if (L < T.min || L > T.max) return null;
    const tr = trajectory(type, ctx.A, ctx.B, side);
    const u = [(ctx.B[0] - ctx.A[0]) / L, (ctx.B[1] - ctx.A[1]) / L];
    const sC = Math.max(0.5, (L - P.hands) / L), sBlock = Math.max(0.3, sC - P.contest / L);
    let early = 9, late = 9, blocker = null, contester = null, bS = sBlock, cS = sC;
    const N = 28;
    for (let i = 1; i <= N; i++) {
      const s = sC * i / N, p = tr.at(s), t = tr.tAt(s);
      const zone = s <= sBlock ? 'block' : 'contest';
      for (const d of ctx.defs) {
        if (d.mark && s * L > 4) continue;          // the mark only matters near the release
        let r = reach(p[2], d.mark, t);
        if (r < 0) continue;
        if (zone === 'contest') {
          const proj = (d.pos[0] - ctx.B[0]) * u[0] + (d.pos[1] - ctx.B[1]) * u[1];
          if (proj > -0.3) r = Math.min(r, 0.5);
        }
        // cheap lower bound first: no one covers ground faster than top speed. Margins above 0.8 s don't
        // change the result (the logistic is saturated), so far-away defenders skip the exact solve.
        const best = zone === 'block' ? early : late, vmx = d.vmax || P.vmax;
        const lb = (d.delay || 0) - P.inReach * r + Math.max(0, dist(d.pos, p) - r - (d.vel ? Math.hypot(d.vel[0], d.vel[1]) * 0.3 : 0)) / vmx - t;
        if (lb > Math.min(best, 0.8)) continue;
        let m;
        if (d.vel) {
          // a moving defender keeps their momentum through the reaction time, then runs from that speed;
          // running the wrong way costs the time to stop (about 8 m/s^2)
          const re = d.mark ? P.reactMark : P.reactD, S0 = [d.pos[0] + d.vel[0] * re, d.pos[1] + d.vel[1] * re];
          const gap = dist(S0, p), need = Math.max(0, gap - r), dir = gap > 1e-6 ? [(p[0] - S0[0]) / gap, (p[1] - S0[1]) / gap] : [0, 0];
          const vp = d.vel[0] * dir[0] + d.vel[1] * dir[1];
          // a disc already inside their reach: the deeper inside, the surer the block
          const inside = Math.min(0, gap - r);
          m = (d.delay || 0) + re + (vp < 0 ? -vp / 8 : 0) + (need > 0 ? tRunFrom(need, Math.max(0, vp), d.vmax, P.tauSprint) : P.inReach * inside) - t;
        } else {
          const g0 = dist(d.pos, p) - r;
          m = (d.delay || 0) + (d.mark ? P.reactMark : P.reactD) + (g0 > 0 ? tRunFrom(g0, 0, d.vmax) : P.inReach * g0) - t;
        }
        if (zone === 'block') { if (m < early) { early = m; blocker = d.id; bS = s; } }
        else if (m < late) { late = m; contester = d.id; cS = s; }
      }
    }
    const f = ctx.field;
    const inBounds = !f || (ctx.B[0] >= 0 && ctx.B[0] <= f.L && ctx.B[1] >= 0 && ctx.B[1] <= f.W);
    const pe = sig(early / 0.1);
    const pc = sig((late + 0.05) / 0.15);
    const rel = clamp(T.rel(L), 0.05, 0.99);
    // A fast disc from close range arrives before the receiver can read it: drops go up below P.readT of flight.
    // upside-down and edge-on discs (hammer, scoober, blade) are harder to catch: T.catch
    const pk = (1 - P.dropMax * sig((P.readT - tr.flight) / P.readW)) * (T.catch || 1);
    const p = inBounds ? rel * pe * pc * pk : 0;
    return {
      type, side, name: throwName(type, side), over: T.over, len: L, flight: tr.flight,
      early, late, blocker: early < 0.25 ? blocker : null, contester: late < 0.2 ? contester : null,
      rel, pe, pc, pk, bId: blocker, cId: contester, bS, cS, tAt: tr.tAt,
      p, inBounds, goal: !!f && ctx.B[0] >= f.L - f.ez && inBounds, at: tr.at,
    };
  }

  // Best throw for a target. allowed: list of types (default all). Returns {best, all} or null.
  function bestThrow(ctx, allowed) {
    const all = [];
    for (const type of allowed || TYPE_ORDER) for (const side of [1, -1]) {
      const r = evalThrow(ctx, type, side);
      if (r) all.push(r);
    }
    if (!all.length) return null;
    all.sort((a, b) => b.p - a.p);
    const seen = new Set(), uniq = [];
    for (const r of all) if (!seen.has(r.name)) { seen.add(r.name); uniq.push(r); }
    return { best: uniq[0], all: uniq };
  }

  const isO = pid => typeof pid === 'string' && pid[0] === 'O';
  const PIDS = ['O1', 'O2', 'O3', 'O4', 'D1', 'D2', 'D3', 'D4'];

  function markOf(A, defPos) {
    let best = null, bd = 2.6;
    for (const [id, p] of Object.entries(defPos)) { const d = dist(A, p); if (d < bd) { bd = d; best = id; } }
    return best;
  }
  function defsAt(defPos, A) {
    const mk = markOf(A, defPos);
    return Object.entries(defPos).map(([id, pos]) => ({ id, pos, mark: id === mk }));
  }

  // Analyse the phase from parent to child. Returns {dur, auto, tr, throw, issues}
  function analyzeEdge(play, par, chi) {
    const f = play.field, issues = [];
    const lens = {};
    let maxLen = 0;
    for (const pid of PIDS) { lens[pid] = pathLen(par.pos[pid], chi.pos[pid], chi.via && chi.via[pid]); maxLen = Math.max(maxLen, lens[pid]); }
    const expect = Array.isArray(chi.expect) ? chi.expect : [];
    const throwing = typeof par.disc === 'string' && typeof chi.disc === 'string' && par.disc !== chi.disc;
    const explicit = Number.isFinite(chi.dur) && chi.dur > 0;
    let dur = explicit ? chi.dur : Math.max(1, Math.ceil(tRun(maxLen) * 4) / 4);
    const posAt = (pid, u) => pathAt(par.pos[pid], chi.pos[pid], chi.via && chi.via[pid], u);

    // movement realism
    if (explicit) for (const pid of PIDS) {
      const can = dRun(dur);
      if (lens[pid] > can * 1.08 + 0.3) issues.push({ level: 'error', pid, msg: `${lbl(play, pid)} runs ${lens[pid].toFixed(1)} m in ${dur} s. A sprinter needs ${tRun(lens[pid]).toFixed(1)} s for that.` });
    }
    // travelling with the disc
    if (typeof par.disc === 'string' && par.disc === chi.disc && isO(par.disc) && lens[par.disc] > 1.3)
      issues.push({ level: 'error', pid: par.disc, msg: `${lbl(play, par.disc)} moves ${lens[par.disc].toFixed(1)} m while holding the disc (travel). Only a pivot is allowed.` });

    let thr = null, tr = null;
    if (throwing) {
      const thrower = par.disc, rcv = chi.disc;
      if (!isO(rcv)) issues.push({ level: 'error', pid: rcv, msg: `The disc goes to ${lbl(play, rcv)}, a defender. Draw that as a turnover.` });
      const want = chi.throw && TYPES[chi.throw.type] ? chi.throw.type : null;
      let A = posAt(thrower, 0), B = chi.pos[rcv], flight = 1;
      for (let k = 0; k < 2; k++) {
        if (!explicit) dur = Math.max(dur, flight + 0.4);
        tr = Math.max(0, dur - flight);
        A = posAt(thrower, tr / dur);
        const defPos = {}; for (const pid of PIDS) if (!isO(pid)) defPos[pid] = posAt(pid, tr / dur);
        const ctx = { A, B, defs: defsAt(defPos, A), field: f };
        let res;
        if (want) {
          const side = chi.throw.side === 1 || chi.throw.side === -1 ? [chi.throw.side] : [1, -1];
          res = side.map(sd => evalThrow(ctx, want, sd)).filter(Boolean).sort((a, b) => b.p - a.p)[0] || null;
          const alt = bestThrow(ctx);
          thr = res ? Object.assign(res, { alternatives: alt ? alt.all.slice(0, 4) : [] }) : null;
          if (!res) { thr = alt ? Object.assign(alt.best, { alternatives: alt.all.slice(0, 4) }) : null; if (k === 1) issues.push({ level: 'warn', msg: `A ${TYPE_LABEL[want].toLowerCase()} doesn't fit a ${dist(A, B).toFixed(0)} m throw. Using ${thr ? thr.name : 'nothing'} instead.` }); }
        } else {
          const alt = bestThrow(ctx);
          thr = alt ? Object.assign(alt.best, { alternatives: alt.all.slice(0, 4) }) : null;
        }
        if (thr) flight = thr.flight;
      }
      if (thr && expect.includes('fail')) {
        thr.from = thrower; thr.to = rcv; thr.A = A; thr.B = B; thr.tr = tr;
        if (thr.p < 0.7) issues.push({ level: 'ok', msg: `As intended, this is a bad throw for the offense: ${thr.name} to ${lbl(play, rcv)} has ${pct(thr.p)}${thr.blocker ? ', ' + lbl(play, thr.blocker) + ' is in the lane' : thr.contester ? ', ' + lbl(play, thr.contester) + ' contests the catch' : ''}.` });
        else issues.push({ level: 'warn', msg: `This step is meant to go badly for the offense, but ${thr.name} to ${lbl(play, rcv)} still has ${pct(thr.p)}. Tighten the defense.` });
      } else if (thr) {
        thr.from = thrower; thr.to = rcv; thr.A = A; thr.B = B; thr.tr = tr;
        if (!thr.inBounds) issues.push({ level: 'error', msg: `The catch is out of bounds.` });
        else if (thr.p < 0.45) issues.push({ level: 'error', msg: `${cap(thr.name)} to ${lbl(play, rcv)} is likely blocked${thr.blocker ? ' by ' + lbl(play, thr.blocker) : thr.contester ? ': ' + lbl(play, thr.contester) + ' gets to the catch first' : ''} (${pct(thr.p)}).` });
        else if (thr.p < 0.7) issues.push({ level: 'warn', msg: `${cap(thr.name)} to ${lbl(play, rcv)} is risky (${pct(thr.p)})${thr.blocker ? ', ' + lbl(play, thr.blocker) + ' is close to the line' : thr.contester ? ', ' + lbl(play, thr.contester) + ' contests the catch' : ''}.` });
      } else issues.push({ level: 'error', msg: `No throw reaches ${lbl(play, rcv)} from there.` });
    }

    // person-defense assignments (Dn guards On)
    if ((play.defense || 'person') === 'person') {
      for (let i = 1; i <= 4; i++) {
        const d = chi.pos['D' + i], own = chi.pos['O' + i];
        const dOwn = dist(d, own);
        if (dOwn < 4) continue;
        for (let j = 1; j <= 4; j++) {
          if (j === i) continue;
          const o = chi.pos['O' + j];
          if (dist(d, o) < 2.5 && dist(chi.pos['D' + j], o) < 2.5)
            issues.push(expect.includes('poach')
              ? { level: 'ok', pid: 'D' + i, msg: `Intended poach: ${lbl(play, 'D' + i)} helps on ${lbl(play, 'O' + j)} and leaves ${lbl(play, 'O' + i)} ${dOwn.toFixed(0)} m away.` }
              : { level: 'warn', pid: 'D' + i, msg: `${lbl(play, 'D' + i)} doubles ${lbl(play, 'O' + j)} and leaves ${lbl(play, 'O' + i)} ${dOwn.toFixed(0)} m away. Only do this on purpose (a poach) and say so.` });
        }
      }
    }
    // picks: in person defense, a defender within 3 m of their own player runs into another player
    if ((play.defense || 'person') === 'person') {
      const seen = new Set();
      for (let k = 1; k <= 20; k++) {
        const u = k / 20, at = {};
        for (const pid of PIDS) at[pid] = posAt(pid, u);
        for (let i = 1; i <= 4; i++) {
          const d = 'D' + i, own = 'O' + i;
          if (dist(at[d], at[own]) > 3) continue;
          for (const x of PIDS) {
            if (x === d || x === own || seen.has(d + x)) continue;
            const gap = dist(at[d], at[x]);
            if (gap < P.body) {
              seen.add(d + x);
              const who = isO(x) ? lbl(play, x) : 'teammate ' + lbl(play, x);
              issues.push(expect.includes('pick')
                ? { level: 'ok', pid: d, msg: `Intended: ${lbl(play, d)} is picked by ${who} (${(u * dur).toFixed(1)} s into the phase).` }
                : { level: isO(x) ? 'error' : 'warn', pid: d, msg: `Pick: ${lbl(play, d)} runs into ${who} ${(u * dur).toFixed(1)} s into the phase (${gap.toFixed(1)} m apart) while guarding ${lbl(play, own)}. ${isO(x) ? 'Call "pick", play stops. Re-route ' + lbl(play, x) + ' or ' + lbl(play, own) + '.' : 'Defenders should switch or one goes around.'}` });
            }
          }
        }
      }
    }
    if ((play.defense || 'person') === 'person' && typeof chi.disc === 'string' && isO(chi.disc)) {
      const H = chi.pos[chi.disc];
      const near = PIDS.filter(pid => !isO(pid) && dist(chi.pos[pid], H) < 3);
      if (near.length > 1) issues.push({ level: 'warn', msg: `${near.map(x => lbl(play, x)).join(' and ')} are both within 3 m of the thrower: that's a double team in person defense.` });
    }
    return { dur, auto: !explicit, tr, throw: thr, issues };
  }

  // Whole play: per node {edge, held (s with disc at end of step), stallAtRelease, issues}
  function analyzePlay(play) {
    const out = {}, limit = play.stall || P.stall;
    const walk = (id, held, clock) => {
      const n = play.nodes[id]; if (!n) return;
      const par = n.parent ? play.nodes[n.parent] : null;
      let edge = null, issues = [], h = held, c = clock;
      if (par) {
        edge = analyzeEdge(play, par, n);
        issues = edge.issues.slice();
        c = clock + edge.dur;
        if (edge.throw) {
          const st = held + edge.tr;
          edge.stallAtRelease = st;
          const okLate = Array.isArray(n.expect) && n.expect.includes('fail');
          if (st > limit - 0.5) issues.push({ level: 'error', msg: `The throw goes at stall ${Math.floor(st)}. Stall limit is ${limit}.` });
          else if (st > limit - 3) issues.push({ level: okLate ? 'ok' : 'warn', msg: `The throw goes late in the stall (${Math.floor(st)}).` });
          h = 0;
        } else h = held + edge.dur;
      }
      if (!edge || !edge.throw) if (h > limit && typeof n.disc === 'string') issues.push({ level: 'error', msg: `The holder has been stalled out (${Math.floor(h)} s with the disc).` });
      out[id] = { edge, held: h, clock: c, issues };
      n.children.forEach(k => walk(k, h, c));
    };
    walk(play.rootId, 0, 0);
    return out;
  }

  // Lanes from the holder to every other offensive player if the disc went now.
  // Each receiver may be led into space: targets up to 6 m away that they reach before the disc lands.
  function lanes(play, node) {
    if (typeof node.disc !== 'string' || !isO(node.disc)) return [];
    const A = node.pos[node.disc], defPos = {}, f = play.field;
    for (const pid of PIDS) if (!isO(pid)) defPos[pid] = node.pos[pid];
    const defs = defsAt(defPos, A);
    return PIDS.filter(pid => isO(pid) && pid !== node.disc).map(pid => {
      const R = node.pos[pid];
      let best = null;
      for (const r of [0, 2, 4, 6]) for (let k = 0; k < (r ? 12 : 1); k++) {
        const a = k * Math.PI / 6, B = [R[0] + r * Math.cos(a), R[1] + r * Math.sin(a)];
        if (B[0] < 0.3 || B[0] > f.L - 0.3 || B[1] < 0.3 || B[1] > f.W - 0.3) continue;
        const res = bestThrow({ A, B, defs, field: f });
        if (!res) continue;
        const arrive = r ? 0.1 + tRun(r) : 0;
        for (const t of res.all) {
          if (arrive > t.flight + 0.1) continue;
          const score = t.p - r * 0.004;          // tiny preference for the simplest target
          if (!best || score > best.score) best = Object.assign({}, t, { B, lead: r, score });
          break;
        }
      }
      return { pid, best };
    });
  }

  const lbl = (play, pid) => (play.labels && play.labels[pid]) || pid;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const pct = p => Math.round(p * 100) + '%';

  const api = { P, TYPES, TYPE_ORDER, TYPE_LABEL, tRun, tRunFrom, dRun, pathAt, pathLen, trajectory, evalThrow, bestThrow, analyzeEdge, analyzePlay, lanes, throwName, markOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UltiSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
