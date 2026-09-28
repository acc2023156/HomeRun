/*
 * 全壘打大賽引擎（不碰 DOM）
 * 回合狀態機：betting → running（球在飛）→ crashed（接殺或全壘打）→ betting ...
 * 倍數 = 飛行距離(m) / 10；飛過全壘打牆 = 牆距倍數 × 2，本局結束。
 */
(function (global) {
  'use strict';

  const CFG = {
    BET_MS: 7000,          // 下注階段長度
    CRASH_PAUSE_MS: 5000,  // 結果停留（接殺／全壘打慶祝）
    GROWTH: Math.log(12.2) / 12000, // m(t) = e^(GROWTH * ms)，約 12 秒飛到中外野牆
    RTP: 0.985,            // 返還率 98.5%
    DECAY_START: 6,        // 60 m 之後彈道開始下墜
    DECAY_K: 2,            // 下墜曲線陡度
    ACCOUNT_COUNT: 100,
    START_BALANCE: 1000,
    MIN_BET: 0.1,
    SALT: 'homerun',
    STORE_KEY: 'homerun.v1',
  };

  const multAt = ms => Math.exp(CFG.GROWTH * Math.max(0, ms));
  const timeFor = m => Math.log(m) / CFG.GROWTH;
  const floor2 = v => Math.floor(v * 100 + 1e-9) / 100;
  const round2 = v => Math.round(v * 100) / 100;
  const randIn = ([a, b], rnd = Math.random) => a + (b - a) * rnd();

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(a);
    else for (let i = 0; i < bytes; i++) a[i] = (Math.random() * 256) | 0;
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  /* 外野切三等分，牆距（倍數 = 公尺 / 10） */
  const FIELDS = [
    { key: 'LF', name: '左外野', fence: 11.0, from: -45, to: -15 },
    { key: 'CF', name: '中外野', fence: 12.2, from: -15, to: 15 },
    { key: 'RF', name: '右外野', fence: 11.4, from: 15, to: 45 },
  ];

  /* 存活函數：球飛到 x 倍（x*10 公尺）還沒落地的機率。
     60 m 內 = R/x（和原本 Crash 相同），之後乘上下墜係數 g，到牆邊剛好剩一半，
     使「押全壘打」的期望值 2H × S(H) = R；任何策略的期望值都 ≤ R。 */
  function survival(x, H) {
    const x0 = CFG.DECAY_START;
    const g = x <= x0 ? 1 : 1 - 0.5 * Math.pow((x - x0) / (H - x0), CFG.DECAY_K);
    return CFG.RTP * g / x;
  }

  /* 公平性：結果 = f(SHA256(seed:salt:roundId))。前 52 bits 決定距離（同原本 Crash），
     接下來 32 bits 決定擊球方向；回合開始前公開 SHA256(seed)，結束後公開 seed */
  function outcomeFromSeed(seed, roundId) {
    const h = global.sha256(seed + ':' + CFG.SALT + ':' + roundId);
    const u = 1 - parseInt(h.slice(0, 13), 16) / 4503599627370496; // (0, 1]
    const v = parseInt(h.slice(13, 21), 16) / 4294967296;           // [0, 1)
    const sector = Math.min(2, Math.floor(v * 3));
    const f = FIELDS[sector];
    const angle = f.from + (v * 3 - sector) * (f.to - f.from);
    const H = f.fence;
    let dist, homer = false;
    if (u <= CFG.RTP / (2 * H)) {
      homer = true;
      dist = H;
    } else if (u > CFG.RTP / CFG.DECAY_START) {
      dist = Math.max(1, floor2(CFG.RTP / u));
    } else {
      let lo = CFG.DECAY_START, hi = H;
      for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (survival(mid, H) > u) lo = mid; else hi = mid; }
      dist = Math.min(floor2(lo), round2(H - 0.01));
    }
    return { dist, homer, fence: H, field: f.key, angle, payout: homer ? round2(2 * H) : dist };
  }

  /* ---------- 100 個暫代帳號 ---------- */
  const STYLES = {
    safe:   { label: '保守', w: 0.36, target: [1.05, 1.6], pct: [0.05, 0.15] },
    normal: { label: '穩健', w: 0.34, target: [1.5, 3],    pct: [0.02, 0.08] },
    risky:  { label: '冒險', w: 0.18, target: [2.5, 5.8],  pct: [0.01, 0.05] },
    homer:  { label: '全壘打', w: 0.12, target: [99, 99],  pct: [0.005, 0.02] },
  };
  const NAME_A = ['Wolf', 'Luna', 'Tiger', 'Neo', 'Ace', 'Kira', 'Mochi', 'Dragon', 'Shadow', 'Pixel',
    'Nova', 'Blaze', 'Zen', 'Rex', 'Echo', 'Frost', 'Jade', 'Orca', 'Viper', 'Sky', 'Bubu', 'Kai', 'Momo', 'Ryu'];
  const NAME_B = ['', '', '_tw', 'x', 'King', 'Pro', 'Z', '_88', 'San', 'GG', 'Lin', 'Chen'];

  function makeAccounts() {
    const rnd = mulberry32(926);
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const used = new Set();
    const list = [];
    for (let i = 0; i < CFG.ACCOUNT_COUNT; i++) {
      let name;
      do {
        name = pick(NAME_A) + pick(NAME_B) + (rnd() < 0.6 ? Math.floor(rnd() * 1000) : '');
      } while (used.has(name));
      used.add(name);
      let x = rnd(), style = 'safe';
      for (const [k, s] of Object.entries(STYLES)) { if ((x -= s.w) < 0) { style = k; break; } }
      list.push({
        id: 'bot' + String(i + 1).padStart(3, '0'),
        name,
        hidden: rnd() < 0.25,
        style,
        color: `hsl(${Math.floor(rnd() * 360)} 65% 58%)`,
        balance: round2(500 + rnd() * 9500),
        rounds: 0, wins: 0, profit: 0, refills: 0,
      });
    }
    return list;
  }

  function niceAmount(v) {
    if (v >= 100) return Math.round(v);
    if (v >= 10) return Math.round(v * 10) / 10;
    return Math.max(CFG.MIN_BET, round2(v));
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  class Engine {
    constructor(store) {
      this.store = store || null;
      this.listeners = {};
      this.accounts = makeAccounts();
      this.player = { id: 'you', name: '你', color: '#00e701', balance: CFG.START_BALANCE, rounds: 0, wins: 0, profit: 0, history: [] };
      this.settings = { botMin: 5, botMax: 60 };
      this.history = [];
      this.roundId = 0;
      this.round = null;
      this.queued = null;
      this.auto = { on: false };
      this.load();
    }

    on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
    emit(ev, d) { (this.listeners[ev] || []).forEach(f => f(d)); }
    fail(msg) { this.emit('toast', { msg, type: 'err' }); return false; }

    start(now) { this.newRound(now); }

    myBet() { return this.round ? this.round.bets.find(b => b.isPlayer) : null; }

    newRound(now) {
      const id = ++this.roundId;
      const seed = randomHex(32);
      const o = outcomeFromSeed(seed, id);
      // crash = 球停下（接殺）或飛過牆時的距離倍數；payout = 全壘打時的派彩倍數（2H）
      const r = { id, seed, hash: global.sha256(seed), crash: o.dist, homer: o.homer, fence: o.fence, field: o.field, angle: o.angle, payout: o.payout, phase: 'betting', phaseStart: now, bets: [], pending: [] };
      this.round = r;

      const lo = Math.min(this.settings.botMin, this.settings.botMax);
      const hi = Math.max(this.settings.botMin, this.settings.botMax);
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      shuffle(this.accounts.slice()).slice(0, n).forEach(acc => {
        if (acc.balance < 1) { acc.balance = CFG.START_BALANCE; acc.refills++; }
        const st = STYLES[acc.style];
        const amount = Math.min(acc.balance, niceAmount(acc.balance * randIn(st.pct)));
        const target = randIn(st.target);
        r.pending.push({ acc, at: Math.random() * (CFG.BET_MS - 800), amount, target: Math.max(1.01, floor2(target)) });
      });
      r.pending.sort((a, b) => a.at - b.at);
      this.emit('round', r);

      if (this.auto.on) {
        if (!this.placeBet(this.auto.amount, this.auto.target)) this.stopAuto('餘額不足，自動投注已停止');
      } else if (this.queued) {
        const q = this.queued;
        this.queued = null;
        this.placeBet(q.amount, q.target);
      }
      this.emit('queue');
    }

    joinBot(p) {
      const bet = { isPlayer: false, acc: p.acc, name: p.acc.name, hidden: p.acc.hidden, amount: p.amount, target: p.target, cashedAt: null, payout: 0 };
      p.acc.balance = round2(p.acc.balance - p.amount);
      this.round.bets.push(bet);
      this.emit('bet', bet);
    }

    placeBet(amount, target) {
      amount = round2(+amount);
      target = +target >= 1.01 ? floor2(+target) : null;
      if (!(amount >= CFG.MIN_BET)) return this.fail('下注金額最少 ' + CFG.MIN_BET);
      if (amount > this.player.balance) return this.fail('餘額不足');
      const r = this.round;
      if (r.phase !== 'betting') {
        this.queued = { amount, target };
        this.emit('queue');
        return true;
      }
      if (this.myBet()) return false;
      const bet = { isPlayer: true, acc: this.player, name: '你', hidden: false, amount, target, cashedAt: null, payout: 0 };
      this.player.balance = round2(this.player.balance - amount);
      r.bets.push(bet);
      this.emit('bet', bet);
      this.emit('balance');
      this.save();
      return true;
    }

    cancelBet() {
      if (this.queued) { this.queued = null; this.emit('queue'); return; }
      const r = this.round, bet = this.myBet();
      if (r.phase !== 'betting' || !bet) return;
      r.bets.splice(r.bets.indexOf(bet), 1);
      this.player.balance = round2(this.player.balance + bet.amount);
      this.emit('bet', null);
      this.emit('balance');
      this.save();
    }

    cashOut(now) {
      this.tick(now);
      const r = this.round, bet = this.myBet();
      if (r.phase !== 'running' || !bet || bet.cashedAt) return;
      const m = floor2(multAt(now - r.phaseStart));
      if (m >= r.crash) return;
      this.settleCash(bet, Math.max(1, m));
    }

    settleCash(bet, m, homer) {
      bet.cashedAt = m;
      bet.homer = !!homer;
      bet.payout = round2(bet.amount * m);
      bet.acc.balance = round2(bet.acc.balance + bet.payout);
      this.emit('cashout', bet);
      if (bet.isPlayer) { this.emit('balance'); this.save(); }
    }

    tick(now) {
      const r = this.round;
      const el = now - r.phaseStart;
      if (r.phase === 'betting') {
        while (r.pending.length && r.pending[0].at <= el) this.joinBot(r.pending.shift());
        if (el >= CFG.BET_MS) {
          while (r.pending.length) this.joinBot(r.pending.shift());
          r.phase = 'running';
          r.phaseStart = now;
          this.emit('run', r);
          this.tick(now);
        }
      } else if (r.phase === 'running') {
        const m = multAt(el);
        const reach = Math.min(m, r.crash);
        // 依目標倍數由小到大結算，自動兌現恰好等於落點也算成功；目標 ≥ 牆距的只等全壘打
        r.bets
          .filter(b => !b.cashedAt && b.target && b.target <= reach && b.target < r.fence)
          .sort((a, b) => a.target - b.target)
          .forEach(b => this.settleCash(b, b.target));
        if (m >= r.crash) {
          if (r.homer) r.bets.filter(b => !b.cashedAt).forEach(b => this.settleCash(b, r.payout, true));
          this.crash(now);
        }
      } else if (el >= CFG.CRASH_PAUSE_MS) {
        this.newRound(now);
      }
    }

    crash(now) {
      const r = this.round;
      r.phase = 'crashed';
      r.phaseStart = now;
      for (const b of r.bets) {
        const a = b.acc;
        a.rounds++;
        if (b.cashedAt) { a.wins++; a.profit = round2(a.profit + b.payout - b.amount); }
        else a.profit = round2(a.profit - b.amount);
      }
      const mine = this.myBet();
      if (mine) {
        this.player.history.unshift({ id: r.id, amount: mine.amount, target: mine.target, cashedAt: mine.cashedAt, crash: r.crash, homer: r.homer, field: r.field, profit: round2((mine.cashedAt ? mine.payout : 0) - mine.amount) });
        this.player.history.length = Math.min(this.player.history.length, 100);
      }
      this.history.unshift({ id: r.id, crash: r.crash, homer: r.homer, payout: r.payout, field: r.field, seed: r.seed, hash: r.hash });
      this.history.length = Math.min(this.history.length, 60);

      const a = this.auto;
      if (a.on && mine) {
        const won = !!mine.cashedAt;
        const pct = won ? a.winPct : a.lossPct;
        a.amount = pct ? Math.max(CFG.MIN_BET, round2(a.amount * (1 + pct / 100))) : a.base;
        if (a.remaining > 0 && --a.remaining === 0) this.stopAuto('自動投注完成');
      }
      this.emit('crash', r);
      this.emit('balance');
      this.save();
    }

    startAuto({ amount, target, count, winPct, lossPct }) {
      amount = round2(+amount);
      target = +target;
      if (!(target >= 1.01)) return this.fail('自動投注需設定兌現倍數 ≥ 1.01（押全壘打可按「HR」）');
      if (!(amount >= CFG.MIN_BET)) return this.fail('下注金額最少 ' + CFG.MIN_BET);
      if (amount > this.player.balance) return this.fail('餘額不足');
      this.queued = null;
      this.auto = { on: true, base: amount, amount, target: floor2(target), remaining: Math.max(0, count | 0), winPct: +winPct || 0, lossPct: +lossPct || 0 };
      if (this.round.phase === 'betting' && !this.myBet()) this.placeBet(amount, target);
      this.emit('auto');
      return true;
    }

    stopAuto(msg) {
      this.auto.on = false;
      this.emit('auto');
      if (msg) this.emit('toast', { msg, type: 'info' });
    }

    setBotRange(min, max) {
      this.settings.botMin = Math.max(0, Math.min(CFG.ACCOUNT_COUNT, min | 0));
      this.settings.botMax = Math.max(0, Math.min(CFG.ACCOUNT_COUNT, max | 0));
      this.save();
    }

    save() {
      if (!this.store) return;
      try {
        const p = this.player;
        this.store.setItem(CFG.STORE_KEY, JSON.stringify({
          player: { balance: p.balance, rounds: p.rounds, wins: p.wins, profit: p.profit, history: p.history.slice(0, 50) },
          bots: this.accounts.map(a => [a.id, a.balance, a.rounds, a.wins, a.profit, a.refills]),
          settings: this.settings,
          history: this.history.slice(0, 30),
          roundId: this.roundId,
        }));
      } catch (e) { /* 儲存失敗不影響遊戲 */ }
    }

    load() {
      if (!this.store) return;
      try {
        const d = JSON.parse(this.store.getItem(CFG.STORE_KEY) || 'null');
        if (!d) return;
        Object.assign(this.player, d.player);
        Object.assign(this.settings, d.settings);
        this.history = d.history || [];
        this.roundId = d.roundId || 0;
        const byId = new Map(this.accounts.map(a => [a.id, a]));
        (d.bots || []).forEach(([id, balance, rounds, wins, profit, refills]) => {
          const a = byId.get(id);
          if (a) Object.assign(a, { balance, rounds, wins, profit, refills });
        });
      } catch (e) { /* 資料損壞就用預設值 */ }
    }

    reset() {
      try { if (this.store) this.store.removeItem(CFG.STORE_KEY); } catch (e) { /* ignore */ }
    }
  }

  global.Crash = { CFG, STYLES, FIELDS, Engine, multAt, timeFor, outcomeFromSeed, survival, floor2, round2 };
})(typeof window !== 'undefined' ? window : globalThis);
