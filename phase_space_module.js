// Phase-Space Engine Module
export let isEngineRunning = false;
let audioCtx, synthNode, analyserL, analyserR, dataL, dataR;
let isPlaying = false;
let globalTime = 0;
let eventIndex = 0;
let animationId;
let canvas, ctx, toggleBtn;

let ALL_EVENTS = [];
let SPB = 0;
let maxTime = "0.00";
let hasDataLoaded = false;

function parseMacroData(dataString) {
    try {
        const data = JSON.parse(dataString);
        SPB = 60.0 / data.bpm;
        ALL_EVENTS = [];
        
        const TRACK_MAP = {
            'Flute': 'melody',
            'Grand Piano': 'pad',
            'Synthesizer': 'pad',
            '8-Bit Sawtooth': 'pad',
            'Bass': 'bass',
            'Synth Pluck': 'pluck'
        };

        for (const [trackName, notes] of Object.entries(data.tracks)) {
            if (TRACK_MAP[trackName]) {
                notes.forEach(n => {
                    let duration = n.d !== undefined ? n.d : (n.duration !== undefined ? n.duration : 1.0);
                    ALL_EVENTS.push({ t: n.s, p: n.p, d: duration, type: TRACK_MAP[trackName] });
                });
            }
        }
        ALL_EVENTS.sort((a, b) => a.t - b.t);
        maxTime = ALL_EVENTS.length > 0 ? ALL_EVENTS[ALL_EVENTS.length-1].t.toFixed(2) : "0.00";
        hasDataLoaded = true;
        return true;
    } catch (err) {
        console.error("JSON Parsing Error:", err);
        return false;
    }
}

const midiToFreq = (m) => 440.0 * Math.pow(2.0, (m - 69.0) / 12.0);

