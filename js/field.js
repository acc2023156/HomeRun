/*
 * 球場渲染（Canvas 2D，全部程式繪製）
 * 世界座標（公尺）：本壘 = (0,0)，+y 朝中外野，+x 朝一壘／右外野，z 為高度。
 * 視角 A「本壘後方」：透視投影，小倍數時使用。
 * 視角 B「俯視全場」：距離 ≥ SWITCH_M 公尺時切換，可看到三個方向的牆距。
 */
(function (global) {
  'use strict';
  const { FIELDS } = global.Crash;
  const DEG = Math.PI / 180;
  const SWITCH_M = 50;          // 飛到 50 m 切換俯視（對所有球相同，不洩漏結果）
  const FADE_MS = 450;

  const C = {
    grass1: '#3f9a3a', grass2: '#4aab43', grassDark: '#2f7d2d',
    dirt: '#c77a47', dirtDark: '#a9602f', track: '#b8693a',
    line: '#ffffff', wall: '#0e5a3c', wallTop: '#f4c542',
    sky1: '#f3f5f7', sky2: '#cfd7de', ring: '#9aa6b1',
    jersey: '#1d3f8f', jersey2: '#e5383b', ball: '#ffffff', seam: '#e5383b',
  };

  const fenceAt = deg => (deg < -15 ? FIELDS[0] : deg <= 15 ? FIELDS[1] : FIELDS[2]).fence * 10;
  const polar = (d, deg) => [d * Math.sin(deg * DEG), d * Math.cos(deg * DEG)];

  // 球的高度只跟「目前距離」有關，所有球同一條彈道，畫面不會提前透露落點
  const heightAt = d => 1 + d * 0.58 * (1 - d / 190);

  const FIELDER_HOME = [
    [0, 18.4], [0, -1.5], [15, 25], [9, 37], [-9, 37], [-15, 25],
    polar(80, -30), polar(92, 0), polar(80, 30),
  ];

  class FieldRenderer {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.W = 0; this.H = 0; this.dpr = 1;
      this.view = 'behind';
      this.viewChangedAt = -1e9;
      this.prevView = 'behind';
      this.tilt = 0;
      this.particles = [];
      this.fielders = FIELDER_HOME.map(p => ({ home: p, pos: p.slice() }));
      this.crowd = null;
      this.lastNow = 0;
      this.roundId = -1;
    }

    resize(W, H, dpr) {
      this.W = W; this.H = H; this.dpr = dpr;
      this.cv.width = Math.round(W * dpr);
      this.cv.height = Math.round(H * dpr);
      this.crowd = this.makeCrowd();
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
        this.fielders.forEach(f => { f.pos = f.home.slice(); });
        this.particles = [];
        this.fireworksUntil = 0;
      }
      this.updateFielders(state, dt);
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

    /* ---------- 守備員：最近的人追球的地面落點 ---------- */
    updateFielders(s, dt) {
      const ball = s.ball;
      let chaser = -1;
      if (ball && s.phase !== 'betting') {
        let best = 1e9;
        this.fielders.forEach((f, i) => {
          if (i === 1) return; // 捕手不追
          const d = Math.hypot(f.pos[0] - ball.x, f.pos[1] - ball.y);
          if (d < best) { best = d; chaser = i; }
        });
      }
      this.fielders.forEach((f, i) => {
        const target = i === chaser ? (s.catching ? [ball.x, ball.y] : [ball.x, ball.y]) : f.home;
        const speed = i === chaser ? (s.catching ? 14 : 7.5) : 4;
        const dx = target[0] - f.pos[0], dy = target[1] - f.pos[1];
        const d = Math.hypot(dx, dy);
        if (d > 0.05) {
          const step = Math.min(d, speed * dt);
          f.pos[0] += (dx / d) * step; f.pos[1] += (dy / d) * step;
        }
        // 不追出全壘打牆
        const r = Math.hypot(f.pos[0], f.pos[1]);
        const deg = Math.atan2(f.pos[0], f.pos[1]) / DEG;
        const lim = fenceAt(Math.max(-45, Math.min(45, deg))) - 1.5;
        if (r > lim) { f.pos[0] *= lim / r; f.pos[1] *= lim / r; }
      });
    }

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

      ctx.fillStyle = this.crowd; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(8,20,30,.35)'; ctx.fillRect(0, 0, W, H);

      // 外野牆外的警戒區（棕）＋草地（條紋）
      const fan = (inset) => {
        ctx.beginPath();
        ctx.moveTo(...P(0, -4));
        for (let a = -45; a <= 45; a += 0.5) ctx.lineTo(...P(...polar(fenceAt(a) - inset, a)));
        ctx.closePath();
      };
      fan(-3); ctx.fillStyle = C.track; ctx.fill();
      ctx.save(); fan(4); ctx.clip();
      ctx.fillStyle = C.grass1; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = C.grass2;
      for (let i = -12; i < 12; i += 2) {
        ctx.beginPath();
        ctx.moveTo(...P(0, 0));
        ctx.lineTo(...P(...polar(200, i * 3.75)));
        ctx.lineTo(...P(...polar(200, (i + 1) * 3.75)));
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();

      // 本局方向高亮
      if (s.phase !== 'betting' && s.field) {
        const f = FIELDS.find(x => x.key === s.field);
        ctx.beginPath(); ctx.moveTo(...P(0, 0));
        for (let a = f.from; a <= f.to; a += 1) ctx.lineTo(...P(...polar(f.fence * 10, a)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,230,120,.13)'; ctx.fill();
      }

      // 內野紅土
      ctx.beginPath();
      ctx.moveTo(...P(...polar(-3, 0)));
      ctx.lineTo(...P(...polar(38.9, -45)));
      for (let a = -45; a <= 45; a += 3) {
        const [x, y] = polar(29, a * 1.6);
        ctx.lineTo(...P(x, y + 18.4));
      }
      ctx.lineTo(...P(...polar(38.9, 45)));
      ctx.closePath(); ctx.fillStyle = C.dirt; ctx.fill();
      // 內野草地
      const bases = [[0, 0], [19.4, 19.4], [0, 38.8], [-19.4, 19.4]];
      ctx.beginPath();
      [[0, 3.5], [16.5, 19.4], [0, 35.5], [-16.5, 19.4]].forEach((p, i) => (i ? ctx.lineTo(...P(...p)) : ctx.moveTo(...P(...p))));
      ctx.closePath(); ctx.fillStyle = C.grass2; ctx.fill();
      // 投手丘、本壘區
      this.dot(P(0, 18.4), 2.8 * sc, C.dirt);
      this.dot(P(0, 0), 4 * sc, C.dirt);
      ctx.fillStyle = '#fff'; ctx.fillRect(P(0, 18.4)[0] - 0.8 * sc, P(0, 18.4)[1] - 0.25 * sc, 1.6 * sc, 0.5 * sc);

      // 邊線
      ctx.strokeStyle = C.line; ctx.lineWidth = Math.max(1.2, 0.5 * sc);
      [-45, 45].forEach(a => { ctx.beginPath(); ctx.moveTo(...P(0, 0)); ctx.lineTo(...P(...polar(fenceAt(a), a))); ctx.stroke(); });
      bases.forEach((b, i) => {
        const [x, y] = P(...b), r = Math.max(2, 1.1 * sc);
        ctx.fillStyle = '#fff';
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-r / 2, -r / 2, r, r);
        ctx.restore();
        if (i === 0) this.dot([x, y], r * 0.7, '#fff');
      });

      // 全壘打牆（三段，各自牆距）
      ctx.lineWidth = Math.max(3, 1.4 * sc); ctx.strokeStyle = C.wallTop; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let a = -45; a <= 45; a += 0.5) {
        const p = P(...polar(fenceAt(a), a));
        a === -45 ? ctx.moveTo(...p) : ctx.lineTo(...p);
      }
      ctx.stroke();

      // 牆距標示
      const fs = Math.max(10, Math.min(15, sc * 5.5));
      FIELDS.forEach(f => {
        const mid = (f.from + f.to) / 2;
        const active = s.phase !== 'betting' && s.field === f.key;
        const [x, y] = P(...polar(f.fence * 10 - 13, mid));
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `800 ${fs}px system-ui, sans-serif`;
        ctx.fillStyle = active ? '#ffe27a' : 'rgba(255,255,255,.9)';
        ctx.fillText(`${f.fence * 10} m`, x, y);
        ctx.font = `600 ${fs * 0.72}px system-ui, sans-serif`;
        ctx.fillStyle = active ? '#ffe27a' : 'rgba(255,255,255,.7)';
        ctx.fillText(`${f.name} ×${(f.fence * 2).toFixed(1)}`, x, y + fs * 0.95);
      });

      // 守備員
      this.fielders.forEach((f, i) => {
        const [x, y] = P(...f.pos);
        this.dot([x, y], Math.max(3.5, 1.6 * sc), i === 1 ? '#666' : C.jersey, '#fff');
      });

      // 球：影子 + 軌跡 + 球（高度用往上位移表現）
      const b = s.ball;
      if (b && s.phase !== 'betting') {
        const [gx, gy] = P(b.x, b.y);
        ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(...P(0, 0)); ctx.lineTo(gx, gy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.beginPath(); ctx.ellipse(gx, gy, 2.2 * sc * 0.9, 1.3 * sc * 0.9, 0, 0, Math.PI * 2); ctx.fill();
        const lift = b.z * sc * 0.55, rad = Math.max(3.5, (1.3 + b.z * 0.045) * sc);
        this.ball(gx, gy - lift, rad);
        // 距離標籤
        ctx.font = `700 ${Math.max(10, fs * 0.8)}px system-ui, sans-serif`;
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`${b.d.toFixed(1)} m`, gx + rad + 6, gy - lift);
      }
    }

    /* =========================================================
       視角 A：本壘後方（圖二）
       ========================================================= */
    drawBehind(s) {
      const { ctx, W, H } = this;
      const b = s.ball;
      // 鏡頭跟著球往上仰
      let want = 0;
      if (b && s.phase !== 'betting') {
        const f0 = 1.27 * H, hy0 = 0.512 * H;
        const sy = hy0 + f0 * (4 - b.z) / Math.max(1, b.y + 10);
        want = Math.max(0, H * 0.18 - sy);
      }
      this.tilt += (want - this.tilt) * 0.12;
      const f = 1.27 * H, hy = 0.512 * H + this.tilt, camY = -10, camZ = 4;
      const Pp = (x, y, z = 0) => {
        const dy = Math.max(0.8, y - camY);
        return [W / 2 + (f * x) / dy, hy + (f * (camZ - z)) / dy];
      };
      const poly = (pts, fill) => {
        ctx.beginPath();
        pts.forEach((p, i) => { const q = Pp(...p); i ? ctx.lineTo(...q) : ctx.moveTo(...q); });
        ctx.closePath();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      };

      // 天空／巨蛋
      const sky = ctx.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, C.sky1); sky.addColorStop(1, C.sky2);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(120,135,150,.28)'; ctx.lineWidth = 1.2;
      for (let i = 1; i <= 5; i++) {
        ctx.beginPath(); ctx.ellipse(W / 2, hy - H * 0.12 + i * 6, W * (0.2 + i * 0.16), H * (0.08 + i * 0.12), 0, Math.PI, 0); ctx.stroke();
      }
      for (let i = -6; i <= 6; i++) {
        ctx.beginPath(); ctx.moveTo(W / 2 + i * W * 0.03, hy - H * 0.9); ctx.quadraticCurveTo(W / 2 + i * W * 0.12, hy - H * 0.3, W / 2 + i * W * 0.2, hy); ctx.stroke();
      }

      // 看台
      const standPts = [];
      for (let a = -70; a <= 70; a += 2) standPts.push([...polar(fenceAt(Math.max(-45, Math.min(45, a))) + 60, a), 32]);
      for (let a = 70; a >= -70; a -= 2) standPts.push([...polar(fenceAt(Math.max(-45, Math.min(45, a))) + 1, a), 3.5]);
      poly(standPts); ctx.fillStyle = this.crowd; ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fill();
      // 看台分層走道
      ctx.strokeStyle = 'rgba(210,220,228,.8)'; ctx.lineWidth = 2;
      [12, 22].forEach(z => {
        ctx.beginPath();
        for (let a = -70; a <= 70; a += 2) {
          const k = (z - 3.5) / 28.5;
          const q = Pp(...polar(fenceAt(Math.max(-45, Math.min(45, a))) + 1 + 59 * k, a), z);
          a === -70 ? ctx.moveTo(...q) : ctx.lineTo(...q);
        }
        ctx.stroke();
      });
      // 屋簷
      ctx.beginPath();
      for (let a = -70; a <= 70; a += 2) { const q = Pp(...polar(fenceAt(Math.max(-45, Math.min(45, a))) + 60, a), 32); a === -70 ? ctx.moveTo(...q) : ctx.lineTo(...q); }
      ctx.lineWidth = Math.max(4, H * 0.02); ctx.strokeStyle = '#b7c1ca'; ctx.stroke();

      // 記分板
      const sb = [Pp(-20, 182, 52), Pp(20, 182, 52), Pp(20, 182, 30), Pp(-20, 182, 30)];
      ctx.fillStyle = '#0d4a3f';
      ctx.beginPath(); sb.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#08302a'; ctx.lineWidth = 2; ctx.stroke();
      const sbw = sb[1][0] - sb[0][0], sbh = sb[3][1] - sb[0][1];
      ctx.fillStyle = '#8fd0d6';
      ctx.fillRect(sb[0][0] + sbw * 0.04, sb[0][1] + sbh * 0.1, sbw * 0.22, sbh * 0.5);
      ctx.fillRect(sb[0][0] + sbw * 0.74, sb[0][1] + sbh * 0.1, sbw * 0.22, sbh * 0.5);
      ctx.fillStyle = '#1b5fa8';
      ctx.fillRect(sb[0][0] + sbw * 0.3, sb[0][1] + sbh * 0.12, sbw * 0.4, sbh * 0.46);
      ctx.fillStyle = '#ffe27a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.max(8, sbh * 0.26)}px system-ui, sans-serif`;
      ctx.fillText(s.scoreboard || 'HOME RUN', sb[0][0] + sbw / 2, sb[0][1] + sbh * 0.35);
      ctx.fillStyle = '#cfe'; ctx.font = `700 ${Math.max(7, sbh * 0.16)}px system-ui, sans-serif`;
      ctx.fillText('LF 110  ·  CF 122  ·  RF 114', sb[0][0] + sbw / 2, sb[0][1] + sbh * 0.8);

      // 地面（整片草地）＋ 條紋
      ctx.fillStyle = C.grassDark;
      ctx.fillRect(0, Pp(0, 300, 0)[1], W, H);
      const ground = [];
      for (let a = -80; a <= 80; a += 2) ground.push([...polar(fenceAt(Math.max(-45, Math.min(45, a))), a), 0]);
      ground.push([60, -9, 0], [-60, -9, 0]);
      ctx.save(); poly(ground); ctx.clip();
      ctx.fillStyle = C.grass1; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = C.grass2;
      for (let k = -4; k < 30; k += 2) poly([[-200, k * 6, 0], [200, k * 6, 0], [200, (k + 1) * 6, 0], [-200, (k + 1) * 6, 0]], C.grass2);
      ctx.restore();

      // 全壘打牆（綠色牆面 + 黃色牆頂 + 牆距）
      const wallTop = [], wallBot = [];
      for (let a = -60; a <= 60; a += 1) {
        const d = fenceAt(Math.max(-45, Math.min(45, a)));
        wallTop.push([...polar(d, a), 3.5]); wallBot.push([...polar(d, a), 0]);
      }
      poly([...wallTop, ...wallBot.slice().reverse()], C.wall);
      ctx.beginPath(); wallTop.forEach((p, i) => { const q = Pp(...p); i ? ctx.lineTo(...q) : ctx.moveTo(...q); });
      ctx.strokeStyle = C.wallTop; ctx.lineWidth = 2; ctx.stroke();
      FIELDS.forEach(fd => {
        const mid = (fd.from + fd.to) / 2;
        const [x, y] = Pp(...polar(fd.fence * 10, mid), 1.8);
        const active = s.phase !== 'betting' && s.field === fd.key;
        ctx.font = `800 ${Math.max(9, H * 0.032)}px system-ui, sans-serif`;
        ctx.fillStyle = active ? '#ffe27a' : '#fff';
        ctx.fillText(`${fd.fence * 10}`, x, y);
      });

      // 內野紅土
      const dirt = [[...polar(-4, 0), 0], [...polar(38.9, -45), 0]];
      for (let a = -45; a <= 45; a += 3) { const [x, y] = polar(29, a * 1.6); dirt.push([x, y + 18.4, 0]); }
      dirt.push([...polar(38.9, 45), 0]);
      poly(dirt, C.dirt);
      poly([[0, 3.5, 0], [16.5, 19.4, 0], [0, 35.5, 0], [-16.5, 19.4, 0]], C.grass2);
      const circle = (cx, cy, r, fill) => { const pts = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0]); } poly(pts, fill); };
      circle(0, 18.4, 2.8, C.dirt);
      circle(0, 0, 4.2, C.dirt);

      // 邊線、打擊區、壘包
      ctx.strokeStyle = C.line; ctx.lineWidth = 2;
      [-45, 45].forEach(a => { ctx.beginPath(); ctx.moveTo(...Pp(0, 0)); ctx.lineTo(...Pp(...polar(fenceAt(a), a))); ctx.stroke(); });
      [[-1.9, -0.9, 1.2, 1.8], [0.7, -0.9, 1.2, 1.8]].forEach(([x, y, w, h]) => poly([[x, y, 0], [x + w, y, 0], [x + w, y + h, 0], [x, y + h, 0]]) || ctx.stroke());
      poly([[-0.22, 0, 0], [0.22, 0, 0], [0.22, 0.22, 0], [0, 0.44, 0], [-0.22, 0.22, 0]], '#fff');
      [[19.4, 19.4], [0, 38.8], [-19.4, 19.4]].forEach(([x, y]) => poly([[x - 0.4, y, 0], [x, y + 0.4, 0], [x + 0.4, y, 0], [x, y - 0.4, 0]], '#fff'));
      poly([[-0.3, 18.2, 0], [0.3, 18.2, 0], [0.3, 18.35, 0], [-0.3, 18.35, 0]], '#fff');

      // 守備員（遠的先畫）
      this.fielders
        .map((fd, i) => ({ fd, i }))
        .sort((a, b2) => b2.fd.pos[1] - a.fd.pos[1])
        .forEach(({ fd, i }) => {
          if (i === 1) return;
          const [x, y] = Pp(fd.pos[0], fd.pos[1], 0);
          const dy = Math.max(0.8, fd.pos[1] + 10);
          const hgt = (f * 1.8) / dy;
          ctx.fillStyle = 'rgba(0,0,0,.25)';
          ctx.beginPath(); ctx.ellipse(x, y, hgt * 0.3, hgt * 0.08, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#eef2f5'; ctx.fillRect(x - hgt * 0.14, y - hgt * 0.45, hgt * 0.28, hgt * 0.45);
          ctx.fillStyle = C.jersey; ctx.fillRect(x - hgt * 0.16, y - hgt * 0.8, hgt * 0.32, hgt * 0.38);
          this.dot([x, y - hgt * 0.9], hgt * 0.12, '#f1c9a5');
          ctx.fillStyle = C.jersey; ctx.fillRect(x - hgt * 0.13, y - hgt * 1.0, hgt * 0.26, hgt * 0.07);
        });

      // 球 + 影子
      if (b && s.phase !== 'betting') {
        const [sx, sy] = Pp(b.x, b.y, 0);
        const dy = Math.max(0.8, b.y + 10);
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.beginPath(); ctx.ellipse(sx, sy, (f * 0.5) / dy, (f * 0.18) / dy, 0, 0, Math.PI * 2); ctx.fill();
        const [bx, by] = Pp(b.x, b.y, b.z);
        this.ball(bx, by, Math.max(2.5, (f * 0.55) / dy));
      }
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
  global.FieldMath = { heightAt, polar, fenceAt, SWITCH_M };
})(window);
