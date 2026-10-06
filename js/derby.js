/* 全壘打競賽：一局 10 球，下注前猜會打出幾支全壘打（0–10），猜中依支數倍數派彩。
   從大廳進入（網址帶 ?api=<SHA API> 與 #token=<launch token>）時由 SHA Platform 開球、GDBO 錢包結算；
   沒有 token 時為本機試玩（遊戲幣存在瀏覽器）。每球結果與伺服器同一套算法，可在「公平性驗證」重算。 */
(function (global) {
  'use strict';
  const { FIELDS } = global.Crash;
  const { polar, visScale } = global.FieldMath;
  const $ = (s) => document.querySelector(s);

  /* ---------- 規則（與 SHA-Platform apps/edge-api/src/derby.ts 相同） ---------- */
  const BALLS = 10, CHANCE = 0.4, RTP = 0.985, MAX_MULT = 2000, MAX_CHANCE = 0.97, MAX_DISTANCE = 160, MIN_BET = 1, MAX_BET = 100;
  const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); };
  const chance = (k) => binom(BALLS, k) * CHANCE ** k * (1 - CHANCE) ** (BALLS - k);
  // 玩法：剛好 k 支、k 支以上、k 支以下（同六子骰）；猜中機率超過 97% 的選項不開放
  const CONDS = { le: '以下', eq: '剛好', ge: '以上' };
  const hit = (cond, homers, k) => (cond === 'eq' ? homers === k : cond === 'ge' ? homers >= k : homers <= k);
  const winChance = (cond, k) => { let t = 0; for (let n = 0; n <= BALLS; n++) if (hit(cond, n, k)) t += chance(n); return t; };
  const multiplierOf = (cond, k) => { const c = winChance(cond, k); return c > MAX_CHANCE ? null : Math.min(MAX_MULT, Math.floor((RTP / c) * 100 + 1e-9) / 100); };
  const PAYTABLE = Object.fromEntries(Object.keys(CONDS).map((c) => [c, Array.from({ length: BALLS + 1 }, (_, k) => multiplierOf(c, k))]));
  const betText = (cond, k) => (cond === 'eq' ? `剛好 ${k} 支` : `${k} 支${CONDS[cond]}`);
  const SECTORS = [{ key: 'LF', fence: 110, from: -45, to: -15 }, { key: 'CF', fence: 122, from: -15, to: 15 }, { key: 'RF', fence: 114, from: 15, to: 45 }];

  function ballFromSeed(serverSeed, clientSeed, nonce, i) {
    const h = global.sha256(`${serverSeed}:${clientSeed}:${nonce}:derby:${i}`);
    const u = parseInt(h.slice(0, 13), 16) / 4503599627370496;
    const v = parseInt(h.slice(13, 21), 16) / 4294967296;
    const w = parseInt(h.slice(21, 29), 16) / 4294967296;
    const sector = Math.min(2, Math.floor(v * 3)), f = SECTORS[sector];
    const angle = Math.round((f.from + (0.15 + 0.7 * (v * 3 - sector)) * (f.to - f.from)) * 10) / 10;
    const homer = u < CHANCE;
    const distance = homer ? f.fence + 3 + w * (MAX_DISTANCE - f.fence - 3) : 25 + w * (f.fence - 27);
    return { homer, distance: distance.toFixed(1), angle, field: f.key, fence: f.fence };
  }
  const roundFromSeed = (seed, clientSeed, nonce) => Array.from({ length: BALLS }, (_, i) => ballFromSeed(seed, clientSeed, nonce, i));

  const cents = (v) => Math.floor(v * 100 + 1e-7) / 100;
  const fmt = (v) => Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtX = (m) => (m >= 100 ? Math.round(m).toLocaleString() : m.toFixed(2)) + '×';
  const randomHex = (bytes) => { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };

  /* ---------- 連線（大廳）或試玩 ---------- */
  const query = new URLSearchParams(location.search);
  let token = new URLSearchParams(location.hash.slice(1)).get('token');
  try {
    if (token) sessionStorage.setItem('derby.launchToken', token);
    else token = sessionStorage.getItem('derby.launchToken');
  } catch (e) { /* ignore */ }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const apiBase = (() => {
    try {
      const u = new URL(query.get('api') || 'https://sha-platform-dev.sha-platform.workers.dev/api/v1');
      return /\.workers\.dev$|^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? u.href.replace(/\/$/, '') : '';
    } catch (e) { return ''; }
  })();
  const remote = !!(token && apiBase);
  const toUnits = (coins) => String(Math.round(coins * 100) * 10);
  const fromMoney = (m) => Number(m.units) / 10 ** m.scale;

  async function api(path, body) {
    const res = await fetch(apiBase + path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}), cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = { INSUFFICIENT_FUNDS: '餘額不足', INVALID_LAUNCH_TOKEN: '登入已逾時，請回大廳重新進入', INVALID_WAGER: `每局下注 ${MIN_BET}–${MAX_BET}` };
      throw new Error(msg[data.error && data.error.code] || (data.error && data.error.message) || `連線錯誤 (${res.status})`);
    }
    return data;
  }

  const DEMO_KEY = 'derby.demo';
  const game = {
    balance: 0, commitment: null, clientSeed: randomHex(8), history: [],
    async connect() {
      if (remote) {
        const s = await api('/games/home-run-derby/session');
        this.balance = fromMoney(s.balance);
        this.commitment = s.commitment;
        return;
      }
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(DEMO_KEY)) || {}; } catch (e) { /* ignore */ }
      this.balance = Number(saved.balance) > 0 ? saved.balance : 1000;
      this.nonce = saved.nonce || 0;
      this.history = saved.history || [];
      this.newDemoSeed();
    },
    newDemoSeed() { this.demoSeed = randomHex(32); this.commitment = { id: 'demo', server_seed_hash: global.sha256(this.demoSeed) }; },
    saveDemo() { try { localStorage.setItem(DEMO_KEY, JSON.stringify({ balance: this.balance, nonce: this.nonce, history: this.history.slice(0, 30) })); } catch (e) { /* ignore */ } },
    /** 下一局：回傳 10 球、全壘打支數、派彩與公平性資料。 */
    async play(wager, cond, pick) {
      if (remote) {
        const res = await api('/games/home-run-derby/bets', {
          request_id: crypto.randomUUID(), commitment_id: this.commitment.id, client_seed: this.clientSeed,
          wager: { units: toUnits(wager), currency: 'TWD', scale: 3 }, cond, pick,
        });
        this.balance = fromMoney(res.balance);
        this.commitment = res.next_commitment;
        const o = res.outcome, f = res.fairness;
        return { balls: o.balls, homers: o.homers, cond, pick, wager, payout: fromMoney(res.payout), multiplier: Number(o.multiplier),
          seed: f.server_seed, hash: f.server_seed_hash, clientSeed: f.client_seed, nonce: Number(f.nonce), id: res.round_id };
      }
      if (wager > this.balance + 1e-9) throw new Error('餘額不足');
      const seed = this.demoSeed, hash = this.commitment.server_seed_hash, nonce = this.nonce++;
      const balls = roundFromSeed(seed, this.clientSeed, nonce);
      const homers = balls.filter((b) => b.homer).length;
      const payout = hit(cond, homers, pick) ? cents(wager * PAYTABLE[cond][pick]) : 0;
      this.balance = cents(this.balance - wager + payout);
      this.newDemoSeed();
      return { balls, homers, cond, pick, wager, payout, multiplier: PAYTABLE[cond][pick], seed, hash, clientSeed: this.clientSeed, nonce, id: `demo-${nonce}` };
    },
  };

  /* ---------- 畫面 ---------- */
  const el = {
    balance: $('#balance'), wager: $('#wager'), picks: $('#picks'), go: $('#goBtn'), skip: $('#skipBtn'), slots: $('#ballSlots'),
    ballNo: $('#ballNo'), homerCount: $('#homerCount'), pickShown: $('#pickShown'), result: $('#result'), history: $('#history'),
    toasts: $('#toasts'), soundBtn: $('#soundBtn'),
  };
  // 進場預設：4 支以上
  let cond = 'ge', pick = 4, playing = false, shownBalance = null;
  $('#modeTag').textContent = remote ? 'GD 錢包' : '試玩 · 非真錢';

  function toast(msg, type = 'info') {
    const d = document.createElement('div');
    d.className = 'toast ' + type; d.textContent = msg;
    el.toasts.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }
  const renderBalance = () => { el.balance.textContent = fmt(shownBalance ?? game.balance); };
  function renderPicks() {
    if (PAYTABLE[cond][pick] == null) pick = PAYTABLE[cond].findIndex((m) => m != null);
    $('#conds').innerHTML = Object.entries(CONDS).map(([c, name]) => `<button type="button" data-cond="${c}" class="${c === cond ? 'on' : ''}">${name}</button>`).join('');
    $('#conds').querySelectorAll('button').forEach((b) => { b.disabled = playing; b.onclick = () => { cond = b.dataset.cond; renderPicks(); }; });
    el.picks.innerHTML = PAYTABLE[cond].map((m, k) => `<button type="button" data-pick="${k}" class="${k === pick ? 'on' : ''}" ${m == null ? 'disabled' : ''}><b>${k}</b><small>${m == null ? '—' : fmtX(m)}</small></button>`).join('');
    el.picks.querySelectorAll('button').forEach((b) => { if (PAYTABLE[cond][Number(b.dataset.pick)] != null) b.disabled = playing; b.onclick = () => { pick = Number(b.dataset.pick); renderPicks(); }; });
    $('#betSummary').textContent = `猜 ${betText(cond, pick)}・${fmtX(PAYTABLE[cond][pick])}`;
  }
  function renderSlots(balls = [], upto = -1) {
    el.slots.innerHTML = Array.from({ length: BALLS }, (_, i) => {
      const b = balls[i];
      if (!b || i > upto) return `<li class="${i === upto + 1 && playing ? 'now' : ''}">${i + 1}</li>`;
      return `<li class="${b.homer ? 'hr' : 'out'}">${b.homer ? 'HR' : ''}<br>${Math.round(b.distance)}m</li>`;
    }).join('');
  }
  function readWager() {
    const v = Math.min(MAX_BET, Math.max(MIN_BET, Math.round(Number(el.wager.value) || MIN_BET)));
    el.wager.value = v;
    return v;
  }
  function lock(on) {
    playing = on;
    el.go.disabled = on;
    el.wager.disabled = on;
    document.querySelectorAll('.dy-wager button').forEach((b) => { b.disabled = on; });
    el.skip.hidden = !on;
    renderPicks();
  }
  document.querySelectorAll('.dy-wager button').forEach((b) => (b.onclick = () => {
    const v = b.dataset.set ? Number(b.dataset.set) : (Number(el.wager.value) || 0) + Number(b.dataset.step);
    el.wager.value = Math.min(MAX_BET, Math.max(MIN_BET, v));
  }));
  el.wager.addEventListener('change', readWager);

  function renderHistory() {
    el.history.innerHTML = game.history.map((h) => {
      const net = cents(h.payout - h.wager);
      return `<div class="dy-hist-row"><span>猜 ${betText(h.cond || 'eq', h.pick)}・打出 ${h.homers} 支</span><span>${fmt(h.wager)}</span><span class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${fmt(net)}</span></div>`;
    }).join('') || '<div class="empty">尚無紀錄</div>';
  }

  // 只接受自家網域的 return
  (function () {
    const ret = query.get('return');
    if (!ret) return;
    try {
      const url = new URL(ret);
      const okHost = url.hostname === 'acc2023156.github.io' || url.hostname === location.hostname || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (/^https?:$/.test(url.protocol) && okHost) $('#backBtn').href = url.href;
    } catch (e) { /* invalid */ }
  })();

  /* ---------- 玩法說明、公平性 ---------- */
  $('#payTable').insertAdjacentHTML('beforeend', Array.from({ length: BALLS + 1 }, (_, k) =>
    `<tr><td>${k} 支</td><td>${(chance(k) * 100).toFixed(k >= 9 ? 4 : 2)}%</td>${['le', 'eq', 'ge'].map((c) => `<td>${PAYTABLE[c][k] == null ? '—' : `<b>${fmtX(PAYTABLE[c][k])}</b>`}</td>`).join('')}</tr>`).join(''));
  const modal = (id) => {
    const m = $(id);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
    return m;
  };
  const rulesModal = modal('#rulesModal'), fairModal = modal('#fairModal');
  $('#rulesBtn').onclick = () => { rulesModal.hidden = false; };
  $('#fairBtn').onclick = () => {
    $('#fairCurrent').innerHTML = `下一局伺服器種子 hash：<br><code>${game.commitment ? game.commitment.server_seed_hash : '-'}</code><br>客戶種子：<code>${game.clientSeed}</code>`;
    const list = $('#fairList');
    list.innerHTML = game.history.map((h, i) => `<details data-i="${i}"><summary><span>猜 ${betText(h.cond || 'eq', h.pick)}・打出 ${h.homers} 支</span><b>${h.payout > 0 ? '+' + fmt(h.payout) : '未中'}</b></summary>
      <div class="kv">hash：<code>${h.hash}</code></div><div class="kv">seed：<code>${h.seed}</code></div><div class="kv">客戶種子：<code>${h.clientSeed}</code>・nonce：${h.nonce}</div><div class="kv verify"></div></details>`).join('') || '<div class="empty">尚無已結束的局</div>';
    list.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => {
      if (!d.open) return;
      const h = game.history[Number(d.dataset.i)];
      const hashOk = global.sha256(h.seed) === h.hash;
      const balls = roundFromSeed(h.seed, h.clientSeed, h.nonce);
      const same = balls.every((b, i) => b.homer === h.balls[i].homer && b.distance === h.balls[i].distance);
      const homers = balls.filter((b) => b.homer).length;
      d.querySelector('.verify').innerHTML = `重新計算：SHA256(seed) ${hashOk ? '<span class="ok">相符 ✓</span>' : '<span class="neg">不符 ✗</span>'}，10 球 ${same ? '<span class="ok">相同 ✓</span>' : '<span class="neg">不同 ✗</span>'}（全壘打 ${homers} 支）`;
    }));
    fairModal.hidden = false;
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { rulesModal.hidden = true; fairModal.hidden = true; } });

  /* ---------- 音效 ---------- */
  const renderSound = () => { el.soundBtn.textContent = Sound.enabled ? '🔊' : '🔇'; el.soundBtn.classList.toggle('off', !Sound.enabled); };
  el.soundBtn.onclick = () => { Sound.toggle(); Sound.unlock(); renderSound(); };
  document.addEventListener('pointerdown', () => Sound.unlock(), { once: true, capture: true });
  renderSound();

  /* ---------- 球場動畫 ---------- */
  const cv = $('#chart');
  const field = new FieldRenderer(cv);
  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    field.resize(r.width, r.height, Math.min(2, devicePixelRatio || 1));
    field.bottomReserve = 8;
  }
  new ResizeObserver(resize).observe(cv.parentElement);
  resize();

  const state = { derby: true, roundId: 0, phase: 'betting', betLeft: -1, ball: null, field: null, celebrate: false, marks: [], trail: [], trailHomer: false };
  let anim = null; // { balls, i, stage, t0, ... }
  const PITCH_FIRST = 1500, PITCH_NEXT = 750;

  function flightOf(b) {
    const d = Number(b.distance);
    return { d, angle: b.angle, fence: b.fence, peak: 8 + d * 0.32, ms: 1300 + d * 9 };
  }
  // 畫面上的距離：牆前 15 公尺以內照實際，之後平滑地逐漸收斂（tanh），最遠 160 公尺也留在看台內，
  // 而且沒有轉折，球不會像撞到牆一樣突然變慢（顯示的公尺數不變）
  const KNEE = 15, SPAN = 28;
  const shownOf = (h, fence) => (h <= fence - KNEE ? h : fence - KNEE + SPAN * Math.tanh((h - fence + KNEE) / SPAN));
  function ballAt(fl, t) {
    // 拋物線：水平等速、高度 = 4·頂點·t·(1−t)
    const horiz = fl.d * t;
    const [x, y] = polar(shownOf(horiz, fl.fence) * visScale(fl.angle), fl.angle);
    return { x, y, z: fl.peak * 4 * t * (1 - t) + (1 - t), d: horiz, label: horiz };
  }

  function startBall(now) {
    const a = anim;
    state.roundId += 1;
    state.phase = 'betting';
    state.ball = null;
    state.field = a.balls[a.i].field;
    state.celebrate = false;
    state.trail = [];
    a.t0 = now;
    a.stage = 'pitch';
    if (a.i === 0) {
      // 開場：本壘後方看投手投球（號角聲），之後每球都留在上視角
      field.setView('behind', now);
      a.pitchMs = PITCH_FIRST;
      Sound.calvary();
    } else {
      a.pitchMs = PITCH_NEXT;
    }
    el.ballNo.textContent = a.i + 1;
    renderSlots(a.balls, a.i - 1);
  }

  function frame(now) {
    const a = anim;
    if (a) {
      if (a.stage === 'pitch') {
        state.betLeft = Math.max(0, a.pitchMs - (now - a.t0));
        if (state.betLeft <= 0) {
          a.stage = 'flight'; a.t0 = now; a.fl = flightOf(a.balls[a.i]);
          state.phase = 'running'; state.flightT = 0; state.trailHomer = a.balls[a.i].homer;
          if (a.i === 0) { field.setView('top', now); Sound.swoosh(); }
          Sound.hit();
        }
      } else if (a.stage === 'flight') {
        const t = Math.min(1, (now - a.t0) / a.fl.ms);
        state.ball = ballAt(a.fl, t);
        if (!state.trail.length || t - a.lastTrail > 0.02) { state.trail.push({ x: state.ball.x, y: state.ball.y, z: state.ball.z }); a.lastTrail = t; }
        if (t >= 1) land(now);
      } else if (a.stage === 'pause' && now - a.t0 >= a.pauseMs) {
        a.i += 1;
        if (a.i < BALLS) startBall(now); else finish();
      }
    }
    field.render(state, now);
    requestAnimationFrame(frame);
  }

  function land(now) {
    const a = anim, b = a.balls[a.i];
    state.marks.push({ x: state.ball.x, y: state.ball.y, homer: b.homer, label: `${Math.round(Number(b.distance))}m` });
    state.ball.label = Number(b.distance);
    if (b.homer) {
      a.homers += 1;
      state.celebrate = true;
      field.startFireworks(now);
      Sound.homer();
    } else {
      Sound.crash();
    }
    el.homerCount.textContent = a.homers;
    renderSlots(a.balls, a.i);
    a.stage = 'pause'; a.t0 = now; a.pauseMs = b.homer ? 1300 : 700;
  }

  function finish() {
    const r = anim.round;
    anim = null;
    state.phase = 'betting'; state.betLeft = -1; state.ball = null;
    renderSlots(r.balls, BALLS - 1);
    el.homerCount.textContent = r.homers;
    el.result.hidden = false;
    el.result.className = 'dy-result' + (r.payout > 0 ? '' : ' lose');
    el.result.innerHTML = r.payout > 0
      ? `打出 ${r.homers} 支・猜 ${betText(r.cond, r.pick)} 猜中！<b>+${fmt(r.payout)}</b>${fmtX(r.multiplier)}`
      : `打出 ${r.homers} 支・猜 ${betText(r.cond, r.pick)}<b>沒猜中</b>`;
    if (r.payout > 0) Sound.win(); else Sound.lose();
    shownBalance = null;
    renderBalance();
    game.history.unshift(r);
    game.history.length = Math.min(game.history.length, 30);
    if (!remote) game.saveDemo();
    renderHistory();
    lock(false);
  }

  // 跳過動畫：剩下的球直接標上落點
  el.skip.onclick = () => {
    const a = anim;
    if (!a) return;
    for (let i = a.i + (a.stage === 'pause' ? 1 : 0); i < BALLS; i++) {
      const b = a.balls[i], fl = flightOf(b), p = ballAt(fl, 1);
      if (!(i === a.i && a.stage === 'pause')) state.marks.push({ x: p.x, y: p.y, homer: b.homer, label: `${Math.round(Number(b.distance))}m` });
    }
    field.setView('top', performance.now());
    finish();
  };

  el.go.onclick = async () => {
    if (playing) return;
    Sound.unlock();
    const wager = readWager();
    if (wager > game.balance + 1e-9) return toast('餘額不足', 'err');
    lock(true);
    el.result.hidden = true;
    state.marks = []; state.trail = [];
    el.pickShown.textContent = betText(cond, pick);
    el.homerCount.textContent = 0;
    shownBalance = cents(game.balance - wager);
    renderBalance();
    try {
      const round = await game.play(wager, cond, pick);
      anim = { round, balls: round.balls, i: 0, homers: 0 };
      startBall(performance.now());
    } catch (e) {
      shownBalance = null; renderBalance();
      lock(false);
      toast(e.message, 'err');
    }
  };

  /* ---------- 開始 ---------- */
  renderPicks();
  renderSlots();
  renderHistory();
  requestAnimationFrame(frame);
  game.connect()
    .then(() => { renderBalance(); renderHistory(); })
    .catch((e) => { toast(`無法連接遊戲伺服器：${e.message}`, 'err'); el.go.disabled = true; });
})(window);