const kernelCode = `
class AdvancedMathEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.sampleRate = 44100.0;
    this.dt = 1.0 / this.sampleRate;
    
    // Sine Wavetable
    this.WT_SIZE = 8192;
    this.wt = new Float32Array(this.WT_SIZE);
    for (let i = 0; i < this.WT_SIZE; i++) {
        this.wt[i] = Math.sin((i / this.WT_SIZE) * 2.0 * Math.PI);
    }
    
    this.delays = [
      new Float32Array(Math.floor(this.sampleRate * 0.0437)),
      new Float32Array(Math.floor(this.sampleRate * 0.0511)),
      new Float32Array(Math.floor(this.sampleRate * 0.0613)),
      new Float32Array(Math.floor(this.sampleRate * 0.0739))
    ];
    this.ptrs = [0, 0, 0, 0];
    this.matrix = [
      [-0.5,  0.5,  0.5,  0.5],
      [ 0.5, -0.5,  0.5,  0.5],
      [ 0.5,  0.5, -0.5,  0.5],
      [ 0.5,  0.5,  0.5, -0.5]
    ];

    this.lx = 0.1; this.ly = 0.0; this.lz = 0.0;
    this.sigma = 10.0; this.rho = 28.0; this.beta = 8.0 / 3.0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'NOTE_ON') {
        const d = e.data;
        const nMax = Math.min(
          d.voiceType === 'pad' ? 14 : (d.voiceType === 'bass' ? 24 : 10),
          Math.floor((this.sampleRate / 2.0) / d.freq)
        );

        let alpha = 40.0, lambda = 1.5, releaseDamp = 15.0;
        if (d.voiceType === 'pad') { alpha = 1.5; lambda = 0.25; releaseDamp = 1.2; }
        if (d.voiceType === 'pluck') { alpha = 150.0; lambda = 5.0; releaseDamp = 30.0; } 

        const safeDur = isNaN(d.dur) ? 1.0 : d.dur;
        const delay = d.delay || 0.0;

        this.voices.push({
          f0: d.freq, type: d.voiceType, dur: safeDur, t: -delay,
          released: false, releaseT: 0.0, N: nMax,
          alpha, lambda, releaseDamp
        });
      }
    };
  }

  fastSin(phase_rad) {
      let p = (phase_rad * 0.15915494309189535) % 1.0;
      if (p < 0) p += 1.0;
      return this.wt[~~(p * this.WT_SIZE)];
  }

  process(inputs, outputs, parameters) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    if (!outL || !outR) return true;

    for (let i = 0; i < outL.length; i++) {
      const ldt = this.dt * 0.5;
      const dx = this.sigma * (this.ly - this.lx) * ldt;
      const dy = (this.lx * (this.rho - this.lz) - this.ly) * ldt;
      const dz = (this.lx * this.ly - this.beta * this.lz) * ldt;
      this.lx += dx; this.ly += dy; this.lz += dz;

      const lorenzOffset = (this.lx / 20.0) * 0.002; 

      let dryL = 0.0;
      let dryR = 0.0;

      for (let v = this.voices.length - 1; v >= 0; v--) {
        const voice = this.voices[v];
        voice.t += this.dt;
        
        if (voice.t <= 0) continue; 

        if (!voice.released && voice.t >= voice.dur) {
          voice.released = true;
          voice.releaseT = voice.t;
        }

        let voiceOut = 0.0;
        let voiceOutR = 0.0;
        
        for (let k = 1; k <= voice.N; k++) {
          let f_k = voice.f0 * k;
          if (voice.type === 'pluck') f_k = voice.f0 * Math.pow(k, 1.0 + (0.04 * Math.log2(k) / 12.0)); 
          
          const w_k = 2.0 * Math.PI * f_k;
          const sigma = Math.sin(Math.PI * k / voice.N) / (Math.PI * k / voice.N);
          const baseAmp = (k % 2 === 0 ? -1.0 : 1.0) / Math.pow(k, 1.1);
          
          const attack = Math.pow(1.0 - Math.exp(-voice.alpha * voice.t), 2.0);
          let decay = !voice.released 
            ? Math.exp(-voice.lambda * (k * 0.1) * voice.t)
            : Math.exp(-voice.lambda * (k * 0.1) * voice.releaseT) * Math.exp(-voice.releaseDamp * (voice.t - voice.releaseT));

          let amp = sigma * baseAmp * attack * decay;
          if (voice.type === 'bass' && k % 2 !== 0) amp *= 2.0; 
          if (voice.type === 'pad') amp *= 0.4;
          if (voice.type === 'pluck') amp *= 0.5;

          voiceOut += amp * this.fastSin(w_k * voice.t);
          voiceOutR += amp * this.fastSin(w_k * (voice.t + (voice.type === 'pad' ? lorenzOffset : 0)));
        }

        let vol = 0.4;
        if (voice.type === 'pad') vol = 0.15;
        if (voice.type === 'pluck') vol = 0.25;

        dryL += voiceOut * vol;
        dryR += voiceOutR * vol;

        if (voice.released && (voice.t - voice.releaseT > 2.5)) this.voices.splice(v, 1);
      }

      const drive = 1.2;
      let preL = Math.tanh(dryL * drive);
      let preR = Math.tanh(dryR * drive);
      
      dryL = Math.tanh(preL + 0.15 * (4 * Math.pow(preL, 3) - 3 * preL));
      dryR = Math.tanh(preR + 0.15 * (4 * Math.pow(preR, 3) - 3 * preR));

      const revOut = [0, 0, 0, 0];
      for (let j = 0; j < 4; j++) revOut[j] = this.delays[j][this.ptrs[j]];

      const revIn = [0, 0, 0, 0];
      for (let j = 0; j < 4; j++) {
        let sum = 0.0;
        for (let k = 0; k < 4; k++) sum += this.matrix[j][k] * revOut[k];
        let feedback = ((dryL + dryR) * 0.15) + (sum * 0.88); 
        if (Math.abs(feedback) < 1e-8) feedback = 0.0;
        revIn[j] = feedback;
        this.delays[j][this.ptrs[j]] = revIn[j];
        this.ptrs[j] = (this.ptrs[j] + 1) % this.delays[j].length;
      }

      const wetL = (revOut[0] + revOut[1] - revOut[2] - revOut[3]) * 0.2;
      const wetR = (revOut[0] - revOut[1] + revOut[2] - revOut[3]) * 0.2;

      outL[i] = Math.tanh(dryL + wetL);
      outR[i] = Math.tanh(dryR + wetR);
    }
    return true;
  }
}
registerProcessor('advanced-math-engine', AdvancedMathEngine);
`;

async function initSystem() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
  const blob = new Blob([kernelCode], { type: 'application/javascript' });
  await audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));
  
  synthNode = new AudioWorkletNode(audioCtx, 'advanced-math-engine', { outputChannelCount: [2] });
  
  const splitter = audioCtx.createChannelSplitter(2);
  analyserL = audioCtx.createAnalyser();
  analyserR = audioCtx.createAnalyser();
  
  analyserL.fftSize = 1024;
  analyserR.fftSize = 1024;
  dataL = new Float32Array(analyserL.fftSize);
  dataR = new Float32Array(analyserR.fftSize);

  synthNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  synthNode.connect(audioCtx.destination);
}

