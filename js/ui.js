(function () {
  'use strict';
  const { CFG, STYLES, FIELDS, Engine, multAt, outcomeFromSeed, floor2 } = window.Crash;
  const { heightAt, polar, visScale } = window.FieldMath;
  const TOP_BEFORE_HIT_MS = 180; // 揮棒開始（擊球前）就切俯視，短距離也看得到

  let store = null;
  try { store = window.localStorage; store.setItem('__t', '1'); store.removeItem('__t'); } catch (e) { store = null; }

  const eng = new Engine(store);
  const $ = s => document.querySelector(s);
  // 金額顯示兩位小數、無條件捨去（與大廳、GDBO 一致）
  const fmt = v => (Math.trunc(Math.round(+v * 1000) / 10) / 100 || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtX = v => v.toFixed(2) + '×';
  const signed = v => (v >= 0 ? '+' : '') + fmt(v);
  const fmtT = t => (t >= 99 ? 'HR' : fmtX(t));
  const fieldName = k => (FIELDS.find(f => f.key === k) || {}).name || '';

  const el = {
    balance: $('#balance'), history: $('#history'), live: $('#liveCashouts'),
    roundNo: $('#roundNo'), playerCount: $('#playerCount'), totalBet: $('#totalBet'), totalWon: $('#totalWon'),
    amount: $('#betAmount'), target: $('#autoCashout'), autoFields: $('#autoFields'),
    autoCount: $('#autoCount'), onWin: $('#onWin'), onLoss: $('#onLoss'),
    profitHint: $('#profitHint'), mainBtn: $('#mainBtn'),
    botMin: $('#botMin'), botMax: $('#botMax'), botRangeText: $('#botRangeText'),
    betList: $('#betList'), accList: $('#accList'), mineList: $('#mineList'),
    fairModal: $('#fairModal'), fairList: $('#fairList'), fairCurrent: $('#fairCurrent'),
    toasts: $('#toasts'),
  };

  let mode = 'manual';
  let tab = 'bets';
  let dirtyBets = true, dirtyAcc = true, dirtyMine = true;
  let liveCashouts = [];
  const MILESTONES = [5, 8, 10];
  let milestoneIdx = 0, lastTickSec = 0;
  let cueRound = -1, cues = {};

  /* ---------- toast ---------- */
  function toast(msg, type = 'info') {
    const d = document.createElement('div');
    d.className = 'toast ' + type;
    d.textContent = msg;
    el.toasts.appendChild(d);
    setTimeout(() => d.remove(), 2600);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  }

  /* ---------- engine events ---------- */
  eng.on('toast', t => toast(t.msg, t.type));
  eng.on('balance', () => { el.balance.textContent = fmt(eng.player.balance); updateProfitHint(); });
  eng.on('round', r => {
    liveCashouts = [];
    el.live.innerHTML = '';
    el.roundNo.textContent = r.id;
    dirtyBets = true;
  });
  eng.on('bet', b => {
    dirtyBets = true;
    if (b === null) Sound.cancel();
    else if (b.isPlayer) Sound.bet();
  });
  eng.on('run', () => { milestoneIdx = 0; Sound.humStart(); });
  eng.on('cashout', b => {
    dirtyBets = true;
    liveCashouts.unshift(b);
    liveCashouts.length = Math.min(liveCashouts.length, 4);
    el.live.innerHTML = liveCashouts.map(c =>
      `<div>${c.isPlayer ? '⭐ 你' : c.hidden ? '🕶 Hidden' : c.name}<b>${c.homer ? 'HR ' : ''}${fmtX(c.cashedAt)}</b><b>+${fmt(c.payout)}</b></div>`).join('');
    if (b.isPlayer) Sound.win(); else if (!b.homer) Sound.blip();
    if (b.isPlayer) toast(`${b.homer ? '全壘打！' : '兌現成功'} ${fmtX(b.cashedAt)}　+${fmt(b.payout - b.amount)}`, 'win');
  });
  eng.on('crash', r => {
    dirtyBets = dirtyAcc = dirtyMine = true;
    renderHistory(true);
    Sound.humStop();
    if (r.homer) { Sound.homer(); field.startFireworks(performance.now()); } else Sound.crash();
    const mine = r.bets.find(b => b.isPlayer);
    if (mine && !mine.cashedAt) Sound.lose();
    if (mine && !mine.cashedAt) toast(`球落地 ${(r.crash * 10).toFixed(1)} m　−${fmt(mine.amount)}`, 'lose');
  });
  eng.on('auto', () => { syncModeUI(); });

  /* ---------- history chips ---------- */
  function chipClass(x, homer) { return homer ? 'y' : x >= 6 ? 'g' : x < 1.5 ? 'r' : ''; }
  const chipText = h => (h.homer ? 'HR ' + fmtX(h.payout) : fmtX(h.crash));
  function renderHistory(fresh) {
    el.history.innerHTML = eng.history.slice(0, 30).map((h, i) =>
      `<button type="button" class="chip ${chipClass(h.crash, h.homer)} ${fresh && i === 0 ? 'new' : ''}" data-round="${h.id}">${chipText(h)}</button>`).join('');
  }
  el.history.addEventListener('click', e => {
    const b = e.target.closest('[data-round]');
    if (b) openFair(b.dataset.round);
  });

  /* ---------- lists ---------- */
  function nameCell(b) {
    if (b.isPlayer) return `<span class="name"><i style="background:var(--green)"></i>你</span>`;
    if (b.hidden) return `<span class="name hid"><i style="background:#557086"></i>🕶 Hidden</span>`;
    return `<span class="name"><i style="background:${b.acc.color}"></i>${b.name}</span>`;
  }
  function renderBets() {
    const r = eng.round;
    const bets = r.bets.slice().sort((a, b) => (b.isPlayer - a.isPlayer) || (b.amount - a.amount));
    const total = bets.reduce((s, b) => s + b.amount, 0);
    const won = bets.reduce((s, b) => s + b.payout, 0);
    el.playerCount.textContent = bets.length;
    el.totalBet.textContent = fmt(total);
    el.totalWon.textContent = fmt(won);
    if (!bets.length) { el.betList.innerHTML = `<div class="empty">等待玩家下注…</div>`; return; }
    const crashed = r.phase === 'crashed';
    el.betList.innerHTML = bets.map(b => {
      const cls = b.cashedAt ? 'won' : crashed ? 'lost' : '';
      const mult = b.cashedAt ? (b.homer ? 'HR ' : '') + fmtX(b.cashedAt) : crashed ? '未兌現' : b.target >= 99 ? 'HR?' : '-';
      const pay = b.cashedAt ? '+' + fmt(b.payout) : crashed ? '−' + fmt(b.amount) : '-';
      return `<div class="row ${cls} ${b.isPlayer ? 'me' : ''}">${nameCell(b)}<span>${fmt(b.amount)}</span><span class="mult">${mult}</span><span class="pay">${pay}</span></div>`;
    }).join('');
  }
  function renderAccounts() {
    const inRound = new Set(eng.round.bets.map(b => b.acc.id));
    const list = eng.accounts.slice().sort((a, b) => b.balance - a.balance);
    el.accList.innerHTML = list.map(a =>
      `<div class="row"><span class="name"><i style="background:${a.color}"></i>${a.name}${a.hidden ? ' 🕶' : ''}${inRound.has(a.id) ? ' <em class="tag in">本局</em>' : ''}</span>` +
      `<span><em class="tag">${STYLES[a.style].label}</em></span><span>${fmt(a.balance)}</span>` +
      `<span class="${a.profit >= 0 ? 'pos' : 'neg'}">${signed(a.profit)}</span></div>`).join('');
  }
  function renderMine() {
    const h = eng.player.history;
    if (!h.length) { el.mineList.innerHTML = `<div class="empty">還沒有紀錄，下一注吧！</div>`; return; }
    el.mineList.innerHTML = h.map(x =>
      `<div class="row ${x.cashedAt ? 'won' : 'lost'}"><span>#${x.id}</span><span>${fmt(x.amount)}</span>` +
      `<span class="mult">${x.cashedAt ? (x.homer ? 'HR ' : '') + fmtX(x.cashedAt) : '落地 ' + (x.crash * 10).toFixed(0) + 'm'}</span><span class="pay">${signed(x.profit)}</span></div>`).join('');
  }

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    ['bets', 'accounts', 'mine'].forEach(t => { $('#tab-' + t).hidden = t !== tab; });
    dirtyBets = dirtyAcc = dirtyMine = true;
  });

  /* ---------- controls ---------- */
  function readAmount() { return Math.max(0, +el.amount.value || 0); }
  function readTarget() { return +el.target.value || 0; }
  function updateProfitHint() {
    const t = readTarget();
    el.profitHint.textContent = t >= 99 ? `全壘打 ${fmt(readAmount() * 17)} ~ ${fmt(readAmount() * 23)}` : t >= 1.01 ? fmt(readAmount() * (t - 1)) : '手動兌現';
  }
  el.amount.addEventListener('input', updateProfitHint);
  el.target.addEventListener('input', updateProfitHint);
  document.querySelectorAll('[data-amt]').forEach(b => b.addEventListener('click', () => {
    let v = readAmount();
    if (b.dataset.amt === 'half') v = v / 2;
    else if (b.dataset.amt === 'double') v = v * 2;
    else v = eng.player.balance;
    v = Math.min(Math.max(CFG.MIN_BET, Math.floor(v * 100) / 100), Math.max(CFG.MIN_BET, eng.player.balance));
    el.amount.value = v.toFixed(2);
    updateProfitHint();
  }));

  $('#modeSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b || eng.auto.on) return;
    mode = b.dataset.mode;
    syncModeUI();
  });
  function syncModeUI() {
    document.querySelectorAll('#modeSeg button').forEach(x => {
      x.classList.toggle('on', x.dataset.mode === mode);
      x.disabled = eng.auto.on && x.dataset.mode !== mode;
    });
    el.autoFields.hidden = mode !== 'auto';
    [el.amount, el.target, el.autoCount, el.onWin, el.onLoss].forEach(i => { i.disabled = eng.auto.on; });
  }

  let btnKey = '';
  function updateButton(now) {
    const r = eng.round, bet = eng.myBet();
    let cls = '', label = '', sub = '';
    if (eng.auto.on) {
      cls = 'stop'; label = '停止自動投注';
      sub = `下注 ${fmt(eng.auto.amount)} @ ${fmtT(eng.auto.target)}` + (eng.auto.remaining ? `　剩 ${eng.auto.remaining} 局` : '　無限');
    } else if (r.phase === 'running' && bet && !bet.cashedAt) {
      const m = floor2(Math.min(multAt(now - r.phaseStart), r.crash));
      cls = 'cash'; label = '兌現 ' + fmt(bet.amount * m); sub = `${fmtX(m)} · ${(m * 10).toFixed(1)} m`;
    } else if (r.phase === 'betting' && bet) {
      cls = 'cancel'; label = '取消下注'; sub = `${fmt(bet.amount)}${bet.target ? ' @ ' + fmtT(bet.target) : ''}`;
    } else if (eng.queued) {
      cls = 'queued'; label = '取消（已排下一局）'; sub = fmt(eng.queued.amount);
    } else if (mode === 'auto') {
      label = '開始自動投注';
    } else if (r.phase === 'betting') {
      label = '下注';
    } else {
      label = '下注（下一局）';
      if (bet && bet.cashedAt) sub = `本局已兌現 ${bet.homer ? 'HR ' : ''}${fmtX(bet.cashedAt)}`;
    }
    const key = cls + label + sub;
    if (key === btnKey) return;
    btnKey = key;
    el.mainBtn.className = 'main-btn ' + cls;
    el.mainBtn.innerHTML = label + (sub ? `<small>${sub}</small>` : '');
  }

  function onMain() {
    const now = performance.now();
    const r = eng.round, bet = eng.myBet();
    if (eng.auto.on) { eng.stopAuto('已停止自動投注'); return; }
    if (r.phase === 'running' && bet && !bet.cashedAt) { eng.cashOut(now); return; }
    if ((r.phase === 'betting' && bet) || eng.queued) { eng.cancelBet(); return; }
    if (mode === 'auto') {
      eng.startAuto({ amount: readAmount(), target: readTarget(), count: +el.autoCount.value, winPct: +el.onWin.value, lossPct: +el.onLoss.value });
      return;
    }
    eng.placeBet(readAmount(), readTarget());
  }
  el.mainBtn.addEventListener('click', onMain);
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat) return;
    if (/INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    onMain();
  });

  /* ---------- simulation settings ---------- */
  function syncBotRange() {
    el.botMin.value = eng.settings.botMin;
    el.botMax.value = eng.settings.botMax;
    const lo = Math.min(eng.settings.botMin, eng.settings.botMax), hi = Math.max(eng.settings.botMin, eng.settings.botMax);
    el.botRangeText.textContent = `${lo} ~ ${hi} 人`;
  }
  [el.botMin, el.botMax].forEach(i => i.addEventListener('input', () => {
    eng.setBotRange(+el.botMin.value, +el.botMax.value);
    syncBotRange();
  }));
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('確定要重置 100 個帳號與你的餘額？')) return;
    eng.reset();
    location.reload();
  });

  /* ---------- 全壘打快捷、玩法、返回大廳 ---------- */
  $('#hrBtn').addEventListener('click', () => { el.target.value = '99'; updateProfitHint(); toast('自動兌現設為「只收全壘打」', 'info'); });
  const rulesModal = $('#rulesModal');
  $('#rulesBtn').addEventListener('click', () => { rulesModal.hidden = false; });
  rulesModal.addEventListener('click', e => {
    if (e.target === rulesModal || e.target.closest('[data-close]')) rulesModal.hidden = true;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') rulesModal.hidden = true; });
  // 只接受自家網域的 return，避免被當成跳轉跳板
  (function () {
    const ret = new URLSearchParams(location.search).get('return');
    if (!ret) return;
    try {
      const url = new URL(ret);
      const okHost = url.hostname === 'acc2023156.github.io' || url.hostname === location.hostname || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (!/^https?:$/.test(url.protocol) || !okHost) return;
      $('#backBtn').href = url.href;
    } catch (e) { /* invalid url */ }
  })();

  /* ---------- 跑馬燈（同 Plinko：兩份相同文字捲動一半寬度，無縫循環） ---------- */
  (function startMarquee() {
    const track = $('#marquee');
    const brand = '全壘打';
    const cheers = ['轟出全壘打', '一棒逆轉', '再見全壘打', '滿貫砲', '飛越全壘打牆', '強棒出擊', '重砲轟擊', '中外野 24 倍', '揮出好球', '大棒一揮'];
    const sep = '　✦　';
    const build = () => {
      const c = cheers.slice().sort(() => Math.random() - 0.5);
      const text = [brand, c[0], c[1], brand, c[2], c[3]].join(sep) + sep;
      track.innerHTML = '';
      for (let i = 0; i < 2; i++) track.appendChild(document.createElement('span')).textContent = text;
      track.style.animationDuration = text.length * 0.32 + 's';
    };
    track.addEventListener('animationiteration', build);
    build();
  })();

  /* ---------- fairness ---------- */
  function openFair(focusId) {
    const r = eng.round;
    el.fairCurrent.innerHTML = `目前第 <b>${r.id}</b> 局 hash：<br><code>${r.hash}</code><br>` +
      (r.phase === 'crashed' ? `seed：<code>${r.seed}</code>` : '<span class="hint">seed 將在本局結束後公開</span>');
    el.fairList.innerHTML = eng.history.map(h =>
      `<details ${String(h.id) === String(focusId) ? 'open' : ''} data-id="${h.id}"><summary><span>#${h.id}</span><b class="chip ${chipClass(h.crash, h.homer)}">${chipText(h)}</b></summary>` +
      `<div class="kv">hash：<code>${h.hash}</code></div><div class="kv">seed：<code>${h.seed}</code></div>` +
      `<div class="kv verify"></div></details>`).join('') || '<div class="empty">尚無已結束的局</div>';
    el.fairList.querySelectorAll('details').forEach(d => {
      const run = () => {
        const h = eng.history.find(x => String(x.id) === d.dataset.id);
        const hashOk = window.sha256(h.seed) === h.hash;
        const o = outcomeFromSeed(h.seed, h.id);
        const same = o.dist === h.crash && o.homer === !!h.homer && (!h.field || o.field === h.field);
        d.querySelector('.verify').innerHTML = `重新計算：SHA256(seed) ${hashOk ? '<span class="ok">相符 ✓</span>' : '<span class="neg">不符 ✗</span>'}，${fieldName(o.field)} ${o.homer ? '全壘打 ' + fmtX(o.payout) : (o.dist * 10).toFixed(1) + ' m（' + fmtX(o.dist) + '）'} ${same ? '<span class="ok">✓</span>' : '<span class="neg">✗</span>'}`;
      };
      if (d.open) run();
      d.addEventListener('toggle', () => { if (d.open) run(); });
    });
    el.fairModal.hidden = false;
  }
  $('#fairBtn').addEventListener('click', () => openFair());
  el.fairModal.addEventListener('click', e => {
    if (e.target === el.fairModal || e.target.closest('[data-close]')) el.fairModal.hidden = true;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') el.fairModal.hidden = true; });

  /* ---------- field + HUD ---------- */
  const cv = $('#chart');
  const field = new FieldRenderer(cv);
  const ctx = field.ctx;
  let W = 0, H = 0;
  function resize() {
    const rect = cv.parentElement.getBoundingClientRect();
    W = rect.width; H = rect.height;
    field.resize(W, H, Math.min(2, window.devicePixelRatio || 1));
    const big = Math.max(26, Math.min(W * 0.09, H * 0.14, 64));
    field.bottomReserve = big * 1.65 + 8;
  }
  new ResizeObserver(resize).observe(cv.parentElement);
  resize();

  // 球的位置：飛行中只依目前距離計算；結束後球落地彈跳，或飛進看台
  function ballState(now) {
    const r = eng.round;
    if (r.phase === 'betting') return null;
    const t = now - r.phaseStart;
    let d, z;
    if (r.phase === 'running') {
      const m = Math.min(multAt(t), r.crash);
      d = m * 10 * Math.min(1, 0.25 + t / 400);
      z = heightAt(d);
    } else {
      const dEnd = r.crash * 10, h0 = heightAt(dEnd);
      if (r.homer) {
        const k = Math.min(1, t / 1600);
        d = dEnd + 38 * k;
        z = h0 + (16 - h0) * k * k;
      } else {
        // 下墜落地 → 小彈跳 → 滾一小段
        const fall = Math.min(1, t / 700);
        d = dEnd + 1.5 * Math.max(0, Math.min(1, (t - 700) / 900)); // 落地後只滾 1.5 m
        if (t < 700) z = h0 * (1 - fall * fall);
        else { const tb = (t - 700) / 450; z = tb < 1 ? 1.4 * Math.sin(Math.PI * tb) : 0; }
      }
    }
    const [x, y] = polar(d * visScale(r.angle), r.angle);
    // label：顯示的距離以落地點為準（滾動不算）
    return { x, y, z, d, label: r.phase === 'crashed' && !r.homer ? r.crash * 10 : d };
  }

  function draw(now) {
    if (!W || !H) return;
    const r = eng.round;
    const ball = ballState(now);
    const toTop = r.phase !== 'betting' || CFG.BET_MS - (now - r.phaseStart) <= TOP_BEFORE_HIT_MS;
    if (toTop && field.view !== 'top') Sound.swoosh();
    field.setView(toTop ? 'top' : 'behind', now);

    let scoreboard = 'ROUND ' + r.id;
    if (r.phase === 'running' && ball) scoreboard = ball.d.toFixed(1) + ' m';
    else if (r.phase === 'crashed') scoreboard = r.homer ? 'HOME RUN!' : (r.crash * 10).toFixed(1) + ' m';
    field.render({
      roundId: r.id, phase: r.phase, field: r.field, angle: r.angle, homer: r.homer, ball,
      betLeft: r.phase === 'betting' ? Math.max(0, CFG.BET_MS - (now - r.phaseStart)) : -1,
      flightT: r.phase === 'running' ? now - r.phaseStart : 99999,
      celebrate: r.phase === 'crashed' && r.homer, scoreboard,
    }, now);
    drawHud(r, ball, now);
  }

  function pill(x, y, w, h, fill) {
    ctx.fillStyle = fill;
    roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
  }

  function drawHud(r, ball, now) {
    ctx.setTransform(field.dpr, 0, 0, field.dpr, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const big = Math.max(26, Math.min(W * 0.09, H * 0.14, 64));
    const cx = W / 2;

    if (r.phase === 'betting') {
      const left = Math.max(0, CFG.BET_MS - (now - r.phaseStart));
      const canBet = !eng.myBet() && !eng.auto.on;
      // 單一倒數放在畫面上方，一直倒數到 0
      const cy = big * 0.95, pw = Math.min(W - 24, big * 5), ph = big * 1.5;
      pill(cx, cy, pw, ph, 'rgba(10,25,35,.78)');
      ctx.fillStyle = '#cfd8e3';
      ctx.font = `700 ${Math.round(big * 0.3)}px system-ui, sans-serif`;
      ctx.fillText('投球倒數', cx - pw * 0.2, cy - big * 0.08);
      ctx.fillStyle = left <= 1500 ? '#ffd166' : '#fff';
      ctx.font = `900 ${Math.round(big * 0.72)}px system-ui, sans-serif`;
      ctx.fillText((left / 1000).toFixed(1) + 's', cx + pw * 0.16, cy - big * 0.08);
      const bw = pw * 0.8, by = cy + big * 0.45;
      ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(cx - bw / 2, by, bw, 4);
      ctx.fillStyle = '#ffd166'; ctx.fillRect(cx - bw / 2, by, bw * (left / CFG.BET_MS), 4);
      if (canBet && field.view === 'behind') hint('點擊畫面下注', H - 26);
      return;
    }
    // 打擊視角不顯示飛行距離，切到俯視才開始量
    if (field.view !== 'top') return;

    const m = r.phase === 'running' ? floor2(Math.min(multAt(now - r.phaseStart), r.crash)) : r.crash;

    // 結果大字
    if (r.phase === 'crashed') {
      const cy = H * 0.4;
      if (r.homer) {
        const pulse = 1 + 0.05 * Math.sin(now / 90);
        ctx.font = `900 ${Math.round(big * 1.05 * pulse)}px system-ui, sans-serif`;
        ctx.lineWidth = 6; ctx.strokeStyle = '#7a1d10'; ctx.strokeText('HOME RUN!', cx, cy);
        ctx.fillStyle = '#ffd166'; ctx.fillText('HOME RUN!', cx, cy);
        ctx.font = `800 ${Math.round(big * 0.45)}px system-ui, sans-serif`;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.6)';
        const t2 = `${fieldName(r.field)} 全壘打 ${fmtX(r.payout)}`;
        ctx.strokeText(t2, cx, cy + big * 0.85); ctx.fillStyle = '#fff'; ctx.fillText(t2, cx, cy + big * 0.85);
      } else {
        const label = `飛行 ${(r.crash * 10).toFixed(1)} m`;
        ctx.font = `900 ${Math.round(big * 0.8)}px system-ui, sans-serif`;
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(label, cx, cy);
        ctx.fillStyle = '#fff'; ctx.fillText(label, cx, cy);
      }
    }

    // 下方：倍數（距離已標在球旁邊）
    const by = H - big * 0.95;
    pill(cx, by, Math.min(W - 24, big * 3.6), big * 1.3, 'rgba(10,25,35,.78)');
    const shown = r.phase === 'crashed' && r.homer ? r.payout : m;
    ctx.fillStyle = r.phase === 'crashed' ? (r.homer ? '#ffd166' : '#ff6b6b') : '#fff';
    ctx.font = `900 ${Math.round(big * 0.78)}px system-ui, sans-serif`;
    ctx.fillText(fmtX(shown), cx, by);
    const mine = eng.myBet();
    if (mine && !mine.cashedAt && r.phase === 'running') hint('點擊畫面兌現', by - big * 1.15, '#ff9f1c');
    if (mine && mine.cashedAt) {
      const txt = `${mine.homer ? '全壘打 ' : '已兌現 '}${fmtX(mine.cashedAt)}  +${fmt(mine.payout - mine.amount)}`;
      ctx.font = `700 ${Math.round(big * 0.3)}px system-ui, sans-serif`;
      const w2 = ctx.measureText(txt).width + 26;
      pill(cx, by - big * 1.15, w2, big * 0.5, 'rgba(6,120,60,.9)');
      ctx.fillStyle = '#fff'; ctx.fillText(txt, cx, by - big * 1.15);
    }
  }
  function hint(txt, y, color = '#00e701') {
    ctx.font = `800 ${Math.max(12, Math.round(Math.min(W * 0.035, 17)))}px system-ui, sans-serif`;
    const w = ctx.measureText(txt).width + 28, hh = Math.max(24, Math.min(W * 0.035, 17) + 14);
    const a = 0.75 + 0.25 * Math.sin(performance.now() / 220);
    ctx.globalAlpha = a;
    pill(W / 2, y, w, hh, color);
    ctx.fillStyle = color === '#00e701' ? '#05260a' : '#2b1600';
    ctx.fillText(txt, W / 2, y);
    ctx.globalAlpha = 1;
  }
  // 點擊畫面：打擊視角＝下注；俯視＝兌現
  cv.addEventListener('click', () => {
    const now = performance.now(), r = eng.round, bet = eng.myBet();
    if (field.view === 'behind' && r.phase === 'betting') {
      if (bet || eng.auto.on) return;
      if (mode === 'auto') eng.startAuto({ amount: readAmount(), target: readTarget(), count: +el.autoCount.value, winPct: +el.onWin.value, lossPct: +el.onLoss.value });
      else eng.placeBet(readAmount(), readTarget());
    } else if (field.view === 'top' && r.phase === 'running' && bet && !bet.cashedAt) {
      eng.cashOut(now);
    }
  });
  function roundRect(x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
  }

  /* ---------- sound ---------- */
  function soundFrame(now) {
    const r = eng.round;
    if (r.id !== cueRound) { cueRound = r.id; cues = {}; }
    if (r.phase === 'betting') {
      const leftMs = CFG.BET_MS - (now - r.phaseStart);
      if (leftMs <= 2500 && !cues.calvary) { cues.calvary = 1; Sound.calvary(); } // 投手動作（1.5 秒）前一秒
      if (leftMs <= 70 && !cues.hit) { cues.hit = 1; Sound.hit(); }
      const sec = Math.ceil(leftMs / 1000);
      if (sec <= 3 && sec >= 1 && sec !== lastTickSec) Sound.tick(sec === 1);
      lastTickSec = sec;
    } else if (r.phase === 'running') {
      if (!cues.hit) { cues.hit = 1; Sound.hit(); }
      const m = multAt(now - r.phaseStart);
      Sound.humUpdate(m);
      if (m >= MILESTONES[milestoneIdx] && m < r.crash) Sound.milestone(MILESTONES[milestoneIdx++]);
    }
  }
  const soundBtn = $('#soundBtn');
  function renderSound() {
    soundBtn.textContent = Sound.enabled ? '🔊' : '🔇';
    soundBtn.classList.toggle('off', !Sound.enabled);
    soundBtn.setAttribute('aria-pressed', String(Sound.enabled));
  }
  soundBtn.addEventListener('click', () => {
    Sound.toggle();
    Sound.unlock();
    if (Sound.enabled && eng.round.phase === 'running') Sound.humStart();
    renderSound();
  });
  // 瀏覽器要求使用者操作後才能出聲
  const unlock = () => {
    Sound.unlock();
    if (eng.round.phase === 'running') Sound.humStart();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) Sound.humStop();
    else if (eng.round.phase === 'running') Sound.humStart();
  });
  renderSound();

  /* ---------- loops ---------- */
  let lastList = 0;
  function frame(now) {
    eng.tick(now);
    soundFrame(now);
    draw(now);
    updateButton(now);
    if (now - lastList > 120) {
      lastList = now;
      if (tab === 'bets' && dirtyBets) { dirtyBets = false; renderBets(); }
      if (tab === 'accounts' && dirtyAcc) { dirtyAcc = false; renderAccounts(); }
      if (tab === 'mine' && dirtyMine) { dirtyMine = false; renderMine(); }
      if (tab !== 'bets' && dirtyBets) { // 頁尾統計仍要更新
        const bets = eng.round.bets;
        el.playerCount.textContent = bets.length;
        el.totalBet.textContent = fmt(bets.reduce((s, b) => s + b.amount, 0));
        el.totalWon.textContent = fmt(bets.reduce((s, b) => s + b.payout, 0));
      }
    }
    requestAnimationFrame(frame);
  }
  // 分頁在背景時 rAF 會停，改用計時器推進遊戲，保持自動兌現準確
  setInterval(() => { if (document.hidden) eng.tick(performance.now()); }, 250);

  eng.start(performance.now());
  el.balance.textContent = fmt(eng.player.balance);
  renderHistory(false);
  syncBotRange();
  syncModeUI();
  updateProfitHint();
  requestAnimationFrame(frame);

  window.__crash = eng;
  window.__field = field; // 方便除錯
})();
