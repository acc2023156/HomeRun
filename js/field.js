/*
 * 球場渲染（Canvas 2D，全部程式繪製）
 * 世界座標（公尺）：本壘 = (0,0)，+y 朝中外野，+x 朝一壘／右外野，z 為高度。
 * 視角 A「本壘後方」：透視投影，鏡頭跟著球走（平移、轉向、仰角），小倍數時使用。
 * 視角 B「俯視全場」：距離 ≥ SWITCH_M 公尺時切換。
 */
(function (global) {
  'use strict';
  const { FIELDS } = global.Crash;
  const DEG = Math.PI / 180;
  const SWITCH_M = 50;          // 飛到 50 m 切換俯視（對所有球相同，不洩漏結果）
  const FADE_MS = 450;
  const NEAR = 1;               // 近平面（公尺）

  const C = {
    grass1: '#3f9a3a', grass2: '#4aab43', grassDark: '#2f7d2d',
    dirt: '#c77a47', track: '#b8693a',
    line: '#ffffff', wall: '#0e5a3c', wallTop: '#f4c542',
    sky1: '#f3f5f7', sky2: '#cfd7de',
    jersey: '#1d3f8f', ball: '#ffffff', seam: '#e5383b',
  };

  // 規則上的牆距（依方向三等分）
  const fenceAt = deg => (deg < -15 ? FIELDS[0] : deg <= 15 ? FIELDS[1] : FIELDS[2]).fence * 10;
  // 畫面上的牆：通過三個方向中央牆距點（-30°:110、0°:122、30°:114）的單一圓弧，外型是正常扇形
  const WALL = (() => {
    const p = (d, a) => [d * Math.sin(a * DEG), d * Math.cos(a * DEG)];
    const A = p(FIELDS[0].fence * 10, -30), B = p(FIELDS[1].fence * 10, 0), Cc = p(FIELDS[2].fence * 10, 30);
    const D = 2 * (A[0] * (B[1] - Cc[1]) + B[0] * (Cc[1] - A[1]) + Cc[0] * (A[1] - B[1]));
    const s = q => q[0] * q[0] + q[1] * q[1];
    const ux = (s(A) * (B[1] - Cc[1]) + s(B) * (Cc[1] - A[1]) + s(Cc) * (A[1] - B[1])) / D;
    const uy = (s(A) * (Cc[0] - B[0]) + s(B) * (A[0] - Cc[0]) + s(Cc) * (B[0] - A[0])) / D;
    return { ux, uy, r: Math.hypot(A[0] - ux, A[1] - uy) };
  })();
  function fenceVis(deg) {
    const a = Math.max(-45, Math.min(45, deg)) * DEG;
    const dx = Math.sin(a), dy = Math.cos(a), b = dx * WALL.ux + dy * WALL.uy;
    return b + Math.sqrt(b * b - (WALL.ux * WALL.ux + WALL.uy * WALL.uy - WALL.r * WALL.r));
  }
  // 球的畫面距離依該角度的牆距等比縮放，讓「過牆／牆前接殺」在畫面上一致（顯示距離與判定不變）
  const visScale = deg => fenceVis(deg) / fenceAt(deg);
  const polar = (d, deg) => [d * Math.sin(deg * DEG), d * Math.cos(deg * DEG)];

  // 球的高度只跟「目前距離」有關，所有球同一條彈道，畫面不會提前透露落點
  const heightAt = d => 1 + d * 0.5 * (1 - d / 200);

  const FIELDER_HOME = [
    [0, 18.4], [0, -1.5], [15, 25], [9, 37], [-9, 37], [-15, 25],
    polar(80, -30), polar(92, 0), polar(80, 30),
  ];
  const CATCHER = 1;

  const lerp = (a, b, k) => a + (b - a) * k;

  class FieldRenderer {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.W = 0; this.H = 0; this.dpr = 1;
      this.view = 'behind';
      this.prevView = 'behind';
      this.viewChangedAt = -1e9;
      this.particles = [];
      this.fielders = FIELDER_HOME.map(p => ({ home: p, pos: p.slice(), step: null }));
      this.chaser = -1;
      this.cam = { x: 0, y: -10, z: 4, yaw: 0, hy: 0 };
      this.lastNow = 0;
      this.roundId = -1;
    }

    resize(W, H, dpr) {
      this.W = W; this.H = H; this.dpr = dpr;
      this.cv.width = Math.round(W * dpr);
      this.cv.height = Math.round(H * dpr);
      this.crowd = this.makeCrowd();
      this.cam.hy = 0.512 * H;
    }

    makeCrowd() {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 60;
      const g = c.getContext('2d');
      g.fillStyle = '#2c4a5a'; g.fillRect(0, 0, c.width, c.height);
      const colors = ['#e9eef2', '#f2c14e', '#e5383b', '#4cc9f0', '#90be6d', '#f28482', '#577590', '#ffffff', '#43aa8b'];
      for (let i = 0; i < 900; i++) {
        g.fillStyle = colors[(Math.random() * colors.length) | 0];
        g.globalAlpha = 0.55 + Math.random() * 0.45;
        g.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
      }
      return this.ctx.createPattern(c, 'repeat');
    }

    setView(v, now) {
      if (v === this.view) return;
      this.prevView = this.view;
      this.view = v;
      this.viewChangedAt = now;
    }

    /* ---------- 每幀 ---------- */
    render(state, now) {
      const { ctx, W, H } = this;
      if (!W || !H) return;
      const dt = Math.min(0.1, (now - this.lastNow) / 1000 || 0);
      this.lastNow = now;
      if (state.roundId !== this.roundId) {
        this.roundId = state.roundId;
        this.fielders.forEach(f => { f.pos = f.home.slice(); f.step = null; });
        this.chaser = -1;
        this.catchLocked = false;
        this.catchKind = null;
        this.runStart = null;
        this.particles = [];
        this.fireworksUntil = 0;
      }
      if (state.phase === 'running' && this.runStart == null) this.runStart = now - (state.flightT || 0);
      this.updateFielders(state, dt);
      this.updateCamera(state, dt);
      this.updateParticles(state, dt, now);

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const fade = Math.min(1, (now - this.viewChangedAt) / FADE_MS);
      if (fade < 1) {
        this.drawView(this.prevView, state);
        ctx.globalAlpha = fade;
        this.drawView(this.view, state);
        ctx.globalAlpha = 1;
      } else {
        this.drawView(this.view, state);
      }
      this.drawParticles();
    }

    drawView(v, s) { if (v === 'top') this.drawTop(s); else this.drawBehind(s); }

    /* ---------- 守備員 ----------
       擊球後全員往球的方向跨兩三步；之後由離球最近的那位負責：
       先橫移到球的飛行線上（不往本壘衝），球飛過頭才跟著往後退。
       結束時球若就在身邊 → 撲接；太遠 → 跑過去撿（落地出局）。 */
    updateFielders(s, dt) {
      const ball = s.ball;
      this.fielders.forEach(f => { f.moving = false; });
      if (!ball || s.phase === 'betting') return;
      const ux = Math.sin(s.angle * DEG), uy = Math.cos(s.angle * DEG);
      if (!this.fielders[0].step) {
        this.fielders.forEach((f, i) => {
          if (i === CATCHER) { f.step = f.home.slice(); return; }
          const along = Math.max(0, f.home[0] * ux + f.home[1] * uy);
          const dx = ux * along - f.home[0], dy = uy * along - f.home[1], d = Math.hypot(dx, dy) || 1;
          const k = Math.min(2.4, d);
          f.step = [f.home[0] + (dx / d) * k, f.home[1] + (dy / d) * k];
        });
      }
      const flightT = s.flightT || 0;
      const ballR = Math.hypot(ball.x, ball.y);
      if ((flightT > 600 || s.phase === 'crashed') && !this.catchLocked) {
        let best = 1e9, pick = -1;
        this.fielders.forEach((f, i) => {
          if (i === CATCHER) return;
          const d = Math.hypot(f.home[0] - ball.x, f.home[1] - ball.y);
          if (d < best) { best = d; pick = i; }
        });
        this.chaser = pick;
      }
      if (s.phase === 'crashed' && !s.homer && !this.catchLocked && this.chaser >= 0) {
        this.catchLocked = true;
        const c = this.fielders[this.chaser];
        this.catchKind = Math.hypot(c.pos[0] - ball.x, c.pos[1] - ball.y) <= 9 ? 'catch' : 'drop';
      }
      this.fielders.forEach((f, i) => {
        let target = f.step, speed = 4;
        if (i === this.chaser) {
          if (s.phase === 'crashed' && s.homer) {
            const a = Math.atan2(f.pos[0], f.pos[1]) / DEG;
            target = polar(fenceVis(a) - 1.5, a); speed = 6;             // 追到牆邊目送
          } else if (s.phase === 'crashed') {
            target = [ball.x, ball.y];
            speed = this.catchKind === 'catch' ? 22 : 9;                   // 撲接／跑去撿
          } else {
            const along = Math.max(f.home[0] * ux + f.home[1] * uy, ballR); // 只沿飛行線往外追
            target = [ux * along, uy * along]; speed = 7.5;
          }
        } else if (this.chaser >= 0 && flightT > 600) {
          target = null;                                                   // 其他人站定看球
        }
        if (!target) return;
        const dx = target[0] - f.pos[0], dy = target[1] - f.pos[1], d = Math.hypot(dx, dy);
        if (d > 0.05) {
          const stp = Math.min(d, speed * dt);
          f.pos[0] += (dx / d) * stp; f.pos[1] += (dy / d) * stp;
          f.moving = stp > 0.01;
        }
        const r = Math.hypot(f.pos[0], f.pos[1]);
        const lim = fenceVis(Math.atan2(f.pos[0], f.pos[1]) / DEG) - 1.5;
        if (r > lim) { f.pos[0] *= lim / r; f.pos[1] *= lim / r; }
      });
    }

    /* ---------- 打擊者：晃棒 → 揮棒 → 丟棒跑一壘 ---------- */
    batterState(now) {
      const start = [-1.25, -0.25];
      if (this.runStart == null) return { pos: start, swing: -1, moving: false, t: now / 1000 };
      const bt = now - this.runStart;
      const swing = Math.min(1, bt / 260);
      if (bt < 750) return { pos: start, swing, moving: false, t: now / 1000 };
      const to = [19.4, 19.4], L = Math.hypot(to[0] - start[0], to[1] - start[1]);
      const d = Math.min(L, ((bt - 750) / 1000) * 8);
      return { pos: [start[0] + (to[0] - start[0]) * d / L, start[1] + (to[1] - start[1]) * d / L], swing: 2, moving: d < L, t: now / 1000 };
    }

    /* ---------- 跟球鏡頭 ---------- */
    updateCamera(s, dt) {
      const { H } = this, cam = this.cam, b = s.ball;
      let tx = 0, ty = -10, tz = 4, tyaw = 0, thy = 0.512 * H;
      if (b && s.phase !== 'betting') {
        tx = b.x * 0.45;
        ty = -10 + b.y * 0.45;
        tz = 3 + b.z * 0.3;
        tyaw = Math.atan2(b.x - tx, b.y - ty);
        // 讓球停在畫面約 42% 高度
        const fw = Math.hypot(b.x - tx, b.y - ty);
        thy = 0.42 * H - (this.focal() * (tz - b.z)) / Math.max(NEAR, fw);
        thy = Math.max(0.2 * H, Math.min(1.25 * H, thy));
      }
      const k = b && s.phase !== 'betting' ? 1 - Math.pow(0.02, dt) : 1 - Math.pow(0.1, dt);
      cam.x = lerp(cam.x, tx, k); cam.y = lerp(cam.y, ty, k); cam.z = lerp(cam.z, tz, k);
      cam.yaw = lerp(cam.yaw, tyaw, k); cam.hy = lerp(cam.hy, thy, k);
    }
    focal() { return 1.27 * this.H; }

    /* ---------- 煙火 ---------- */
    updateParticles(s, dt, now) {
      if (s.celebrate && now < this.fireworksUntil && Math.random() < dt * 5) this.burst();
      this.particles.forEach(p => { p.vx *= 0.98; p.vy = p.vy * 0.98 + 60 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; });
      this.particles = this.particles.filter(p => p.life > 0);
    }
    startFireworks(now) { this.fireworksUntil = now + 3200; for (let i = 0; i < 3; i++) this.burst(); }
    burst() {
      const { W, H } = this;
      const x = W * (0.15 + Math.random() * 0.7), y = H * (0.1 + Math.random() * 0.3);
      const color = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#ffffff'][(Math.random() * 5) | 0];
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2, v = 60 + Math.random() * 90;
        this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.9 + Math.random() * 0.6, color });
      }
    }
    drawParticles() {
      const { ctx } = this;
      this.particles.forEach(p => {
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      });
      ctx.globalAlpha = 1;
    }

    /* =========================================================
       視角 B：俯視全場（圖一）
       ========================================================= */
    drawTop(s) {
      const { ctx, W, H } = this;
      const sc = Math.min(W / 205, (H - 16) / 150);
      const ox = W / 2, oy = H - 10 - 6 * sc;
      const P = (x, y) => [ox + x * sc, oy - y * sc];

      // 場外：素色深底 + 淡淡的座位弧線
      const bg = ctx.createRadialGradient(ox, oy, 60 * sc, ox, oy, 190 * sc);
      bg.addColorStop(0, '#1d3a45'); bg.addColorStop(1, '#10222b');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = Math.max(1, sc * 1.2);
      for (let r = 135; r < 230; r += 7) {
        ctx.beginPath(); ctx.arc(ox, oy, r * sc, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      }

      // 外框（棕）：扇形往外擴 4 m；草地：牆內
      const fan = (grow, spread) => {
        ctx.beginPath();
        ctx.moveTo(...P(0, -grow * 1.4));
        for (let a = -45 - spread; a <= 45 + spread; a += 0.5) ctx.lineTo(...P(...polar(fenceVis(a) + grow, a)));
        ctx.closePath();
      };
      fan(4, 2.2); ctx.fillStyle = C.track; ctx.fill();
      ctx.save(); fan(0, 0); ctx.clip();
      ctx.fillStyle = '#1f7d36'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#1a7130';
      for (let x = -160; x < 160; x += 16) {
        const [x0] = P(x, 0), [x1] = P(x + 8, 0);
        ctx.fillRect(x0, 0, x1 - x0, H);
      }
      ctx.restore();

      // 本局方向高亮
      if (s.phase !== 'betting' && s.field) {
        const f = FIELDS.find(x => x.key === s.field);
        ctx.beginPath(); ctx.moveTo(...P(0, 0));
        for (let a = f.from; a <= f.to; a += 1) ctx.lineTo(...P(...polar(fenceVis(a), a)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,230,120,.13)'; ctx.fill();
      }

      // 內野
      ctx.beginPath();
      ctx.moveTo(...P(...polar(-3, 0)));
      ctx.lineTo(...P(...polar(38.9, -45)));
      for (let a = -45; a <= 45; a += 3) { const [x, y] = polar(29, a * 1.6); ctx.lineTo(...P(x, y + 18.4)); }
      ctx.lineTo(...P(...polar(38.9, 45)));
      ctx.closePath(); ctx.fillStyle = C.dirt; ctx.fill();
      ctx.beginPath();
      [[0, 3.5], [16.5, 19.4], [0, 35.5], [-16.5, 19.4]].forEach((p, i) => (i ? ctx.lineTo(...P(...p)) : ctx.moveTo(...P(...p))));
      ctx.closePath(); ctx.fillStyle = C.grass2; ctx.fill();
      this.dot(P(0, 18.4), 2.8 * sc, C.dirt);
      this.dot(P(0, 0), 4 * sc, C.dirt);

      ctx.strokeStyle = C.line; ctx.lineWidth = Math.max(1.2, 0.5 * sc);
      [-45, 45].forEach(a => { ctx.beginPath(); ctx.moveTo(...P(0, 0)); ctx.lineTo(...P(...polar(fenceVis(a), a))); ctx.stroke(); });
      [[0, 0], [19.4, 19.4], [0, 38.8], [-19.4, 19.4]].forEach(b => {
        const [x, y] = P(...b), r = Math.max(2, 1.1 * sc);
        ctx.fillStyle = '#fff';
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-r / 2, -r / 2, r, r); ctx.restore();
      });


      // 牆距標示
      const fs = Math.max(10, Math.min(15, sc * 5.5));
      FIELDS.forEach(f => {
        const mid = (f.from + f.to) / 2;
        const active = s.phase !== 'betting' && s.field === f.key;
        const [x, y] = P(...polar(fenceVis(mid) - 12, mid));
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `800 ${fs}px system-ui, sans-serif`;
        ctx.fillStyle = active ? '#ffe27a' : 'rgba(255,255,255,.9)';
        ctx.fillText(`${f.fence * 10} m`, x, y);
        ctx.font = `700 ${fs * 0.75}px system-ui, sans-serif`;
        ctx.fillStyle = active ? '#ffe27a' : 'rgba(255,255,255,.7)';
        ctx.fillText(`×${(f.fence * 2).toFixed(1)}`, x, y + fs * 0.95);
      });

      this.fielders.forEach((f, i) => this.dot(P(...f.pos), Math.max(3.5, 1.6 * sc), i === CATCHER ? '#666' : C.jersey, '#fff'));

      const b = s.ball;
      if (b && s.phase !== 'betting') {
        const [gx, gy] = P(b.x, b.y);
        ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(...P(0, 0)); ctx.lineTo(gx, gy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.beginPath(); ctx.ellipse(gx, gy, 2 * sc, 1.2 * sc, 0, 0, Math.PI * 2); ctx.fill();
        const lift = b.z * sc * 0.55, rad = Math.max(3.5, (1.3 + b.z * 0.045) * sc);
        this.ball(gx, gy - lift, rad);
        ctx.font = `700 ${Math.max(10, fs * 0.8)}px system-ui, sans-serif`;
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`${b.d.toFixed(1)} m`, gx + rad + 6, gy - lift);
      }
    }

    /* =========================================================
       視角 A：本壘後方（圖二），鏡頭跟球
       ========================================================= */
    drawBehind(s) {
      const { ctx, W, H } = this;
      const cam = this.cam, f = this.focal();
      const cs = Math.cos(cam.yaw), sn = Math.sin(cam.yaw);
      // 世界 → 相機空間（rx 右、ry 前、rz 上）
      const toCam = (x, y, z = 0) => {
        const dx = x - cam.x, dy = y - cam.y;
        return [dx * cs - dy * sn, dx * sn + dy * cs, z - cam.z];
      };
      const proj = c => [W / 2 + (f * c[0]) / c[1], cam.hy - (f * c[2]) / c[1]];
      const P = (x, y, z = 0) => { const c = toCam(x, y, z); return c[1] < NEAR ? null : proj(c); };
      // 多邊形先在相機空間對近平面裁切，再投影
      const clip = pts => {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const ina = a[1] >= NEAR, inb = b[1] >= NEAR;
          if (ina) out.push(a);
          if (ina !== inb) {
            const t = (NEAR - a[1]) / (b[1] - a[1]);
            out.push([a[0] + (b[0] - a[0]) * t, NEAR, a[2] + (b[2] - a[2]) * t]);
          }
        }
        return out;
      };
      const path = pts => {
        const c = clip(pts.map(p => toCam(...p)));
        if (c.length < 2) return false;
        ctx.beginPath();
        c.forEach((q, i) => { const p = proj(q); i ? ctx.lineTo(...p) : ctx.moveTo(...p); });
        ctx.closePath();
        return true;
      };
      const poly = (pts, fill) => { if (path(pts)) { ctx.fillStyle = fill; ctx.fill(); } };
      const line = (a, b) => {
        let ca = toCam(...a), cb = toCam(...b);
        if (ca[1] < NEAR && cb[1] < NEAR) return;
        if (ca[1] < NEAR) { const t = (NEAR - ca[1]) / (cb[1] - ca[1]); ca = [ca[0] + (cb[0] - ca[0]) * t, NEAR, ca[2] + (cb[2] - ca[2]) * t]; }
        if (cb[1] < NEAR) { const t = (NEAR - cb[1]) / (ca[1] - cb[1]); cb = [cb[0] + (ca[0] - cb[0]) * t, NEAR, cb[2] + (ca[2] - cb[2]) * t]; }
        ctx.beginPath(); ctx.moveTo(...proj(ca)); ctx.lineTo(...proj(cb)); ctx.stroke();
      };

      // 天空／巨蛋
      const hy = cam.hy;
      const sky = ctx.createLinearGradient(0, hy - H, 0, hy);
      sky.addColorStop(0, C.sky1); sky.addColorStop(1, C.sky2);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(120,135,150,.28)'; ctx.lineWidth = 1.2;
      const yawShift = -cam.yaw * f;
      for (let i = 1; i <= 5; i++) {
        ctx.beginPath(); ctx.ellipse(W / 2 + yawShift * 0.3, hy - H * 0.12 + i * 6, W * (0.2 + i * 0.16), H * (0.08 + i * 0.12), 0, Math.PI, 0); ctx.stroke();
      }

      // 看台（牆後，連續）
      const ringPts = (extra, z, from, to, stepA) => {
        const pts = [];
        for (let a = from; stepA > 0 ? a <= to : a >= to; a += stepA) pts.push([...polar(fenceVis(a) + extra, a), z]);
        return pts;
      };
      if (path([...ringPts(60, 32, -75, 75, 2), ...ringPts(1, 3.5, 75, -75, -2)])) {
        ctx.fillStyle = this.crowd; ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fill();
      }
      ctx.strokeStyle = 'rgba(210,220,228,.8)'; ctx.lineWidth = 2;
      [0.3, 0.63].forEach(k => {
        const pts = ringPts(1 + 59 * k, 3.5 + 28.5 * k, -75, 75, 3);
        for (let i = 0; i < pts.length - 1; i++) line(pts[i], pts[i + 1]);
      });
      ctx.strokeStyle = '#b7c1ca'; ctx.lineWidth = Math.max(4, H * 0.02);
      const roof = ringPts(60, 32, -75, 75, 3);
      for (let i = 0; i < roof.length - 1; i++) line(roof[i], roof[i + 1]);

      // 記分板
      const sb = [P(-20, 182, 52), P(20, 182, 52), P(20, 182, 30), P(-20, 182, 30)];
      if (sb.every(Boolean)) {
        ctx.fillStyle = '#0d4a3f';
        ctx.beginPath(); sb.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.fill();
        const sbw = sb[1][0] - sb[0][0], sbh = sb[3][1] - sb[0][1];
        ctx.fillStyle = '#8fd0d6';
        ctx.fillRect(sb[0][0] + sbw * 0.04, sb[0][1] + sbh * 0.1, sbw * 0.22, sbh * 0.6);
        ctx.fillRect(sb[0][0] + sbw * 0.74, sb[0][1] + sbh * 0.1, sbw * 0.22, sbh * 0.6);
        ctx.fillStyle = '#1b5fa8';
        ctx.fillRect(sb[0][0] + sbw * 0.3, sb[0][1] + sbh * 0.12, sbw * 0.4, sbh * 0.56);
        ctx.fillStyle = '#ffe27a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `800 ${Math.max(8, sbh * 0.28)}px system-ui, sans-serif`;
        ctx.fillText(s.scoreboard || 'HOME RUN', sb[0][0] + sbw / 2, sb[0][1] + sbh * 0.4);
      }

      // 地面
      ctx.fillStyle = C.grassDark;
      ctx.fillRect(0, hy, W, H);
      const ground = [...ringPts(0, 0, -80, 80, 2), [70, -12, 0], [-70, -12, 0]];
      ctx.save();
      if (path(ground)) {
        ctx.clip();
        ctx.fillStyle = C.grass1; ctx.fillRect(0, 0, W, H);
        for (let k = -2; k < 24; k += 2) poly([[-200, k * 6, 0], [200, k * 6, 0], [200, (k + 1) * 6, 0], [-200, (k + 1) * 6, 0]], C.grass2);
      }
      ctx.restore();

      // 全壘打牆（連續牆面 + 黃色牆頂 + 牆距）
      const top = ringPts(0, 3.5, -62, 62, 1), bot = ringPts(0, 0, 62, -62, -1);
      poly([...top, ...bot], C.wall);
      ctx.strokeStyle = C.wallTop; ctx.lineWidth = 2;
      for (let i = 0; i < top.length - 1; i++) line(top[i], top[i + 1]);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      FIELDS.forEach(fd => {
        const p = P(...polar(fd.fence * 10, (fd.from + fd.to) / 2), 1.8);
        if (!p) return;
        const active = s.phase !== 'betting' && s.field === fd.key;
        ctx.font = `800 ${Math.max(9, H * 0.032)}px system-ui, sans-serif`;
        ctx.fillStyle = active ? '#ffe27a' : '#fff';
        ctx.fillText(`${fd.fence * 10}`, ...p);
      });

      // 內野
      const dirt = [[...polar(-4, 0), 0], [...polar(38.9, -45), 0]];
      for (let a = -45; a <= 45; a += 3) { const [x, y] = polar(29, a * 1.6); dirt.push([x, y + 18.4, 0]); }
      dirt.push([...polar(38.9, 45), 0]);
      poly(dirt, C.dirt);
      poly([[0, 3.5, 0], [16.5, 19.4, 0], [0, 35.5, 0], [-16.5, 19.4, 0]], C.grass2);
      const circle = (cx, cy, r, fill) => { const pts = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0]); } poly(pts, fill); };
      circle(0, 18.4, 2.8, C.dirt);
      circle(0, 0, 4.2, C.dirt);

      ctx.strokeStyle = C.line; ctx.lineWidth = 2;
      [-45, 45].forEach(a => line([...polar(2.9, a), 0], [...polar(fenceVis(a), a), 0]));
      [[-1.9, -0.9], [0.7, -0.9]].forEach(([x, y]) => {
        const r = [[x, y, 0], [x + 1.2, y, 0], [x + 1.2, y + 1.8, 0], [x, y + 1.8, 0]];
        for (let i = 0; i < 4; i++) line(r[i], r[(i + 1) % 4]);
      });
      poly([[-0.22, 0, 0], [0.22, 0, 0], [0.22, 0.22, 0], [0, 0.44, 0], [-0.22, 0.22, 0]], '#fff');
      [[19.4, 19.4], [0, 38.8], [-19.4, 19.4]].forEach(([x, y]) => poly([[x - 0.4, y, 0], [x, y + 0.4, 0], [x + 0.4, y, 0], [x, y - 0.4, 0]], '#fff'));

      // 守備員與打擊者（遠的先畫，二頭身）
      const bat = this.batterState(this.lastNow);
      const people = this.fielders
        .map((fd, i) => ({ kind: 'f', i, pos: fd.pos, moving: fd.moving }))
        .filter(o => o.i !== CATCHER);
      people.push({ kind: 'b', i: 0, pos: bat.pos, moving: bat.moving });
      people
        .map(o => ({ ...o, c: toCam(o.pos[0], o.pos[1], 0) }))
        .filter(o => o.c[1] >= NEAR + 0.5)
        .sort((a, b) => b.c[1] - a.c[1])
        .forEach(o => {
          const [x, y] = proj(o.c);
          const h = (f * 1.7) / o.c[1];
          if (o.kind === 'b') { this.drawBatter(x, y, h, bat); return; }
          this.chibi(x, y, h, {
            front: true, moving: o.moving, t: this.lastNow / 1000 + o.i * 0.37,
            catching: s.phase === 'crashed' && o.i === this.chaser && this.catchKind === 'catch',
          });
        });
      // 丟在本壘旁的球棒
      if (bat.swing === 2) {
        const p1 = P(-0.6, 0.4, 0.05), p2 = P(-1.4, 1.1, 0.05);
        if (p1 && p2) {
          ctx.strokeStyle = '#d9b27a'; ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(2, (f * 0.06) / Math.max(1, toCam(-1, 0.7, 0)[1]));
          ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.stroke();
        }
      }

      // 球 + 影子
      const b = s.ball;
      if (b && s.phase !== 'betting') {
        const cg = toCam(b.x, b.y, 0), cb = toCam(b.x, b.y, b.z);
        if (cg[1] >= NEAR) {
          const [sx, sy] = proj(cg);
          ctx.fillStyle = 'rgba(0,0,0,.28)';
          ctx.beginPath(); ctx.ellipse(sx, sy, (f * 0.5) / cg[1], (f * 0.18) / cg[1], 0, 0, Math.PI * 2); ctx.fill();
        }
        if (cb[1] >= NEAR) {
          const [bx, by] = proj(cb);
          this.ball(bx, by, Math.max(3, Math.min(18, (f * 0.3) / cb[1])));
        }
      }
    }

    /* ---------- 二頭身球員（參考實況野球比例：大頭、帽子、短身體） ---------- */
    chibi(x, y, h, o) {
      const c = this.ctx;
      if (h < 7) { this.dot([x, y - h * 0.5], Math.max(2, h * 0.3), C.jersey, '#fff'); return; }
      const run = o.moving ? Math.sin(o.t * 16) : 0;
      const bob = o.moving ? Math.abs(run) * h * 0.035 : 0;
      c.fillStyle = 'rgba(0,0,0,.28)';
      c.beginPath(); c.ellipse(x, y, h * 0.26, h * 0.065, 0, 0, Math.PI * 2); c.fill();
      // 腿、鞋
      [-1, 1].forEach((sd, k) => {
        const sw = k ? -run : run;
        c.fillStyle = '#f2f4f7';
        this.rr(x + sd * h * 0.09 - h * 0.065, y - h * 0.22 - bob + sw * h * 0.03, h * 0.13, h * 0.2, h * 0.05); c.fill();
        c.fillStyle = '#1b2433';
        c.beginPath(); c.ellipse(x + sd * h * 0.09, y - h * 0.02 - bob + sw * h * 0.03, h * 0.08, h * 0.045, 0, 0, Math.PI * 2); c.fill();
      });
      // 身體
      c.fillStyle = C.jersey;
      this.rr(x - h * 0.19, y - h * 0.47 - bob, h * 0.38, h * 0.28, h * 0.11); c.fill();
      c.fillStyle = '#f2f4f7'; c.fillRect(x - h * 0.17, y - h * 0.24 - bob, h * 0.34, h * 0.04);
      c.fillStyle = '#fff'; c.font = `900 ${Math.max(6, h * 0.12)}px system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('H', x, y - h * 0.35 - bob);
      // 手臂＋手套（接殺時舉高）
      const gy = o.catching ? y - h * 0.8 : y - h * 0.34 - bob - run * h * 0.03;
      c.fillStyle = C.jersey;
      c.beginPath(); c.arc(x + h * 0.21, y - h * 0.36 - bob + run * h * 0.03, h * 0.065, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#8a4b1f';
      c.beginPath(); c.arc(x - h * 0.23, gy, h * 0.085, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#5e3212'; c.lineWidth = Math.max(1, h * 0.012); c.stroke();
      // 頭
      const hx = x, hy = y - h * 0.72 - bob, R = h * 0.27;
      c.fillStyle = '#f7d7b5';
      c.beginPath(); c.arc(hx, hy, R, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(120,70,40,.35)'; c.lineWidth = Math.max(1, h * 0.01); c.stroke();
      // 眼睛、腮紅、嘴
      [-1, 1].forEach(sd => {
        c.fillStyle = '#1b1b2a';
        c.beginPath(); c.ellipse(hx + sd * R * 0.36, hy + R * 0.05, R * 0.12, R * 0.19, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#fff';
        c.beginPath(); c.arc(hx + sd * R * 0.36 - R * 0.04, hy - R * 0.03, R * 0.05, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,120,120,.35)';
        c.beginPath(); c.ellipse(hx + sd * R * 0.58, hy + R * 0.32, R * 0.13, R * 0.07, 0, 0, Math.PI * 2); c.fill();
      });
      c.strokeStyle = '#9a4a3a'; c.lineWidth = Math.max(1, R * 0.06);
      c.beginPath(); c.arc(hx, hy + R * 0.38, R * 0.12, 0.2, Math.PI - 0.2); c.stroke();
      // 帽子＋帽簷
      c.fillStyle = C.jersey;
      c.beginPath(); c.arc(hx, hy - R * 0.08, R * 1.02, Math.PI * 1.02, Math.PI * 1.98); c.closePath(); c.fill();
      c.fillStyle = '#152f6b';
      c.beginPath(); c.ellipse(hx, hy - R * 0.12, R * 1.02, R * 0.2, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff'; c.font = `900 ${Math.max(5, R * 0.45)}px system-ui, sans-serif`;
      c.fillText('H', hx, hy - R * 0.55);
    }

    /* ---------- 打擊者（從背後看，右打，戴頭盔，揮棒） ---------- */
    drawBatter(x, y, h, st) {
      const c = this.ctx;
      if (h < 7) { this.dot([x, y - h * 0.5], Math.max(2, h * 0.3), '#e5383b', '#fff'); return; }
      const run = st.moving ? Math.sin(st.t * 16) : 0;
      const bob = st.moving ? Math.abs(run) * h * 0.035 : 0;
      c.fillStyle = 'rgba(0,0,0,.28)';
      c.beginPath(); c.ellipse(x, y, h * 0.28, h * 0.07, 0, 0, Math.PI * 2); c.fill();
      [-1, 1].forEach((sd, k) => {
        const sw = k ? -run : run;
        c.fillStyle = '#f2f4f7';
        this.rr(x + sd * h * 0.1 - h * 0.065, y - h * 0.22 - bob + sw * h * 0.03, h * 0.13, h * 0.2, h * 0.05); c.fill();
        c.fillStyle = '#1b2433';
        c.beginPath(); c.ellipse(x + sd * h * 0.1, y - h * 0.02 - bob + sw * h * 0.03, h * 0.085, h * 0.045, 0, 0, Math.PI * 2); c.fill();
      });
      // 背號球衣（白底紅邊）
      c.fillStyle = '#f7f7f5';
      this.rr(x - h * 0.2, y - h * 0.48 - bob, h * 0.4, h * 0.29, h * 0.11); c.fill();
      c.strokeStyle = '#e5383b'; c.lineWidth = Math.max(1, h * 0.02); c.stroke();
      c.fillStyle = '#e5383b'; c.font = `900 ${Math.max(6, h * 0.15)}px system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('88', x, y - h * 0.34 - bob);
      // 球棒：握點在右肩前
      if (st.swing < 2) {
        let ang;
        if (st.swing < 0) ang = -118 + Math.sin(st.t * 3) * 6;                   // 等待：小幅晃棒
        else { const k = 1 - Math.pow(1 - st.swing, 3); ang = -118 + 318 * k; }  // 揮棒到收棒
        const px = x + h * 0.16, py = y - h * 0.5 - bob, L = h * 0.78, a = ang * DEG;
        c.lineCap = 'round';
        c.strokeStyle = '#c99a5b'; c.lineWidth = Math.max(2, h * 0.07);
        c.beginPath(); c.moveTo(px + Math.cos(a) * L * 0.45, py + Math.sin(a) * L * 0.45); c.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); c.stroke();
        c.strokeStyle = '#e3c089'; c.lineWidth = Math.max(1.5, h * 0.045);
        c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(a) * L * 0.5, py + Math.sin(a) * L * 0.5); c.stroke();
        c.fillStyle = '#f7d7b5';
        c.beginPath(); c.arc(px, py, h * 0.06, 0, Math.PI * 2); c.fill();
      }
      // 頭盔（深藍亮面＋護耳）
      const hx = x, hy = y - h * 0.73 - bob, R = h * 0.28;
      c.fillStyle = '#f7d7b5';
      c.beginPath(); c.arc(hx, hy + R * 0.15, R * 0.92, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#16306a';
      c.beginPath(); c.arc(hx, hy, R, Math.PI * 0.92, Math.PI * 2.08); c.closePath(); c.fill();
      c.beginPath(); c.ellipse(hx - R * 0.78, hy + R * 0.22, R * 0.3, R * 0.36, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(255,255,255,.35)';
      c.beginPath(); c.ellipse(hx - R * 0.3, hy - R * 0.5, R * 0.28, R * 0.12, -0.5, 0, Math.PI * 2); c.fill();
    }
    rr(x, y, w, h, r) {
      const c = this.ctx;
      r = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }

    /* ---------- 小工具 ---------- */
    dot([x, y], r, fill, stroke) {
      const { ctx } = this;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.lineWidth = 1.5; ctx.strokeStyle = stroke; ctx.stroke(); }
    }
    ball(x, y, r) {
      const { ctx } = this;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = C.ball; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.stroke();
      if (r > 4) {
        ctx.strokeStyle = C.seam; ctx.lineWidth = Math.max(1, r * 0.14);
        ctx.beginPath(); ctx.arc(x - r * 0.9, y, r * 0.7, -0.9, 0.9); ctx.stroke();
        ctx.beginPath(); ctx.arc(x + r * 0.9, y, r * 0.7, Math.PI - 0.9, Math.PI + 0.9); ctx.stroke();
      }
    }
  }

  global.FieldRenderer = FieldRenderer;
  global.FieldMath = { heightAt, polar, fenceAt, visScale, SWITCH_M };
})(window);
