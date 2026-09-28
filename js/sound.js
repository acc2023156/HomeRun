/* 合成音效（Web Audio，不需音檔）：擊球、觀眾聲浪、接殺、全壘打歡呼。第一次使用者操作後才建立 AudioContext */
(function (global) {
  'use strict';
  let ctx = null;
  let enabled = true;
  let noiseBuf = null;
  let hum = null;
  let lastBlip = 0;
  let cheerBuf = null, cheerLoading = false;
  const CHEER_URL = 'Sound/crowd-cheer.mp3';
  const CHEER_GAIN = 0.7; // 原音量降低 30%
  try { enabled = localStorage.getItem('homerun.sound') !== 'off'; } catch (e) { /* storage unavailable */ }

  function audio() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    loadCheer();
    return ctx;
  }

  function loadCheer() {
    if (cheerBuf || cheerLoading || !ctx) return;
    cheerLoading = true;
    fetch(CHEER_URL)
      .then(r => r.arrayBuffer())
      .then(ab => new Promise((ok, bad) => ctx.decodeAudioData(ab, ok, bad)))
      .then(buf => { cheerBuf = buf; })
      .catch(() => { cheerLoading = false; });
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
    launch() { // 擊球「鏗」一聲
      noise({ dur: 0.07, gain: 0.5, from: 9000, to: 2500, type: 'highpass' });
      tone(1900, { dur: 0.05, type: 'square', gain: 0.07, slide: 0.7 });
      tone(420, { dur: 0.09, type: 'triangle', gain: 0.12, slide: 0.5 });
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
    crash() { // 接殺：手套「啪」＋觀眾嘆氣
      noise({ dur: 0.08, gain: 0.45, from: 1800, to: 300 });
      tone(160, { dur: 0.1, type: 'sine', gain: 0.18, slide: 0.6 });
      noise({ at: 0.12, dur: 1.1, gain: 0.14, from: 900, to: 350, type: 'bandpass', q: 2 });
    },
    homer() { // 全壘打：觀眾歡呼（音檔，降 30%）＋輕號角＋煙火
      const ac = enabled && audio();
      if (!ac) return;
      if (cheerBuf) {
        const src = ac.createBufferSource(), g = ac.createGain(), t = ac.currentTime;
        const len = Math.min(cheerBuf.duration, 4.8);
        src.buffer = cheerBuf;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(CHEER_GAIN, t + 0.15);
        g.gain.setValueAtTime(CHEER_GAIN, t + len - 1.2);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        src.connect(g).connect(ac.destination);
        src.start(t);
        src.stop(t + len + 0.05);
      } else {
        noise({ dur: 2.2, gain: 0.12, from: 1200, to: 2000, type: 'bandpass', q: 0.7 });
      }
      [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: 0.1 + i * 0.12, dur: i === 3 ? 0.4 : 0.14, type: 'triangle', gain: 0.05 }));
      [0.7, 1.3, 1.9].forEach(at => noise({ at, dur: 0.3, gain: 0.1, from: 2500, to: 100 }));
    },
    lose() { tone(330, { at: 0.35, dur: 0.18, type: 'triangle', gain: 0.07 }); tone(247, { at: 0.52, dur: 0.3, type: 'triangle', gain: 0.07 }); },

    // 球在飛時的觀眾聲浪，越遠越大聲
    humStart() {
      const ac = enabled && audio();
      if (!ac || hum) return;
      if (!noiseBuf) noise({ dur: 0.01, gain: 0.0001 });
      const src = ac.createBufferSource();
      const f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf; src.loop = true;
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.8;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.05, ac.currentTime + 0.3);
      src.connect(f).connect(g).connect(ac.destination);
      src.start();
      hum = { src, f, g };
    },
    humUpdate(m) {
      if (!hum || !ctx) return;
      const t = ctx.currentTime, k = Math.min(1, (m - 1) / 11);
      hum.g.gain.setTargetAtTime(0.05 + 0.2 * k * k, t, 0.1);
      hum.f.frequency.setTargetAtTime(700 + 900 * k, t, 0.1);
    },
    humStop() {
      if (!hum || !ctx) { hum = null; return; }
      const t = ctx.currentTime, h = hum;
      hum = null;
      h.g.gain.cancelScheduledValues(t);
      h.g.gain.setValueAtTime(Math.max(0.0001, h.g.gain.value), t);
      h.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      h.src.stop(t + 0.2);
    },
  };

  global.Sound = Sound;
})(window);