function fireNote(freq, voiceType, dur, delay) {
  if (!synthNode) return;
  synthNode.port.postMessage({ type: 'NOTE_ON', freq, voiceType, dur, delay });
}

function coreLoop() {
  if (!isPlaying) return;

  const lookaheadTime = audioCtx.currentTime + 0.1;

  while (eventIndex < ALL_EVENTS.length) {
    const ev = ALL_EVENTS[eventIndex];
    const eventTime = globalTime + (ev.t * SPB);
    
    if (eventTime < lookaheadTime) {
      let delay = eventTime - audioCtx.currentTime;
      if (delay < 0) delay = 0;
      fireNote(midiToFreq(ev.p), ev.type, ev.d * SPB, delay);
      eventIndex++;
    } else {
      break; 
    }
  }

  if (eventIndex >= ALL_EVENTS.length) {
      isPlaying = false;
      if(toggleBtn) toggleBtn.innerText = "[ SEQUENCE COMPLETE ]";
      return;
  }

  requestAnimationFrame(coreLoop);
}

function drawPhaseScope() {
  if (!ctx || !canvas) return;

  ctx.fillStyle = 'rgba(1, 4, 4, 0.2)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(46, 196, 182, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(canvas.width/2, 0); ctx.lineTo(canvas.width/2, canvas.height);
  ctx.moveTo(0, canvas.height/2); ctx.lineTo(canvas.width, canvas.height/2);
  ctx.stroke();

  if (isPlaying && analyserL && analyserR) {
    analyserL.getFloatTimeDomainData(dataL);
    analyserR.getFloatTimeDomainData(dataR);

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 159, 28, 0.8)';
    ctx.lineWidth = 1.5;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const scale = canvas.height * 0.45;

    for (let i = 0; i < dataL.length; i++) {
      const x = cx + (dataL[i] * scale);
      const y = cy - (dataR[i] * scale);

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    
    ctx.shadowBlur = 12;
    ctx.shadowColor = 'rgba(255, 159, 28, 0.6)';
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  
  animationId = requestAnimationFrame(drawPhaseScope);
}

export async function initPhaseSpace(canvasId, btnId) {
    canvas = document.getElementById(canvasId);
    toggleBtn = document.getElementById(btnId);
    
    if (canvas) {
        ctx = canvas.getContext('2d');
        // Initial drawing state
        ctx.fillStyle = '#051010';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (toggleBtn) {
        // Reset state from previous loads
        toggleBtn.innerText = "[ START ENGINE ]";
        isPlaying = false;
        isEngineRunning = true;
        
        // Remove existing listener to avoid duplicates if re-opened
        const newBtn = toggleBtn.cloneNode(true);
        toggleBtn.parentNode.replaceChild(newBtn, toggleBtn);
        toggleBtn = newBtn;

        toggleBtn.addEventListener('click', async () => {
            if (!hasDataLoaded) {
                toggleBtn.innerText = "[ DOWNLOADING DATA... ]";
                try {
                    const response = await fetch('data/veridis_macro_structure.json');
                    if (!response.ok) throw new Error("HTTP " + response.status);
                    const rawText = await response.text();
                    if (!parseMacroData(rawText)) throw new Error("Parse Error");
                } catch (err) {
                    console.error(err);
                    toggleBtn.innerText = "[ CONNECTION ERROR ]";
                    return;
                }
            }

            if (!audioCtx) await initSystem();
            if (audioCtx.state === 'suspended') await audioCtx.resume();

            isPlaying = !isPlaying;
            
            if (isPlaying) {
                toggleBtn.innerText = "[ HALT SIGNAL ]";
                toggleBtn.style.color = "var(--highlight, #ff3333)";
                toggleBtn.style.borderColor = "var(--highlight, #ff3333)";
                if (eventIndex === 0) {
                    globalTime = audioCtx.currentTime;
                } else {
                    globalTime = audioCtx.currentTime - (ALL_EVENTS[eventIndex].t * SPB);
                }
                coreLoop();
            } else {
                toggleBtn.innerText = "[ RESUME ENGINE ]";
                toggleBtn.style.color = "var(--accent, #ffffff)";
                toggleBtn.style.borderColor = "var(--accent, #ffffff)";
            }
        });
    }

    if (animationId) cancelAnimationFrame(animationId);
    drawPhaseScope();
}

export function stopPhaseSpace() {
    isEngineRunning = false;
    isPlaying = false;
    eventIndex = 0; // Reset for next time
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
        synthNode = null;
    }
    if (animationId) cancelAnimationFrame(animationId);
}
