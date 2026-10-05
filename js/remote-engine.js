/* 從大廳（GDBO）進入時使用 SHA Platform：距離、全壘打、兌現與餘額皆由伺服器決定，餘額為會員的 GDBO 錢包。
   網址帶 ?api=<SHA API>&return=<大廳> 與 #token=<launch token>；沒有 token 時沿用本機試玩（engine.js）。
   流程與沖高高（Crash/js/remote-engine.js）相同：有下注的局向伺服器開局，擊球方向開局即公開，
   距離與是否全壘打在回合結束後由公平性證明公開；沒下注的局只是畫面示範。 */
(function (global) {
  'use strict';

  const Base = global.Crash;
  const { CFG, STYLES, multAt, floor2, round2, outcomeFromSeed } = Base;
  const query = new URLSearchParams(global.location.search);
  let token = new URLSearchParams(global.location.hash.slice(1)).get('token');
  try {
    if (token) global.sessionStorage.setItem('homerun.launchToken', token);
    else token = global.sessionStorage.getItem('homerun.launchToken');
  } catch (e) { /* ignore */ }
  if (global.location.hash) global.history.replaceState(null, '', global.location.pathname + global.location.search);
  // api 只接受 Cloudflare Workers 或本機，launch token 不會送到其他主機
  const apiBase = (() => {
    try {
      const u = new URL(query.get('api') || 'https://sha-platform-dev.sha-platform.workers.dev/api/v1');
      return /\.workers\.dev$|^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? u.href.replace(/\/$/, '') : '';
    } catch (e) { return ''; }
  })();
  if (!token || !apiBase) return;

  const toUnits = coins => String(Math.round(coins * 100) * 10);
  const fromMoney = money => Number(money.units) / 10 ** money.scale;
  // 投手開始投球（下注倒數最後 1.5 秒）時就向伺服器開局
  const EARLY_START_MS = 1500;
  const AUTO_MARGIN_MS = 40;

  // 畫面上的其他玩家（示範）：固定 100 個帳號
  function makeAccounts() {
    const styles = Object.keys(STYLES);
    return Array.from({ length: CFG.ACCOUNT_COUNT }, (_, i) => ({
      id: `bot${String(i + 1).padStart(3, '0')}`, name: `Player${String(i + 1).padStart(3, '0')}`, hidden: i % 7 === 0,
      style: styles[i % styles.length], color: `hsl(${(i * 47) % 360} 65% 58%)`, balance: 500 + ((i * 137) % 9500),
      rounds: 0, wins: 0, profit: 0, refills: 0,
    }));
  }

  class RemoteEngine {
    constructor(store) {
      this.store = store || null;
      this.listeners = {};
      this.accounts = makeAccounts();
      this.player = { id: 'you', name: '你', color: '#00e701', balance: 0, rounds: 0, wins: 0, profit: 0, history: [] };
      this.settings = { botMin: 5, botMax: 60 };
      this.history = [];
      this.roundId = 0;
      this.round = null;
      this.queued = null;
      this.auto = { on: false };
      this.commitment = null;
      this.nextPoll = 0;
      this.load();
    }

    on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
    emit(ev, d) { (this.listeners[ev] || []).forEach(f => f(d)); }
    fail(msg) { this.emit('toast', { msg, type: 'err' }); return false; }

    async api(path, body) {
      const response = await fetch(apiBase + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messages = { INSUFFICIENT_FUNDS: '餘額不足', INVALID_LAUNCH_TOKEN: '登入已逾時，請回大廳重新進入' };
        const error = new Error(messages[payload.error && payload.error.code] || (payload.error && payload.error.message) || `連線錯誤 (${response.status})`);
        error.code = payload.error && payload.error.code;
        throw error;
      }
      return payload;
    }

    async start(now) {
      this.newRound(now);
      try { await this.refreshSession(); } catch (e) { this.fail(`無法連接遊戲伺服器：${e.message}`); }
    }

    async refreshSession() {
      const session = await this.api('/games/home-run/session', {});
      this.player.balance = fromMoney(session.balance);
      this.commitment = session.commitment;
      if (this.round && this.round.phase === 'betting' && !this.round.remote) this.round.hash = this.commitment.server_seed_hash;
      this.emit('balance');
    }

    myBet() { return this.round ? this.round.bets.find(b => b.isPlayer) : null; }

    newRound(now) {
      const id = ++this.roundId;
      const r = {
        id, serverId: null, proofToken: '', hash: this.commitment ? this.commitment.server_seed_hash : '', seed: '',
        crash: Infinity, homer: false, payout: 0, field: '', angle: 0, fence: Infinity,
        phase: 'betting', phaseStart: now, bets: [], pending: [], remote: false,
      };
      this.round = r;
      const lo = Math.min(this.settings.botMin, this.settings.botMax), hi = Math.max(this.settings.botMin, this.settings.botMax);
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      for (let i = 0; i < n; i++) {
        const acc = this.accounts[(id * 13 + i * 31) % this.accounts.length];
        const st = STYLES[acc.style];
        const amount = round2(Math.max(CFG.MIN_BET, Math.min(acc.balance, acc.balance * (st.pct[0] + Math.random() * (st.pct[1] - st.pct[0])))));
        const target = Math.max(1.01, floor2(st.target[0] + Math.random() * (st.target[1] - st.target[0])));
        r.pending.push({ acc, at: Math.random() * (CFG.BET_MS - 800), amount, target });
      }
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
      this.round.bets.push(bet);
      this.emit('bet', bet);
    }

    placeBet(amount, target) {
      amount = floor2(+amount);
      target = +target >= 1.01 ? floor2(+target) : null;
      if (!(amount >= CFG.MIN_BET)) return this.fail('下注金額最少 ' + CFG.MIN_BET);
      if (amount > this.player.balance + 1e-9) return this.fail('餘額不足');
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
      return true;
    }

    cancelBet() {
      if (this.queued) { this.queued = null; this.emit('queue'); return; }
      const r = this.round, bet = this.myBet();
      if (r.phase !== 'betting' || r.launching || !bet) return;
      r.bets.splice(r.bets.indexOf(bet), 1);
      this.player.balance = round2(this.player.balance + bet.amount);
      this.emit('bet', null);
      this.emit('balance');
    }

    // 有下注：投手開始投球時就向伺服器開局（扣 GDBO 錢包），約定在下注倒數結束（擊球瞬間）才開始，
    // 伺服器回應趕在投球動畫期間回來，揮棒後直接接上飛球，不必停下來等
    async launchRemote(startInMs) {
      const r = this.round, bet = this.myBet();
      r.launching = true;
      const sentAt = performance.now();
      startInMs = Math.max(0, Math.round(startInMs));
      try {
        const res = await this.api('/games/home-run/rounds', {
          request_id: global.crypto.randomUUID(), commitment_id: this.commitment.id,
          wager: { units: toUnits(bet.amount), currency: 'TWD', scale: 3 },
          start_in_ms: startInMs
        });
        // 開始時間從送出請求時起算，不從收到回應時起算，否則揮棒後還要多等一趟網路。
        // 伺服器從收到請求起算，本機因此早了單程網路時間；兌現請求抵達時兩邊的經過時間正好相同
        r.ready = { res, startAt: sentAt + startInMs };
        this.player.balance = fromMoney(res.balance);
        this.emit('balance');
      } catch (e) {
        this.player.balance = round2(this.player.balance + bet.amount);
        r.bets.splice(r.bets.indexOf(bet), 1);
        r.launching = false;
        this.emit('balance');
        this.emit('bet', null);
        if (this.auto.on) this.stopAuto();
        this.fail(`開局失敗：${e.message}`);
      }
    }

    // 下注倒數結束：開始已向伺服器開好的回合
    startRemote(r) {
      const { res, startAt } = r.ready;
      Object.assign(r, {
        serverId: res.round.id, remote: true, hash: res.fairness.server_seed_hash, proofToken: res.fairness.proof_token,
        // 不讓飛行時間變成負數（回應晚到時從現在開始飛）
        field: res.round.field, angle: res.round.angle, fence: res.round.fence, phase: 'running', phaseStart: Math.min(startAt, performance.now()),
      });
      this.emit('run', r);
      this.nextPoll = 0;
    }

    // 沒下注：本機隨機一局當畫面示範（不計入紀錄）
    runDemo(now) {
      const r = this.round;
      const o = outcomeFromSeed(`${Date.now()}:${Math.random()}`, r.id);
      Object.assign(r, { crash: o.dist, homer: o.homer, payout: o.payout, field: o.field, angle: o.angle, fence: o.fence, phase: 'running', phaseStart: now });
      this.emit('run', r);
    }

    async pollRemote() {
      if (this.polling) return;
      this.polling = true;
      const r = this.round;
      try {
        const res = await fetch(`${apiBase}/games/home-run/rounds/${encodeURIComponent(r.serverId)}/proof`, {
          headers: { authorization: `Bearer ${r.proofToken}` }, cache: 'no-store'
        });
        const proof = await res.json();
        // 兌現請求還在路上時先不結束這局，等它的結果回來再公開
        if (proof.reveal && this.round === r && !r.cashing) this.finishRemote(proof, performance.now());
      } catch (e) {
        // 輪詢失敗不影響伺服器上的結果，下次再查
      } finally {
        this.polling = false;
      }
    }

    finishRemote(proof, now) {
      const r = this.round, rec = proof.recorded_result;
      r.seed = proof.reveal.server_seed;
      r.crash = Number(rec.crash_multiplier);
      r.homer = !!rec.homer;
      const mine = this.myBet();
      if (r.homer) {
        r.payout = Number(rec.cashed_at);
        if (mine && !mine.cashedAt) this.settleCash(mine, r.payout, true, fromMoney(rec.payout));
      } else r.payout = r.crash;
      this.crash(now);
      this.refreshSession().catch(() => {});
    }

    async cashOut() {
      const r = this.round, bet = this.myBet();
      if (r.phase !== 'running' || !r.remote || !bet || bet.cashedAt || bet.rejected || r.cashing) return;
      r.cashing = true;
      const elapsed = performance.now() - r.phaseStart;
      // 先以按下時的倍數顯示兌現，伺服器確認後更新金額與餘額；被拒絕（已落地）時撤回
      bet.pending = true;
      this.settleCash(bet, floor2(multAt(elapsed)));
      const shownPayout = bet.payout;
      try {
        const res = await this.api(`/games/home-run/rounds/${encodeURIComponent(r.serverId)}/cashout`, {
          request_id: global.crypto.randomUUID(),
          // 按下時離開局幾毫秒：伺服器以此時的倍數結算（最多補償 300ms 網路延遲）
          elapsed_ms: Math.round(elapsed)
        });
        this.commitment = res.next_commitment;
        bet.cashedAt = Number(res.round.cashed_at);
        bet.payout = fromMoney(res.round.payout);
        this.player.balance = fromMoney(res.balance);
        bet.pending = false;
        this.emit('cashout-confirm', bet);
        this.emit('balance');
      } catch (e) {
        bet.cashedAt = null;
        bet.payout = 0;
        bet.pending = false;
        this.player.balance = round2(this.player.balance - shownPayout);
        this.emit('cashout-undo', bet);
        this.emit('balance');
        // 球已落地就不再重送；其他錯誤（例如網路）1 秒後才允許自動兌現再試，避免每格畫面重送
        if (e.code === 'ROUND_CRASHED' || e.code === 'ROUND_FINISHED') { bet.rejected = true; this.fail('來不及兌現，球已落地'); this.pollRemote(); }
        else { bet.retryAt = performance.now() + 1000; this.fail(`兌現失敗：${e.message}`); }
      } finally {
        r.cashing = false;
      }
    }

    settleCash(bet, m, homer, payout) {
      bet.cashedAt = m;
      bet.homer = !!homer;
      bet.payout = payout ?? round2(bet.amount * m);
      if (bet.isPlayer) { this.player.balance = round2(this.player.balance + bet.payout); this.emit('balance'); }
      this.emit('cashout', bet);
    }

    tick(now) {
      const r = this.round;
      if (!r) return;
      const el = now - r.phaseStart;
      if (r.phase === 'betting') {
        while (r.pending.length && r.pending[0].at <= el) this.joinBot(r.pending.shift());
        if (!r.launching && this.myBet() && this.commitment && el >= CFG.BET_MS - EARLY_START_MS) this.launchRemote(CFG.BET_MS - el);
        // 伺服器還沒回應時停在擊球前一刻等（網路很慢時才會發生）
        if (el >= CFG.BET_MS && (!r.launching || r.ready)) {
          while (r.pending.length) this.joinBot(r.pending.shift());
          if (r.ready) this.startRemote(r);
          else this.runDemo(now);
        }
      } else if (r.phase === 'running') {
        const m = multAt(el);
        const reach = Math.min(m, r.crash);
        // 目標 ≥ 牆距的只等全壘打
        r.bets.filter(b => !b.isPlayer && !b.cashedAt && b.target <= reach && b.target < r.fence)
          .forEach(b => this.settleCash(b, b.target));
        const mine = this.myBet();
        if (r.remote) {
          // 自動兌現晚 40ms 才送，網路抖動時伺服器結算的倍數仍不低於目標
          if (mine && mine.target && !mine.cashedAt && !(mine.retryAt > now) && mine.target < r.fence && floor2(multAt(el - AUTO_MARGIN_MS)) >= mine.target) this.cashOut();
          if (now >= this.nextPoll) { this.nextPoll = now + 250; this.pollRemote(); }
        } else if (m >= r.crash) {
          if (r.homer) r.bets.filter(b => !b.cashedAt).forEach(b => this.settleCash(b, r.payout, true));
          this.crash(now);
        }
      } else if (r.phase === 'crashed' && el >= CFG.CRASH_PAUSE_MS) {
        this.newRound(now);
      }
    }

    crash(now) {
      const r = this.round;
      if (r.remote && r.homer) r.bets.filter(b => !b.isPlayer && !b.cashedAt).forEach(b => this.settleCash(b, r.payout, true));
      r.phase = 'crashed';
      r.phaseStart = now;
      const mine = this.myBet();
      if (r.remote && mine) {
        const profit = round2((mine.cashedAt ? mine.payout : 0) - mine.amount);
        this.player.rounds++;
        if (mine.cashedAt) this.player.wins++;
        this.player.profit = round2(this.player.profit + profit);
        this.player.history.unshift({ id: r.serverId, amount: mine.amount, target: mine.target, cashedAt: mine.cashedAt, crash: r.crash, homer: r.homer, field: r.field, profit });
        this.player.history.length = Math.min(this.player.history.length, 100);
        this.history.unshift({ id: r.serverId, crash: r.crash, homer: r.homer, payout: r.payout, field: r.field, seed: r.seed, hash: r.hash });
        this.history.length = Math.min(this.history.length, 60);
        const a = this.auto;
        if (a.on) {
          const pct = mine.cashedAt ? a.winPct : a.lossPct;
          a.amount = pct ? Math.max(CFG.MIN_BET, floor2(a.amount * (1 + pct / 100))) : a.base;
          if (a.remaining > 0 && --a.remaining === 0) this.stopAuto('自動投注完成');
        }
      }
      this.emit('crash', r);
      this.emit('balance');
      this.save();
    }

    startAuto({ amount, target, count, winPct, lossPct }) {
      amount = floor2(+amount);
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

    // 紀錄與本機試玩分開存；餘額一律以伺服器為準
    save() {
      try {
        if (this.store) this.store.setItem('homerun.gd.v1', JSON.stringify({ history: this.history.slice(0, 30), mine: this.player.history.slice(0, 50), settings: this.settings }));
      } catch (e) { /* ignore */ }
    }

    load() {
      try {
        const d = this.store && JSON.parse(this.store.getItem('homerun.gd.v1') || 'null');
        if (!d) return;
        this.history = d.history || [];
        this.player.history = d.mine || [];
        Object.assign(this.settings, d.settings);
      } catch (e) { /* ignore */ }
    }

    reset() { try { if (this.store) this.store.removeItem('homerun.gd.v1'); } catch (e) { /* ignore */ } }
  }

  Base.Engine = RemoteEngine;
})(window);
