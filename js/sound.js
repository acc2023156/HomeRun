/* 音效：投球前 calvary、擊球 Hit、全壘打 Homerun 用 Sound/ 音檔；飛行、落地等用 Web Audio 合成。第一次使用者操作後才建立 AudioContext */
(function (global) {
  'use strict';
  let ctx = null;
  let enabled = true;
  let noiseBuf = null;
  let hum = null;
  let lastBlip = 0;
  // 音檔（大小寫需與檔名一致，GitHub Pages 區分大小寫）
  const FILES = {
    calvary: { url: 'Sound/calvary.MP3', gain: 1 },
    hit: { url: 'Sound/Hit.MP3', gain: 0.8 },
    homerun: { url: 'Sound/Homerun.MP3', gain: 1 },
    flight: { url: 'Sound/flight.MP3', gain: 1 },
  };
  const bufs = {};
  let filesLoading = false;
  const HUM_GAIN = 0.035 * 0.8; // Crash 引擎聲音量的 80%
  function humFreq(m) { return 90 + Math.min(520, 150 * Math.log2(m) + 40 * (m - 1)); }
  try { enabled = localStorage.getItem('homerun.sound') !== 'off'; } catch (e) { /* storage unavailable */ }

  function audio() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    loadFiles();
    return ctx;
  }

  function loadFiles() {
    if (filesLoading || !ctx) return;
    filesLoading = true;
    Object.entries(FILES).forEach(([k, f]) => {
      fetch(f.url)
        .then(r => r.arrayBuffer())
        .then(ab => new Promise((ok, bad) => ctx.decodeAudioData(ab, ok, bad)))
        .then(buf => { bufs[k] = buf; })
        .catch(() => { /* 載入失敗就用合成音 */ });
    });
  }

  // 播放音檔；沒載入成功回傳 false，讓呼叫端改用合成音
  function play(name) {
    const ac = enabled && audio();
    if (!ac || !bufs[name]) return false;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = bufs[name];
    g.gain.value = FILES[name].gain;
    src.connect(g).connect(ac.destination);
    src.start();
    return true;
  }

  function tone(freq, { at = 0, dur = 0.08, type = 'sine', gain = 0.12, slide = 0 } = {}) {
    const ac = enabled && audio();
    if (!ac) return;
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // 白噪音經低通濾波，用在發射與爆炸
  function noise({ dur = 0.6, gain = 0.3, from = 3000, to = 120, at = 0, type = 'lowpass', q = 1 } = {}) {
    const ac = enabled && audio();
    if (!ac) return;
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime + at;
    const src = ac.createBufferSource();
    const f = ac.createBiquadFilter();
    const g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t);
    src.stop(t + dur + 0.05);
  }


  const Sound = {
    get enabled() { return enabled; },
    toggle() {
      enabled = !enabled;
      if (!enabled) Sound.humStop();
      try { localStorage.setItem('homerun.sound', enabled ? 'on' : 'off'); } catch (e) { /* storage unavailable */ }
      return enabled;
    },
    unlock() { if (enabled) audio(); },

    bet() { tone(520, { dur: 0.06, type: 'square', gain: 0.05 }); tone(780, { at: 0.06, dur: 0.09, type: 'square', gain: 0.05 }); },
    cancel() { tone(420, { dur: 0.12, type: 'triangle', gain: 0.09, slide: 0.6 }); },
    tick(last) { tone(last ? 1175 : 880, { dur: last ? 0.16 : 0.07, type: 'sine', gain: 0.1 }); },
    calvary() { play('calvary'); },      // 投球前一秒的號角
    hit() { if (!play('hit')) Sound.launch(); }, // 擊球（Hit.MP3，重擊點在 0.07 秒）
    launch() { // 合成版擊球「鏗！」（音檔載入失敗時的備援）
      noise({ dur: 0.05, gain: 0.55, from: 12000, to: 3000, type: 'highpass' });
      tone(2600, { dur: 0.04, type: 'square', gain: 0.08, slide: 0.55 });
      tone(1318, { dur: 0.32, type: 'triangle', gain: 0.1 });
      tone(1976, { dur: 0.26, type: 'triangle', gain: 0.06 });
      tone(2637, { at: 0.01, dur: 0.18, type: 'sine', gain: 0.04 });
      tone(110, { dur: 0.16, type: 'sine', gain: 0.22, slide: 0.5 });
      noise({ at: 0.02, dur: 0.22, gain: 0.12, from: 2500, to: 600, type: 'bandpass', q: 1.2 });
    },
    swoosh() { // 切換視角的鏡頭掃動聲
      noise({ dur: 0.26, gain: 0.16, from: 500, to: 3200, type: 'bandpass', q: 2.5 });
    },
    milestone() { // 飛向外野，觀眾「喔～」
      noise({ dur: 0.9, gain: 0.12, from: 500, to: 900, type: 'bandpass', q: 3 });
    },
    blip() { // 其他玩家兌現，節流避免 60 人同時響
      const now = performance.now();
      if (now - lastBlip < 70) return;
      lastBlip = now;
      tone(1400 + Math.random() * 500, { dur: 0.04, type: 'sine', gain: 0.025 });
    },
    win() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, { at: i * 0.07, dur: 0.16, type: 'triangle', gain: 0.1 })); },
    crash() { // 球落地：草地「咚」（配合 0.7 秒的下墜動畫）＋觀眾嘆氣
      noise({ at: 0.68, dur: 0.1, gain: 0.3, from: 900, to: 150 });
      tone(120, { at: 0.68, dur: 0.12, type: 'sine', gain: 0.16, slide: 0.6 });
      noise({ at: 0.2, dur: 1.1, gain: 0.12, from: 900, to: 350, type: 'bandpass', q: 2 });
    },
    homer() { // 全壘打：Homerun.MP3（失敗時用合成歡呼）
      if (play('homerun')) return;
      noise({ dur: 2.2, gain: 0.12, from: 1200, to: 2000, type: 'bandpass', q: 0.7 });
      [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: 0.1 + i * 0.12, dur: i === 3 ? 0.4 : 0.14, type: 'triangle', gain: 0.05 }));
    },
    lose() { tone(330, { at: 0.35, dur: 0.18, type: 'triangle', gain: 0.07 }); tone(247, { at: 0.52, dur: 0.3, type: 'triangle', gain: 0.07 }); },

    // 球飛行聲：Sound/flight.MP3；載入失敗時改用合成的上升引擎聲
    humStart() {
      const ac = enabled && audio();
      if (!ac || hum) return;
      if (bufs.flight) { // 飛行聲音檔：擊球起播放，結束時淡出
        const src = ac.createBufferSource(), g = ac.createGain();
        src.buffer = bufs.flight;
        src.loop = true; // 音檔 9.4 秒，長飛行時循環
        g.gain.value = FILES.flight.gain;
        src.connect(g).connect(ac.destination);
        src.start();
        hum = { src, g, file: true };
        return;
      }
      const osc = ac.createOscillator(), osc2 = ac.createOscillator();
      const f = ac.createBiquadFilter(), g = ac.createGain();
      osc.type = 'sawtooth'; osc2.type = 'triangle';
      osc.frequency.value = humFreq(1); osc2.frequency.value = humFreq(1) * 1.005;
      f.type = 'lowpass'; f.frequency.value = 900;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(HUM_GAIN, ac.currentTime + 0.3);
      osc.connect(f); osc2.connect(f); f.connect(g).connect(ac.destination);
      osc.start(); osc2.start();
      hum = { osc, osc2, f, g };
    },
    humUpdate(m) {
      if (!hum || !ctx || hum.file) return;
      const t = ctx.currentTime, fr = humFreq(m);
      hum.osc.frequency.setTargetAtTime(fr, t, 0.05);
      hum.osc2.frequency.setTargetAtTime(fr * 1.005, t, 0.05);
      hum.f.frequency.setTargetAtTime(900 + fr * 2, t, 0.1);
    },
    humStop() {
      if (!hum || !ctx) { hum = null; return; }
      const t = ctx.currentTime, h = hum;
      hum = null;
      h.g.gain.cancelScheduledValues(t);
      h.g.gain.setValueAtTime(Math.max(0.0001, h.g.gain.value), t);
      h.g.gain.exponentialRampToValueAtTime(0.0001, t + (h.file ? 0.25 : 0.08));
      if (h.file) h.src.stop(t + 0.3);
      else { h.osc.stop(t + 0.1); h.osc2.stop(t + 0.1); }
    },
  };

  global.Sound = Sound;
})(window);
