class NeonBingo {
  constructor() {
    this.maxNumber = 75;
    this.remaining = [];
    this.drawn = [];
    this.isSpinning = false;
    this.audioCtx = null;
    this.timers = [];
    this.lastNumber = null;
    this.bigTimer = null;
    this.confettiRaf = 0;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.wakeLock = null;
    this.muted = this.read('bingo.muted') === '1';

    this.initDOM();
    this.initAudio();
    const saved = this.loadState();
    if (saved) { this.maxNumber = saved.max; this.maxNumSelect.value = String(saved.max); }
    this.resetGame();
    if (saved) this.replay(saved.drawn);
    this.setMuted(this.muted);
    this.bindEvents();
    this.registerServiceWorker();
  }

  initDOM() {
    ['maxNumSelect', 'resetBtn', 'drawBtn', 'repeatBtn', 'bigBtn', 'digitTens', 'digitOnes',
      'slotStatus', 'drawnCount', 'maxCountDisplay', 'latestNum', 'bingoBoard', 'recentList',
      'bigOverlay', 'bigNum', 'flash', 'confetti', 'muteBtn', 'undoBtn', 'fullBtn'
    ].forEach((id) => { this[id] = document.getElementById(id); });
  }

  /* ---------- Audio ---------- */
  initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) this.audioCtx = new AC();
  }

  tone(freq, wave, vol, dur, endFreq) {
    const c = this.audioCtx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur);
  }

  noiseBurst() {
    const c = this.audioCtx, n = Math.floor(c.sampleRate * 0.12);
    const buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.frequency.value = 300; g.gain.value = 0.5;
    s.buffer = buf; s.connect(f); f.connect(g); g.connect(c.destination);
    s.start();
  }

  playSound(type) {
    if (!this.audioCtx || this.muted) return;
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    if (type === 'tick') this.tone(440 + Math.random() * 200, 'sine', 0.04, 0.05);
    else if (type === 'stop') this.tone(880, 'square', 0.07, 0.12);
    else if (type === 'thud') { this.tone(90, 'sine', 0.7, 0.5, 35); this.noiseBurst(); }
    else if (type === 'win') [523.25, 659.25, 783.99, 1046.5].forEach((f) => this.tone(f, 'triangle', 0.15, 0.6));
  }

  speakNumberEnglish(number) {
    if (this.muted || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(`Number, ${number}`);
      u.lang = 'en-US';
      u.rate = 1.0;
      u.onerror = (e) => console.log('Speech error:', e);
      window.speechSynthesis.speak(u);
    } catch (err) {
      console.log('Speech synthesis not supported or blocked:', err);
    }
  }

  /* ---------- Events ---------- */
  bindEvents() {
    this.maxNumSelect.addEventListener('change', (e) => {
      this.maxNumber = parseInt(e.target.value, 10);
      this.resetGame();
    });
    this.resetBtn.addEventListener('click', () => {
      if (confirm('Reset and start over?')) this.resetGame();
    });
    this.drawBtn.addEventListener('click', () => {
      if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
      if ('speechSynthesis' in window) window.speechSynthesis.resume();
      this.spinSlot();
    });
    this.repeatBtn.addEventListener('click', () => {
      if (this.lastNumber !== null) this.speakNumberEnglish(this.lastNumber);
    });
    this.bigBtn.addEventListener('click', () => {
      if (this.lastNumber !== null) this.showBig(this.lastNumber, false);
    });
    this.bigOverlay.addEventListener('click', () => this.hideBig());
    this.muteBtn.addEventListener('click', () => this.setMuted(!this.muted));
    this.undoBtn.addEventListener('click', () => this.undo());
    this.fullBtn.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return this.hideBig();
      if (e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if ((k === ' ' || k === 'enter') && e.target.tagName !== 'BUTTON') { e.preventDefault(); this.drawBtn.click(); }
      else if (k === 'r') this.repeatBtn.click();
      else if (k === 'b') this.bigBtn.click();
      else if (k === 'm') this.muteBtn.click();
      else if (k === 'f') this.fullBtn.click();
    });
  }

  /* ---------- Game ---------- */
  later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }

  resetGame() {
    this.clearTimers();
    cancelAnimationFrame(this.confettiRaf);
    this.confetti.getContext('2d').clearRect(0, 0, this.confetti.width, this.confetti.height);
    this.hideBig();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();

    this.remaining = Array.from({ length: this.maxNumber }, (_, i) => i + 1);
    this.drawn = [];
    this.lastNumber = null;
    this.isSpinning = false;
    [this.digitTens, this.digitOnes].forEach((el) => {
      el.textContent = '0';
      el.classList.remove('spinning', 'stopped');
    });
    this.slotStatus.textContent = 'READY';
    this.drawnCount.textContent = '0';
    this.maxCountDisplay.textContent = this.maxNumber;
    this.latestNum.textContent = '--';
    this.drawBtn.disabled = false;
    this.repeatBtn.disabled = true;
    this.bigBtn.disabled = true;
    this.renderBoard();
    this.renderRecent();
    this.undoBtn.disabled = true;
    this.save();
  }

  renderBoard() {
    this.bingoBoard.innerHTML = '';
    for (let i = 1; i <= this.maxNumber; i++) {
      const cell = document.createElement('div');
      cell.className = 'bingo-cell';
      cell.id = `cell-${i}`;
      cell.textContent = i;
      this.bingoBoard.appendChild(cell);
    }
  }

  renderRecent() {
    const last = this.drawn.slice(-5);
    this.recentList.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const item = document.createElement('div');
      const n = last[i];
      item.className = 'recent-item' + (n === undefined ? ' empty' : '') + (i === last.length - 1 ? ' newest' : '');
      item.textContent = n === undefined ? '--' : String(n).padStart(2, '0');
      this.recentList.appendChild(item);
    }
  }

  /* Tens and ones reels spin together; tens stops first, then ones. */
  spinSlot() {
    if (this.isSpinning || this.remaining.length === 0) return;
    this.isSpinning = true;
    this.drawBtn.disabled = true;
    this.hideBig();
    this.undoBtn.disabled = true;
    this.keepAwake();
    this.slotStatus.textContent = 'SPINNING...';

    const n = this.remaining.splice(Math.floor(Math.random() * this.remaining.length), 1)[0];
    const [tens, ones] = String(n).padStart(2, '0');
    this.spinDigit(this.digitTens, tens, 1600);
    this.spinDigit(this.digitOnes, ones, 3000, () => this.finishSpin(n));
  }

  spinDigit(el, finalDigit, stopAt, done) {
    const start = performance.now();
    el.classList.remove('stopped');
    el.classList.add('spinning');
    const step = () => {
      const t = performance.now() - start;
      if (t >= stopAt) {
        el.textContent = finalDigit;
        el.classList.remove('spinning');
        void el.offsetWidth;
        el.classList.add('stopped');
        this.playSound('stop');
        if (done) done();
        return;
      }
      el.textContent = Math.floor(Math.random() * 10);
      this.playSound('tick');
      this.later(step, 40 + 200 * Math.pow(t / stopAt, 2)); // slows down toward the stop
    };
    step();
  }

  finishSpin(n) {
    this.drawn.push(n);
    this.lastNumber = n;
    const s = String(n).padStart(2, '0');
    this.slotStatus.textContent = 'NUMBER DRAWN!';
    this.latestNum.textContent = s;
    this.drawnCount.textContent = this.drawn.length;

    this.playSound('thud');
    this.playSound('win');
    this.doFlash();
    this.launchConfetti();
    this.updateBoard(n);
    this.renderRecent();
    this.later(() => this.showBig(n, true), 700); // let the stopped reel shine first
    this.repeatBtn.disabled = false;
    this.bigBtn.disabled = false;
    this.undoBtn.disabled = false;
    this.save();
    this.later(() => this.speakNumberEnglish(n), 400);

    this.isSpinning = false;
    if (this.remaining.length > 0) this.drawBtn.disabled = false;
    else this.slotStatus.textContent = 'ALL NUMBERS DRAWN';
  }

  updateBoard(n) {
    const prev = this.bingoBoard.querySelector('.bingo-cell.latest');
    if (prev) prev.classList.remove('latest');
    const cell = document.getElementById(`cell-${n}`);
    if (cell) cell.classList.add('drawn', 'latest');
  }

  /* ---------- Effects ---------- */
  doFlash() {
    if (this.reduceMotion) return;
    this.flash.classList.remove('on');
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
  }

  launchConfetti() {
    if (this.reduceMotion) return;
    const cv = this.confetti, ctx = cv.getContext('2d');
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    const colors = ['#00bfe8', '#9000bf', '#ff2d2d', '#ffffff', '#ffd400'];
    const ps = Array.from({ length: 140 }, () => ({
      x: cv.width / 2, y: cv.height * 0.45,
      vx: (Math.random() - 0.5) * 18, vy: -Math.random() * 16 - 4,
      s: 6 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      c: colors[Math.floor(Math.random() * colors.length)]
    }));
    const t0 = performance.now();
    cancelAnimationFrame(this.confettiRaf);
    const frame = (now) => {
      const age = now - t0;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ps.forEach((p) => {
        p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.globalAlpha = Math.max(0, 1 - age / 2600);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      });
      if (age < 2600) this.confettiRaf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, cv.width, cv.height);
    };
    this.confettiRaf = requestAnimationFrame(frame);
  }

  /* Full-screen latest number. auto=true closes itself after 4 s; tap or Esc closes it any time. */
  showBig(n, auto) {
    clearTimeout(this.bigTimer);
    this.bigNum.textContent = String(n).padStart(2, '0');
    this.bigOverlay.classList.add('show');
    if (auto) this.bigTimer = setTimeout(() => this.hideBig(), 4000);
  }

  hideBig() {
    clearTimeout(this.bigTimer);
    this.bigOverlay.classList.remove('show');
  }

  /* ---------- Save / undo / sound / screen ---------- */
  read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  save() {
    try { localStorage.setItem('bingo.state', JSON.stringify({ max: this.maxNumber, drawn: this.drawn })); } catch (e) { /* ignore */ }
  }

  loadState() {
    try {
      const s = JSON.parse(this.read('bingo.state'));
      if (!s || ![30, 50, 75, 90].includes(s.max) || !Array.isArray(s.drawn)) return null;
      return { max: s.max, drawn: s.drawn.filter((n) => Number.isInteger(n) && n >= 1 && n <= s.max) };
    } catch (e) { return null; }
  }

  replay(list) {
    list.forEach((n) => {
      const i = this.remaining.indexOf(n);
      if (i >= 0) { this.remaining.splice(i, 1); this.drawn.push(n); }
    });
    if (!this.drawn.length) return;
    const n = this.drawn[this.drawn.length - 1], s = String(n).padStart(2, '0');
    this.drawn.forEach((m) => document.getElementById(`cell-${m}`).classList.add('drawn'));
    this.updateBoard(n);
    this.digitTens.textContent = s[0];
    this.digitOnes.textContent = s[1];
    this.lastNumber = n;
    this.latestNum.textContent = s;
    this.drawnCount.textContent = this.drawn.length;
    this.repeatBtn.disabled = false;
    this.bigBtn.disabled = false;
    this.undoBtn.disabled = false;
    this.renderRecent();
    if (this.remaining.length === 0) { this.slotStatus.textContent = 'ALL NUMBERS DRAWN'; this.drawBtn.disabled = true; }
    this.save();
  }

  undo() {
    if (this.isSpinning || !this.drawn.length) return;
    const keep = this.drawn.slice(0, -1);
    this.resetGame();
    this.replay(keep);
  }

  setMuted(v) {
    this.muted = v;
    try { localStorage.setItem('bingo.muted', v ? '1' : '0'); } catch (e) { /* ignore */ }
    this.muteBtn.textContent = v ? 'SOUND OFF' : 'SOUND ON';
    this.muteBtn.classList.toggle('off', v);
    if (v && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  async keepAwake() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch (e) { /* not supported or denied */ }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.log('SW reg error:', err));
    }
  }
}

document.addEventListener('DOMContentLoaded', () => { new NeonBingo(); });
