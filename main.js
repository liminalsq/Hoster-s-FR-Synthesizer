(async () => {
  let sampleRate = 44100;

  // voice cloning and gender variables
  let genderShift = 0; // -100 (male) to 100 (female)
  let clonedRatios = null; // ratios for formant scaling from cloned voice
  let clonedTimbre = { harmonics: 27, duty: 0.65 }; // default
  const standardFormants = [700, 1220, 2600]; // standard formants for 'a'

  // personal dictionary and dynamic mode
  let personalDict = {}; // word -> [phoneme1, phoneme2, ...]
  let dynamicMode = false;
  let consonantDuration = 0.05;

// phonemeMap entries carry 6 formants (F4-F6 ignored by the 3-filter engine).
  // morphTo checks must accept all 6 so diphthongs keep working.
  const MAP_FORMANTS = 6;
  const ENGINE_FORMANTS = 3;

  // --- Experimental / for-fun options ---
  let disableFormantFilter = false; // bypass the biquad formant filters
  let oscType = "rosenberg";        // rosenberg(default) | sawtooth | square | custom
  let customOscSample = null;       // decoded Float32Array for custom waveform
  let customOscSampleRate = 44100;
  let synthesisMethod = "synthesized";
  const concatenativeSamples = new Map();
  const concatenativeRequiredPhonemes = [
    "a", "ae", "aa", "e", "i", "ee", "o", "u", "y", "w", "r", "l",
    "h", "s", "z", "zh", "t", "d", "dx", "k", "g", "gx", "m", "n", "b", "bx",
    "p", "f", "v", "th", "dh", "sh", "ch", "uh", "er", "jh", "ng", "ih", "rest"
  ];
  const ROSENBERG_GAIN_BOOST = 1.7;
  const NOISE_GAIN_BOOST = 1.55;

  // preview playback state (shared so re-synthesizing stops any playing preview)
  let actx = null;
  let prevSrc = null;
  let previewBuf = null;
  let previewFrameId = null;
  let drawPreviewWaveform = null;
  let lastRenderedAudio = null;
  let lastRenderedPhonemes = null;

const stopPreview = () => {
  stopVisualAnim();
    if (previewFrameId !== null) {
      cancelAnimationFrame(previewFrameId);
      previewFrameId = null;
    }
    drawPreviewWaveform?.(null);
    if (prevSrc) {
      try {
        prevSrc.onended = null;
        prevSrc.disconnect();
        prevSrc.stop();
      } catch (e) {}
      prevSrc = null;
    }
    previewBuf = null;
    setVisualIdle();
    if (actx) {
      try { if (actx.state === "running") actx.close(); } catch (e) {}
      actx = null;
    }
  };

  const resolvePortamento = (value, fallbackSeconds = 0.08, noteDuration = 0) => {
    const normalizePortamento = (candidate, fallbackNoteDuration) => {
      if (candidate == null || candidate === "") {
        return Number.isFinite(fallbackSeconds) ? Math.max(0, Number(fallbackSeconds)) : 0;
      }
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (/^auto$/i.test(trimmed)) return Math.max(0, fallbackNoteDuration * 0.5);
        const parsed = parseFloat(trimmed);
        if (Number.isFinite(parsed)) return Math.max(0, parsed);
        return Number.isFinite(fallbackSeconds) ? Math.max(0, Number(fallbackSeconds)) : 0;
      }
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
      return Number.isFinite(fallbackSeconds) ? Math.max(0, Number(fallbackSeconds)) : 0;
    };
    return normalizePortamento(value, noteDuration);
  };

  const getPortamentoStartPitch = (previous, current) => {
    if (!previous || !current || !previous.pitchIsNote || !current.pitchIsNote) {
      return previous && current && !previous.pitchIsNote && !current.pitchIsNote && previous.pitch - current.pitch >= 50
        ? current.pitch - 10
        : previous?.pitch;
    }
    const downwardSemitones = 12 * Math.log2(previous.pitch / current.pitch);
    return downwardSemitones >= 4
      ? current.pitch * Math.pow(2, -1 / 12)
      : previous.pitch;
  };

  // personal dictionary persistence functions
  function savePersonalDict(silent = false) {
    try {
      localStorage.setItem('personalDict', JSON.stringify(personalDict));
      if (!silent) console.log('Personal dictionary saved.');
    } catch (e) {
      console.warn('Failed to save personal dictionary:', e);
    }
  }

  function loadPersonalDict() {
    try {
      const stored = localStorage.getItem('personalDict');
      if (stored) {
        personalDict = JSON.parse(stored);
        console.log('Personal dictionary loaded.');
      }
    } catch (e) {
      console.warn('Failed to load personal dictionary:', e);
    }
  }

  // load on initialization
  loadPersonalDict();

  // adjust formants for gender and cloning
  const getAdjustedFormants = (baseF) => {
    let f = [...baseF];
    if (clonedRatios) {
      // apply cloned voice ratios (voice cloning only supplies 3 formants, so
      // guard the extra F4+ entries against NaN when the map has 6 formants)
      f = f.map((freq, i) => freq * (clonedRatios[i] ?? 1));
    }
    // gender shift: scale frequencies (female higher, male lower)
    const scale = 1 + (genderShift / 100) * 0.3; // Â±30%
    f = f.map(freq => freq * scale);
    return f;
  };

  // extract voice parameters from uploaded audio
  const extractVoiceParameters = (audioBuffer) => {
    // Improved extraction: analyze spectrum with time-averaging for better formant detection
    const sampleRate = audioBuffer.sampleRate;
    const data = audioBuffer.getChannelData(0);
    const fftSize = 2048;
    const analyser = new AnalyserNode(new (window.AudioContext || window.webkitAudioContext)(), { fftSize });
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Time-average the spectrum over the entire buffer for sustained vowel assumption
    const avgSpectrum = new Uint8Array(bufferLength);
    const windowSize = Math.floor(data.length / 10); // divide into 10 windows
    for (let w = 0; w < 10; w++) {
      const start = w * windowSize;
      const end = Math.min((w + 1) * windowSize, data.length);
      analyser.getByteFrequencyData(dataArray);
      for (let i = 0; i < bufferLength; i++) {
        avgSpectrum[i] += dataArray[i];
      }
    }
    for (let i = 0; i < bufferLength; i++) {
      avgSpectrum[i] /= 10;
    }

    // Improved peak finding with parabolic interpolation for sub-bin accuracy
    const findPeak = (startHz, endHz) => {
      const startBin = Math.floor(startHz / (sampleRate / 2) * bufferLength);
      const endBin = Math.floor(endHz / (sampleRate / 2) * bufferLength);
      let maxVal = 0;
      let maxBin = startBin;
      for (let i = startBin; i <= endBin && i < bufferLength; i++) {
        if (avgSpectrum[i] > maxVal) {
          maxVal = avgSpectrum[i];
          maxBin = i;
        }
      }
      // Parabolic interpolation for better accuracy
      if (maxBin > startBin && maxBin < endBin) {
        const a = avgSpectrum[maxBin - 1];
        const b = avgSpectrum[maxBin];
        const c = avgSpectrum[maxBin + 1];
        const p = 0.5 * (a - c) / (a - 2 * b + c);
        maxBin += p;
      }
      return maxBin / bufferLength * (sampleRate / 2);
    };

    const f1 = findPeak(400, 1000);
    const f2 = findPeak(1000, 2000);
    const f3 = findPeak(2000, 3500);

    const extractedFormants = [f1 || 700, f2 || 1220, f3 || 2600];
    clonedRatios = extractedFormants.map((f, i) => f / standardFormants[i]);
    clonedTimbre = { harmonics: 27, duty: 0.55 }; // keep default for now
  };

  // phoneme -> formant settings
  const phonemeMap = {
    // --- VOWELS & LIQUIDS ---
    a:   { f: [700, 1220, 2600, 3500, 4500, 5500], voiced: true },
    ax:   { f: [620, 1220, 2550, 3500, 4500, 5500], voiced: true },
    ae:  { f: [620, 1660, 2430, 3700, 4700, 5700], voiced: true, morphTo: [650, 1490, 2470, 3700, 4700, 5700] },
    aa:  { f: [900, 1300, 2650, 3550, 4500, 5500], voiced: true },
    e:   { f: [530, 1680, 2500, 3600, 4600, 5600], voiced: true, morphTo: [620, 1530, 2530, 3600, 4600, 5600] },
    i:   { f: [350, 2200, 2900, 3600, 4500, 5500], voiced: true },
    ee:  { f: [285, 2275, 2900, 3650, 4650, 5650], voiced: true },
    o:   { f: [400, 1000, 2600, 3400, 4400, 5400], voiced: true },
    u:   { f: [350, 1250, 2200, 3300, 4300, 5300], voiced: true},
    y:   { f: [300, 2000, 2800, 3600, 4600, 5600], voiced: true },
    w:   { f: [290, 610, 2150, 3300, 4300, 5300], voiced: true },
    r:   { f: [450, 1300, 1700, 3200, 4300, 5300], voiced: true },
    l:   { f: [310, 1050, 2880, 3500, 4500, 5500], voiced: true },

    // --- CONSONANTS & SIBILANTS ---
    h:  { f: [750,  1750, 3150, 3800, 4800, 5800], breathy: true, amp: 0.9, voiced: false, noiseAmp: 1 },
    s:  { f: [320, 1390, 5500, 5900, 6800, 7800], breathy: true, amp: 1.4, voiced: false, noiseAmp: 1 },
    z:  { f: [240, 1390, 5500, 5800, 6700, 7700], breathy: true, amp: 1.4, voiced: true,  noiseAmp: 0.185 },
    zh: { f: [270, 1840, 2750, 5800, 6700, 7700], breathy: true, amp: 1.4, voiced: true,  noiseAmp: 0.2 },
    t:  { f: [400,  1600, 2600, 4900, 5900, 6900], burst: true, amp: 0.9, voiced: false, noiseAmp: 1.4, morphs: false },
    d:  { f: [200,  1600, 2600, 3800, 4800, 5800], breathy: true, burst: true, amp: 0.55, voiced: true, short: true, noiseAmp: 0.2, morphs: false },
    dx:  { f: [200,  1600, 2600, 3800, 4800, 5800], breathy: true, burst: true, amp: 0.55, voiced: true, short: true, noiseAmp: 0.02, morphs: false },
    k:  { f: [300, 1990, 2850, 4100, 5100, 6100], burst: true, short: true, voiced: false, noiseAmp: 1 },
    g:  { f: [200,  1990, 2850, 3600, 4600, 5600], breathy: true, burst: true, voiced: true, short: true, noiseAmp: 0.3, morphs: false },
    gx:  { f: [200,  1990, 2850, 3600, 4600, 5600], breathy: true, burst: true, voiced: true, short: true, noiseAmp: 0.035, morphs: false },


    // --- NASALS & PLOSIVES/FRICATIVES ---
    n:  { f: [270,  1340, 2470, 3400, 4400, 5400], voiced: true, nasal: true, noiseAmp: 1 },
    m:  { f: [270,  1270, 2130, 3300, 4300, 5300], voiced: true, nasal: true, noiseAmp: 1 },
    b:  { f: [200,  1100, 2150, 3400, 4400, 5400], breathy: true, burst: true, voiced: true, short: true, noiseAmp: 0.35, morphs: false },
    bx:  { f: [200,  1100, 2150, 3400, 4400, 5400], breathy: true, burst: true, voiced: true, short: true, noiseAmp: 0.035, morphs: false },
    p:  { f: [400,  1100, 2150, 3600, 4600, 5600], burst: true, short: true, voiced: false, noiseAmp: 1 },
    f:  { f: [1150, 2950, 4950, 5900, 6800, 7800], breathy: true, voiced: false, noiseAmp: 1 },
    v:  { f: [220,  1100, 2080, 4200, 5200, 6200], breathy: true, voiced: true, noiseAmp: 0.225, amp: 0.575 },
    th: { f: [1150, 2150, 3450, 4500, 5500, 6500], breathy: true, voiced: false, noiseAmp: 1 },
    dh: { f: [270,  1290, 2540, 3800, 4800, 5800], breathy: true, voiced: true, noiseAmp: 0.25, amp: 0.55 },
    sh: { f: [2450, 3050, 3950, 4900, 5900, 6900], breathy: true, voiced: false, noiseAmp: 1 },
    ch: { f: [350, 1800, 2820, 5400, 6400, 7400], breathy: true, burst: true, voiced: false, noiseAmp: 1, usePinkNoise: true },
    uh: { f: [450,  1100,  2350, 3500, 4500, 5500], voiced: true },

    // --- ADDED PHONES & DIPHTHONGS ---
    er: { f: [550, 1200, 2450, 3300, 4300, 5300], morphTo: [450, 1300, 1700, 3200, 4300, 5300], voiced: true },
    jh:  { f: [260, 1800, 2820, 3600, 4600, 5600], voiced: true, breathy: true, amp: 0.8, noiseAmp: 0.15 },
    ng: { f: [200, 850,  1950, 3300, 4300, 5300], voiced: true, nasal: true },

    oy: { f: [400, 1000, 2600, 3400, 4400, 5400], morphTo: [350, 2200, 2900, 3600, 4500, 5500], voiced: true },
    ow: { f: [400, 1000, 2600, 3400, 4400, 5400], morphTo: [290, 610, 2150, 3300, 4300, 5300], voiced: true },
    ou: { f: [400, 1000, 2600, 3400, 4400, 5400], morphTo: [325, 700,  2530, 3300, 4300, 5300], voiced: true },
    ol: { f: [400, 1000, 2600, 3400, 4400, 5400], morphTo: [310, 1050, 2880, 3500, 4500, 5500], voiced: true },
    or: { f: [400, 1000, 2600, 3400, 4400, 5400], morphTo: [450, 1300, 1700, 3200, 4300, 5300], voiced: true },

    ay: { f: [650, 1250, 2550, 3500, 4500, 5500], morphTo: [350, 2200, 2900, 3600, 4500, 5500], voiced: true },
    aw: { f: [650, 1250, 2550, 3500, 4500, 5500], morphTo: [400, 1000, 2600, 3400, 4400, 5400], voiced: true },
    ar: { f: [700, 1220, 2600, 3500, 4500, 5500], morphTo: [450, 1300, 1700, 3200, 4300, 5300], voiced: true },
    al: { f: [650, 1250, 2550, 3500, 4500, 5500], morphTo: [310, 1050, 2880, 3500, 4500, 5500], voiced: true },
    ao: { f: [650, 990, 2570, 3500, 4500, 5500], morphTo: [630, 1040, 2600, 3500, 4500, 5500], voiced: true },
    aee:{ f: [600, 1250, 2550, 3500, 4500, 5500], morphTo: [285, 2275, 2900, 3650, 4650, 5650], voiced: true },

    ew: { f: [300, 2000, 2800, 3600, 4600, 5600], morphTo: [325, 700,  2530, 3300, 4300, 5300], voiced: true },
    eu: { f: [300, 2000, 2800, 3600, 4600, 5600], morphTo: [325, 700,  2530, 3300, 4300, 5300], voiced: true },
    ey: { f: [530, 1680, 2500, 3600, 4600, 5600], morphTo: [300, 2000, 2800, 3600, 4600, 5600], voiced: true },
    el: { f: [530, 1680, 2500, 3600, 4600, 5600], morphTo: [310, 1050, 2880, 3500, 4500, 5500], voiced: true },
    ex: { f: [500, 1700, 2300, 3600, 4600, 5600], voiced: true },

    uw: { f: [350, 1250, 2200, 3300, 4300, 5300], morphTo: [320, 900, 2200, 3300, 4300, 5300], voiced: true },
    ul: { f: [350, 1250, 2200, 3300, 4300, 5300], morphTo: [310, 1050, 2880, 3500, 4500, 5500], voiced: true },
    ur: { f: [350, 1250, 2200, 3300, 4300, 5300], morphTo: [420, 1300, 1700, 3200, 4300, 5300], voiced: true },

    iw: { f: [300, 2000, 2800, 3600, 4600, 5600], morphTo: [325, 700,  2530, 3300, 4300, 5300], voiced: true },
    il: { f: [300, 2000, 2800, 3600, 4600, 5600], morphTo: [310, 1050, 2880, 3500, 4500, 5500], voiced: true },
    ir: { f: [300, 2000, 2800, 3600, 4600, 5600], morphTo: [420, 1300, 1700, 3200, 4300, 5300], voiced: true },
    iy: { f: [300, 2000, 2800, 3600, 4600, 5600], morphTo: [285, 2275, 2900, 3650, 4650, 5650], voiced: true },

    ih: { f: [400, 1800, 2570, 3600, 4600, 5600], morphTo: [470, 1600, 2600, 3600, 4500, 5500], voiced: true },

    rest: { f: [0, 0, 0, 0, 0, 0], voiced: false, burst: false, short: false, breathy: false }
  };

  // --- CMUdict-based G2P + ARPAbet -> phonemeKey converter ---
  let CMUDICT = null;
  const CMUDICT_URL = "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict";
  let useCMUDict = false;

  async function loadCMUDict(url = CMUDICT_URL) {
    if (CMUDICT) return CMUDICT;
    const res = await fetch(url);
    if (!res.ok) throw new Error("failed to fetch CMUdict: " + res.status);
    const txt = await res.text();
    const map = new Map();
    const lines = txt.split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.startsWith(";;;")) continue;
      const m = line.match(/^([A-Z'()]+)\s+(.*)$/);
      if (!m) continue;
      const wordRaw = m[1].replace(/\(\d+\)$/, "");
      const word = wordRaw.toLowerCase();
      const arp = m[2].trim().split(/\s+/);
      if (!map.has(word)) map.set(word, arp);
    }
    CMUDICT = map;
    return CMUDICT;
  }

  const arpabetMap = {
    "AA":["aa"],"AE":["a"],"AH":["uh"],"AO":["o"],"AW":["aw"],
    "AY":["aa"],"EH":["e"],"ER":["er"],"EY":["ee"],"IH":["I"],
    "IY":["ee"],"OW":["o"],"OY":["oy"],"UH":["uh"],"UW":["u"],
    "B":["b"],"CH":["ch"],"D":["d"],"DH":["th"],"F":["f"],"G":["g"],
    "HH":["h"],"JH":["jh"],"K":["k"],"L":["l"],"M":["m"],"N":["n"],
    "NG":["ng"],"P":["p"],"R":["r"],"S":["s"],"SH":["sh"],"T":["t"],
    "TH":["th"],"V":["v"],"W":["w"],"Y":["y"],"Z":["z"],"ZH":["z"]
  };

  const DYNAMIC_CONSONANTS = new Set([
    "h", "n", "m", "s", "z", "t", "d", "r", "l", "b", "p", "k", "g",
    "f", "v", "w", "y", "th", "dh", "sh", "ch", "jh", "ng", "dx", "gx", "bx",
    "zh",
  ]);
  const DYNAMIC_STOPS = new Set(["t", "p", "d", "b", "k", "g", "dx", "bx", "gx"]);

  function arpabetToKeys(arpArr) {
    const out = [];
    for (let token of arpArr) {
      token = token.replace(/\d+$/, "");
      const mapped = arpabetMap[token];
      if (mapped) out.push(...mapped);
      else out.push(token.toLowerCase());
    }
    return out;
  }

  async function textToPhonemes(word) {
    if (!word || !word.trim()) return [];
    const w = word.toLowerCase().replace(/[^a-z']/g, "");
    if (w.length === 0) return [];

    // Check personal dictionary first
    if (personalDict[w]) {
      return personalDict[w].slice();
    }

    if (useCMUDict) {
      try {
        await loadCMUDict();
        if (CMUDICT && CMUDICT.has(w)) {
          const arp = CMUDICT.get(w).slice();
          return arpabetToKeys(arp);
        }
      } catch (e) {
        console.warn("CMUdict load/lookup failed:", e);
      }
    }

    // Greedy fallback (multigraphs + contextual c/g)
    const multigraphRules = [
      ["tion", ["sh","uh","n"]], ["tch", ["ch"]], ["ch", ["ch"]], ["sh", ["sh"]],
      ["ph", ["f"]], ["ng", ["ng"]], ["jh", ["jh"]], ["qu", ["k","w"]], ["wh", ["w"]],
      ["kn", ["n"]], ["wr", ["r"]], ["ee", ["ee"]], ["ea", ["ee"]],
      ["ai", ["aa"]], ["ay", ["aa"]], ["oa", ["o"]], ["oo", ["u"]],
      ["ow", ["o"]], ["oy", ["oy"]], ["au", ["aw"]], ["ough", ["o"]]
    ];
    multigraphRules.sort((a,b) => b[0].length - a[0].length);

    const single = {
      a:"a", b:"b", c:"c", d:"d", e:"e", f:"f", g:"g", h:"h",
      i:"i", j:"j", k:"k", l:"l", m:"m", n:"n", o:"o", p:"p",
      q:"q", r:"r", s:"s", t:"t", u:"u", v:"v", w:"w", x:"x", y:"y", z:"z"
    };

    const out = [];
    let i = 0;
    while (i < w.length) {
      let matched = false;
      for (const [pat, phon] of multigraphRules) {
        if (w.startsWith(pat, i)) {
          out.push(...phon);
          i += pat.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      if (w[i] === "'") { i++; continue; }
      const ch = w[i];
      if (ch === "c") {
        const next = w[i+1] || "";
        out.push(...("eiy".includes(next) ? ["s"] : ["k"]));
        i++; continue;
      }
      if (ch === "g") {
        const next = w[i+1] || "";
        out.push(...("eiy".includes(next) ? ["j"] : ["g"]));
        i++; continue;
      }
      if (ch === "x") { out.push("k","s"); i++; continue; }
      if (single[ch]) out.push(single[ch]); else out.push(ch);
      i++;
    }
    return out;
  }

  // helper: convert musical note to frequency, returns numeric freq if note parse fails
  const noteToFreq = (note) => {
    const A4 = 440;
    const semitoneMap = {
      C: -9, "C#": -8, Db: -8,
      D: -7, "D#": -6, Eb: -6,
      E: -5, F: -4, "F#": -3, Gb: -3,
      G: -2, "G#": -1, Ab: -1,
      A: 0, "A#": 1, Bb: 1, B: 2,
    };
    const match = /^([A-Ga-g])([#b]?)(\d)$/.exec(note);
    if (!match) return parseFloat(note);
    const [, base, accidental, octave] = match;
    const name = base.toUpperCase() + (accidental || "");
    const semis = semitoneMap[name] ?? 0;
    const semitonesFromA4 = (parseInt(octave) - 4) * 12 + semis;
    return A4 * Math.pow(2, semitonesFromA4 / 12);
  };

  // parseInput async: supports grid types and uses textToPhonemes for words
  const parseInput = async (text, beatLen, gridType = "beats", stepsPerBeat = 4) => {
  // Token formats:
  // phon <NOTE,duration>     (sets the current pitch)
  // phon <duration>          (reuses the current pitch)
  // phon phon phon <NOTE,duration> (spaced phonemes share one timing)
  // phon <NOTE,duration,vibFreqHz,vibDelayBeats,vibFadeInBeats,vibSpeedBeats>
  // [settings] phon <NOTE,duration>  (settings persist until changed or reset)
  //   fs   = formant scale (e.g. 0.5 male, 1.5 female)
  //   vd   = vibrato depth (Hz)
  //   vf   = vibrato frequency (Hz)
  //   vde  = vibrato delay (seconds)
  //   vfa  = vibrato fade-in (seconds)
  //   vfao = vibrato fade-out (seconds)
  // Phoneme vibrato fields inside <>:
  // - vibDelay, vibFadeIn are in BEATS-based units; vibSpeed overrides vibrato rate.
  // - NOTE is a pitch name (e.g. C#4) and duration is in units per gridType.
  const parseBracketSettings = (s) => {
    const out = {};
    if (!s) return out;
    const re = /\b(fs|vd|vf|vde|vdae|vfa|vfao|sl|slide|fm|fmorph|port|portamento|pt)\s*(?::|=)?\s*(auto|-?(?:\d+(?:\.\d*)?|\.\d+))/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const rawKey = m[1].toLowerCase();
      const key = rawKey === "vdae" ? "vde" : rawKey === "sl" ? "slide" : rawKey === "fm" ? "fmorph" : rawKey;
      const rawValue = m[2].trim();
      out[key] = /^auto$/i.test(rawValue) ? "auto" : parseFloat(rawValue);
    }
    return out;
  };
  // Apply per-phoneme vibrato overrides from [settings] brackets and <...> extra
  // fields. Only fields that are explicitly provided are stored on the phoneme;
  // anything else falls back to the global vibrato settings at synthesis time.
  const applyPerNoteVibrato = (p, settings, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats) => {
    if (settings.fs !== 1) {
      p.f = p.f.map(x => x * settings.fs);
      if (p.morphTo) p.morphTo = p.morphTo.map(x => x * settings.fs);
    }
    if (Number.isFinite(settings.vf)) p.vibFreq = settings.vf;
    if (Number.isFinite(settings.vd)) p.vibDepth = settings.vd;
    if (Number.isFinite(settings.vde)) p.vibDelay = settings.vde;
    if (Number.isFinite(settings.vfa)) p.vibFadeIn = settings.vfa;
    if (Number.isFinite(settings.vfao)) p.vibFadeOut = settings.vfao;
    if (settings.slide != null) p.slideTime = settings.slide;
    if (settings.fmorph != null) {
      p.morphTime = settings.fmorph;
      p.morphEnabled = settings.fmorph > 0;
    }
    if (settings.portamento != null) p.portamento = settings.portamento;
    if (settings.port != null) p.portamento = settings.port;
    if (settings.pt != null) p.portamento = settings.pt;
    p.vibratoOverride = Number.isFinite(settings.vf) || Number.isFinite(settings.vd) ||
      Number.isFinite(settings.vde) || Number.isFinite(settings.vfa) || Number.isFinite(settings.vfao) ||
      vibFreqHz !== null || vibDelayBeats !== null || vibFadeInBeats !== null || vibSpeedBeats !== null;
    if (vibFreqHz !== null && Number.isFinite(vibFreqHz)) p.vibFreq = vibFreqHz;
    if (vibSpeedBeats !== null && Number.isFinite(vibSpeedBeats)) p.vibSpeed = vibSpeedBeats;
    if (vibDelayBeats !== null && Number.isFinite(vibDelayBeats)) p.vibDelay = vibDelayBeats * beatLen;
    if (vibFadeInBeats !== null && Number.isFinite(vibFadeInBeats)) p.vibFadeIn = vibFadeInBeats * beatLen;
  };

    const regex = /(\[[^\]]*\])?\s*([a-zA-Z']+(?:\s+[a-zA-Z']+)*)\s*<\s*([^>]+)\s*>/gi;
    const result = [];
    const defaultSettings = { fs: 1, vd: null, vf: null, vde: null, vfa: null, vfao: null, slide: null, fmorph: null, portamento: null };
    let persistentSettings = { ...defaultSettings };
    let currentPitch = noteToFreq("C4");
    let currentPitchIsNote = true;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const bracketText = match[1] || "";
      if (/\breset\b/i.test(bracketText)) persistentSettings = { ...defaultSettings };
      Object.assign(persistentSettings, parseBracketSettings(bracketText));
      const settings = { ...persistentSettings };
      const tokenRaw = match[2];
      const token = tokenRaw.trim().toLowerCase();
      const hasSeparatedPhonemes = /\s/.test(token);
      const fields = match[3].split(",").map(field => field.trim());
      const hasExplicitPitch = fields.length > 1;
      const pitchRaw = hasExplicitPitch ? fields[0] : null;
      const units = parseFloat(hasExplicitPitch ? fields[1] : fields[0]);
      if (!Number.isFinite(units)) continue;
      if (hasExplicitPitch) {
        const parsedPitch = noteToFreq(pitchRaw);
        if (Number.isFinite(parsedPitch)) {
          currentPitch = parsedPitch;
          currentPitchIsNote = /^([A-Ga-g])([#b]?)\d$/.test(pitchRaw);
        }
      }
      const pitch = currentPitch;

      // Optional per-phoneme vibrato fields (beats-based):
      // fields[2]=vibFreqHz, fields[3]=vibDelayBeats, fields[4]=vibFadeInBeats, fields[5]=vibSpeedBeats
      const vibFreqHz = fields[2] != null && fields[2] !== "" ? parseFloat(fields[2]) : null;
      const vibDelayBeats = fields[3] != null && fields[3] !== "" ? parseFloat(fields[3]) : null;
      const vibFadeInBeats = fields[4] != null && fields[4] !== "" ? parseFloat(fields[4]) : null;
      const vibSpeedBeats = fields[5] != null && fields[5] !== "" ? parseFloat(fields[5]) : null;

      // compute duration from units based on grid type
      let dur = 0;
      if (gridType === "beats") dur = units * beatLen;
      else if (gridType === "steps") dur = (units / stepsPerBeat) * beatLen;
      else if (gridType === "seconds") dur = units;
      else dur = units * beatLen;

      // exact phoneme key match
      if (!hasSeparatedPhonemes && phonemeMap[token]) {
        let p = { key: token, ...phonemeMap[token], d: dur, pitch, pitchIsNote: currentPitchIsNote };
        p.f = getAdjustedFormants(p.f);
        if (p.morphTo) p.morphTo = getAdjustedFormants(p.morphTo);

        applyPerNoteVibrato(p, settings, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats);

        result.push(p);
        continue;
      }

      // otherwise treat token as a word and convert to phoneme keys
      const parts = hasSeparatedPhonemes
        ? token.split(/\s+/)
        : await textToPhonemes(tokenRaw);
      if (!parts || parts.length === 0) continue;
      let partDurations = parts.map(() => dur / Math.max(1, parts.length));
      if (dynamicMode) {
        const consonantCount = parts.filter(part => DYNAMIC_CONSONANTS.has(part.toLowerCase())).length;
        const vowelCount = parts.length - consonantCount;
        const consonantBudget = consonantCount * Math.min(consonantDuration, dur / Math.max(1, consonantCount));
        const vowelDuration = vowelCount > 0
          ? Math.max(0, dur - consonantBudget) / vowelCount
          : 0;
        partDurations = parts.map(part => DYNAMIC_CONSONANTS.has(part.toLowerCase())
          ? Math.min(consonantDuration, dur / Math.max(1, consonantCount))
          : vowelDuration);
      }
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        const partDur = partDurations[partIndex];
        const key = part.toLowerCase();
        if (phonemeMap[key]) {
          let p = { key, ...phonemeMap[key], d: partDur, pitch, pitchIsNote: currentPitchIsNote, dynamicDurationApplied: dynamicMode };
          p.f = getAdjustedFormants(p.f);
          if (p.morphTo) p.morphTo = getAdjustedFormants(p.morphTo);

          applyPerNoteVibrato(p, settings, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats);

          result.push(p);
        } else {
          const fallbackMap = {
            a: "a", e: "e", i: "i", o: "o", u: "u",
            h: "h", n: "n", m: "m", s: "s", t: "t", d: "d", r: "r", l: "l",
            b: "b", p: "p", k: "k", g: "g", f: "f", v: "v", y: "y", j: "j",
            ng: "ng", er: "er", oy: "oy", aw: "aw"
          };
          const fm = (fallbackMap[key] || "rest");
          let p = { key: fm, ...phonemeMap[fm], d: partDur, pitch, pitchIsNote: currentPitchIsNote, dynamicDurationApplied: dynamicMode };
          p.f = getAdjustedFormants(p.f);
          if (p.morphTo) p.morphTo = getAdjustedFormants(p.morphTo);

          applyPerNoteVibrato(p, settings, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats);

          result.push(p);
        }
      }
    }
    return result;
  };

  // noise buffers
  // Spec update: NEVER use brown noise for TTS.
  // Use:
  // - White noise for unvoiced fricatives & bursts
  // - Pink noise for voiced fricatives & aspiration

  const createWhiteNoiseBuffer = (ctx, duration, amp = 0.08) => {
    const len = Math.max(1, Math.floor(duration * ctx.sampleRate));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * amp * NOISE_GAIN_BOOST;
    return buffer;
  };

  // Paul Kellet pink noise (filter method)
  const createPinkNoiseBuffer = (ctx, duration, amp = 0.25) => {
    const len = Math.max(1, Math.floor(duration * ctx.sampleRate));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      const pink = b0 + b1 + b2 + white * 0.1848;
      data[i] = pink * amp * NOISE_GAIN_BOOST;
    }
    return buffer;
  };

  // Whisper should preserve the natural noise color of each phoneme: white for
  // unvoiced fricatives/bursts, pink for voiced/aspirated noise.
  const createWhisperNoiseBuffer = (ctx, duration, amp = 0.09, { voiced = false, usePinkNoise = false } = {}) => {
    return (voiced || usePinkNoise) ? createPinkNoiseBuffer(ctx, duration, amp) : createWhiteNoiseBuffer(ctx, duration, amp);
  };

  // Pick noise type by phonation.
  // voiced fricatives/aspiration => pink
  // unvoiced fricatives/bursts => white
  const createFricativeNoiseBuffer = (ctx, duration, { voiced = false, amp = 0.0, usePinkNoise = false } = {}) => {
    return (usePinkNoise || voiced) ? createPinkNoiseBuffer(ctx, duration, amp) : createWhiteNoiseBuffer(ctx, duration, amp);
  };

  const getVoicedGain = (amp) => amp * 0.89 * (oscType === "rosenberg" ? ROSENBERG_GAIN_BOOST : 1);

  // Rosenberg (1971) glottal pulse model.
  // Builds one period of the classic glottal FLOW waveform:
  //   - Open phase:    u(x) = 3x^2 - 2x^3, x = t/(OQ*T)   (0 -> 1, zero slope at both ends)
  //   - Return phase:  fast exponential decay back to zero (LF-style closure)
  //   - Closed phase:  u = 0
  // The glottal flow DERIVATIVE (the standard voiced excitation in formant
  // synthesis, e.g. Klatt's KLGLOTT88) is obtained by numeric differentiation
  // and then decomposed via DFT into real/imag coefficients so the pulse keeps
  // the correct phase relationships between harmonics (a real glottal source has
  // roughly -12 dB/octave roll-off plus a characteristic phase dispersion that a
  // naive 1/n^2 cosine series cannot reproduce).
  const createRosenbergGlottalWave = (
    ctx, 
    numHarmonics = 27, 
    openQuotient = 0.55, 
    returnQuotient = 0.2,
    vocalEffort = 0.8, // Increased default effort level
  ) => {
    const nH = Math.max(1, numHarmonics | 0);
    const real = new Float32Array(nH);
    const imag = new Float32Array(nH);

    // Clamp effort between 0 (softest) and 1 (highest effort)
    const effort = Math.min(1.0, Math.max(0.0, vocalEffort));

    // High vocal effort causes:
    // 1. Shorter open quotient (OQ drops down toward ~0.35)
    // 2. Faster glottal closure / lower return quotient (RQ drops toward ~0.03)
    const OQ = Math.min(0.95, Math.max(0.1, openQuotient * (1.0 - 0.35 * effort)));
    const RQ = Math.min(0.4, Math.max(0.02, returnQuotient * (1.0 - 0.7 * effort)));

    // Peak Glottal Flow asymmetry ratio
    const alpha = 1.0 / (1.0 - OQ); 

    // Corner frequency cutoff shifts higher with effort (less spectral tilt attenuation)
    const spectralTiltCutoff = 1.0 / (2.0 * Math.PI * RQ);

    // High effort reduces the steepness of the spectral slope (roll-off drops from ~1.05 to ~0.55)
    const spectralSlopeExponent = 1.05 - (0.50 * effort);

    for (let k = 1; k < nH; k++) {
      const normalizedFreq = k / (nH * 0.5);
      
      // Spectral tilt filter (corner frequency shifts higher under effort)
      const tiltAttenuation = 1.0 / (1.0 + Math.pow(k / spectralTiltCutoff, 2));
      
      // Boosted magnitude for high harmonics under greater effort
      const mag = (1.0 / Math.pow(k, spectralSlopeExponent)) * tiltAttenuation;

      // Asymmetric Phase alignment (sharper excitation peak)
      const phase = -Math.PI * k * OQ * (1.0 - 0.25 * alpha * normalizedFreq);

      // Convert Polar -> Rectangular
      real[k] = mag * Math.cos(phase);
      imag[k] = mag * Math.sin(phase);
    }

    // Normalize against fundamental (F0) magnitude so energy remains predictable
    const f0mag = Math.hypot(real[1], imag[1]) || 1;
    for (let k = 1; k < nH; k++) {
      real[k] /= f0mag;
      imag[k] /= f0mag;
    }

    // Strip DC offset
    real[0] = 0;
    imag[0] = 0;

    return ctx.createPeriodicWave(real, imag);
  };

  // Liljencrants-Fant-style glottal flow derivative. The LF source models the
  // asymmetric open phase with an exponential sinusoid and the closing phase
  // with a short exponential return, then uses its derivative as excitation.
  const createLFGlottalWave = (ctx, numHarmonics = 27, openQuotient = 0.55, returnQuotient = 0.2) => {
    const nH = Math.max(2, numHarmonics | 0);
    const sampleCount = 1024;
    const flow = new Float32Array(sampleCount + 1);
    const OQ = Math.min(0.9, Math.max(0.35, openQuotient));
    const RQ = Math.min(0.4, Math.max(0.02, returnQuotient));
    const openSamples = Math.max(2, Math.floor(sampleCount * OQ));
    const returnSamples = Math.max(1, Math.floor(sampleCount * RQ));
    const peakSample = Math.max(1, Math.floor(openSamples * 0.6));

    for (let i = 0; i <= sampleCount; i++) {
      if (i <= openSamples) {
        const x = i / openSamples;
        const peakX = peakSample / openSamples;
        const phase = Math.min(1, x / peakX);
        const growth = 3.5 * phase;
        flow[i] = Math.exp(growth - 3.5 * phase * phase) * Math.sin(Math.PI * phase * 0.5);
      } else {
        const closingProgress = Math.min(1, (i - openSamples) / returnSamples);
        flow[i] = Math.exp(-7 * closingProgress);
      }
    }

    const real = new Float32Array(nH);
    const imag = new Float32Array(nH);
    for (let k = 1; k < nH; k++) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < sampleCount; i++) {
        const derivative = flow[i + 1] - flow[i];
        const phase = 2 * Math.PI * k * i / sampleCount;
        re += derivative * Math.cos(phase);
        im -= derivative * Math.sin(phase);
      }
      real[k] = re;
      imag[k] = im;
    }

    const fundamental = Math.hypot(real[1], imag[1]) || 1;
    for (let k = 1; k < nH; k++) {
      real[k] /= fundamental;
      imag[k] /= fundamental;
    }
    return ctx.createPeriodicWave(real, imag);
  };

  // Build a PeriodicWave from a single detected period of an uploaded sample.
  const createPeriodicWaveFromSample = (ctx, data, sr) => {
    const N = Math.min(4096, data.length);
    const seg = data.slice(0, N);
    // Autocorrelation to find the period length in samples.
    const minLag = Math.max(1, Math.floor(sr / 2000));
    const maxLag = Math.min(N - 2, Math.floor(sr / 40));
    let bestCorr = -Infinity;
    let period = Math.floor(sr / 220);
    for (let lag = minLag; lag < maxLag; lag++) {
      let corr = 0;
      const span = N - lag;
      for (let i = 0; i < span; i++) corr += seg[i] * seg[i + lag];
      corr /= span;
      if (corr > bestCorr) { bestCorr = corr; period = lag; }
    }
    const pN = Math.max(2, Math.min(period, N));
    const onePeriod = new Float32Array(pN);
    for (let i = 0; i < pN; i++) onePeriod[i] = seg[i];
    const numHarmonics = 27;
    const real = new Float32Array(numHarmonics);
    const imag = new Float32Array(numHarmonics);
    const scale = 2 / pN;
    for (let k = 1; k < numHarmonics; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < pN; n++) {
        const ph = 2 * Math.PI * k * n / pN;
        re += onePeriod[n] * Math.cos(ph);
        im += onePeriod[n] * Math.sin(ph);
      }
      real[k] = re * scale;
      imag[k] = im * scale;
    }
    const f0mag = Math.hypot(real[1], imag[1]) || 1;
    for (let k = 1; k < numHarmonics; k++) { real[k] /= f0mag; imag[k] /= f0mag; }
    real[0] = 0; imag[0] = 0;
    return ctx.createPeriodicWave(real, imag);
  };

  // Create an oscillator configured per the selected experimental oscillator type.
  const createSelectedOsc = (ctx) => {
    const osc = ctx.createOscillator();
    const t = oscType || "rosenberg";
    if (t === "sawtooth") osc.type = "sawtooth";
    else if (t === "square") osc.type = "square";
    else if (t === "lf") {
      osc.setPeriodicWave(createLFGlottalWave(ctx, 27, clonedTimbre.duty));
    }
    else if (t === "custom" && customOscSample) {
      osc.setPeriodicWave(createPeriodicWaveFromSample(ctx, customOscSample, customOscSampleRate));
    } else {
      osc.setPeriodicWave(createRosenbergGlottalWave(ctx, 27, clonedTimbre.duty));
    }
    return osc;
  };

  const estimateSampleFormants = (buffer) => {
    const data = buffer.getChannelData(0);
    const sampleCount = Math.min(data.length, 4096);
    const bins = 256;
    const order = 12;
    const autocorrelation = new Float64Array(order + 1);
    for (let lag = 0; lag <= order; lag++) {
      for (let i = 0; i < sampleCount - lag; i++) autocorrelation[lag] += data[i] * data[i + lag];
    }
    const lpc = new Float64Array(order + 1);
    lpc[0] = 1;
    let error = autocorrelation[0] || 1;
    for (let i = 1; i <= order; i++) {
      let reflection = autocorrelation[i];
      for (let j = 1; j < i; j++) reflection -= lpc[j] * autocorrelation[i - j];
      reflection /= Math.max(error, 1e-9);
      const previous = lpc.slice();
      lpc[i] = reflection;
      for (let j = 1; j < i; j++) lpc[j] = previous[j] - reflection * previous[i - j];
      error *= Math.max(0.001, 1 - reflection * reflection);
    }
    const spectrum = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin++) {
      const frequency = (bin + 1) * buffer.sampleRate / (bins * 2);
      let real = 0;
      let imag = 0;
      const phaseStep = 2 * Math.PI * frequency / buffer.sampleRate;
      for (let i = 0; i <= order; i++) {
        real += lpc[i] * Math.cos(phaseStep * i);
        imag -= lpc[i] * Math.sin(phaseStep * i);
      }
      spectrum[bin] = 1 / Math.max(1e-6, Math.hypot(real, imag));
    }
    const formants = [];
    for (let bin = 2; bin < bins - 2 && formants.length < ENGINE_FORMANTS; bin++) {
      if (spectrum[bin] >= spectrum[bin - 1] && spectrum[bin] >= spectrum[bin + 1]) {
        const frequency = (bin + 1) * buffer.sampleRate / (bins * 2);
        if (frequency >= 180 && frequency <= 7000 && (!formants.length || frequency > formants[formants.length - 1] + 180)) {
          formants.push(frequency);
        }
      }
    }
    return formants.concat([700, 1800, 3000]).slice(0, ENGINE_FORMANTS);
  };

  const estimateSamplePitch = (buffer) => {
    const data = buffer.getChannelData(0);
    const sampleCount = Math.min(data.length, 16384);
    if (sampleCount < 4) return 140;
    let mean = 0;
    for (let i = 0; i < sampleCount; i++) mean += data[i];
    mean /= sampleCount;
    const centered = new Float32Array(sampleCount);
    let energy = 0;
    for (let i = 0; i < sampleCount; i++) {
      centered[i] = data[i] - mean;
      energy += centered[i] * centered[i];
    }
    if (energy < 1e-8) return 140;
    const minLag = Math.max(1, Math.floor(buffer.sampleRate / 500));
    const maxLag = Math.min(Math.floor(buffer.sampleRate / 50), sampleCount - 2);
    let bestLag = Math.floor(buffer.sampleRate / 140);
    let bestCorrelation = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let correlation = 0;
      let lagEnergy = 0;
      const count = sampleCount - lag;
      for (let i = 0; i < count; i++) {
        correlation += centered[i] * centered[i + lag];
        lagEnergy += centered[i + lag] * centered[i + lag];
      }
      correlation /= Math.sqrt(Math.max(1e-12, energy * lagEnergy));
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }
    return bestCorrelation > 0.15 ? buffer.sampleRate / Math.max(1, bestLag) : 140;
  };

  const concatenativeCompositeCache = new WeakMap();
  const concatenativePreparedCache = new WeakMap();
  const getPreparedConcatenativeSample = (ctx, sample) => {
    let prepared = concatenativePreparedCache.get(sample);
    if (!prepared) {
      prepared = new WeakMap();
      concatenativePreparedCache.set(sample, prepared);
    }
    if (prepared.has(ctx)) return prepared.get(ctx);

    const input = sample.buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
    const threshold = Math.max(0.002, peak * 0.02);
    let first = 0;
    let last = input.length - 1;
    while (first < input.length && Math.abs(input[first]) < threshold) first++;
    while (last > first && Math.abs(input[last]) < threshold) last--;
    if (first >= last) { first = 0; last = input.length - 1; }

    const trimmedLength = Math.max(1, last - first + 1);
    const impulseThreshold = Math.floor(sample.buffer.sampleRate * 0.12);
    const sourceLength = trimmedLength > impulseThreshold ? Math.floor(trimmedLength / 2) : trimmedLength;
    const outputLength = Math.max(1, Math.floor(sourceLength * ctx.sampleRate / sample.buffer.sampleRate));
    const source = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const sourcePosition = first + i * sample.buffer.sampleRate / ctx.sampleRate;
      const lower = Math.min(input.length - 1, Math.floor(sourcePosition));
      const fraction = sourcePosition - lower;
      const next = Math.min(lower + 1, input.length - 1);
      source[i] = input[lower] * (1 - fraction) + input[next] * fraction;
    }

    const loopLength = source.length;
    const crossfadeLength = Math.max(1, Math.floor(loopLength * 0.5));
    const loopData = new Float32Array(loopLength);
    loopData.set(source);
    for (let i = 0; i < crossfadeLength; i++) {
      const position = loopLength - crossfadeLength + i;
      const fade = (i + 1) / (crossfadeLength + 1);
      loopData[position] = source[position] * (1 - fade) + source[i] * fade;
    }

    const buffer = ctx.createBuffer(1, loopLength, ctx.sampleRate);
    buffer.getChannelData(0).set(loopData);
    const result = { ...sample, buffer, loopEnd: buffer.duration };
    prepared.set(ctx, result);
    return result;
  };

  const findConcatenativePhoneme = (formants, excludedKey = null) => {
    let closestKey = null;
    let closestDistance = Infinity;
    for (const key of concatenativeRequiredPhonemes) {
      const candidate = phonemeMap[key]?.f;
      if (key === excludedKey || !candidate || !concatenativeSamples.has(key)) continue;
      let distance = 0;
      for (let index = 0; index < ENGINE_FORMANTS; index++) {
        distance += Math.abs(Math.log(Math.max(1, formants[index]) / Math.max(1, candidate[index])));
      }
      if (distance < closestDistance) {
        closestDistance = distance;
        closestKey = key;
      }
    }
    return closestKey;
  };

  const getConcatenativeSample = (ctx, key, phoneme = null, morphEnabled = false) => {
    const direct = concatenativeSamples.get(key);
    if (direct) return direct;
    if (key === "rest" || key.length < 2 || !/^[a-z]+$/.test(key)) return null;
    let cached = concatenativeCompositeCache.get(ctx);
    if (!cached) {
      cached = new Map();
      concatenativeCompositeCache.set(ctx, cached);
    }
    if (cached.has(key)) return cached.get(key);

    if (morphEnabled && phoneme?.morphTo?.length >= MAP_FORMANTS) {
      const mapEntry = phonemeMap[key];
      const sourceKey = findConcatenativePhoneme(mapEntry?.f || phoneme.f, key);
      const targetKey = findConcatenativePhoneme(mapEntry?.morphTo || phoneme.morphTo, key);
      const source = sourceKey && concatenativeSamples.get(sourceKey);
      const target = targetKey && concatenativeSamples.get(targetKey);
      if (source && target) {
        const sourceSample = getPreparedConcatenativeSample(ctx, source);
        const targetSample = getPreparedConcatenativeSample(ctx, target);
        const sourceData = sourceSample.buffer.getChannelData(0);
        const targetData = targetSample.buffer.getChannelData(0);
        const length = Math.max(sourceData.length, targetData.length);
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let index = 0; index < length; index++) {
          const progress = length > 1 ? index / (length - 1) : 1;
          const sourcePosition = (index / length * sourceData.length) % sourceData.length;
          const targetPosition = (index / length * targetData.length) % targetData.length;
          const sourceIndex = Math.floor(sourcePosition);
          const targetIndex = Math.floor(targetPosition);
          const sourceValue = sourceData[sourceIndex] * (1 - sourcePosition % 1) + sourceData[(sourceIndex + 1) % sourceData.length] * (sourcePosition % 1);
          const targetValue = targetData[targetIndex] * (1 - targetPosition % 1) + targetData[(targetIndex + 1) % targetData.length] * (targetPosition % 1);
          const angle = progress * Math.PI * 0.5;
          output[index] = sourceValue * Math.cos(angle) + targetValue * Math.sin(angle);
        }
        const composite = {
          buffer,
          formants: source.formants.map((value, index) => (value + target.formants[index]) / 2),
          pitch: (source.pitch + target.pitch) / 2,
          fileName: `${sourceKey}-${targetKey}`,
          fileType: "morph composite"
        };
        cached.set(key, composite);
        return composite;
      }
    }

    const parts = [...key].map(part => concatenativeSamples.get(part));
    if (parts.length !== key.length || parts.some(part => !part)) return null;
    const length = parts.reduce((total, part) => total + Math.max(1, Math.floor(part.buffer.duration * ctx.sampleRate)), 0);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const output = buffer.getChannelData(0);
    let offset = 0;
    for (const part of parts) {
      const input = part.buffer.getChannelData(0);
      const count = Math.max(1, Math.floor(part.buffer.duration * ctx.sampleRate));
      for (let i = 0; i < count; i++) {
        const sourcePosition = i * part.buffer.sampleRate / ctx.sampleRate;
        const lower = Math.floor(sourcePosition);
        const fraction = sourcePosition - lower;
        const next = Math.min(lower + 1, input.length - 1);
        output[offset + i] = input[lower] * (1 - fraction) + input[next] * fraction;
      }
      offset += count;
    }
    const compositeData = buffer.getChannelData(0);
    const crossfadeLength = Math.max(1, Math.floor(Math.min(parts[0].buffer.length || compositeData.length, compositeData.length) * 0.5));
    for (let i = 0; i < Math.min(crossfadeLength, compositeData.length); i++) {
      const position = compositeData.length - Math.min(crossfadeLength, compositeData.length) + i;
      const fade = (i + 1) / (Math.min(crossfadeLength, compositeData.length) + 1);
      compositeData[position] = compositeData[position] * (1 - fade) + compositeData[i] * fade;
    }
    const composite = {
      buffer,
      formants: parts.reduce((sum, part) => sum.map((value, index) => value + part.formants[index]), [0, 0, 0]).map(value => value / parts.length),
      pitch: parts.reduce((sum, part) => sum + part.pitch, 0) / parts.length,
      fileName: key,
      fileType: "composite"
    };
    cached.set(key, composite);
    return composite;
  };

  const renderConcatenative = async (ctx, phonemeSeq, mode, morphTime, morphEnabled, slideTime = 0.08, portamento = 0.08, vibFreq = 0, vibDepth = 0, vibDelay = 0, persistentVib = true, vibFadeIn = 0) => {
    const master = ctx.createGain();
    master.gain.value = 0.92;
    master.connect(ctx.destination);
    let time = 0;
    let previousFormants = null;

    for (let index = 0; index < phonemeSeq.length; index++) {
      const phoneme = phonemeSeq[index];
      const duration = Math.max(0.001, phoneme.d);
      const next = phonemeSeq[index + 1];
      const rawSample = getConcatenativeSample(ctx, phoneme.key, phoneme, morphEnabled) || (phoneme.key === "rest" ? null : concatenativeSamples.get("rest"));
      const sample = rawSample ? getPreparedConcatenativeSample(ctx, rawSample) : null;
      if (!sample) {
        time += duration;
        previousFormants = null;
        continue;
      }

      const sourcePitch = Number.isFinite(sample.pitch) && sample.pitch > 0 ? sample.pitch : 140;
      const targetPitch = Number.isFinite(phoneme.pitch) && phoneme.pitch > 0 ? phoneme.pitch : sourcePitch;
      const pitchRatio = targetPitch / sourcePitch;
      const nextPitch = next && next.voiced && Number.isFinite(next.pitch) && next.pitch > 0 ? next.pitch : targetPitch;
      const glideRatio = nextPitch / sourcePitch;
      const glideDuration = Math.min(duration, Math.max(0, Number(slideTime) || 0));
      const gain = ctx.createGain();
      const nextRawSample = next ? getConcatenativeSample(ctx, next.key, next, morphEnabled) : null;
      const releaseTime = nextRawSample ? Math.min(0.05, duration * 0.3, Math.max(0.001, next.d) * 0.3) : 0;
      const fade = Math.min(0.012, duration * 0.12, releaseTime || duration * 0.12);
      const level = mode === "whisper" ? 0.72 : 1;
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(level, time + fade);
      gain.gain.setValueAtTime(level, time + Math.max(fade, duration - Math.max(releaseTime, fade)));
      gain.gain.linearRampToValueAtTime(0, time + duration);

      const baseFormants = phonemeMap[phoneme.key]?.f || phoneme.f || [700, 1220, 2600];
      const adjustedFormants = phoneme.f || baseFormants;
      const formantScale = adjustedFormants.map((value, formantIndex) =>
        value > 0 && baseFormants[formantIndex] > 0 ? value / baseFormants[formantIndex] : 1
      );
      const formants = sample.formants.map((frequency, formantIndex) =>
        frequency * (formantScale[formantIndex] || 1)
      );
      const scheduleFormantMorph = (parameter, start, target, startTime, morphDuration) => {
        if (!(start > 0) || !(target > 0) || morphDuration <= 0) return;
        const curve = new Float32Array(33);
        const logStart = Math.log(start);
        const logDistance = Math.log(target) - logStart;
        for (let point = 0; point < curve.length; point++) {
          const progress = point / (curve.length - 1);
          const eased = progress * progress * (3 - 2 * progress);
          curve[point] = Math.exp(logStart + logDistance * eased);
        }
        parameter.setValueCurveAtTime(curve, startTime, morphDuration);
      };
      const filters = formants.map((frequency, filterIndex) => {
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = 5;
        const start = previousFormants?.[filterIndex] || frequency;
        const morphBase = phonemeMap[phoneme.key]?.morphTo || baseFormants;
        const morphScale = phoneme.morphTo?.[filterIndex] && morphBase[filterIndex]
          ? phoneme.morphTo[filterIndex] / morphBase[filterIndex]
          : formantScale[filterIndex] || 1;
        const target = sample.formants[filterIndex] * (formantScale[filterIndex] || 1) * morphScale;
        const coarticulationTime = morphEnabled && morphTime > 0 && previousFormants
          ? Math.min(morphTime, duration * 0.35)
          : 0;
        if (coarticulationTime > 0) {
          scheduleFormantMorph(filter.frequency, start, frequency, time, coarticulationTime);
        } else {
          filter.frequency.setValueAtTime(frequency, time);
        }
        if (morphEnabled && phoneme.morphTo?.[filterIndex]) {
          scheduleFormantMorph(
            filter.frequency,
            frequency,
            target,
            time + coarticulationTime,
            duration - coarticulationTime
          );
        }
        return filter;
      });
      const dryGain = ctx.createGain();
      dryGain.gain.value = filters.length ? 0.08 : 1;
      gain.connect(dryGain).connect(master);
      for (const filter of filters) {
        const wetGain = ctx.createGain();
        wetGain.gain.value = 0.32;
        gain.connect(filter).connect(wetGain).connect(master);
      }
      const phonemeVibFreq = Number.isFinite(phoneme.vibFreq) ? phoneme.vibFreq : vibFreq;
      const phonemeVibDepth = Number.isFinite(phoneme.vibDepth) ? phoneme.vibDepth : vibDepth;
      const phonemeVibDelay = Number.isFinite(phoneme.vibDelay) ? phoneme.vibDelay : vibDelay;
      const phonemeVibFade = Number.isFinite(phoneme.vibFadeIn) ? phoneme.vibFadeIn : vibFadeIn;
      const phonemeVibFadeOut = Number.isFinite(phoneme.vibFadeOut) ? phoneme.vibFadeOut : 0;
      const phonemePortamento = resolvePortamento(phoneme.portamento ?? portamento, portamento, duration);
      const phonemeSlide = resolvePortamento(phoneme.slideTime ?? slideTime, slideTime, duration);
      const activeGlideDuration = Math.min(duration, Math.max(0, phonemeSlide));
      const glideStart = duration - activeGlideDuration;
      const glideTarget = phonemePortamento > 0 ? pitchRatio + 0.5 * (glideRatio - pitchRatio) : glideRatio;
      const sourcePeriod = 1 / sourcePitch;
      const segmentFrameCount = Math.max(1, Math.ceil(duration * ctx.sampleRate));
      const segmentData = new Float32Array(segmentFrameCount);
      const segmentWeights = new Float32Array(segmentFrameCount);
      const sampleData = sample.buffer.getChannelData(0);
      let grainOffset = 0;
      let grainIndex = 0;
      while (grainOffset < duration) {
        const centerTime = Math.min(duration, grainOffset + sourcePeriod);
        const slideProgress = activeGlideDuration > 0 && next?.voiced
          ? Math.max(0, Math.min(1, (centerTime - glideStart) / activeGlideDuration))
          : 0;
        const currentRatio = pitchRatio + (glideTarget - pitchRatio) * slideProgress;
        let currentPitch = sourcePitch * currentRatio;
        if (mode !== "whisper" && phonemeVibFreq > 0 && phonemeVibDepth > 0 && centerTime >= phonemeVibDelay) {
          const vibElapsed = persistentVib ? time + centerTime - phonemeVibDelay : centerTime - phonemeVibDelay;
          const fadeInProgress = phonemeVibFade > 0 ? Math.min(1, (centerTime - phonemeVibDelay) / phonemeVibFade) : 1;
          const fadeOutProgress = phonemeVibFadeOut > 0 ? Math.min(1, (duration - centerTime) / phonemeVibFadeOut) : 1;
          const fadeProgress = Math.min(fadeInProgress, fadeOutProgress);
          currentPitch += Math.sin(2 * Math.PI * phonemeVibFreq * vibElapsed) * phonemeVibDepth * fadeProgress;
        }
        currentPitch = Math.max(40, Math.min(1000, currentPitch));
        const targetPeriod = 1 / currentPitch;
        const grainLength = Math.min(phoneme.voiced ? 0.12 : 0.02, phoneme.voiced ? 2 * Math.max(sourcePeriod, targetPeriod) : 0.02, duration - grainOffset);
        const grainStartFrame = Math.floor(grainOffset * ctx.sampleRate);
        const grainLengthFrames = Math.max(1, Math.min(segmentFrameCount - grainStartFrame, Math.ceil(grainLength * ctx.sampleRate)));
        const offsetFrames = phoneme.voiced
          ? (grainIndex * sourcePeriod * ctx.sampleRate) % sampleData.length
          : (grainIndex * 0.02 * ctx.sampleRate) % sampleData.length;
        for (let frame = 0; frame < grainLengthFrames; frame++) {
          const phase = frame / grainLengthFrames;
          const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
          const samplePosition = (offsetFrames + frame) % sampleData.length;
          const sampleIndex = Math.floor(samplePosition);
          const fraction = samplePosition - sampleIndex;
          const nextIndex = (sampleIndex + 1) % sampleData.length;
          const value = sampleData[sampleIndex] * (1 - fraction) + sampleData[nextIndex] * fraction;
          segmentData[grainStartFrame + frame] += value * window;
          segmentWeights[grainStartFrame + frame] += window;
        }
        grainOffset += phoneme.voiced ? targetPeriod : 0.01;
        grainIndex++;
      }
      for (let frame = 0; frame < segmentFrameCount; frame++) {
        if (segmentWeights[frame] > 1e-4) segmentData[frame] /= segmentWeights[frame];
      }
      const segmentBuffer = ctx.createBuffer(1, segmentFrameCount, ctx.sampleRate);
      segmentBuffer.getChannelData(0).set(segmentData);
      const source = ctx.createBufferSource();
      source.buffer = segmentBuffer;
      source.connect(gain);
      source.start(time);
      source.stop(time + duration + 0.001);
      previousFormants = formants;
      // Every phoneme owns its full parsed time slot; sample release must not shift later notes.
      time += duration;
      if (next?.key === "rest") previousFormants = null;
    }
    return await ctx.startRendering();
  };

  // synthesize with nasal-aware transitions and humanizing features
  const synthesize = async (ctx, phonemeSeq, mode, vibFreq, vibDepth, vibDelay, morphTime = 0.05, morphEnabled = true, slideTime = 0.08, portamento = 0.08, persistentVib = true, dynamicMode = false, consonantDuration = 0.1, globalVibFadeIn = 0, method = synthesisMethod, beatLength = 0.5) => {
    if (method === "concatenative") {
      return renderConcatenative(ctx, phonemeSeq, mode, morphTime, morphEnabled, slideTime, portamento, vibFreq, vibDepth, vibDelay, persistentVib, globalVibFadeIn);
    }
    // Preprocess phonemeSeq for humanizing features
    const processedSeq = [];
    for (let i = 0; i < phonemeSeq.length; i++) {
      const p = phonemeSeq[i];
      const prev = processedSeq.length > 0 ? processedSeq[processedSeq.length - 1] : null;
      const hasPrevVoiced = prev && prev.voiced;

      // Feature 3: If b and no previous voiced, prepend m
      // if (p.key === 'b' && !hasPrevVoiced) {
      //   // Prepend a brief m, but keep it quieter to avoid loud noise bursts.
      //   // 40% quieter than normal m -> amp scale 0.6
      //   const mDur = Math.min(0.05, p.d * 0.1); // short m
      //   const mPhoneme = { key: 'm', ...phonemeMap['m'], d: mDur, pitch: p.pitch, amp: (phonemeMap['m'].amp ?? 1) * 0.6 };
      //   processedSeq.push(mPhoneme);
      //   p.d -= mDur; // trim p/b duration
      // }



      // Feature 2: If t,b,p,k after s or z, add silence delay
      if ((p.key === 't' || p.key === 'b' || p.key === 'p' || p.key === 'k') && prev && (prev.key === 's' || prev.key === 'z')) {
        const silenceDur = Math.min(0.02, prev.d * 0.1); // slight silence
        prev.d -= silenceDur; // trim s/z
        p.d -= silenceDur; // trim consonant
        // silence is implicit by delaying start
      }

      const nextKey = phonemeSeq[i + 1]?.key;
      p.dynamicFadeOut = DYNAMIC_STOPS.has(nextKey);

      processedSeq.push(p);
    }

    const totalDuration = processedSeq.reduce((a,p) => a + p.d, 0);
    const endTime = totalDuration;

    // master output
    const master = ctx.createGain();
    master.gain.value = 1;

    // shared vowel voice filters (3 formants) and per-filter gains (so we can dip vowel energy)
    const numFormants = 3;
    const voiceFilters = [];
    const voiceGains = [];

    if (!disableFormantFilter) {
      for (let i = 0; i < numFormants; i++) {
        const f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.Q.value = 10;
        f.frequency.value = 0;
        const g = ctx.createGain();
        g.gain.value = 1; // normal full vowel energy
        f.connect(g);
        g.connect(master);
        voiceFilters.push(f);
        voiceGains.push(g);
      }
    };

    // Feature 4: Sine wave for bass/timbre backing the pulse train, affected by formant filters
    const bassOsc = ctx.createOscillator();
    bassOsc.type = "sine";
    const bassGain = ctx.createGain();
    bassGain.gain.value = 0.1; // subtle bass
    // Route bass through formant filters for integration

    if (!disableFormantFilter) {
      for (let idx = 0; idx < numFormants; idx++) {
        bassGain.connect(voiceFilters[idx]);
      }
    }
    // Will set frequency and start/stop later

    // shared noise filters for breathy vowel/noise path
    const sharedNoiseFilters = [];
    
    if (!disableFormantFilter) {
      for (let i = 0; i < numFormants; i++) {
        const f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.Q.value = 10;
        f.frequency.value = 0;
        f.connect(master);
        sharedNoiseFilters.push(f);
      }
    }

    // persistent vibrato LFO
    let lfo = null;
    let lfoGain = null;
    const vibActive = vibFreq > 0 && vibDepth > 0 && persistentVib && mode !== "whisper";
    if (vibActive) {
      lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = vibFreq;
      lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(0, vibDelay);
      lfoGain.gain.linearRampToValueAtTime(vibDepth, vibDelay + Math.max(0, globalVibFadeIn));
      lfo.connect(lfoGain);
      lfo.start(vibDelay);
      lfo.stop(endTime + 1);
    }

    const setFilterNow = (filter, t, val) => {
      try { filter.frequency.setValueAtTime(val, t); } catch (e) {}
    };

    // -- Formant automation helpers (morphTo / adjacent-morph fix) --
    // When voiced phonemes are adjacent (a continuous voiced run), they share the
    // same voiceFilters/sharedNoiseFilters frequency params. The old code called
    //   cancelScheduledValues(t); setValueAtTime(onset, t);
    // at the start of EVERY phoneme. Because the PREVIOUS phoneme's morph endpoint
    // is scheduled at exactly time t, that cancelled it — so a morphTo diphthong
    // followed by another voiced phoneme sounded flat (e.g. "a-aw" for "ay aw").
    // The helpers below preserve the previous phoneme's endpoint when the run
    // continues (isRunStart=false) and only glide (~GLIDE seconds) to this
    // phoneme's onset before following its own formant schedule. Fresh runs
    // (after a rest / at the start of a sequence) still hard-set at time t.
    const GLIDE = 0.006; // seconds
    const scheduledFormantEnds = new WeakMap();
    const getFreqAt = (param, t) => {
      try {
        const v = param.getValueAtTime(t);
        return Number.isFinite(v) ? v : null;
      } catch (e) { return null; }
    };
    // Anchor the start of a phoneme on a frequency param.
    // - Fresh run: cancel everything at t and hard-set the onset.
    // - Continuing run: do NOT clobber the previous phoneme's ramp endpoint at t;
    //   anchor a hold at t equal to the value already scheduled there (identical
    //   audible curve), then glide to this phoneme's onset over GLIDE seconds.
    const anchorStart = (param, t, isRunStart, onset) => {
      const tOnset = t + (isRunStart ? 0 : GLIDE);
      try {
        if (isRunStart) {
          param.cancelScheduledValues(t);
          param.setValueAtTime(onset, t);
        } else {
          const cur = scheduledFormantEnds.get(param) ?? getFreqAt(param, t);
          param.setValueAtTime(cur != null ? cur : onset, t);
          param.linearRampToValueAtTime(onset, tOnset);
        }
        param.setValueAtTime(onset, tOnset);
        scheduledFormantEnds.set(param, onset);
      } catch (e) {}
    };
    // Ramp onset -> target across [tOnset, endTime] (used by hasMorphTo).
    const rampFreq = (param, t, isRunStart, onset, target, endTime) => {
      try {
        anchorStart(param, t, isRunStart, onset);
        param.linearRampToValueAtTime(target, endTime);
        scheduledFormantEnds.set(param, target);
      } catch (e) {}
    };
    // Hold onset across the phoneme (used by nasal / no-target branches).
    const holdFreq = (param, t, isRunStart, onset) => {
      anchorStart(param, t, isRunStart, onset);
    };
    // Hold onset until rampStart, then ramp to target at endTime (hasVoicedTarget).
    const holdThenRampFreq = (param, t, isRunStart, onset, rampStart, target, endTime) => {
      const tOnset = t + (isRunStart ? 0 : GLIDE);
      try {
        anchorStart(param, t, isRunStart, onset);
        if (rampStart > tOnset + 1e-4) {
          param.setValueAtTime(onset, rampStart);
        }
        param.linearRampToValueAtTime(target, endTime);
        scheduledFormantEnds.set(param, target);
      } catch (e) {}
    };

    // find next voiced phoneme (skip consonants/unvoiced) and return it
    const findNextVoiced = (i) => {
      for (let j = i + 1; j < phonemeSeq.length; j++) {
        const p = phonemeSeq[j];
        if (p && p.voiced) return p;
      }
      return null;
    };

      // create a short nasal noise burst scheduled in the morph window
      // Nasal airflow behaves more like aspiration: use PINK.
      const scheduleNasalBurst = (morphStart, morphEnd, depth = 0.4) => {

      // bandpass centered low (~250-400Hz) for nasal resonance
      const nasalFilter = ctx.createBiquadFilter();
      nasalFilter.type = "bandpass";
      nasalFilter.Q.value = 8;
      nasalFilter.frequency.value = 300; // center freq for general nasal flavour

      const nasalGain = ctx.createGain();
      nasalGain.gain.value = 0;
      nasalFilter.connect(nasalGain).connect(master);

      const dur = Math.max(0.001, morphEnd - morphStart);
      const src = ctx.createBufferSource();
      src.buffer = createFricativeNoiseBuffer(ctx, dur + 0.02, { voiced: true, amp: 0.1, usePinkNoise: false });

      // envelope: ramp in at morphStart, ramp out at morphEnd
      nasalGain.gain.setValueAtTime(0, morphStart - 0.001);
      nasalGain.gain.linearRampToValueAtTime(depth, morphStart + Math.min(0.02, dur * 0.25));
      nasalGain.gain.setValueAtTime(depth, morphEnd - Math.min(0.02, dur * 0.25));
      nasalGain.gain.linearRampToValueAtTime(0, morphEnd + 0.01);

      src.connect(nasalFilter);
      src.start(morphStart);
      src.stop(morphEnd + 0.02);
    };


    // consonant noise generator with subtle fade-in
      const playConsonantNoise = (t, d, fArr, amp = 1, noiseAmp = 1, fadeOutRatio = 0, fadeToSilence = false, fadeInRatio = 0, voiced = false, usePinkNoise = false) => {
      if (d <= 0 || !fArr || fArr.length === 0) return;
      const src = ctx.createBufferSource();
        // White noise for unvoiced fricatives/bursts, pink for voiced breathy
        // variants such as v/dh/z. This must respect the phoneme metadata,
        // especially when whisper mode is enabled and when the filter is disabled.
      // quiet base so voice dominates (fixes nasal artifact audibility)
      // amp param is used only for envelope peak.
      src.buffer = createFricativeNoiseBuffer(ctx, d, { voiced, amp: 0.015 * noiseAmp, usePinkNoise });


      const consonantGain = ctx.createGain();
      const fadeEndRatio = fadeOutRatio > 0 ? fadeOutRatio : 1;
      const fadeInDuration = fadeInRatio > 0
        ? d * fadeInRatio
        : fadeToSilence
          ? Math.min(0.01, d * 0.05)
          : Math.min(0.01, d);
      consonantGain.gain.setValueAtTime(0, t);
      consonantGain.gain.linearRampToValueAtTime(amp * noiseAmp, t + fadeInDuration); // subtle fade-in over 0.01s
      if (fadeToSilence) {
        const fadeStart = Math.max(t + fadeInDuration, t + d * 0.8);
        const fadeEnd = t + d;
        consonantGain.gain.setValueAtTime(amp * noiseAmp, fadeStart);
        consonantGain.gain.linearRampToValueAtTime(0, fadeEnd);
        consonantGain.gain.setValueAtTime(0, t + d);
      } else {
        consonantGain.gain.linearRampToValueAtTime(amp * noiseAmp * fadeEndRatio, t + d);
      }
      const consonantFilters = !disableFormantFilter && fArr ? fArr.slice(0, numFormants).map(freq => {
        const bf = ctx.createBiquadFilter();
        bf.type = "bandpass";
        bf.Q.value = 12;
        bf.frequency.value = freq || 0;
        bf.connect(master);
        return bf;
      }) : [];
      src.connect(consonantGain);
      if (consonantFilters.length > 0) {
        for (const bf of consonantFilters) consonantGain.connect(bf);
      } else {
        consonantGain.connect(master);
      }
      src.start(t);
      src.stop(t + d + 0.005);
    };

    const scheduleWhisperFormants = (t, d, f, opt, nextVoiced, isRunStart) => {
      if (sharedNoiseFilters.length === 0) return;
      const hasMorphTo = voiceFilters.length > 0 && morphEnabled && opt.morphTo && opt.morphTo.length >= MAP_FORMANTS;
      const hasVoicedTarget = voiceFilters.length > 0 && morphEnabled && morphTime > 0 && nextVoiced && nextVoiced.voiced && nextVoiced.morphs !== false;
      const morphStart = t + Math.max(0, d - morphTime);
      const morphEnd = t + d;

      for (let idx = 0; idx < numFormants; idx++) {
        const curVal = (f && f[idx]) || 0;
        if (hasMorphTo) {
          const targetVal = (opt.morphTo && opt.morphTo[idx]) || 0;
          rampFreq(sharedNoiseFilters[idx].frequency, t, isRunStart, curVal, targetVal, morphEnd);
        } else if (hasVoicedTarget) {
          const targetVal = (nextVoiced.f && nextVoiced.f[idx]) || 0;
          holdThenRampFreq(sharedNoiseFilters[idx].frequency, t, isRunStart, curVal, morphStart, targetVal, morphEnd);
        } else {
          holdFreq(sharedNoiseFilters[idx].frequency, t, isRunStart, curVal);
        }
      }
    };

    const playWhisperNoise = (t, d, f, opt = {}, fadeInRatio = 0) => {
      if (d <= 0) return;
      const config = typeof opt === "number" ? { noiseAmp: opt } : opt;
      const noiseAmp = config.noiseAmp ?? 1;
      const voicedNoise = !!config.voiced;
      const src = ctx.createBufferSource();
      src.buffer = createWhisperNoiseBuffer(ctx, d, 0.08 * noiseAmp, {
        voiced: voicedNoise,
        usePinkNoise: config.usePinkNoise
      });
      const gain = ctx.createGain();
      const amp = (config.amp ?? 0.9) * noiseAmp;
      gain.gain.setValueAtTime(0, t);
      const fadeInDuration = fadeInRatio > 0 ? d * fadeInRatio : Math.min(0.01, d);
      gain.gain.linearRampToValueAtTime(amp, t + fadeInDuration);
      gain.gain.setValueAtTime(amp, t + Math.max(0, d - 0.01));
      gain.gain.linearRampToValueAtTime(0, t + d);
      src.connect(gain);
      if (sharedNoiseFilters.length > 0) {
        for (const filter of sharedNoiseFilters) gain.connect(filter);
      } else {
        gain.connect(master);
      }
      src.start(t);
      src.stop(t + d + 0.005);
    };


    // main play routine
    const play = (t, d, f, opt = {}, nextVoiced = null, immediateNext = null) => {
      const { breathy = false, amp = 0.9, burst = false, voiced = true, pitch = 220, short = false, usePinkNoise = false } = opt;
      if (d <= 0) return;

      // If current phoneme is consonant/unvoiced or purely breathy/burst -> produce consonant-filtered noise
      if (opt.breathy || opt.burst) {
        playConsonantNoise(t, d, f, amp, opt.noiseAmp ?? 1, 0, opt.dynamicFadeOut, (opt.key === "s" || opt.key === "ch" || opt.key === "sh" || opt.key === "z" ) ? 0.5 : 0, Boolean(voiced), usePinkNoise);
        // If it's not voiced at all, we're done
        if (!voiced) return;
      }

      const shouldVoice = voiced && mode !== "whisper";
      if (!shouldVoice) return;

      // determine morph behaviour: skip consonants for target as before
      // Check nextVoiced.morphs — if false, the next phone plays instantly without morph transition
      const hasVoicedTarget = morphEnabled && morphTime > 0 && nextVoiced && nextVoiced.voiced && nextVoiced.morphs !== false;

// morphTo: ramp formants from f -> opt.morphTo across the FULL phoneme duration
      // (bypasses morphTime). Mirrors the main synthesis loop for consistency.
      // Note: phonemeMap entries carry 6 formants (F4-F6 ignored by the 3-filter
      // engine), so accept >= numFormants here.
const hasMorphTo = voiceFilters.length > 0 && morphEnabled && opt.morphTo && opt.morphTo.length >= MAP_FORMANTS;

      // if target is nasal, schedule a nasal transition instead of morphing formants toward nasal targets
      const targetIsNasal = hasVoicedTarget && !!nextVoiced.nasal;
      const morphStart = t + Math.max(0, d - morphTime);
      const morphEnd = t + d;

      if (hasMorphTo) {
        for (let idx = 0; idx < numFormants; idx++) {
          const curVal = (f && f[idx]) || 0;
          const morphVal = (opt.morphTo && opt.morphTo[idx]) || 0;
          try {
            voiceFilters[idx].frequency.cancelScheduledValues(t);
            voiceFilters[idx].frequency.setValueAtTime(curVal, t);
            voiceFilters[idx].frequency.linearRampToValueAtTime(morphVal, t + d);
          } catch (e) {}
          try {
            sharedNoiseFilters[idx].frequency.cancelScheduledValues(t);
            sharedNoiseFilters[idx].frequency.setValueAtTime(curVal, t);
            sharedNoiseFilters[idx].frequency.linearRampToValueAtTime(morphVal, t + d);
          } catch (e) {}
          try { voiceGains[idx].gain.setValueAtTime(1, t); } catch (e) {}
        }
      } else if (targetIsNasal) {
        // keep vowel formants at current values, but dip vowel gain slightly and add a nasal burst
        for (let idx = 0; idx < numFormants; idx++) {
          const curVal = (f && f[idx]) || 0;
          // hold formant frequency across the phoneme (no ramp to nasal targets)
          setFilterNow(voiceFilters[idx], t, curVal);
          setFilterNow(sharedNoiseFilters[idx], t, curVal);

          // schedule vowel gain dip (small reduction)
          try {
            voiceGains[idx].gain.cancelScheduledValues(t);
            voiceGains[idx].gain.setValueAtTime(1, t);
            // dip to e.g. 0.65 during morph window, then back to 1
            const tSetStart = Math.max(t, morphStart - 0.001);
            const tRampEnd = Math.min(morphEnd, morphStart + Math.min(0.02, morphTime * 0.5));
            const tDipEnd = Math.max(tSetStart, morphEnd - Math.min(0.02, morphTime * 0.5));
            const tSetEnd = Math.max(tDipEnd, morphEnd + 0.01);
            voiceGains[idx].gain.setValueAtTime(1, tSetStart);
            voiceGains[idx].gain.linearRampToValueAtTime(0.65, tRampEnd);
            voiceGains[idx].gain.setValueAtTime(0.65, tDipEnd);
            voiceGains[idx].gain.linearRampToValueAtTime(1, tSetEnd);
          } catch (e) {}
        }
        // schedule nasal burst (filtered noise) in morph window to add "nah"/nasal timbre
        // Reduced depth to prevent artifacts on g/b and other morph-to-nasal contexts.
        scheduleNasalBurst(morphStart, morphEnd, Math.max(0.05, 0.1 * (opt.amp || 1)));

      } else if (hasVoicedTarget) {
        // normal morph-to-next voiced formants
        for (let idx = 0; idx < numFormants; idx++) {
          const curVal = (f && f[idx]) || 0;
          const nextVal = (nextVoiced.f && nextVoiced.f[idx]) || 0;
            try {
              voiceFilters[idx].frequency.cancelScheduledValues(t);
              voiceFilters[idx].frequency.setValueAtTime(curVal, t);
              voiceFilters[idx].frequency.setValueAtTime(curVal, morphStart);
              voiceFilters[idx].frequency.linearRampToValueAtTime(nextVal, morphEnd);
            } catch (e) {}
            try {
              sharedNoiseFilters[idx].frequency.cancelScheduledValues(t);
              sharedNoiseFilters[idx].frequency.setValueAtTime(curVal, t);
              sharedNoiseFilters[idx].frequency.setValueAtTime(curVal, morphStart);
              sharedNoiseFilters[idx].frequency.linearRampToValueAtTime(nextVal, morphEnd);
            } catch (e) {}

        }
      } else if (voiceFilters.length > 0) {
        // no voiced target (or morph disabled) -> set filters to current f immediately
        for (let idx = 0; idx < numFormants; idx++) {
          const val = (f && f[idx]) || 0;
          setFilterNow(voiceFilters[idx], t, val);
          setFilterNow(sharedNoiseFilters[idx], t, val);
          // ensure gains are at full value
          try { voiceGains[idx].gain.setValueAtTime(1, t); } catch (e) {}
        }
      }

      // oscillator (voiced) - Rosenberg (1971) glottal pulse derivative source
      const osc = ctx.createOscillator();

      // Glottal flow derivative with proper phase dispersion; open quotient driven
      // by clonedTimbre.duty so voice cloning can shape the pulse.
      const glottalWave = createRosenbergGlottalWave(ctx, 27, clonedTimbre.duty);
      osc.setPeriodicWave(glottalWave);
      
      const pitchParam = osc.frequency;
      pitchParam.setValueAtTime(pitch, t);

      // vibrato
      // If vibFreq is provided for this phoneme (including vibFreq=0), override global vibrato settings.
      // Delay/FadeIn/Speed fields are beats-based (Delay/FadeIn) and treated like existing "vibFreq" semantics for rate.
      // Note: use opt.vib* (per-phoneme fields), falling back to the global vibrato params.
      const vibFreqForNote = Number.isFinite(opt.vibFreq) ? opt.vibFreq : vibFreq;
      const vibDelayForNoteSec = Number.isFinite(opt.vibDelay) ? opt.vibDelay : vibDelay;
      const vibFadeInForNoteSec = Number.isFinite(opt.vibFadeIn) ? opt.vibFadeIn : globalVibFadeIn;
      const vibSpeedForNote = Number.isFinite(opt.vibSpeed) ? opt.vibSpeed : null;

      const vibForThis = (vibFreqForNote > 0 && vibDepth > 0 && mode !== "whisper");
      if (vibForThis && lfoGain && persistentVib && !opt.vibratoOverride) {
        // Persistent vibrato only: we can’t retime the global LFO per-note.
        // Use global persistent vibrato.
        lfoGain.connect(pitchParam);
      } else if (vibForThis) {
        // Non-persistent or per-note retiming: schedule a per-phoneme LFO.
        const lfol = ctx.createOscillator();
        const lfoGl = ctx.createGain();
        lfol.type = "sine";

        // “speed” overrides the LFO rate (keeps existing global-vibFreq semantics)
        const lfoRateHz = (vibSpeedForNote != null && vibSpeedForNote > 0) ? vibSpeedForNote : vibFreqForNote;
        lfol.frequency.setValueAtTime(lfoRateHz, t);

        // Apply delay via start time and fadeIn via gain envelope
        const fadeStart = t + vibDelayForNoteSec;
        const fadeEnd = fadeStart + Math.max(0, vibFadeInForNoteSec);
        lfoGl.gain.setValueAtTime(0, fadeStart);
        lfoGl.gain.linearRampToValueAtTime(vibDepth, fadeEnd);

        lfol.connect(lfoGl).connect(pitchParam);
        lfol.start(fadeStart);
        lfol.stop(t + d + 0.02);
      } else if (!persistentVib && vibFreq > 0 && vibDepth > 0) {
        const lfol = ctx.createOscillator();
        const lfoGl = ctx.createGain();
        lfol.type = "sine";
        lfol.frequency.setValueAtTime(vibFreq, t);
        lfoGl.gain.setValueAtTime(vibDepth, t);
        lfol.connect(lfoGl).connect(pitchParam);
        lfol.start(t + vibDelay);
        lfol.stop(t + d + 0.02);
      }

      // Slide reaches halfway to the next pitch; portamento completes the rest.
      const effectiveSlideTime = resolvePortamento(opt.slideTime ?? slideTime, slideTime, d);
      const effectivePortamento = resolvePortamento(opt.portamento ?? portamento, portamento, d);
      const canSlide = effectiveSlideTime > 0 && immediateNext && immediateNext.voiced && immediateNext.pitch && voiced;
      if (canSlide) {
        const rampStart = Math.max(t, t + d - effectiveSlideTime);
        const slideTarget = effectivePortamento > 0
          ? pitch + 0.5 * (immediateNext.pitch - pitch)
          : immediateNext.pitch;
        pitchParam.setValueAtTime(pitch, t);
        pitchParam.setValueAtTime(pitch, rampStart);
        pitchParam.linearRampToValueAtTime(slideTarget, t + d);
      } else {
        pitchParam.setValueAtTime(pitch, t);
      }

      // route oscillator through per-formant filters/gains
      const oscGain = ctx.createGain();
      const fadeTime = 0.01;
      oscGain.gain.setValueAtTime(0, t);
      oscGain.gain.linearRampToValueAtTime(getVoicedGain(amp), t + fadeTime);
      oscGain.gain.setValueAtTime(getVoicedGain(amp), t + d - fadeTime);
      oscGain.gain.linearRampToValueAtTime(0, t + d);
      if (voiceFilters.length > 0) {
        for (const filter of voiceFilters) osc.connect(oscGain).connect(filter);
      } else {
        osc.connect(oscGain).connect(master);
      }

// If breathy component, route a noise source via sharedNoiseFilters as well
      if (opt.breathy) {
        const noiseSrc = ctx.createBufferSource();
        // voiced-ish breathy component/aspiration => PINK
        const breathyNoiseAmp = (opt.noiseAmp ?? 1);
        noiseSrc.buffer = createFricativeNoiseBuffer(ctx, d, { voiced: true, amp: 0.05 * breathyNoiseAmp, usePinkNoise });
        if (sharedNoiseFilters.length > 0) {
          for (const nf of sharedNoiseFilters) noiseSrc.connect(nf);
        } else {
          noiseSrc.connect(master);
        }
        noiseSrc.start(t);
        noiseSrc.stop(t + d + 0.005);
      }


      osc.start(t);
      osc.stop(t + d + fadeTime);
    };

    // initialize voice filters and bass to first voiced phoneme
    if (processedSeq.length > 0) {
      const firstVoiced = processedSeq.find(p => p.voiced) || processedSeq[0];
      if (firstVoiced && firstVoiced.f) {
        for (let idx = 0; idx < numFormants; idx++) {
          const v = firstVoiced.f[idx] || 0;
          setFilterNow(voiceFilters[idx], 0, v);
          setFilterNow(sharedNoiseFilters[idx], 0, v);
        }
        // set bass to octave below
        bassOsc.frequency.setValueAtTime(firstVoiced.pitch / 2, 0);
      }
    }
    // start bass osc
    bassOsc.start(0);
    bassOsc.stop(endTime);

    // continuous oscillator for voiced sequences
    let currentOsc = null;
    let oscGain = null;
    let lastVoicedEnd = 0;
    let currentAmp = 0.9;
    let voicedFadeOutScheduled = false;
    // Tracks whether the global persistent LFO is currently connected to the
    // active oscillator's frequency param, so we can connect/disconnect it per
    // note (needed for per-phoneme bracket vibrato overrides and [vf:0] off).
    let vibConnected = false;

    // schedule phonemes
    let t = 0;
    let whisperRunStart = true;
    for (let i = 0; i < processedSeq.length; i++) {
      const p = processedSeq[i];
      const immediateNext = processedSeq[i + 1] || null;
      const nextVoiced = findNextVoiced(i);

      if (mode === "whisper") {
        if (p.key === "rest") {
          whisperRunStart = true;
        } else {
          scheduleWhisperFormants(t, p.d, p.f, p, nextVoiced, whisperRunStart);
          const whisperNoiseVoiced = !!p.voiced;
          playWhisperNoise(t, p.d, p, { amp: p.amp ?? 0.9, noiseAmp: p.noiseAmp ?? 1, voiced: whisperNoiseVoiced, usePinkNoise: p.usePinkNoise }, p.key === "s" ? 0.5 : 0);
          whisperRunStart = false;
        }
      } else if (p.voiced) {
        if (p.burst) {
          playConsonantNoise(t, p.d, p.f, p.amp, p.noiseAmp ?? 1, 0, p.dynamicFadeOut, p.key === "s" ? 0.5 : 0, Boolean(p.voiced), p.usePinkNoise);
        }
        const isRunStart = !currentOsc;
        if (!currentOsc) {
          // start new oscillator for voiced sequence
          currentOsc = createSelectedOsc(ctx);

          oscGain = ctx.createGain();
          const fadeTime = 0.01;
          const amp = isNaN(p.amp) ? 1 : p.amp;
          oscGain.gain.setValueAtTime(0, t);
          oscGain.gain.linearRampToValueAtTime(getVoicedGain(amp), t + fadeTime);
          currentAmp = amp;
          if (voiceFilters.length > 0) {
            for (const filter of voiceFilters) currentOsc.connect(oscGain).connect(filter);
          } else {
            currentOsc.connect(oscGain).connect(master);
          }
          currentOsc.start(t);
        }
        const voicedAmp = isNaN(p.amp) ? 1 : p.amp;
        if (voicedFadeOutScheduled) {
          const fadeInEnd = t + Math.min(0.01, p.d);
          oscGain.gain.setValueAtTime(0, t);
          oscGain.gain.linearRampToValueAtTime(getVoicedGain(voicedAmp), fadeInEnd);
          currentAmp = voicedAmp;
          voicedFadeOutScheduled = false;
        }

        // schedule pitch
        const pitchParam = currentOsc.frequency;
        const prevVoiced = i > 0 ? processedSeq[i - 1] : null;
        const effectiveSlideTime = resolvePortamento(p.slideTime ?? slideTime, slideTime, p.d);
        const effectivePortamento = resolvePortamento(p.portamento ?? portamento, portamento, p.d);
        const prevSlideTarget = prevVoiced && prevVoiced.voiced && prevVoiced.pitch && p.voiced && p.pitch
          ? prevVoiced.pitch + 0.5 * (p.pitch - prevVoiced.pitch)
          : null;
        const prevPitchForPortamento = (prevVoiced && prevVoiced.voiced && prevVoiced.pitch && p.voiced && p.pitch && effectivePortamento > 0)
          ? (prevSlideTarget && resolvePortamento(prevVoiced.slideTime ?? slideTime, slideTime, prevVoiced.d) > 0
            ? prevSlideTarget
            : getPortamentoStartPitch(prevVoiced, p))
          : p.pitch;
        const shouldPortamentoThisNote = effectivePortamento > 0 && prevVoiced && prevVoiced.voiced && prevVoiced.pitch && p.voiced && p.pitch;
        if (shouldPortamentoThisNote) {
          const blendDuration = Math.min(p.d, Math.max(0.015, Math.min(effectivePortamento, p.d * 0.5)));
          pitchParam.setValueAtTime(prevPitchForPortamento, t);
          pitchParam.linearRampToValueAtTime(p.pitch, t + blendDuration);
          pitchParam.setValueAtTime(p.pitch, t + blendDuration);
        } else {
          pitchParam.setValueAtTime(p.pitch, t);
        }

        // vibrato — per-phoneme aware: uses p.vib* fields from bracket overrides,
        // falls back to global parameters. Handles persistent LFO connect/disconnect
        // via vibConnected tracker.
        const vibFreqForNote = Number.isFinite(p.vibFreq) ? p.vibFreq : vibFreq;
        const vibDepthForNote = Number.isFinite(p.vibDepth) ? p.vibDepth : vibDepth;
        const vibDelayForNoteSec = Number.isFinite(p.vibDelay) ? p.vibDelay : vibDelay;
        const vibFadeInForNoteSec = Number.isFinite(p.vibFadeIn) ? p.vibFadeIn : globalVibFadeIn;
        const vibFadeOutForNoteSec = Number.isFinite(p.vibFadeOut) ? p.vibFadeOut : 0;
        const vibSpeedForNote = Number.isFinite(p.vibSpeed) ? p.vibSpeed : null;

        // Determine if vibrato should be active for this note (requires freq>0, depth>0, not whisper)
        const vibeOnForThis = (vibFreqForNote > 0 && vibDepthForNote > 0 && mode !== "whisper");

        if (vibeOnForThis && lfoGain && persistentVib && !p.vibratoOverride) {
          // Global persistent LFO — connect only once per oscillator run
          if (!vibConnected) {
            lfoGain.connect(pitchParam);
            vibConnected = true;
          }
        } else {
          // Disconnect global LFO if it was connected (e.g. [vf: 0] or per-note override that differs)
          if (vibConnected) {
            try { lfoGain.disconnect(pitchParam); } catch (e) {}
            vibConnected = false;
          }
        }

        // Schedule a per-note LFO only if:
        //   - vibrato is active for this note, AND
        //   - NOT using the persistent global LFO (i.e. persistentVib is false, OR there's no lfoGain)
        // This ensures bracket overrides (vf, vd, vde, vfa, vfao) actually take effect per phoneme
        // and supports disabling vibrato per note (e.g. [vf: 0]).
        if (vibeOnForThis && !(lfoGain && persistentVib && !p.vibratoOverride)) {
          const lfol = ctx.createOscillator();
          const lfoGl = ctx.createGain();
          lfol.type = "sine";
          const lfoRateHz = (vibSpeedForNote != null && vibSpeedForNote > 0) ? vibSpeedForNote : vibFreqForNote;
          lfol.frequency.setValueAtTime(lfoRateHz, t);

          const fadeStart = t + vibDelayForNoteSec;
          const fadeEnd = fadeStart + Math.max(0, vibFadeInForNoteSec);
          lfoGl.gain.setValueAtTime(0, fadeStart);
          lfoGl.gain.linearRampToValueAtTime(vibDepthForNote, fadeEnd);

          // FadeOut: ramp back to 0 at the end of the note
          const fadeOutStart = t + p.d - Math.max(0, vibFadeOutForNoteSec);
          if (fadeOutStart > fadeEnd) {
            lfoGl.gain.setValueAtTime(vibDepthForNote, fadeOutStart);
            lfoGl.gain.linearRampToValueAtTime(0, t + p.d);
          }

          lfol.connect(lfoGl).connect(pitchParam);
          lfol.start(fadeStart);
          lfol.stop(t + p.d + 0.02);
        }

        // Slide reaches halfway to the next pitch; portamento completes the rest.
        const canSlide = effectiveSlideTime > 0 && immediateNext && immediateNext.voiced && immediateNext.pitch && p.voiced;
        if (canSlide) {
          const rampStart = Math.max(t, t + p.d - effectiveSlideTime);
          const slideTarget = effectivePortamento > 0
            ? p.pitch + 0.5 * (immediateNext.pitch - p.pitch)
            : immediateNext.pitch;
          pitchParam.setValueAtTime(p.pitch, t);
          pitchParam.setValueAtTime(p.pitch, rampStart);
          pitchParam.linearRampToValueAtTime(slideTarget, t + p.d);
        }

        // update lastVoicedEnd
        lastVoicedEnd = t + p.d;
        if (p.dynamicFadeOut) {
          const finalBeat = Math.min(Math.max(0, beatLength), p.d);
          const silenceDuration = 0.1 * finalBeat;
          const fadeDuration = 0.05 * finalBeat;
          const fadeEnd = lastVoicedEnd - silenceDuration;
          const fadeStart = fadeEnd - fadeDuration;
          oscGain.gain.setValueAtTime(getVoicedGain(currentAmp), fadeStart);
          oscGain.gain.linearRampToValueAtTime(0, fadeEnd);
          voicedFadeOutScheduled = true;
        }

// morphing logic
        // morphTo: ramp formants from p.f -> p.morphTo across the FULL phoneme duration
        // (bypasses morphTime). This provides diphthong-style transitions like "ew".
// Note: phonemeMap entries carry 6 formants (F4-F6 ignored by the 3-filter
        // engine), so accept all 6 here.
        const hasMorphTo = voiceFilters.length > 0 && morphEnabled && p.morphTo && p.morphTo.length >= MAP_FORMANTS;
        const hasVoicedTarget = voiceFilters.length > 0 && morphEnabled && morphTime > 0 && nextVoiced && nextVoiced.voiced && nextVoiced.morphs !== false;
        const targetIsNasal = hasVoicedTarget && !!nextVoiced.nasal;
        const morphStart = t + Math.max(0, p.d - morphTime);
        const morphEnd = t + p.d;

        if (hasMorphTo) {
          for (let idx = 0; idx < numFormants; idx++) {
            const curVal = (p.f && p.f[idx]) || 0;
            const morphVal = (p.morphTo && p.morphTo[idx]) || 0;
            rampFreq(voiceFilters[idx].frequency, t, isRunStart, curVal, morphVal, t + p.d);
            rampFreq(sharedNoiseFilters[idx].frequency, t, isRunStart, curVal, morphVal, t + p.d);
            try { voiceGains[idx].gain.setValueAtTime(1, t); } catch (e) {}
          }
        } else if (targetIsNasal) {
          for (let idx = 0; idx < numFormants; idx++) {
            const curVal = (p.f && p.f[idx]) || 0;
            holdFreq(voiceFilters[idx].frequency, t, isRunStart, curVal);
            holdFreq(sharedNoiseFilters[idx].frequency, t, isRunStart, curVal);
            try {
              voiceGains[idx].gain.cancelScheduledValues(t);
              voiceGains[idx].gain.setValueAtTime(1, t);
              voiceGains[idx].gain.setValueAtTime(1, morphStart - 0.001);
              voiceGains[idx].gain.linearRampToValueAtTime(0.65, morphStart + Math.min(0.02, morphTime * 0.5));
              voiceGains[idx].gain.setValueAtTime(0.65, morphEnd - Math.min(0.02, morphTime * 0.5));
              voiceGains[idx].gain.linearRampToValueAtTime(1, morphEnd + 0.01);
            } catch (e) {}
          }
        // Clamp nasal burst depth so nasal phones (m/ng/n) don't become too audible/noisy
        scheduleNasalBurst(morphStart, morphEnd, Math.max(0.08, 0.1 * (p.amp || 1)));

        } else if (hasVoicedTarget) {
          for (let idx = 0; idx < numFormants; idx++) {
            const curVal = (p.f && p.f[idx]) || 0;
            const nextVal = (nextVoiced.f && nextVoiced.f[idx]) || 0;
            holdThenRampFreq(voiceFilters[idx].frequency, t, isRunStart, curVal, morphStart, nextVal, morphEnd);
            holdThenRampFreq(sharedNoiseFilters[idx].frequency, t, isRunStart, curVal, morphStart, nextVal, morphEnd);
          }
        } else if (voiceFilters.length > 0) {
          for (let idx = 0; idx < numFormants; idx++) {
            const val = (p.f && p.f[idx]) || 0;
            holdFreq(voiceFilters[idx].frequency, t, isRunStart, val);
            holdFreq(sharedNoiseFilters[idx].frequency, t, isRunStart, val);
            try { voiceGains[idx].gain.setValueAtTime(1, t); } catch (e) {}
          }
        }

        // breathy
        if (p.breathy) {
          const noiseSrc = ctx.createBufferSource();
          // voiced-ish breathy component/aspiration => PINK
          const breathyNoiseAmp = (p.noiseAmp ?? 1);
          noiseSrc.buffer = createFricativeNoiseBuffer(ctx, p.d, { voiced: true, amp: 0.05 * breathyNoiseAmp, usePinkNoise: p.usePinkNoise });
          if (sharedNoiseFilters.length > 0) {
            for (const nf of sharedNoiseFilters) noiseSrc.connect(nf);
          } else {
            noiseSrc.connect(master);
          }
          noiseSrc.start(t);
          noiseSrc.stop(t + p.d + 0.005);
        }


      } else {
        // non-voiced or whisper
        if (currentOsc) {
          // stop the oscillator with fade-out
          const fadeTime = 0.01;
          if (!voicedFadeOutScheduled) {
            oscGain.gain.setValueAtTime(getVoicedGain(currentAmp), lastVoicedEnd - fadeTime);
            oscGain.gain.linearRampToValueAtTime(0, lastVoicedEnd);
          }
          currentOsc.stop(lastVoicedEnd);
          currentOsc = null;
          oscGain = null;
          voicedFadeOutScheduled = false;
        }

        // play consonant noise
        if (!p.voiced || mode === "whisper") {
          playConsonantNoise(t, p.d, p.f, p.amp, p.noiseAmp ?? 1, 0, p.dynamicFadeOut, p.key === "s" ? 0.5 : 0, Boolean(p.voiced), p.usePinkNoise);
        }
      }

      t += p.d;
    }

    // stop any remaining oscillator
    if (currentOsc) {
      const fadeTime = 0.01;
      if (!voicedFadeOutScheduled) {
        oscGain.gain.setValueAtTime(1 * currentAmp, lastVoicedEnd - fadeTime);
        oscGain.gain.linearRampToValueAtTime(0, lastVoicedEnd);
      }
      currentOsc.stop(lastVoicedEnd);
    }

    master.connect(ctx.destination);
    return await ctx.startRendering();
  };

  const resampleAudio = (data, sourceRate, targetRate) => {
    if (sourceRate === targetRate) return data;
    const outputLength = Math.ceil(data.length * targetRate / sourceRate);
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index++) {
      const sourcePosition = index * sourceRate / targetRate;
      const lower = Math.floor(sourcePosition);
      const fraction = sourcePosition - lower;
      const next = Math.min(lower + 1, data.length - 1);
      output[index] = data[lower] * (1 - fraction) + data[next] * fraction;
    }
    return output;
  };

  const previewPhoneme = async (key) => {
    const source = phonemeMap[key];
    if (!source || key === "rest") return;

    const duration = 0.35;
    const phoneme = {
      key,
      ...source,
      d: duration,
      pitch: noteToFreq("C4"),
      f: getAdjustedFormants(source.f),
      morphTo: source.morphTo ? getAdjustedFormants(source.morphTo) : undefined
    };
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(duration * sampleRate) + 128, sampleRate);
    const rendered = await synthesize(offlineCtx, [phoneme], "voiced", 0, 0, 0, 0.05, true, 0, false, false, 0.1);

    stopPreview();
    actx = new (window.AudioContext || window.webkitAudioContext)();
    previewBuf = actx.createBuffer(1, rendered.length, sampleRate);
    previewBuf.getChannelData(0).set(rendered.getChannelData(0));
    prevSrc = actx.createBufferSource();
    prevSrc.buffer = previewBuf;
    prevSrc.connect(actx.destination);
    prevSrc.onended = () => {
      prevSrc = null;
      previewBuf = null;
      setVisualIdle();
      if (actx) {
        try { actx.close(); } catch (e) {}
        actx = null;
      }
    };
    prevSrc.start();
  };

  // UI: minimal container (controls same as previous iterations)
  // Enable page scrolling
  document.body.style.margin = "0";
  document.body.style.padding = "8px";
  document.body.style.overflow = "auto";

  document.querySelectorAll(".voice-ui").forEach(e => e.remove());
  const container = document.createElement("div");
  container.className = "voice-ui";
   container.style = "margin:0 auto;padding:12px;background:#fff;border:1px solid #ccc;font-family:monospace;max-width:900px;box-sizing:border-box;";
  container.innerHTML = `
    <>
    <h3 style="margin:0 0 8px 0">Hoster's FR Synthesizer</h3>
    <div style="font-size:12px;margin-bottom:8px">Javascript Synth that sings for u or smth and is (probably) very buggy and makes artifacts</div>
    <div style="font-size:12px;margin-bottom:8px">This started off as a simple short script by chatgpt that turned into a full project (maintained by vsc blackbox)</div>
    <div style="font-size:12px;margin-bottom:16px">this is ai-written but give me some credit, at least i did SOME of the work...</div>
    <!-- Embedded duplicate help markup is disabled; the standalone panel follows below. -->
    <!--
      <div id="syntaxHelpHeader" style="display:flex;align-items:center;gap:6px;padding:7px 8px;background:#f2f2f2;border-bottom:1px solid #ccc;cursor:grab;user-select:none;touch-action:none;">
    <b style="flex:1;">Syntax Help</b>
    <button id="syntaxRotate" type="button" title="Drag header to rotate" style="padding:1px 5px;">R</button>
    <button id="syntaxCollapse" type="button" title="Collapse help" style="padding:1px 5px;">-</button>
    <button id="syntaxClose" type="button" title="Close help" style="padding:1px 5px;">x</button>
      </div>
      <div id="syntaxHelpBody" style="height:calc(100% - 35px);overflow:auto;padding:9px 10px;box-sizing:border-box;">
    <div><b>Notes</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 9px;">a &lt;C4,1&gt;   explicit pitch and duration
        <label style="display:flex; align-items:center; gap:6px;">
  rest &lt;0.25&gt;  silence</pre>
    <div><b>Persistent settings</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 4px;">[fs:1.2, vf:6, vd:5, vde:0.1, vfa:0.2, vfao:0.1] a &lt;C4,1&gt;
          <input type="checkbox" id="disableFilters"/>
  [reset] i &lt;1&gt;  restore defaults</pre>
    <div style="margin-bottom:9px;">Use <code>name:value</code>, <code>name=value</code>, or <code>name value</code>. Separate settings with commas or spaces. <code>vdae</code> aliases <code>vde</code>.</div>
    <div><b>Setting names</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 9px;">fs    formant scale
  vf    vibrato frequency (Hz)
  vd    vibrato depth (Hz)
  vde   vibrato delay (seconds)
  vfa   vibrato fade-in (seconds)
  vfao  vibrato fade-out (seconds)</pre>
    <div><b>Inline fields</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 9px;">a &lt;C4,1,6,0.1,0.2,4&gt;
  pitch, duration, frequency, delay,
  fade-in, speed</pre>
    <div style="margin-bottom:9px;">Inline fields override persistent settings for that note.</div>
    <div><b>Examples</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0;">[fs:0.8] a &lt;C3,1&gt;
  [vf:0] e &lt;1&gt;
  [vd:8, vfa:0.4] i &lt;1&gt;
  [reset] o &lt;1&gt;</pre>
      </div>
    -->
    <div id="visualFrame" style="position:fixed; top:10px; right:10px; width:240px; height:240px; border:2px solid #333; background:#fff; border-radius:6px; box-sizing:border-box; padding:6px; font-family:monospace; z-index:10;">
      <div style="display:flex;align-items:center;border-bottom:1px solid #ccc;padding-bottom:2px;"><b style="flex:1;text-align:center;font-size:13px;">Visual</b><button id="closeVisualBtn" type="button" title="Close visual">close visual</button></div>
      <canvas id="visualCanvas" width="210" height="140" style="display:block; margin:4px auto;"></canvas>
      <div id="visualFormants" style="text-align:center; font-size:11px; margin-top:4px;">F1: 0&nbsp;&nbsp;F2: 0&nbsp;&nbsp;F3: 0</div>
      <div id="visualPhone" style="text-align:center; font-size:11px; margin-top:3px;">Current Phone: None</div>
    </div>
    <div id="experimentalPanel" style="position:fixed; top:258px; right:10px; width:240px; border:2px solid #333; background:#fff; border-radius:6px; box-sizing:border-box; padding:6px; font-family:monospace; z-index:10;">
      <div style="display:flex;align-items:center;border-bottom:1px solid #ccc;padding-bottom:2px;"><b style="flex:1;text-align:center;font-size:12px;">Experimental/Useless/For Fun</b><button id="closeExperimentalBtn" type="button" title="Close experimental">close experimental</button></div>
      <div style="margin-top:4px; font-size:11px;">
        <label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" id="disableFilters"/>
          Disable biquad/formant filter
        </label>
      </div>
      <div style="margin-top:6px; font-size:11px;">
        <label>Oscillator / Glottal pulse:
          <select id="oscTypeSel" style="width:100%; margin-top:2px;">
            <option value="rosenberg">Rosenberg/Default</option>
            <option value="lf">Liljencrants-Fant (LF)</option>
            <option value="sawtooth">Sawtooth</option>
            <option value="square">Square</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>
      <div id="customOscControls" style="display:none; margin-top:6px; font-size:11px;">
        <button id="uploadOscBtn" style="width:100%; padding:4px 6px;">Upload oscillator sample</button>
        <input type="file" id="oscFile" accept="audio/*" style="display:none;"/>
        <div id="oscStatus" style="margin-top:3px; font-size:10px; color:#555;"></div>
      </div>
    </div>
          
        </label>
      </div>
      <div style="margin-top:6px; font-size:11px;">
        <label>Oscillator / Glottal pulse:
          <select id="oscTypeSel" style="width:100%; margin-top:2px;">
            <option value="rosenberg">Rosenberg/Default</option>
            <option value="lf">Liljencrants-Fant (LF)</option>
            <option value="sawtooth">Sawtooth</option>
            <option value="square">Square</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>
      <div id="customOscControls" style="display:none; margin-top:6px; font-size:11px;">
        <button id="uploadOscBtn" style="width:100%; padding:4px 6px;">Upload oscillator sample</button>
        <input type="file" id="oscFile" accept="audio/*" style="display:none;"/>
        <div id="oscStatus" style="margin-top:3px; font-size:10px; color:#555;"></div>
      </div>
    </div>
    <label style="display:block">Melody / Text:<br/>
      <textarea id="phonemeInput" rows="4" style="width:100%;font-family:monospace;">d<c2,0.1> o<c2,0.9> r<d2,0.1> e<d2,0.9> m<e2,0.1> i<e2,0.9> f<f2,0.1> a<f2,0.9> s<g2,0.1> o<g2,0.9> l<a2,0.1> a<a2,0.9> t<b2,0.1> i<b2,0.9> d<c3,0.1> o<c3,0.9></textarea>
    </label>
    <div style="margin-top:6px">
      <label>Synthesis Method:
        <select id="synthesisMethod"><option value="synthesized" selected>Synthesized</option><option value="concatenative">Concatenative</option></select>
      </label>
      <label>Voice mode:
        <select id="voiceMode"><option value="voiced" selected>Voiced</option><option value="whisper">Whisper</option></select>
      </label>
      <label style="margin-left:8px">BPM: <input type="number" id="bpm" value="120" style="width:80px"/></label>
      <label style="margin-left:8px">Grid:
        <select id="gridType"><option value="beats" selected>Beats</option><option value="steps">Steps</option><option value="seconds">Seconds</option></select>
      </label>
      <label id="stepsPerBeatLabel" style="margin-left:8px">Steps/Beat: <input type="number" id="stepsPerBeat" value="4" min="1" style="width:60px"/></label>
      <label style="margin-left:8px">Sample rate (Hz): <input type="number" id="sampleRate" value="44100" min="8000" max="192000" step="1" style="width:90px"/></label>
    </div>
    <div style="margin-top:6px">
      <label>Vibrato Freq (Hz): <input type="number" id="vibFreq" value="6" step="0.1" style="width:80px"/></label>
      <label style="margin-left:8px">Depth (Hz): <input type="number" id="vibDepth" value="5" step="0.1" style="width:80px"/></label>
      <label style="margin-left:8px">Delay (s): <input type="number" id="vibDelay" value="0.1" step="0.01" style="width:80px"/></label>
      <label style="margin-left:8px">Fade (s): <input type="number" id="vibFade" value="0" min="0" step="0.01" style="width:70px"/></label>
      <label style="margin-left:8px"><input type="checkbox" id="persistentVib" checked/> Persistent Vibrato</label>
    </div>
    <div style="margin-top:6px">
      <label>Formant Morph time (s): <input type="number" id="morphTime" value="0.06" step="0.01" style="width:80px"/></label>
      <label style="margin-left:8px"><input type="checkbox" id="enableMorph" checked/> Enable Morph</label>
      <label style="margin-left:8px">Slide (s): <input type="text" id="slideTime" value="0.08" style="width:80px"/></label>
      <label style="margin-left:8px">Portamento (s; Auto=50%): <input type="text" id="portamento" value="0.08" style="width:100px"/></label>
    </div>
    <div style="margin-top:6px">
      <label><input type="checkbox" id="useCMU"/> Use CMUDict</label>
      <button id="loadCMU" style="margin-left:8px;padding:4px 8px;">Load CMUDict</button>
    </div>
    <div style="margin-top:6px">
      <label>Personal Dictionary:</label>
      <button id="saveDictBtn" style="margin-left:8px;padding:4px 8px;">Save Dict</button>
      <button id="loadDictBtn" style="margin-left:8px;padding:4px 8px;">Load Dict</button>
    </div>
    <div style="margin-top:6px">
      <label><input type="checkbox" id="dynamicMode"/> Dynamic Mode</label>
      <label style="margin-left:8px">Consonant Duration: <input type="number" id="consonantDuration" value="0.1" step="0.01" style="width:80px"/></label>
    </div>
    <div style="margin-top:6px">
      <label>Gender Shift: <input type="range" id="genderShift" min="-150" max="150" value="0" style="width:200px"/></label>
      <span id="genderValue">0</span>
    </div>
    <div style="margin-top:6px">
      <label>Voice Clone: <input type="file" id="voiceFile" accept="audio/*"/></label>
      <div id="cloneControls" style="margin-top:4px;"></div>
    </div>
    <div style="margin-top:8px">
      <button id="synthBtn" style="padding:6px 12px">ðŸŽ¤ Synthesize</button>
      <span id="status" style="margin-left:10px;font-size:12px;color:#444"></span>
    </div>
    <div style="margin-top:6px; padding-top:8px; border-top:1px dashed #ddd;">
      <div style="font-size:12px; margin-bottom:4px">Output normalization (applies to preview + downloaded WAV)</div>
      <label style="font-size:12px; display:block">
        <input type="checkbox" id="enableNormalize" checked/> Enable normalize
      </label>
      <label style="font-size:12px; display:flex; align-items:center; gap:8px; margin-top:4px;">
        Target dBFS:
        <input type="number" id="normalizeTargetDb" value="-20" step="0.1" style="width:90px"/>
      </label>
    </div>

    <div style="margin-top:10px; padding-top:8px; border-top:1px dashed #ddd;">
      <div style="font-size:12px; margin-bottom:6px">MIDI Import</div>
      <label>Midi file: <input type="file" id="midiFile" accept=".mid,.midi,audio/midi,application/octet-stream"/></label>
      <label style="display:block;margin-top:6px;font-size:12px;color:#333;">Custom file name:<br/>
        <input type="text" id="customFileName" placeholder="singer" style="width:140px;font-family:monospace"/>
      </label>

      <button id="importMidiBtn" style="margin-left:0; margin-top:6px; padding:4px 10px;">Import MIDI</button>
      <label style="margin-left:8px; font-size:12px; color:#333; display:inline-flex; align-items:center; gap:6px;">
        <input type="checkbox" id="midiReplacePitches" />
        Replace pitches only (keep existing phonemes)
      </label>
      <div style="font-size:12px; margin-top:6px; color:#444">Notes map to phoneme <b>a</b>. Gaps map to <b>rest</b>. Enable the toggle to keep current phonemes but replace their <code><pitch,duration></code>.</div>
    </div>
    <div id="outputControls" style="margin-top:8px"></div>
<!-- Piano Roll Section -->
    <div style="margin-top:12px; padding-top:8px; border-top:1px dashed #ddd;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
        <span style="font-size:12px; font-weight:bold;">Piano Roll</span>
        <div style="font-size:11px;">
          <label><input type="checkbox" id="pianoRollSnap" checked/> Snap to grid</label>
          <label style="margin-left:6px;">Snap:
            <select id="pianoRollSnapType" style="font-size:11px;">
              <option value="0.5">1/2</option>
              <option value="0.3333333333">1/3</option>
              <option value="0.25" selected>1/4</option>
              <option value="0.1666666667">1/6</option>
              <option value="0.125">1/8</option>
              <option value="0.0833333333">1/12</option>
              <option value="0.0625">1/16</option>
              <option value="0.0416666667">1/24</option>
              <option value="0.03125">1/32</option>
            </select>
          </label>
          <button id="pianoRollRefreshBtn" style="margin-left:6px; padding:2px 6px; font-size:11px;">Refresh from text</button>
        </div>
      </div>
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <div id="pianoRollPanel" style="width:180px; flex:0 0 180px; border:1px solid #ccc; background:#fff; padding:8px; font-size:12px; box-sizing:border-box;"></div>
        <div id="pianoRollContainer" style="position:relative; border:1px solid #999; overflow:auto; width:100%; height:350px; background:#f8f8f8;">
          <canvas id="pianoRollCanvas" tabindex="0" style="display:block;"></canvas>
        </div>
      </div>
      <div style="font-size:11px; margin-top:4px; color:#555;">
        Click grid to add note | Drag note to move | Drag edges to resize | Delete key removes selected | Shift+Click or Shift+Drag to select multiple | Double-click to edit phoneme
      </div>
    </div>
  `;
  document.body.appendChild(container);

  const syntaxHelp = document.createElement("div");
  syntaxHelp.className = "syntax-help";
  syntaxHelp.style = "display:none;position:fixed;left:10px;bottom:10px;width:320px;height:390px;min-width:240px;min-height:150px;max-width:80vw;max-height:80vh;overflow:hidden;padding:0;background:#fff;border:1px solid #999;border-radius:6px;box-sizing:border-box;font-family:monospace;font-size:11px;z-index:20;resize:both;transform-origin:center center;box-shadow:2px 2px 8px rgba(0,0,0,0.18);";
  syntaxHelp.innerHTML = `
    <div id="syntaxHelpHeader" style="display:flex;align-items:center;gap:6px;padding:7px 8px;background:#f2f2f2;border-bottom:1px solid #ccc;cursor:grab;user-select:none;touch-action:none;">
      <b style="flex:1;">Syntax Help</b>
      <button id="syntaxCollapse" type="button" title="Collapse help" style="padding:1px 5px;">-</button>
      <button id="syntaxClose" type="button" title="Close help" style="padding:1px 5px;">x</button>
    </div>
    <div id="syntaxHelpBody" style="height:calc(100% - 35px);overflow:auto;padding:9px 10px;box-sizing:border-box;">
    <div><b>Basic note</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 8px;">a &lt;C4,1&gt; e &lt;1&gt;
rest &lt;0.25&gt;</pre>
    <div><b>Persistent settings</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 8px;">[fs:1.2, vf:6, vd:5, vde:0.1, vfa:0.2, vfao:0.1] a &lt;C4,1&gt;
e &lt;1&gt;   settings continue here
[reset] i &lt;1&gt;   restore defaults</pre>
    <div>Settings also accept <code>fs=1.2</code> or <code>fs 1.2</code>. <code>vdae</code> is accepted as an alias for <code>vde</code>.</div>
    <div style="margin-top:6px;"><b>Pitch and formant settings</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 8px;">[sl:0.12] a &lt;C4,1&gt;   slide time (same as slide)
  [fm:0.2] e &lt;1&gt;      formant morph time (same as fmorph)
  [port:0.08] i &lt;1&gt;   portamento time
  [port:auto] o &lt;1&gt;   half of this token's duration</pre>
    <div>These bracket settings apply to the following token and persist until changed or <code>[reset]</code>. Use <code>sl</code>/<code>slide</code>, <code>fm</code>/<code>fmorph</code>, or <code>port</code>/<code>portamento</code>/<code>pt</code>.</div>
    <div style="margin-top:6px;">With portamento on, slide moves halfway toward the next pitch before portamento finishes the transition. Downward note changes of 4+ semitones start one semitone below the target; raw frequencies dropping by 50+ Hz start 10 Hz below the target.</div>
    <div style="margin-top:6px;"><b>Per-note fields</b></div>
    <pre style="white-space:pre-wrap;margin:4px 0 0;">a &lt;C4,1,6,0.1,0.2,4&gt;
pitch, duration, vibFreq, vibDelay,
vibFadeIn, vibSpeed</pre>
    </div>
  `;
  document.body.appendChild(syntaxHelp);

  const syntaxReopen = document.createElement("button");
  syntaxReopen.type = "button";
  syntaxReopen.textContent = "Syntax Help";
  syntaxReopen.title = "Open syntax help";
  syntaxReopen.style = "display:block;position:fixed;left:10px;bottom:10px;padding:5px 8px;z-index:20;";
  document.body.appendChild(syntaxReopen);

  const dictionaryOpen = document.createElement("button");
  dictionaryOpen.type = "button";
  dictionaryOpen.textContent = "Dictionary";
  dictionaryOpen.title = "Open personal dictionary";
  dictionaryOpen.style = "display:block;position:fixed;left:10px;bottom:48px;padding:5px 8px;z-index:20;";
  document.body.appendChild(dictionaryOpen);

  const dictionaryPanel = document.createElement("div");
  dictionaryPanel.style = "display:none;position:fixed;left:10px;bottom:10px;width:340px;max-width:80vw;height:360px;max-height:80vh;overflow:hidden;padding:0;background:#fff;border:1px solid #999;border-radius:6px;box-sizing:border-box;font-family:monospace;font-size:11px;z-index:22;box-shadow:2px 2px 8px rgba(0,0,0,0.18);";
  dictionaryPanel.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;padding:7px 8px;background:#f2f2f2;border-bottom:1px solid #ccc;">
      <b style="flex:1;">Personal Dictionary</b>
      <button type="button" id="addDictionaryEntry" title="Add entry">+</button>
      <button type="button" id="removeDictionaryEntry" title="Remove last entry">-</button>
      <button type="button" id="closeDictionary" title="Close dictionary">x</button>
    </div>
    <div id="dictionaryRows" style="height:calc(100% - 36px);overflow:auto;padding:8px;box-sizing:border-box;"></div>`;
  document.body.appendChild(dictionaryPanel);

  const dictionaryRows = dictionaryPanel.querySelector("#dictionaryRows");
  const removeDictionaryEntry = dictionaryPanel.querySelector("#removeDictionaryEntry");
  const syncPersonalDictionary = () => {
    const updated = {};
    for (const row of dictionaryRows.children) {
      const word = row.querySelector(".dictionary-word").value.trim().toLowerCase().replace(/[^a-z']/g, "");
      const phonemes = row.querySelector(".dictionary-phonemes").value
        .trim().toLowerCase().split(/[,\s]+/).filter(Boolean);
      if (word && phonemes.length) updated[word] = phonemes;
    }
    personalDict = updated;
    savePersonalDict(true);
    removeDictionaryEntry.disabled = dictionaryRows.children.length === 0;
  };
  const addDictionaryRow = (word = "", phonemes = []) => {
    const row = document.createElement("div");
    row.style = "display:flex;flex-direction:column;gap:4px;margin-bottom:8px;padding:7px;border:1px solid #ccc;border-radius:4px;background:#fafafa;";
    const wordInput = document.createElement("input");
    wordInput.type = "text";
    wordInput.className = "dictionary-word";
    wordInput.placeholder = "Word";
    wordInput.setAttribute("aria-label", "Dictionary word");
    wordInput.value = word;
    wordInput.style = "width:100%;box-sizing:border-box;";
    const phonemeInput = document.createElement("input");
    phonemeInput.type = "text";
    phonemeInput.className = "dictionary-phonemes";
    phonemeInput.placeholder = "Phoneme sequence (e.g. a r)";
    phonemeInput.setAttribute("aria-label", "Phoneme sequence");
    phonemeInput.value = phonemes.join(" ");
    phonemeInput.style = "width:100%;box-sizing:border-box;";
    wordInput.addEventListener("input", syncPersonalDictionary);
    phonemeInput.addEventListener("input", syncPersonalDictionary);
    row.append(wordInput, phonemeInput);
    dictionaryRows.appendChild(row);
  };
  const renderPersonalDictionary = () => {
    dictionaryRows.replaceChildren();
    for (const [word, phonemes] of Object.entries(personalDict)) {
      addDictionaryRow(word, Array.isArray(phonemes) ? phonemes : []);
    }
    removeDictionaryEntry.disabled = dictionaryRows.children.length === 0;
  };
  dictionaryPanel.querySelector("#addDictionaryEntry").addEventListener("click", () => {
    addDictionaryRow();
    syncPersonalDictionary();
    dictionaryRows.lastElementChild.querySelector(".dictionary-word").focus();
  });
  removeDictionaryEntry.addEventListener("click", () => {
    dictionaryRows.lastElementChild?.remove();
    syncPersonalDictionary();
  });
  dictionaryOpen.addEventListener("click", () => {
    renderPersonalDictionary();
    dictionaryPanel.style.display = "block";
    dictionaryOpen.style.display = "none";
  });
  dictionaryPanel.querySelector("#closeDictionary").addEventListener("click", () => {
    dictionaryPanel.style.display = "none";
    dictionaryOpen.style.display = "block";
  });

  const concatenativeOpen = document.createElement("button");
  concatenativeOpen.type = "button";
  concatenativeOpen.textContent = "Concatenative Phoneme Samples";
  concatenativeOpen.style = "display:none;position:fixed;left:10px;bottom:86px;padding:5px 8px;z-index:20;";
  document.body.appendChild(concatenativeOpen);

  const concatenativePanel = document.createElement("div");
  concatenativePanel.style = "display:none;position:fixed;left:10px;bottom:10px;width:340px;max-width:80vw;max-height:80vh;overflow:hidden;padding:0;background:#fff;border:1px solid #999;border-radius:6px;box-sizing:border-box;font-family:monospace;font-size:11px;z-index:21;box-shadow:2px 2px 8px rgba(0,0,0,0.18);";
  concatenativePanel.innerHTML = `
    <div style="display:flex;align-items:center;padding:7px 8px;background:#f2f2f2;border-bottom:1px solid #ccc;">
      <b style="flex:1;">Concatenative Samples</b>
      <button type="button" id="closeConcatenative">x</button>
    </div>
    <div style="display:flex;gap:6px;padding:8px 8px 0;">
      <button type="button" id="exportVoicebank">Export voicebank</button>
      <button type="button" id="importVoicebank">Import voicebank</button>
      <input type="file" id="voicebankFile" accept=".jsvoicebank,application/json" style="display:none;" />
    </div>
    <div id="voicebankStatus" style="padding:4px 8px;color:#555;"></div>
    <div id="concatenativeSampleList" style="overflow:auto;max-height:calc(80vh - 84px);padding:8px;"></div>`;
  document.body.appendChild(concatenativePanel);

  const concatenativeSampleList = concatenativePanel.querySelector("#concatenativeSampleList");
  const voicebankStatus = concatenativePanel.querySelector("#voicebankStatus");
  const voicebankFile = concatenativePanel.querySelector("#voicebankFile");
  concatenativePanel.querySelector("#exportVoicebank").addEventListener("click", () => {
    try {
      const samples = [];
      for (const [key, sample] of concatenativeSamples) {
        const audio = sample.buffer.getChannelData(0);
        const bytes = new Uint8Array(audio.length * 4);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < audio.length; index++) view.setFloat32(index * 4, audio[index], true);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
        }
        samples.push({ key, sampleRate: sample.buffer.sampleRate, encoding: "float32le", data: btoa(binary), fileName: sample.fileName, fileType: sample.fileType });
      }
      if (!samples.length) {
        voicebankStatus.textContent = "Upload at least one phoneme sample first.";
        return;
      }
      const payload = { format: "jsvoicebank", version: 1, samples };
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = "voicebank.jsvoicebank";
      link.click();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      voicebankStatus.textContent = `Exported ${samples.length} samples.`;
    } catch (error) {
      voicebankStatus.textContent = `Export failed: ${error.message || error}`;
    }
  });
  concatenativePanel.querySelector("#importVoicebank").addEventListener("click", () => voicebankFile.click());
  voicebankFile.addEventListener("change", async () => {
    const file = voicebankFile.files?.[0];
    if (!file) return;
    let audioCtx;
    try {
      voicebankStatus.textContent = "Importing voicebank...";
      const payload = JSON.parse(await file.text());
      if (payload?.format !== "jsvoicebank" || payload.version !== 1 || !Array.isArray(payload.samples)) {
        throw new Error("Unsupported or invalid voicebank format.");
      }
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const imported = new Map();
      for (const item of payload.samples) {
        if (!concatenativeRequiredPhonemes.includes(item.key) || item.encoding !== "float32le" ||
            !Number.isFinite(item.sampleRate) || item.sampleRate < 8000 || item.sampleRate > 384000 || typeof item.data !== "string") {
          throw new Error("Voicebank contains an invalid sample entry.");
        }
        const binary = atob(item.data);
        if (!binary.length || binary.length % 4 !== 0) throw new Error(`Invalid audio data for ${item.key}.`);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const buffer = audioCtx.createBuffer(1, bytes.length / 4, item.sampleRate);
        const channel = buffer.getChannelData(0);
        for (let index = 0; index < channel.length; index++) channel[index] = view.getFloat32(index * 4, true);
        for (const value of channel) {
          if (!Number.isFinite(value)) throw new Error(`Non-finite audio data for ${item.key}.`);
        }
        imported.set(item.key, {
          buffer,
          formants: estimateSampleFormants(buffer),
          pitch: estimateSamplePitch(buffer),
          fileName: typeof item.fileName === "string" ? item.fileName : `${item.key}.wav`,
          fileType: typeof item.fileType === "string" ? item.fileType : "audio/wav"
        });
      }
      if (!imported.size) throw new Error("Voicebank contains no samples.");
      concatenativeSamples.clear();
      for (const [key, sample] of imported) concatenativeSamples.set(key, sample);
      renderConcatenativeSampleList();
      voicebankStatus.textContent = `Imported ${imported.size} samples.`;
    } catch (error) {
      voicebankStatus.textContent = `Import failed: ${error.message || error}`;
    } finally {
      if (audioCtx) try { await audioCtx.close(); } catch (error) {}
      voicebankFile.value = "";
    }
  });
  const renderConcatenativeSampleList = () => {
    concatenativeSampleList.innerHTML = "";
    for (const key of concatenativeRequiredPhonemes) {
      const row = document.createElement("div");
      row.style = "display:flex;align-items:center;gap:6px;margin-bottom:5px;min-height:22px;";
      const label = document.createElement("b");
      label.textContent = `${key}:`;
      label.style = "width:38px;flex:0 0 38px;";
      const upload = document.createElement("button");
      upload.type = "button";
      upload.textContent = "Upload";
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "audio/*";
      input.style.display = "none";
      const status = document.createElement("span");
      status.style = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
      if (key === "rest") status.title = "If for some reason rest is a SFX, go ahead";
      const updateRow = () => {
        const sample = concatenativeSamples.get(key);
        upload.style.display = sample ? "none" : "inline-block";
        status.textContent = sample ? `${sample.fileName} (${sample.fileType || "audio"})` : key === "rest" ? "if for some reason rest is a SFX, go ahead" : "";
        row.querySelectorAll(".sample-remove").forEach(remove => remove.remove());
        if (sample) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "sample-remove";
          remove.textContent = "X";
          remove.title = `Remove ${key} sample`;
          remove.addEventListener("click", () => { concatenativeSamples.delete(key); updateRow(); });
          row.appendChild(remove);
        }
      };
      upload.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          status.textContent = "Decoding...";
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
          concatenativeSamples.set(key, { buffer, formants: estimateSampleFormants(buffer), pitch: estimateSamplePitch(buffer), fileName: file.name, fileType: file.type });
          try { await audioCtx.close(); } catch (error) {}
          updateRow();
        } catch (error) {
          status.textContent = `Error: ${error.message || error}`;
        }
      });
      row.append(label, upload, input, status);
      concatenativeSampleList.appendChild(row);
      updateRow();
    }
  };
  renderConcatenativeSampleList();
  concatenativeOpen.addEventListener("click", () => {
    concatenativePanel.style.display = "block";
    concatenativeOpen.style.display = "none";
  });
  concatenativePanel.querySelector("#closeConcatenative").addEventListener("click", () => {
    concatenativePanel.style.display = "none";
    concatenativeOpen.style.display = "block";
  });

  const syntaxHeader = syntaxHelp.querySelector("#syntaxHelpHeader");
  const syntaxBody = syntaxHelp.querySelector("#syntaxHelpBody");
  const syntaxCollapse = syntaxHelp.querySelector("#syntaxCollapse");
  const syntaxClose = syntaxHelp.querySelector("#syntaxClose");
  let syntaxRotation = 0;
  let syntaxRotationVelocity = 0;
  let syntaxDrag = null;
  let syntaxDragFrame = null;

  const scheduleSyntaxPanelUpdate = (x, y) => {
    if (syntaxDragFrame) return;
    syntaxDragFrame = requestAnimationFrame(() => {
      syntaxDragFrame = null;
      if (x !== null && y !== null) {
        syntaxHelp.style.left = `${x}px`;
        syntaxHelp.style.top = `${y}px`;
        syntaxHelp.style.bottom = "auto";
      }
      syntaxHelp.style.transform = `rotate(${syntaxRotation}deg)`;
    });
  };

  const animateSyntaxPanel = () => {
    if (!syntaxDrag) {
      const homePull = -syntaxRotation * 0.12;
      syntaxRotationVelocity += homePull;
      syntaxRotationVelocity *= 0.86;
      if (Math.abs(syntaxRotationVelocity) < 0.08 && Math.abs(syntaxRotation) < 0.08) {
        syntaxRotation = 0;
        syntaxRotationVelocity = 0;
      } else {
        syntaxRotation += syntaxRotationVelocity;
        if (Math.abs(syntaxRotation) < 0.05) syntaxRotation = 0;
      }
      scheduleSyntaxPanelUpdate(null, null);
    }
    requestAnimationFrame(animateSyntaxPanel);
  };
  requestAnimationFrame(animateSyntaxPanel);

  syntaxCollapse.addEventListener("click", () => {
    const collapsed = syntaxBody.style.display === "none";
    syntaxBody.style.display = collapsed ? "block" : "none";
    syntaxHelp.style.height = collapsed ? "390px" : "35px";
    syntaxCollapse.textContent = collapsed ? "-" : "+";
  });
  syntaxClose.addEventListener("click", () => {
    syntaxHelp.style.display = "none";
    syntaxReopen.style.display = "block";
  });
  syntaxReopen.addEventListener("click", () => {
    syntaxHelp.style.display = "block";
    syntaxReopen.style.display = "none";
  });
  syntaxHeader.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    syntaxHeader.setPointerCapture(event.pointerId);
    const rect = syntaxHelp.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    syntaxDrag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      centerX,
      centerY,
      lastAngle: angle,
      lastTime: performance.now()
    };
    event.preventDefault();
  });
  syntaxHeader.addEventListener("pointermove", (event) => {
    if (!syntaxDrag) return;
    const rect = syntaxHelp.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const rawDeltaAngle = (angle - syntaxDrag.lastAngle);
    const deltaAngle = ((rawDeltaAngle + Math.PI) % (Math.PI * 2)) - Math.PI;
    const now = performance.now();
    const dt = Math.max(16, now - syntaxDrag.lastTime);
    syntaxRotation += deltaAngle * 180 / Math.PI;
    syntaxRotationVelocity = (deltaAngle * 180 / Math.PI / dt) * 1000 * 0.7;
    syntaxRotationVelocity = Math.max(-180, Math.min(180, syntaxRotationVelocity));
    syntaxDrag.lastAngle = angle;
    syntaxDrag.lastTime = now;
    const left = event.clientX - syntaxDrag.offsetX;
    const top = event.clientY - syntaxDrag.offsetY;
    scheduleSyntaxPanelUpdate(left, top);
  });
  syntaxHeader.addEventListener("pointerup", () => { syntaxDrag = null; });
  syntaxHeader.addEventListener("pointercancel", () => { syntaxDrag = null; });

  const gridTypeEl = container.querySelector("#gridType");
  const stepsLabel = container.querySelector("#stepsPerBeatLabel");
  const synthesisMethodEl = container.querySelector("#synthesisMethod");
  synthesisMethodEl.addEventListener("change", event => {
    synthesisMethod = event.target.value;
    concatenativeOpen.style.display = synthesisMethod === "concatenative" ? "block" : "none";
    if (synthesisMethod !== "concatenative") concatenativePanel.style.display = "none";
  });
  gridTypeEl.addEventListener("change", () => {
    stepsLabel.style.display = gridTypeEl.value === "steps" ? "inline-block" : "none";
  });
  stepsLabel.style.display = gridTypeEl.value === "steps" ? "inline-block" : "none";

  // Gender shift slider event listener
  const genderShiftEl = container.querySelector("#genderShift");
  const genderValueEl = container.querySelector("#genderValue");
  genderShiftEl.addEventListener("input", (e) => {
    genderShift = parseInt(e.target.value);
    genderValueEl.textContent = genderShift;
  });
  genderValueEl.textContent = genderShift; // initial display

  // Voice clone file upload event listener
  const voiceFileEl = container.querySelector("#voiceFile");
  const cloneControlsEl = container.querySelector("#cloneControls");
  voiceFileEl.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    cloneControlsEl.innerHTML = "Extracting voice parameters...";
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      extractVoiceParameters(audioBuffer);
      cloneControlsEl.innerHTML = `<button id="cloneBtn">Clone Voice</button> <span>Voice extracted successfully.</span>`;
      const cloneBtn = cloneControlsEl.querySelector("#cloneBtn");
      cloneBtn.addEventListener("click", () => {
        // Toggle cloning: if clonedRatios exists, clear it; else set it
        if (clonedRatios) {
          clonedRatios = null;
          cloneBtn.textContent = "Clone Voice";
          cloneControlsEl.querySelector("span").textContent = "Voice cloning disabled.";
        } else {
          // Re-extract or just enable
          extractVoiceParameters(audioBuffer); // re-extract if needed, but since it's already done, just set
          cloneBtn.textContent = "Disable Clone";
          cloneControlsEl.querySelector("span").textContent = "Voice cloned successfully.";
        }
      });
    } catch (err) {
      cloneControlsEl.innerHTML = "Error extracting voice: " + err.message;
    }
  });

  const synthBtn = container.querySelector("#synthBtn");
  const outputControls = container.querySelector("#outputControls");
  const statusEl = container.querySelector("#status");
  const sampleRateEl = container.querySelector("#sampleRate");
  const updateSampleRate = () => {
    const value = Number(sampleRateEl.value);
    if (!Number.isInteger(value) || value < 8000 || value > 192000) return false;
    sampleRate = value;
    return true;
  };
  sampleRateEl.addEventListener("change", () => {
    if (!updateSampleRate()) {
      sampleRateEl.value = String(sampleRate);
      statusEl.textContent = "Sample rate must be between 8000 and 192000 Hz.";
    }
  });
  const useCMUChk = container.querySelector("#useCMU");
  const loadCMUBtn = container.querySelector("#loadCMU");

  useCMUChk.addEventListener("change", (e) => useCMUDict = e.target.checked);
  loadCMUBtn.addEventListener("click", async () => {
    try {
      loadCMUBtn.disabled = true; loadCMUBtn.textContent = "Loading...";
      await loadCMUDict();
      loadCMUBtn.textContent = "Loaded âœ“"; useCMUChk.checked = true;
    } catch (err) {
      console.error(err); loadCMUBtn.textContent = "Load failed";
    } finally { loadCMUBtn.disabled = false; }
  });

  const saveDictBtn = container.querySelector("#saveDictBtn");
  const loadDictBtn = container.querySelector("#loadDictBtn");
  saveDictBtn.addEventListener("click", () => {
    savePersonalDict();
    statusEl.textContent = "Personal dictionary saved.";
  });
  loadDictBtn.addEventListener("click", () => {
    loadPersonalDict();
    renderPersonalDictionary();
    statusEl.textContent = "Personal dictionary loaded.";
  });

  // Dynamic mode and consonant duration event listeners
  const dynamicModeEl = container.querySelector("#dynamicMode");
  const consonantDurationEl = container.querySelector("#consonantDuration");
  dynamicModeEl.addEventListener("change", (e) => {
    dynamicMode = e.target.checked;
  });
  consonantDurationEl.addEventListener("input", (e) => {
    consonantDuration = parseFloat(e.target.value) || 0.1;
  });
  // Set initial values
  dynamicModeEl.checked = dynamicMode;
  consonantDurationEl.value = consonantDuration;

  // --- Experimental / for-fun panel wiring ---
  const disableFiltersEl = container.querySelector("#disableFilters");
  const oscTypeSel = container.querySelector("#oscTypeSel");
  const customOscControlsEl = container.querySelector("#customOscControls");
  const uploadOscBtn = container.querySelector("#uploadOscBtn");
  const oscFileEl = container.querySelector("#oscFile");
  const oscStatusEl = container.querySelector("#oscStatus");

  disableFiltersEl.addEventListener("change", (e) => disableFormantFilter = e.target.checked);
  oscTypeSel.addEventListener("change", () => {
    oscType = oscTypeSel.value;
    customOscControlsEl.style.display = oscType === "custom" ? "block" : "none";
  });
  uploadOscBtn.addEventListener("click", () => oscFileEl.click());
  oscFileEl.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ab = await file.arrayBuffer();
      const buf = await tmpCtx.decodeAudioData(ab);
      customOscSample = buf.getChannelData(0);
      customOscSampleRate = buf.sampleRate;
      try { tmpCtx.close(); } catch (err) {}
      oscStatusEl.textContent = `Loaded (${(buf.duration || 0).toFixed(2)}s)`;
    } catch (err) {
      oscStatusEl.textContent = "Error: " + (err.message || err);
    }
  });

  // --- MIDI Import ---
  const midiFileEl = container.querySelector("#midiFile");
  const importMidiBtn = container.querySelector("#importMidiBtn");

  const parseVarLen = (buf, idxObj) => {
    // Standard MIDI variable-length quantity
    let value = 0;
    while (true) {
      const b = buf[idxObj.i++];
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return value;
  };

  const midiNoteNumberToName = (noteNumber) => {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const n = Math.max(0, Math.min(127, noteNumber|0));
    const octave = Math.floor(n / 12) - 1;
    const name = names[n % 12];
    return `${name}${octave}`;
  };

  const midiDurationUnitsToToken = (seconds, gridType, beatLen, stepsPerBeat) => {
    if (gridType === "seconds") return seconds;
    if (gridType === "beats") return seconds / beatLen;
    if (gridType === "steps") return (seconds / beatLen) * stepsPerBeat;
    return seconds / beatLen;
  };

  const buildPhonemeTextFromMidi = (midiBytes, gridType, bpm, stepsPerBeat) => {
    // Minimal MIDI parser for format 0/1: extracts note-on/off with delta-time scheduling.
    const buf = midiBytes;
    let idx = 0;
    const readU32 = () => (buf[idx++]<<24) | (buf[idx++]<<16) | (buf[idx++]<<8) | (buf[idx++]);
    const readU16 = () => (buf[idx++]<<8) | (buf[idx++]);

    const headerId = String.fromCharCode(buf[idx], buf[idx+1], buf[idx+2], buf[idx+3]);
    if (headerId !== "MThd") throw new Error("Not a valid MIDI file (missing MThd)");
    idx += 4;
    const headerLen = readU32();
    const format = readU16();
    const nTracks = readU16();
    const division = readU16();
    if ((division & 0x8000) !== 0) throw new Error("SMPTE timing MIDI not supported");
    const ticksPerQuarter = division;
    idx = 8 + headerLen; // after header chunk

    // active notes: noteNumber -> {startTick}
    const quarterSec = 60 / bpm;
    const secPerTick = quarterSec / ticksPerQuarter;

    // Collect note intervals across tracks (best-effort: unify by real-time)
    // We'll store in real seconds for each interval.
    const noteIntervals = []; // {noteNumber, startSec, endSec}

    // Parse tracks (inline MIDI varlen decoding)
    idx = 8 + headerLen;
    for (let t = 0; t < nTracks; t++) {
      const trId = String.fromCharCode(buf[idx], buf[idx+1], buf[idx+2], buf[idx+3]);
      if (trId !== "MTrk") throw new Error("Invalid MIDI track chunk");
      idx += 4;
      const trLen = readU32();
      const trEnd = idx + trLen;

      let tick = 0;
      const active = new Map(); // noteNumber -> startTick

      while (idx < trEnd) {
        // delta-time (VLQ)
        let value = 0;
        while (true) {
          const b = buf[idx++];
          value = (value << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        tick += value;

        const status = buf[idx++];

        if (status === 0xff) {
          // meta event
          idx++; // type
          let len = 0;
          while (true) {
            const b = buf[idx++];
            len = (len << 7) | (b & 0x7f);
            if ((b & 0x80) === 0) break;
          }
          idx += len;
          continue;
        }

        const op = status & 0xf0;
        if (op === 0x90 || op === 0x80) {
          const noteNumber = buf[idx++];
          const vel = buf[idx++];

          if (op === 0x90 && vel > 0) {
            active.set(noteNumber, tick);
          } else {
            const startTick = active.get(noteNumber);
            if (startTick != null) {
              const startSec = startTick * secPerTick;
              const endSec = tick * secPerTick;
              if (endSec > startSec) noteIntervals.push({ noteNumber, startSec, endSec });
              active.delete(noteNumber);
            }
          }
        } else {
          // channel events: skip parameter bytes
          if ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0) {
            idx += 1;
          } else {
            idx += 2;
          }
        }
      }
    }


    // Build timeline by sorting interval endpoints. We'll treat polyphony by choosing a single note (highest note) during overlaps.
    // This keeps output simple and deterministic.
    noteIntervals.sort((a,b) => a.startSec - b.startSec || a.endSec - b.endSec);

    const points = [];
    for (const ni of noteIntervals) {
      points.push({ time: ni.startSec, type: "on", noteNumber: ni.noteNumber });
      points.push({ time: ni.endSec, type: "off", noteNumber: ni.noteNumber });
    }
    points.sort((a,b) => a.time - b.time || (a.type === "off" ? -1 : 1));

    const active = new Set();
    const timeline = []; // { startSec, endSec, noteNumberOrNull }

    let lastTime = points.length ? points[0].time : 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const curTime = p.time;
      if (curTime > lastTime) {
        const noteNumber = active.size ? Math.max(...active) : null;
        timeline.push({ startSec: lastTime, endSec: curTime, noteNumber });
      }
      if (p.type === "on") active.add(p.noteNumber);
      else active.delete(p.noteNumber);
      lastTime = curTime;
    }

    // Convert timeline to tokens.
    const tokens = [];
    let previousNoteNumber = null;

    const fmtDur = (x) => {
      // keep readable but not too long
      const s = (Math.round(x * 1000) / 1000);
      return (Number.isFinite(s) ? s : 0).toString();
    };

    for (const seg of timeline) {
      const durSec = seg.endSec - seg.startSec;
      if (durSec <= 0) continue;
      if (seg.noteNumber == null) {
        const durToken = midiDurationUnitsToToken(durSec, gridType, 60 / bpm, stepsPerBeat);
        tokens.push(`rest <${fmtDur(durToken)}>`);
      } else {

        const noteName = midiNoteNumberToName(seg.noteNumber);
        const durToken = midiDurationUnitsToToken(durSec, gridType, 60 / bpm, stepsPerBeat);
        // phoneme is always 'a'
        const pitchPart = seg.noteNumber === previousNoteNumber ? "" : `${noteName},`;
        tokens.push(`a <${pitchPart}${fmtDur(durToken)}>`);
        previousNoteNumber = seg.noteNumber;
      }
    }

    // Ensure spaces between phonemes/tokens
    return tokens.join(" ");
  };

  importMidiBtn.onclick = async () => {
    outputControls.innerHTML = "";
    statusEl.textContent = "Importing MIDI...";
    try {
      const file = midiFileEl.files && midiFileEl.files[0];
      if (!file) { statusEl.textContent = "Select a MIDI file first."; return; }

      const gridType = container.querySelector("#gridType").value || "beats";
      const bpm = parseFloat(container.querySelector("#bpm").value) || 120;
      const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
      const beatLen = 60 / bpm;

      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);

      const midiText = buildPhonemeTextFromMidi(bytes, gridType, bpm, stepsPerBeat);

      const replacePitchesOnly = !!container.querySelector("#midiReplacePitches").checked;
      const phonemeInputEl = container.querySelector("#phonemeInput");

      if (!replacePitchesOnly) {
        phonemeInputEl.value = midiText;
        statusEl.textContent = "MIDI imported. Ready to synthesize.";
        return;
      }

      // Replace only pitches/durations while keeping existing phoneme keys.
      // A token may contain several space-separated phonemes that share one
      // timing, so keep the whole group together during replacement.
      const parseTokens = (source) => {
        const regex = /(\[[^\]]*\])?\s*([a-zA-Z']+(?:\s+[a-zA-Z']+)*)\s*<\s*([^>]+)\s*>/gi;
        const parsed = [];
        let match;
        while ((match = regex.exec(source)) !== null) {
          const fields = match[3].split(",").map(field => field.trim());
          const hasPitch = fields.length > 1;
          parsed.push({
            prefix: match[1] || "",
            key: match[2].trim(),
            pitch: hasPitch ? fields[0] : null,
            dur: hasPitch ? fields[1] : fields[0]
          });
        }
        return parsed;
      };

      const midiParsed = parseTokens(midiText);
      const existingTokens = parseTokens(phonemeInputEl.value || "");
      let midiIdx = 0;

      const outTokens = [];
      for (const p of existingTokens) {
        if (!p) continue;

        const mp = midiParsed[midiIdx];
        // If we ran out of MIDI tokens, keep remaining original tokens.
        if (!mp) {
          outTokens.push(`${p.prefix}${p.key} <${p.pitch ? `${p.pitch},` : ""}${p.dur}>`);
          continue;
        }

        // Only replace pitches/durations for tokens that actually look like phoneme+pitch.
        outTokens.push(`${p.prefix}${p.key} <${mp.pitch ? `${mp.pitch},` : ""}${mp.dur}>`);
        midiIdx++;
      }

      phonemeInputEl.value = outTokens.join(" ");

      // If the MIDI timeline contains more segments than the existing text,
      // append them instead of silently dropping the extra notes. New MIDI
      // note segments use the default vowel phoneme; rests stay rests.
      while (midiIdx < midiParsed.length) {
        const mp = midiParsed[midiIdx++];
        outTokens.push(`${mp.pitch ? `a <${mp.pitch},${mp.dur}>` : `rest <${mp.dur}>`}`);
      }

      phonemeInputEl.value = outTokens.join(" ");
      statusEl.textContent = midiParsed.length > existingTokens.length
        ? "MIDI pitches replaced; extra MIDI notes appended. Ready to synthesize."
        : "MIDI pitches replaced (phonemes preserved). Ready to synthesize.";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "MIDI import failed: " + (err.message || err);
    }
  };

  synthBtn.onclick = async () => {
    stopPreview();
    outputControls.innerHTML = ""; statusEl.textContent = "Parsing...";
    try {
      if (!updateSampleRate()) throw new Error("Sample rate must be between 8000 and 192000 Hz.");
      const text = container.querySelector("#phonemeInput").value;
      const mode = container.querySelector("#voiceMode").value;
      const bpm = parseFloat(container.querySelector("#bpm").value) || 120;
      const beatLen = 60 / bpm;
      const gridType = container.querySelector("#gridType").value || "beats";
      const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
      const vibratoFreq = parseFloat(container.querySelector("#vibFreq").value) || 0;
      const vibratoDepth = parseFloat(container.querySelector("#vibDepth").value) || 0;
      const vibratoDelay = parseFloat(container.querySelector("#vibDelay").value) || 0;
      const vibratoFadeIn = Math.max(0, parseFloat(container.querySelector("#vibFade").value) || 0);
      const persistentVib = !!container.querySelector("#persistentVib").checked;
      const morphTime = Math.max(0, parseFloat(container.querySelector("#morphTime").value) || 0.06);
      const enableMorph = !!container.querySelector("#enableMorph").checked;
      const slideValue = (container.querySelector("#slideTime")?.value ?? "0.08").trim();
      const portamentoValue = (container.querySelector("#portamento")?.value ?? "0.08").trim();
      const slideTime = slideValue === "" ? 0.08 : resolvePortamento(slideValue, 0.08, 0.08);
      const portamento = portamentoValue === "" ? 0.08 : resolvePortamento(portamentoValue, 0.08, 0.08);

      const phonemeSeq = await parseInput(text, beatLen, gridType, stepsPerBeat);
      if (!phonemeSeq || phonemeSeq.length === 0) { statusEl.textContent = "Parsed no phonemes â€” check input."; return; }

      const totalDuration = phonemeSeq.reduce((a,p) => a + p.d, 0);
      statusEl.textContent = `Rendering ${totalDuration.toFixed(2)}s...`;
      const renderSampleRate = synthesisMethod === "synthesized" ? 22050 : sampleRate;
      const offlineCtx = new OfflineAudioContext(1, Math.ceil(totalDuration * renderSampleRate) + 128, renderSampleRate);

      const renderedBuffer = await synthesize(offlineCtx, phonemeSeq, mode, vibratoFreq, vibratoDepth, vibratoDelay, morphTime, enableMorph, slideTime, portamento, persistentVib, dynamicMode, consonantDuration, vibratoFadeIn, synthesisMethod, beatLen);
      statusEl.textContent = "Done";

      // WAV creation & preview
      const audioDataRaw = resampleAudio(renderedBuffer.getChannelData(0), renderedBuffer.sampleRate, sampleRate);

      // Optional output normalization (preview + downloaded WAV)
      const enableNormalize = !!container.querySelector("#enableNormalize")?.checked;
      const normalizeTargetDb = parseFloat(container.querySelector("#normalizeTargetDb")?.value);

      let audioData = audioDataRaw;
      if (enableNormalize && Number.isFinite(normalizeTargetDb)) {
        // dBFS for full scale = 1.0 amplitude.
        // Map RMS to target, with a small epsilon to avoid div by 0.
        const eps = 1e-12;
        let sumSq = 0;
        for (let i = 0; i < audioDataRaw.length; i++) {
          const x = audioDataRaw[i];
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / Math.max(1, audioDataRaw.length));
        if (rms > eps) {
          const rmsDb = 20 * Math.log10(rms);
          const gainDb = normalizeTargetDb - rmsDb;
          const gain = Math.pow(10, gainDb / 20);
          audioData = new Float32Array(audioDataRaw.length);
          for (let i = 0; i < audioDataRaw.length; i++) audioData[i] = audioDataRaw[i] * gain;
          // hard-clip safety
          for (let i = 0; i < audioData.length; i++) {
            if (audioData[i] > 1) audioData[i] = 1;
            else if (audioData[i] < -1) audioData[i] = -1;
          }
        }
      }

      const wavBuffer = new ArrayBuffer(44 + audioData.length * 2);

      const view = new DataView(wavBuffer);
      const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeString(0, "RIFF");
      view.setUint32(4, 36 + audioData.length * 2, true);
      writeString(8, "WAVE");
      writeString(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, "data");
      view.setUint32(40, audioData.length * 2, true);
      for (let i = 0; i < audioData.length; i++) {
        const s = Math.max(-1, Math.min(1, audioData[i]));
        view.setInt16(44 + i * 2, s * 32767, true);
      }

      const blob = new Blob([view], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const dl = document.createElement("a");
      const customNameEl = container.querySelector("#customFileName");
      const rawName = (customNameEl && customNameEl.value != null ? String(customNameEl.value) : "").trim();
      const safeName = rawName ? rawName.replace(/[^a-zA-Z0-9._-]/g, "_") : `singer-${Date.now()}`;
      dl.href = url; dl.download = `${safeName}-${Date.now()}.wav`; dl.textContent = "Download WAV";
      dl.style = "display:inline-block;margin-right:8px;margin-top:8px;";
      outputControls.appendChild(dl);

      const playBtn = document.createElement("button");
      playBtn.textContent = "Preview"; playBtn.style = "margin-top:8px;padding:6px 12px;";
      const previewWaveform = document.createElement("canvas");
      previewWaveform.width = 960;
      previewWaveform.height = 96;
      previewWaveform.setAttribute("role", "slider");
      previewWaveform.setAttribute("aria-label", "Audio waveform. Click or use arrow keys to seek and play.");
      previewWaveform.setAttribute("aria-valuemin", "0");
      previewWaveform.setAttribute("aria-valuemax", String(audioData.length / sampleRate));
      previewWaveform.setAttribute("aria-valuenow", "0");
      previewWaveform.setAttribute("aria-valuetext", "0.00 seconds");
      previewWaveform.tabIndex = 0;
      previewWaveform.style = "display:block;width:100%;height:72px;margin-top:8px;border:1px solid #cbd5e1;border-radius:4px;background:#f4f7fb;cursor:pointer;touch-action:pan-y;";
      const previewDuration = audioData.length / sampleRate;
      drawPreviewWaveform = (playheadSeconds) => {
        const canvasContext = previewWaveform.getContext("2d");
        const width = previewWaveform.width;
        const height = previewWaveform.height;
        const middle = height / 2;
        canvasContext.clearRect(0, 0, width, height);
        canvasContext.fillStyle = "#f4f7fb";
        canvasContext.fillRect(0, 0, width, height);
        canvasContext.fillStyle = "#64748b";
        for (let x = 0; x < width; x++) {
          const start = Math.floor(x * audioData.length / width);
          const end = Math.min(audioData.length, Math.max(start + 1, Math.floor((x + 1) * audioData.length / width)));
          let peak = 0;
          for (let sample = start; sample < end; sample++) {
            peak = Math.max(peak, Math.abs(audioData[sample]));
          }
          const amplitude = Math.max(1, peak * (height * 0.44));
          canvasContext.fillRect(x, middle - amplitude, 1, amplitude * 2);
        }
        if (playheadSeconds !== null) {
          const progress = Math.max(0, Math.min(1, playheadSeconds / previewDuration));
          canvasContext.fillStyle = "#1677ff";
          canvasContext.fillRect(Math.round(progress * (width - 2)), 0, 2, height);
          const currentTime = progress * previewDuration;
          previewWaveform.setAttribute("aria-valuenow", currentTime.toFixed(2));
          previewWaveform.setAttribute("aria-valuetext", `${currentTime.toFixed(2)} seconds`);
        }
      };
      drawPreviewWaveform(0);

      const playPreviewAt = (requestedSeconds = 0) => {
        stopPreview();
        const startSeconds = Math.max(0, Math.min(previewDuration - 1 / sampleRate, requestedSeconds));
        actx = new (window.AudioContext || window.webkitAudioContext)();
        prevSrc = actx.createBufferSource();
        // Preview should match the downloaded WAV (normalized if enabled).
        previewBuf = actx.createBuffer(1, audioData.length, sampleRate);
        previewBuf.getChannelData(0).set(audioData);
        prevSrc.buffer = previewBuf;
        // Keep the mouth animation and waveform playhead aligned to the seek point.
        visualSeq = phonemeSeq;
        visualStartTime = actx.currentTime - startSeconds;
        startVisualAnim();
        const source = prevSrc;
        const playbackContext = actx;
        source.onended = () => {
          // natural-end cleanup: free shared preview state so a new preview can start
          if (previewFrameId !== null) cancelAnimationFrame(previewFrameId);
          previewFrameId = null;
          drawPreviewWaveform(previewDuration);
          if (prevSrc === source) prevSrc = null;
          previewBuf = null;
          stopVisualAnim();
          setVisualIdle();
          if (actx === playbackContext) {
            try { actx.close(); } catch (e) {}
            actx = null;
          }
        };
        source.connect(actx.destination);
        source.start(0, startSeconds);
        const animatePreviewPlayhead = () => {
          if (prevSrc !== source || actx !== playbackContext) return;
          const elapsed = Math.max(0, playbackContext.currentTime - visualStartTime);
          drawPreviewWaveform(Math.min(previewDuration, elapsed));
          if (elapsed < previewDuration) previewFrameId = requestAnimationFrame(animatePreviewPlayhead);
          else previewFrameId = null;
        };
        animatePreviewPlayhead();
      };
      playBtn.onclick = () => playPreviewAt(0);

      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Stop Preview"; stopBtn.style = "margin-top:8px;padding:6px 12px;";
      stopBtn.onclick = () => {
        stopPreview();
      };

      const saveAsBtn = document.createElement("button");
      saveAsBtn.textContent = "Save WAV As...";
      saveAsBtn.style = "margin-top:8px;margin-left:8px;padding:6px 12px;";
      saveAsBtn.onclick = async () => {
        const suggestedName = `${safeName}-${Date.now()}.wav`;
        if (typeof window.showSaveFilePicker === "function") {
          try {
            const fileHandle = await window.showSaveFilePicker({
              suggestedName,
              types: [{ description: "WAV audio", accept: { "audio/wav": [".wav"] } }]
            });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            statusEl.textContent = "WAV saved.";
          } catch (error) {
            if (error.name !== "AbortError") {
              console.error(error);
              statusEl.textContent = `Save failed: ${error.message || error}`;
            }
          }
        } else {
          dl.click();
          statusEl.textContent = "Save location selection is not supported here; downloaded to the browser's default location.";
        }
      };
      previewWaveform.addEventListener("click", (event) => {
        const bounds = previewWaveform.getBoundingClientRect();
        const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        playPreviewAt(position * previewDuration);
      });
      previewWaveform.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          playPreviewAt(Number(previewWaveform.getAttribute("aria-valuenow")) || 0);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          const position = Number(previewWaveform.getAttribute("aria-valuenow")) || 0;
          playPreviewAt(Math.max(0, Math.min(previewDuration, position + direction * Math.max(0.1, previewDuration / 100))));
        }
      });

      outputControls.appendChild(playBtn);
      outputControls.appendChild(stopBtn);
      outputControls.appendChild(saveAsBtn);
      outputControls.appendChild(previewWaveform);

      const exportBtn = document.createElement("button");
      exportBtn.textContent = "Export Animation (WebM)";
      exportBtn.style = "margin-top:8px;margin-left:8px;padding:6px 12px;";
      exportBtn.onclick = () => exportAnimationMp4(exportBtn);
      outputControls.appendChild(exportBtn);

      lastRenderedAudio = audioData.slice();
      lastRenderedPhonemes = phonemeSeq;

    } catch (err) {
      console.error(err);
      statusEl.textContent = "Error: " + (err.message || err);
    }
  };

// ======== VISUAL FRAME (formant-driven mouth) ========
  const visualCanvas = container.querySelector("#visualCanvas");
  const visualCtx = visualCanvas.getContext("2d");
  const visualFormantsEl = container.querySelector("#visualFormants");
  const visualPhoneEl = container.querySelector("#visualPhone");
  let visualAnimId = null;
  let visualStartTime = 0;
  let visualSeq = [];

  // Floating & Rotation state
  let floatTime = 0;
  let mouthRotTime = 0;
  let eyesRotTime = 0;
  let visualTime = 0;
  let pointerPosition = null;
  let gazeTarget = { x: 0, y: 0 };
  let sphereYaw = 0;
  let spherePitch = 0;
  let nextGazeShift = 0;

  // Smooth mouth height transition state
  let currentMouthH = 4; // Start near closed state
  let currentMouthW = 3.5; // Start near default width

  // Eye blinking state
  let blinkState = {
    isBlinking: false,
    progress: 0,
    timer: 120
  };

  function updateFaceState(timeSeconds = null) {
    if (timeSeconds != null) {
      visualTime = Math.max(0, timeSeconds);
      floatTime = visualTime * 2.4;
      mouthRotTime = visualTime * 0.72;
      eyesRotTime = visualTime * 1.02;
    } else {
      visualTime += 1 / 60;
      floatTime += 0.04;
      mouthRotTime += 0.012;
      eyesRotTime += 0.017;
    }

    const hasPointer = pointerPosition !== null;
    if (hasPointer) {
      const dx = pointerPosition.x - visualCanvas.width / 2;
      const dy = pointerPosition.y - visualCanvas.height / 2;
      gazeTarget.x += (clamp(dx / 70, -1, 1) - gazeTarget.x) * 0.12;
      gazeTarget.y += (clamp(dy / 52, -1, 1) - gazeTarget.y) * 0.12;
      const targetYaw = clamp(dx / (visualCanvas.width * 0.42), -1, 1) * 1.05;
      const targetPitch = clamp(-dy / (visualCanvas.height * 0.42), -1, 1) * 0.72;
      sphereYaw += (targetYaw - sphereYaw) * 0.1;
      spherePitch += (targetPitch - spherePitch) * 0.1;
    } else if (visualTime >= nextGazeShift) {
      const angle = visualTime * 1.7;
      gazeTarget.x = Math.sin(angle) * 0.55;
      gazeTarget.y = Math.cos(angle * 0.73) * 0.28;
      nextGazeShift = visualTime + 1.8 + (Math.sin(angle * 0.41) + 1) * 1.4;
    }

    if (!hasPointer) {
      gazeTarget.x += (Math.sin(visualTime * 0.8) * 0.12 - gazeTarget.x) * 0.04;
      gazeTarget.y += (Math.cos(visualTime * 0.63) * 0.08 - gazeTarget.y) * 0.04;
      sphereYaw += (0 - sphereYaw) * 0.06;
      spherePitch += (0 - spherePitch) * 0.06;
    }

    // Random smooth blinking logic
    if (!blinkState.isBlinking) {
      blinkState.timer--;
      if (blinkState.timer <= 0) {
        blinkState.isBlinking = true;
        blinkState.progress = 0;
      }
    } else {
      blinkState.progress += 0.15;
      if (blinkState.progress >= Math.PI) {
        blinkState.isBlinking = false;
        blinkState.progress = 0;
        blinkState.timer = Math.floor(120 + Math.random() * 180);
      }
    }
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Draw the mouth based on the current formant values.
  // - F1 controls jaw drop (mouth height / bottom teeth drop).
  // - F2 controls tongue size.
  // - F3 controls mouth width.
  // When F1 and F3 produce matching normalized values, the mouth is a circle.
  function drawVisual(f1, f2, f3, phone, phonemeKey, timeSeconds = null) {
    // Update floating offset, independent rotations & eye blink state
    updateFaceState(timeSeconds);

    const c = visualCtx;
    const W = visualCanvas.width, H = visualCanvas.height;
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, W, H);

    // --- Positional Floating (Linear bobbing) ---
    const floatY = Math.sin(floatTime) * 8;
    const floatX = Math.cos(floatTime * 0.5) * 4;

    const cx = W / 2 + floatX;
    const cy = H / 2 + floatY;
    const sphereRadius = Math.min(W * 0.43, H * 0.48);
    const surfaceYaw = sphereYaw;
    const surfacePitch = spherePitch;
    const pivotOffsetX = Math.sin(surfaceYaw) * sphereRadius * 0.28;
    const pivotOffsetY = -Math.sin(surfacePitch) * sphereRadius * 0.22;

    // Map facial points over a rotated invisible sphere and recenter the patch.
    const projectSpherePoint = (x, y) => {
      const nx = clamp(x / sphereRadius, -0.96, 0.96);
      const ny = clamp(y / sphereRadius, -0.96, 0.96);
      const nz = Math.sqrt(Math.max(0.04, 1 - nx * nx - ny * ny));
      const cosYaw = Math.cos(surfaceYaw), sinYaw = Math.sin(surfaceYaw);
      const cosPitch = Math.cos(surfacePitch), sinPitch = Math.sin(surfacePitch);
      const rotatedX = nx * cosYaw + nz * sinYaw;
      const rotatedZ = -nx * sinYaw + nz * cosYaw;
      const rotatedY = ny * cosPitch - rotatedZ * sinPitch;
      return [
        cx + pivotOffsetX + (rotatedX - sinYaw) * sphereRadius,
        cy + pivotOffsetY + (rotatedY + cosYaw * sinPitch) * sphereRadius
      ];
    };
    const sphereEllipsePath = (x, y, radiusX, radiusY, rotation = 0) => {
      c.beginPath();
      for (let i = 0; i <= 32; i++) {
        const angle = i / 32 * Math.PI * 2;
        const localX = x + Math.cos(angle) * radiusX * Math.cos(rotation) - Math.sin(angle) * radiusY * Math.sin(rotation);
        const localY = y + Math.cos(angle) * radiusX * Math.sin(rotation) + Math.sin(angle) * radiusY * Math.cos(rotation);
        const [screenX, screenY] = projectSpherePoint(localX, localY);
        if (i === 0) c.moveTo(screenX, screenY); else c.lineTo(screenX, screenY);
      }
      c.closePath();
    };
    const sphereQuadPath = (x, y, width, height) => {
      c.beginPath();
      [[x - width / 2, y], [x + width / 2, y], [x + width / 2, y + height], [x - width / 2, y + height]].forEach(([localX, localY], index) => {
        const [screenX, screenY] = projectSpherePoint(localX, localY);
        if (index === 0) c.moveTo(screenX, screenY); else c.lineTo(screenX, screenY);
      });
      c.closePath();
    };

    // --- Rotational Float Angles (Slower & Subtle) ---
    const mouthRotAngle = Math.sin(mouthRotTime) * 0.04; // ~ ±2.3°
    const eyesRotAngle = Math.sin(eyesRotTime + 1.2) * 0.06; // ~ ±3.4°

    // --- Phoneme & State check ---
    // Treat missing phone/key or explicitly idle keys as rest
    const effectiveKey = phonemeKey || "rest";
    const closedMouthPhonemes = ["m", "b", "p", "v", "f", "bx", "rest"];
    const isClosedMouth = !phone || closedMouthPhonemes.includes(effectiveKey);

    const phData = phonemeMap[effectiveKey];
    const isBreathy = phData && phData.breathy;

    const f1n = clamp((f1 - 200) / 800, 0, 1);
    const f3n = clamp((f3 - 2000) / 1500, 0, 1);

    // Downscaled mouth dimensions
    const mouthScale = 0.45;

    let targetMouthW, targetMouthH;
    if (isClosedMouth) {
      targetMouthW = 56 * mouthScale;
      targetMouthH = 2; // Flat target line height
    } else {
      if (effectiveKey !== "w") {
        targetMouthW = (46 + 44 * f3n) * mouthScale;
        targetMouthH = (40 + 44 * f1n) * mouthScale;
      } else {
        targetMouthW = 5 * mouthScale;
        targetMouthH = 5 * mouthScale;
      }
    }

    // --- Smooth Height Interpolation (Lerp) ---
    // Adjust 0.2 to make closing faster (e.g. 0.3) or smoother/slower (e.g. 0.1)
    currentMouthH += (targetMouthH - currentMouthH) * 0.55;
    currentMouthW += (targetMouthW - currentMouthW) * 0.55;

    const mouthW = currentMouthW;
    const mouthH = currentMouthH;

    const mouthRx = mouthW / 2;
    const mouthRy = Math.max(0.5, mouthH / 2);
    let tongueR = (8 + 20 * clamp((f2 - 700) / 1800, 0, 1)) * mouthScale;

    // ==========================================
    // 1. EYES
    // ==========================================
    const eyeOffsetX = 24 * mouthScale;
    const eyeRadius = 4;

    const blinkFactor = blinkState.isBlinking ? Math.sin(blinkState.progress) : 0;
    const currentEyeScaleY = 1 - blinkFactor;

    const eyeLookX = gazeTarget.x * 2.2;
    const eyeLookY = gazeTarget.y * 1.6;
    c.fillStyle = "#000";

    // Left Eye
    sphereEllipsePath(-eyeOffsetX + eyeLookX, -32 + eyeLookY, eyeRadius, Math.max(0.4, eyeRadius * currentEyeScaleY), eyesRotAngle);
    c.fill();

    // Right Eye
    sphereEllipsePath(eyeOffsetX + eyeLookX, -32 + eyeLookY, eyeRadius, Math.max(0.4, eyeRadius * currentEyeScaleY), eyesRotAngle);
    c.fill();

    // ==========================================
    // 2. MOUTH (With independent floating rotation)
    // ==========================================
    // Consider mouth open only if height is clearly visible
    const isOpenEnough = mouthH > 5 * mouthScale;

    if (isOpenEnough) {
      const mouthPath = () => {
        sphereEllipsePath(0, 0, mouthRx, mouthRy, mouthRotAngle);
      };

      // Cavity (black background)
      mouthPath();
      c.fillStyle = "#000";
      c.fill();

      // Clip interior elements to mouth cavity
      c.save();
      mouthPath();
      c.clip();

      // Tongue
      if (!isClosedMouth) {
        let tongueY = mouthRy * 0.35;
        let tongueRY = tongueR

        if (effectiveKey === "l") {
          tongueY = mouthRy * 0.01
          tongueRY = 20
          tongueR *= 2
        }

        sphereEllipsePath(0, tongueY, tongueR, tongueRY, mouthRotAngle);
        c.fillStyle = "#e03a3a";
        c.fill();
      }

      // Teeth
      const toothW = Math.max(4, mouthW * 0.92);
      let toothH;
      if (isBreathy || effectiveKey === "k" || effectiveKey === "g" || effectiveKey === "ng" || effectiveKey === "d" || effectiveKey === "t") {
        toothH = Math.max(3, mouthRy * 0.95);
      } else {
        toothH = Math.max(4, mouthRy * 0.3);
      }
      c.fillStyle = "#ffffff";
      // Top teeth
      sphereQuadPath(0, -mouthRy, toothW, toothH);
      c.fill();
      // Bottom teeth
      sphereQuadPath(0, mouthRy - toothH, toothW, toothH);
      c.fill();

      c.restore(); // Restore clip mask

      // Lips outline
      mouthPath();
      c.strokeStyle = "#000";
      c.lineWidth = 3;
      c.stroke();

    } else {
      // Smooth Closed State: draw a clean rounded horizontal line for lips
      const [leftLipX, leftLipY] = projectSpherePoint(-mouthRx, 0);
      const [rightLipX, rightLipY] = projectSpherePoint(mouthRx, 0);
      c.beginPath();
      c.moveTo(leftLipX, leftLipY);
      c.lineTo(rightLipX, rightLipY);
      c.strokeStyle = "#000";
      c.lineWidth = 3.5;
      c.lineCap = "round";
      c.stroke();
    }

    // UI labels updates
    visualFormantsEl.innerHTML = `F1: ${Math.round(f1)}&nbsp;&nbsp;F2: ${Math.round(f2)}&nbsp;&nbsp;F3: ${Math.round(f3)}`;
    visualPhoneEl.textContent = phone ? `Current Phone: ${phone}` : "Current Phone: None";
  }

  function startVisualAnim() {
    stopVisualAnim();
    visualAnimId = requestAnimationFrame(animTick);
  }

  function stopVisualAnim() {
    if (visualAnimId) {
      cancelAnimationFrame(visualAnimId);
      visualAnimId = null;
    }
  }

  function setVisualIdle() {
    visualSeq = [];
    drawVisual(0, 0, 0, null, "rest");
  }

  visualCanvas.addEventListener("pointermove", event => {
    const rect = visualCanvas.getBoundingClientRect();
    pointerPosition = {
      x: (event.clientX - rect.left) * visualCanvas.width / rect.width,
      y: (event.clientY - rect.top) * visualCanvas.height / rect.height
    };
  });
  visualCanvas.addEventListener("pointerleave", () => { pointerPosition = null; });

  // Animation tick: find the currently-playing phoneme and update the mouth.
  function renderVisualFrame(elapsed) {
    let t = 0;
    let cur = null;
    let curStart = 0;
    let curIndex = -1;
    for (let i = 0; i < visualSeq.length; i++) {
      const p = visualSeq[i];
      if (elapsed < t + p.d) { cur = p; curStart = t; curIndex = i; break; }
      t += p.d;
    }

    if (cur && cur.f) {
      let f = cur.f.slice();

      // Match synthesis timing: morphTo spans the full phone; adjacent phones
      // use the configured morphTime window at the end of the current phone.
      const morphEnabled = !!container.querySelector("#enableMorph").checked;
      const morphTime = Math.max(0, parseFloat(container.querySelector("#morphTime").value) || 0);

      let target = null;
      let morphStart = curStart + Math.max(0, cur.d - morphTime);
      let morphDuration = morphTime;
      if (morphEnabled) {
        if (cur.morphTo && cur.morphTo.length >= MAP_FORMANTS) {
          // Diphthong/glide: match synthesis and morph across the full phone.
          target = cur.morphTo;
          morphStart = curStart;
          morphDuration = cur.d;
        } else if (morphTime > 0) {
          // Otherwise glide toward the next voiced phoneme's formants.
          for (let j = curIndex + 1; j < visualSeq.length; j++) {
            const n = visualSeq[j];
            if (n && n.voiced && n.f) { target = n.f; break; }
          }
        }
      }

      if (target) {
        const transitionDuration = Math.max(0.0001, morphDuration);
        if (elapsed >= morphStart) {
          const seg = clamp((elapsed - morphStart) / transitionDuration, 0, 1);
          // const prog = 1 - Math.pow(1 - seg, 2); // gentle ease-out for smoother motion
         const prog = seg * seg * (3 - 2 * seg);
          f = f.map((v, i) => v + (target[i] - v) * prog);
        }
      }

      drawVisual(f[0], f[1], f[2], cur.key, cur.key, elapsed);
    } else {
      drawVisual(0, 0, 0, cur ? cur.key : "rest", cur ? cur.key : "rest", elapsed);
    }
  }

  function animTick() {
    if (!actx) {
      setVisualIdle();
      visualAnimId = null;
      return;
    }
    renderVisualFrame(actx.currentTime - visualStartTime);

    visualAnimId = requestAnimationFrame(animTick);
  }

  async function exportAnimationMp4Fallback(button) {
    if (typeof MediaRecorder === "undefined") {
      statusEl.textContent = "This browser supports neither WebCodecs nor MediaRecorder.";
      return;
    }
    const mp4Type = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4"
    ].find(type => MediaRecorder.isTypeSupported(type));
    if (!mp4Type || !visualCanvas.captureStream) {
      statusEl.textContent = "This browser supports neither WebCodecs nor MP4 recording.";
      return;
    }

    button.disabled = true;
    statusEl.textContent = "Recording MP4 fallback...";
    stopPreview();

    const exportCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = exportCtx.createBuffer(1, lastRenderedAudio.length, sampleRate);
    audioBuffer.getChannelData(0).set(lastRenderedAudio);
    const source = exportCtx.createBufferSource();
    const audioDestination = exportCtx.createMediaStreamDestination();
    source.buffer = audioBuffer;
    source.connect(audioDestination);

    const canvasStream = visualCanvas.captureStream(30);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks()
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: mp4Type,
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 128_000
    });
    const chunks = [];
    const duration = audioBuffer.duration;

    const cleanup = () => {
      stopVisualAnim();
      setVisualIdle();
      for (const track of stream.getTracks()) track.stop();
      try { source.stop(); } catch (e) {}
      try { exportCtx.close(); } catch (e) {}
      if (actx === exportCtx) actx = null;
    };

    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = event => {
      cleanup();
      button.disabled = false;
      statusEl.textContent = "MP4 export failed: " + (event.error?.message || "unknown error");
    };
    recorder.onstop = () => {
      cleanup();
      const blob = new Blob(chunks, { type: mp4Type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `singer-animation-${Date.now()}.mp4`;
      link.textContent = "Download MP4 Animation";
      link.style = "display:inline-block;margin:8px 8px 0 0;";
      outputControls.appendChild(link);
      button.disabled = false;
      statusEl.textContent = "Animation exported.";
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };

    visualSeq = lastRenderedPhonemes;
    actx = exportCtx;
    visualStartTime = exportCtx.currentTime;
    startVisualAnim();
    recorder.start(100);
    source.start();
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, Math.ceil(duration * 1000) + 250);
  }

  async function exportAnimationMp4(button) {
    if (!lastRenderedAudio || !lastRenderedPhonemes) {
      statusEl.textContent = "Synthesize audio before exporting.";
      return;
    }
    if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined" || typeof VideoFrame === "undefined") {
      await exportAnimationMp4Fallback(button);
      return;
    }

    button.disabled = true;
    statusEl.textContent = "Rendering animation frames...";
    stopPreview();

    const duration = lastRenderedAudio.length / sampleRate;
    try {
      const { Muxer, ArrayBufferTarget } = await import("https://esm.sh/webm-muxer@5.0.1");
      const fps = 30;
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: { codec: "V_VP9", width: visualCanvas.width, height: visualCanvas.height, frameRate: fps },
        audio: { codec: "A_OPUS", sampleRate: 48000, numberOfChannels: 1 }
      });
      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: error => { throw error; }
      });
      videoEncoder.configure({ codec: "vp09.00.10.08", width: visualCanvas.width, height: visualCanvas.height, bitrate: 2_500_000, framerate: fps });
      visualSeq = lastRenderedPhonemes;
      const frameCount = Math.ceil(duration * fps);
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const timestamp = frameIndex / fps;
        renderVisualFrame(timestamp);
        const frame = new VideoFrame(visualCanvas, { timestamp: Math.round(timestamp * 1_000_000), duration: Math.round(1_000_000 / fps) });
        videoEncoder.encode(frame, { keyFrame: frameIndex % (fps * 2) === 0 });
        frame.close();
      }
      await videoEncoder.flush();
      videoEncoder.close();

      const outputRate = 48000;
      const outputSamples = Math.ceil(lastRenderedAudio.length * outputRate / sampleRate);
      const resampled = new Float32Array(outputSamples);
      for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = i * sampleRate / outputRate;
        const lower = Math.floor(sourcePosition);
        const fraction = sourcePosition - lower;
        const next = Math.min(lower + 1, lastRenderedAudio.length - 1);
        resampled[i] = lastRenderedAudio[lower] * (1 - fraction) + lastRenderedAudio[next] * fraction;
      }
      const audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: error => { throw error; } });
      audioEncoder.configure({ codec: "opus", sampleRate: outputRate, numberOfChannels: 1, bitrate: 128000 });
      const audioFrameSize = 960;
      for (let offset = 0; offset < resampled.length; offset += audioFrameSize) {
        const frameData = resampled.slice(offset, Math.min(offset + audioFrameSize, resampled.length));
        const audioFrame = new AudioData({ format: "f32", sampleRate: outputRate, numberOfFrames: frameData.length, numberOfChannels: 1, timestamp: Math.round(offset * 1_000_000 / outputRate), data: frameData });
        audioEncoder.encode(audioFrame);
        audioFrame.close();
      }
      await audioEncoder.flush();
      audioEncoder.close();
      muxer.finalize();

      const blob = new Blob([target.buffer], { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `singer-animation-${Date.now()}.webm`;
      link.textContent = "Download WebM Animation";
      link.style = "display:inline-block;margin:8px 8px 0 0;";
      outputControls.appendChild(link);
      statusEl.textContent = "Animation exported.";
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      console.error(error);
      statusEl.textContent = "Animation export failed: " + (error.message || error);
    } finally {
      setVisualIdle();
      button.disabled = false;
    }
  }

  // ======== PIANO ROLL IMPLEMENTATION ========
  const pianoRollContainer = container.querySelector("#pianoRollContainer");
  const pianoRollCanvas = container.querySelector("#pianoRollCanvas");
  const ctx = pianoRollCanvas.getContext("2d");
  const pianoRollRefreshBtn = container.querySelector("#pianoRollRefreshBtn");
  const pianoRollSnap = container.querySelector("#pianoRollSnap");
  const pianoRollSnapType = container.querySelector("#pianoRollSnapType");

  // Piano roll constants
  const KEYBOARD_WIDTH = 50;
  const NOTE_HEIGHT = 14;
  let PIXELS_PER_BEAT = 120;
  const MIN_NOTE_DURATION_PX = 8;
  const NOTE_RADIUS = 4;

  // Note names for display (C0-based for internal, but we show C2-C6)
  const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// Piano roll state
  let pianoRollNotes = []; // { phoneme, pitchName, midiNote, startBeat, durBeats, startPx, durPx }
  let selectedNoteIndex = -1;
  let selectedNoteIndexes = new Set(); // multi-selection
  let dragState = null; // { type: 'move'|'resizeLeft'|'resizeRight', noteIdx, startX, startY, origStartBeat, origDurBeats, origMidi, origPitches:[{startBeat,midiNote,durBeats}] }
  let hoveredEdge = null; // { noteIdx, side: 'left'|'right' }
  let shiftHeld = false;
  let selectionState = null; // { startX, startY, curX, curY }
  let skipReparse = false;   // while dragging, don't re-parse from text (preserves absolute positions)
  let consonantWrapperEnabled = true; // default ON
  const pianoRollPanelEl = container.querySelector("#pianoRollPanel");
  const BRACKET_SETTING_DEFAULTS = { fs: "", vf: "", vd: "", vde: "", vfa: "", vfao: "", slide: "", fmorph: "", portamento: "" };
  let pianoRollHistory = [];
  let pianoRollRedo = [];
  let lastPianoRollSnapshot = null;
  let suppressPianoRollHistory = false;

  const clonePianoRollNotes = () => JSON.parse(JSON.stringify(pianoRollNotes));
  const pianoRollSnapshot = () => JSON.stringify(pianoRollNotes.map(note => {
    const copy = { ...note };
    delete copy.startPx;
    delete copy.durPx;
    return copy;
  }));
  const rememberPianoRollChange = () => {
    const snapshot = pianoRollSnapshot();
    if (!suppressPianoRollHistory && lastPianoRollSnapshot && snapshot !== lastPianoRollSnapshot) {
      pianoRollHistory.push(lastPianoRollSnapshot);
      pianoRollRedo = [];
    }
    lastPianoRollSnapshot = snapshot;
  };
  const restorePianoRollSnapshot = (snapshot) => {
    pianoRollNotes = JSON.parse(snapshot);
    selectedNoteIndexes.clear();
    selectedNoteIndex = -1;
    suppressPianoRollHistory = true;
    updateTextFromPianoRoll();
    suppressPianoRollHistory = false;
    drawPianoRoll();
    updatePianoRollPanel();
  };
  const deleteSelectedPianoRollNotes = () => {
    if (selectedNoteIndexes.size === 0) return false;
    const idxs = [...selectedNoteIndexes].sort((a, b) => b - a);
    for (const idx of idxs) {
      if (idx >= 0 && idx < pianoRollNotes.length) pianoRollNotes.splice(idx, 1);
    }
    selectedNoteIndexes.clear();
    selectedNoteIndex = -1;
    updateTextFromPianoRoll();
    drawPianoRoll();
    updatePianoRollPanel();
    return true;
  };
  const closeVisualBtn = container.querySelector("#closeVisualBtn");
  const closeExperimentalBtn = container.querySelector("#closeExperimentalBtn");
  closeVisualBtn.addEventListener("click", () => container.querySelector("#visualFrame").style.display = "none");
  closeExperimentalBtn.addEventListener("click", () => container.querySelector("#experimentalPanel").style.display = "none");

  // Style rules for the left piano-roll panel (note editor controls).
  const prStyle = document.createElement("style");
  prStyle.textContent = `
    #pianoRollPanel .pe-label{font-size:11px;color:#555;margin-top:9px;}
    #pianoRollPanel .pe-input{width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;margin-top:2px;padding:2px 4px;border:1px solid #ccc;border-radius:2px;}
    #pianoRollPanel .pe-btn{display:inline-block;margin:8px 4px 0 0;padding:4px 8px;font-size:11px;}
    #pianoRollPanel .pe-total{font-size:11px;color:#777;margin-top:6px;}
    #pianoRollPanel .pe-hint{font-size:11px;color:#777;margin-top:6px;}
    #pianoRollPanel .phone-bank{position:relative;min-height:90px;max-height:310px;resize:both;overflow:hidden;margin-top:8px;padding:0;border:1px solid #aaa;background:#fafafa;}
    #pianoRollPanel .phone-bank-header{display:flex;align-items:center;gap:5px;padding:5px 6px;background:#f2f2f2;border-bottom:1px solid #ccc;cursor:grab;user-select:none;touch-action:none;}
    #pianoRollPanel .phone-bank-body{height:calc(100% - 29px);overflow:auto;padding:6px;}
    #pianoRollPanel .phone-bank-buttons{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;}
    #pianoRollPanel .phone-bank-buttons button{min-width:0;padding:3px 1px;font:11px monospace;}
  `;
  document.head.appendChild(prStyle);

  // consonant phoneme set (for consonant wrapping)
  const CONSONANT_PHONEMES = new Set([
    "h","s","z","t","d","k","g","b","p","f","v","th","dh","sh","ch",
    "j","ng","r","l",
  ]);

  // Parse the text input and build piano roll notes
  function parsePianoRollFromText(text, bpm, gridType, stepsPerBeat) {
    const beatLen = 60 / bpm;
    const regex = /(\[[^\]]*\])?\s*([a-zA-Z']+)\s*<\s*([^>]+)\s*>/gi;
    const notes = [];
    let currentPitchName = "C4";
    let currentSettings = { ...BRACKET_SETTING_DEFAULTS };
    let match;
    let startBeat = 0;
    while ((match = regex.exec(text)) !== null) {
      const bracketText = match[1] || "";
      const phoneme = match[2].toLowerCase();
      const fields = match[3].split(",").map(field => field.trim());
      if (/\breset\b/i.test(bracketText)) currentSettings = { ...BRACKET_SETTING_DEFAULTS };
      const settingMatches = /\b(fs|vf|vd|vde|vdae|vfa|vfao|sl|slide|fm|fmorph|port|portamento|pt)\s*(?::|=)?\s*(auto|-?(?:\d+(?:\.\d*)?|\.\d+))/gi;
      let settingMatch;
      while ((settingMatch = settingMatches.exec(bracketText)) !== null) {
        let settingName = settingMatch[1].toLowerCase();
        if (settingName === "vdae") settingName = "vde";
        if (settingName === "sl") settingName = "slide";
        if (settingName === "fm") settingName = "fmorph";
        if (settingName === "port" || settingName === "pt") settingName = "portamento";
        currentSettings[settingName] = settingMatch[2];
      }
      const hasExplicitPitch = fields.length > 1;
      if (hasExplicitPitch) currentPitchName = fields[0];
      const pitchRaw = currentPitchName;
      const units = parseFloat(hasExplicitPitch ? fields[1] : fields[0]);
      if (!Number.isFinite(units)) continue;

      let durSec = 0;
      if (gridType === "beats") durSec = units * beatLen;
      else if (gridType === "steps") durSec = (units / stepsPerBeat) * beatLen;
      else if (gridType === "seconds") durSec = units;
      else durSec = units * beatLen;

      const durBeats = durSec / beatLen;
      const midiNote = pitchNameToMidi(pitchRaw);

      if (phoneme !== "rest" && midiNote !== null) {
        notes.push({
          phoneme,
          pitchName: pitchRaw,
          midiNote,
          startBeat,
          durBeats,
          bracketSettings: { ...currentSettings }
        });
      }
      startBeat += durBeats;
    }
    return notes;
  }

  // Convert pitch name like "C4", "D#3" to MIDI note number
  function pitchNameToMidi(name) {
    const m = /^([A-Ga-g])([#b]?)(\d)$/.exec(name);
    if (!m) return null;
    const [, base, acc, oct] = m;
    const semitoneOffsets = { C:0,"C#":1,Db:1,D:2,"D#":3,Eb:3,E:4,F:5,"F#":6,Gb:6,G:7,"G#":8,Ab:8,A:9,"A#":10,Bb:10,B:11 };
    const key = base.toUpperCase() + acc;
    const semi = semitoneOffsets[key];
    if (semi === undefined) return null;
    return (parseInt(oct) + 1) * 12 + semi; // MIDI note numbers: C0=12, C1=24, etc.
  }

  function midiToNoteName(midi) {
    const oct = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12];
    return `${name}${oct}`;
  }

  // Get the range of MIDI notes to display
  function getMidiRange(notes) {
    if (notes.length === 0) return { min: 48, max: 84 }; // C2 to C5
    let min = 127, max = 0;
    for (const n of notes) {
      if (n.midiNote < min) min = n.midiNote;
      if (n.midiNote > max) max = n.midiNote;
    }
    min = Math.max(0, min - 4);
    max = Math.min(127, max + 4);
    if (max - min < 24) { max = min + 24; }
    return { min, max };
  }

  // Get total beats from notes
  function getTotalBeats(notes) {
    let max = 4;
    for (const n of notes) {
      const end = n.startBeat + n.durBeats;
      if (end > max) max = end;
    }
    return max + 2;
  }

  // Snap a value to grid
  function snapToGrid(val, gridSize) {
    return Math.round(val / gridSize) * gridSize;
  }

  function getPianoRollSnapResolution() {
    const resolution = parseFloat(pianoRollSnapType.value);
    return Number.isFinite(resolution) && resolution > 0 ? resolution : 0.25;
  }

// Build display notes for consonant wrapping.
  // When the wrapper is enabled, a consonant note immediately preceding a
  // vowel note (adjacent in time, same pitch) is merged into a single visual
  // group labelled like "[tew]". The underlying text tokens remain separate.
  function buildDisplayNotes() {
    if (!consonantWrapperEnabled) {
      return pianoRollNotes.map((n, i) => ({ noteIdx: i, phoneme: n.phoneme, midiNote: n.midiNote, startBeat: n.startBeat, durBeats: n.durBeats, wrapped: false }));
    }
    const display = [];
    const used = new Set();
    for (let i = 0; i < pianoRollNotes.length; i++) {
      if (used.has(i)) continue;
      const n = pianoRollNotes[i];
      // If this is a consonant directly before a vowel (adjacent, same pitch), wrap them.
      const next = pianoRollNotes[i + 1];
      if (next && CONSONANT_PHONEMES.has(n.phoneme) && !CONSONANT_PHONEMES.has(next.phoneme)
          && Math.abs(n.startBeat + n.durBeats - next.startBeat) < 0.01
          && n.midiNote === next.midiNote) {
        display.push({
          noteIdx: i,
          phoneme: `[${n.phoneme}${next.phoneme}]`,
          midiNote: n.midiNote,
          startBeat: n.startBeat,
          durBeats: n.durBeats + next.durBeats,
          wrapped: true,
          secondIdx: i + 1
        });
        used.add(i);
        used.add(i + 1);
      } else {
        display.push({ noteIdx: i, phoneme: n.phoneme, midiNote: n.midiNote, startBeat: n.startBeat, durBeats: n.durBeats, wrapped: false });
      }
    }
    return display;
  }

  function drawPianoRoll() {
    const text = container.querySelector("#phonemeInput").value;
    const bpm = parseFloat(container.querySelector("#bpm").value) || 120;
    const gridType = container.querySelector("#gridType").value || "beats";
    const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
    const beatLen = 60 / bpm;

    // Drag-fix: while dragging, do NOT re-parse from text (which would reconstruct
    // sequential positions and push notes forward). Use the in-memory notes.
    if (!skipReparse) {
      pianoRollNotes = parsePianoRollFromText(text, bpm, gridType, stepsPerBeat);
      lastPianoRollSnapshot = pianoRollSnapshot();
    }
    const displayNotes = buildDisplayNotes();
    const range = getMidiRange(pianoRollNotes);
    const totalBeats = getTotalBeats(pianoRollNotes);

    const numKeys = range.max - range.min + 1;
    const canvasWidth = KEYBOARD_WIDTH + totalBeats * PIXELS_PER_BEAT + 20;
    const canvasHeight = numKeys * NOTE_HEIGHT + 10;

    pianoRollCanvas.width = canvasWidth;
    pianoRollCanvas.height = canvasHeight;
    pianoRollContainer.style.width = "100%";

    const c = ctx;

    // Background
    c.fillStyle = "#f8f8f8";
    c.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw piano keys
    for (let i = 0; i < numKeys; i++) {
      const midiNote = range.max - i;
      const y = i * NOTE_HEIGHT + 5;
      const isWhite = [0,2,4,5,7,9,11].includes(midiNote % 12);

      if (isWhite) {
        c.fillStyle = "#fff";
        c.fillRect(0, y, KEYBOARD_WIDTH, NOTE_HEIGHT - 1);
        c.strokeStyle = "#ccc";
        c.strokeRect(0, y, KEYBOARD_WIDTH, NOTE_HEIGHT - 1);
      } else {
        c.fillStyle = "#333";
        c.fillRect(0, y, KEYBOARD_WIDTH * 0.65, NOTE_HEIGHT - 1);
      }

      // Note name labels on C notes
      if (midiNote % 12 === 0) {
        c.fillStyle = "#666";
        c.font = "9px monospace";
        c.fillText(midiToNoteName(midiNote), 2, y + 10);
      }
    }

    // Draw grid lines
    const snapResolution = getPianoRollSnapResolution();
    const gridPx = snapResolution * PIXELS_PER_BEAT;

    for (let beat = 0; beat <= totalBeats; beat += snapResolution) {
      const x = KEYBOARD_WIDTH + beat * PIXELS_PER_BEAT;
      c.strokeStyle = beat % 1 === 0 ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.06)";
      c.lineWidth = beat % 1 === 0 ? 1 : 0.5;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, canvasHeight);
      c.stroke();

      // Beat numbers
      if (beat % 1 === 0) {
        c.fillStyle = "#999";
        c.font = "9px monospace";
        c.fillText(`${beat+1}`, x + 3, 10);
      }
    }

// Draw notes (using display notes so consonant+vowel can be wrapped)
    for (let d = 0; d < displayNotes.length; d++) {
      const disp = displayNotes[d];
      const keyIndex = range.max - disp.midiNote;
      const x = KEYBOARD_WIDTH + disp.startBeat * PIXELS_PER_BEAT;
      const y = keyIndex * NOTE_HEIGHT + 5;
      const w = Math.max(MIN_NOTE_DURATION_PX, disp.durBeats * PIXELS_PER_BEAT);
      const h = NOTE_HEIGHT - 2;

      // Store pixel positions for hit-testing on the underlying note(s)
      const baseNote = pianoRollNotes[disp.noteIdx];
      if (baseNote) {
        baseNote.startPx = x;
        baseNote.durPx = w;
      }
      if (disp.wrapped && disp.secondIdx != null && pianoRollNotes[disp.secondIdx]) {
        pianoRollNotes[disp.secondIdx].startPx = x;
        pianoRollNotes[disp.secondIdx].durPx = w;
      }

      const isSelected = selectedNoteIndexes.has(disp.noteIdx) ||
        (disp.wrapped && disp.secondIdx != null && selectedNoteIndexes.has(disp.secondIdx));

      // Note color based on phoneme type
      const phonType = getPhonemeType(baseNote ? baseNote.phoneme : disp.phoneme);
      let color;
      switch (phonType) {
        case "vowel": color = isSelected ? "#4a90d9" : "#6db3f2"; break;
        case "consonant": color = isSelected ? "#d97a4a" : "#f2a56d"; break;
        case "nasal": color = isSelected ? "#7a4ad9" : "#a56df2"; break;
        default: color = isSelected ? "#888" : "#aaa";
      }

      // Rounded rectangle
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(x + NOTE_RADIUS, y);
      c.lineTo(x + w - NOTE_RADIUS, y);
      c.quadraticCurveTo(x + w, y, x + w, y + NOTE_RADIUS);
      c.lineTo(x + w, y + h - NOTE_RADIUS);
      c.quadraticCurveTo(x + w, y + h, x + w - NOTE_RADIUS, y + h);
      c.lineTo(x + NOTE_RADIUS, y + h);
      c.quadraticCurveTo(x, y + h, x, y + h - NOTE_RADIUS);
      c.lineTo(x, y + NOTE_RADIUS);
      c.quadraticCurveTo(x, y, x + NOTE_RADIUS, y);
      c.closePath();
      c.fill();

      // Border for selected
      if (isSelected) {
        c.strokeStyle = "#ff0";
        c.lineWidth = 2;
        c.stroke();
      }

      // Phoneme label (use the wrapped label like "[tew]" when applicable)
      c.fillStyle = "#fff";
      c.font = "10px monospace";
      c.fillText(disp.phoneme, x + 4, y + 10);
    }

    // Edge hover indicators
    if (hoveredEdge) {
      const note = pianoRollNotes[hoveredEdge.noteIdx];
      if (note) {
        const keyIndex = range.max - note.midiNote;
        const y = keyIndex * NOTE_HEIGHT + 5;
        const h = NOTE_HEIGHT - 2;
        if (hoveredEdge.side === "left") {
          c.fillStyle = "rgba(255,255,0,0.4)";
          c.fillRect(note.startPx - 3, y, 6, h);
        } else {
          const rightX = note.startPx + note.durPx;
          c.fillStyle = "rgba(255,255,0,0.4)";
          c.fillRect(rightX - 3, y, 6, h);
        }
      }
    }

    // Selection box
    if (selectionState) {
      const x0 = Math.min(selectionState.startX, selectionState.curX);
      const y0 = Math.min(selectionState.startY, selectionState.curY);
      const w0 = Math.abs(selectionState.curX - selectionState.startX);
      const h0 = Math.abs(selectionState.curY - selectionState.startY);
      c.strokeStyle = "rgba(0,120,255,0.9)";
      c.lineWidth = 1;
      c.strokeRect(x0, y0, w0, h0);
      c.fillStyle = "rgba(0,120,255,0.12)";
      c.fillRect(x0, y0, w0, h0);
    }
  }

  // Get phoneme type for coloring
  function getPhonemeType(phon) {
    const vowels = ["a","aa","e","i","ee","I","o","u","y","w","r","l","uh","er","oy","aw","ew"];
    const nasals = ["m","n","ng"];
    if (vowels.includes(phon)) return "vowel";
    if (nasals.includes(phon)) return "nasal";
    return "consonant";
  }

  // --- Left panel (note editor / piano roll settings) helpers ---
  function escapeHtml(s) {
    const q = String.fromCharCode;
    const ampersand = q(38); // &
    const lt = q(60);         // <
    const gt = q(62);         // >
    const dq = q(34);         // "
    const sq = q(39);         // '
    return String(s).replace(/[&<>"']/g, function (c) {
      if (c === ampersand) return ampersand + 'amp;';
      if (c === lt) return ampersand + 'lt;';
      if (c === gt) return ampersand + 'gt;';
      if (c === dq) return ampersand + 'quot;';
      if (c === sq) return ampersand + '#39;';
      return c;
    });
  }
  function fmtNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "0";
    return (Math.round(n * 1000) / 1000).toString();
  }
  function unitsForNote(durBeats, gridType, stepsPerBeat) {
    if (gridType === "steps") return durBeats * stepsPerBeat;
    if (gridType === "seconds") return durBeats * (60 / (parseFloat(container.querySelector("#bpm").value) || 120));
    return durBeats;
  }

  function attachPhonemeBank() {
    if (!pianoRollPanelEl || pianoRollPanelEl.querySelector("#prOpenPhoneBank")) return;
    const openButton = document.createElement("button");
    openButton.id = "prOpenPhoneBank";
    openButton.className = "pe-btn";
    openButton.type = "button";
    openButton.textContent = "Phoneme Bank";
    const frame = document.createElement("div");
    frame.id = "prPhoneBankFrame";
    frame.className = "phone-bank";
    frame.style.display = "none";
    frame.innerHTML = `<div class="phone-bank-header"><b style="flex:1">Phoneme Bank</b><button type="button" id="prClosePhoneBank">x</button></div><div class="phone-bank-body"><div class="phone-bank-buttons" id="prPhoneBankButtons"></div></div>`;
    const buttons = frame.querySelector("#prPhoneBankButtons");
    for (const key of Object.keys(phonemeMap)) {
      if (key === "rest") continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = key;
      button.title = `Preview ${key}`;
      button.addEventListener("click", () => previewPhoneme(key));
      buttons.appendChild(button);
    }
    openButton.addEventListener("click", () => { frame.style.display = frame.style.display === "none" ? "block" : "none"; });
    frame.querySelector("#prClosePhoneBank").addEventListener("click", () => { frame.style.display = "none"; });
    const header = frame.querySelector(".phone-bank-header");
    let drag = null;
    header.addEventListener("pointerdown", event => {
      const rect = frame.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", event => {
      if (!drag) return;
      frame.style.transform = `translate(${event.clientX - drag.x}px, ${event.clientY - drag.y}px)`;
    });
    header.addEventListener("pointerup", () => { drag = null; });
    header.addEventListener("pointercancel", () => { drag = null; });
    pianoRollPanelEl.append(openButton, frame);
  }

  function updateLegacySelectedPanel() {
    /*
      let h = `<div style="font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;">Piano Roll Settings</div>`;
      h += `<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;">
              <input type="checkbox" id="prConsonantWrap" ${consonantWrapperEnabled ? "checked" : ""}/>
              Consonant wrapping
            </label>`;
      h += `<label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;">
              <input type="checkbox" id="prSnap" ${pianoRollSnap.checked ? "checked" : ""}/>
              Snap to grid
            </label>`;
      h += `<button id="prRefreshBtn" class="pe-btn">Refresh from text</button>`;
      h += `<div class="pe-hint">Click to add note • drag to move • drag edges to resize • Shift+Click/Drag to multi-select • Delete to remove • Double-click to edit phoneme</div>`;
      pianoRollPanelEl.innerHTML = h;
      attachPhonemeBank();

      const wrapChk = pianoRollPanelEl.querySelector("#prConsonantWrap");
      if (wrapChk) wrapChk.addEventListener("change", (e) => {
        consonantWrapperEnabled = e.target.checked;
        drawPianoRoll();
        updatePianoRollPanel();
      });
      const snapChk = pianoRollPanelEl.querySelector("#prSnap");
      if (snapChk) snapChk.addEventListener("change", (e) => { pianoRollSnap.checked = e.target.checked; });
      const refreshBtn = pianoRollPanelEl.querySelector("#prRefreshBtn");
      if (refreshBtn) refreshBtn.addEventListener("click", () => {
        selectedNoteIndex = -1;
        drawPianoRoll();
        updatePianoRollPanel();
      });
      return;
    }

    if (selectedNoteIndexes.size > 1) {
      // Multi-selection summary.
      let h = `<div style="font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;">Selection</div>`;
      h += `<div class="pe-total">${selectedNoteIndexes.size} notes selected</div>`;
      h += `<button id="prDeselect" class="pe-btn">Deselect</button>`;
      pianoRollPanelEl.innerHTML = h;
      attachPhonemeBank();
      const ds = pianoRollPanelEl.querySelector("#prDeselect");
      if (ds) ds.addEventListener("click", () => {
        selectedNoteIndexes.clear();
        selectedNoteIndex = -1;
        drawPianoRoll();
        updatePianoRollPanel();
      });
      return;
    }

    // Single selection: find the underlying note index.
    const selIdx = [...selectedNoteIndexes][0];
    const note = pianoRollNotes[selIdx];
    if (!note) return;

    // Determine if this note is the vowel (second) half of a wrapped consonant group,
    // or the consonant (first) half. If the neighbour forms a wrapped group, show split fields.
    let startPhone = null, startPhoneLength = null, endPhone = null, endPhoneLength = null;
    let isWrappedGroup = false;

    const prev = selIdx > 0 ? pianoRollNotes[selIdx - 1] : null;
    const next = selIdx + 1 < pianoRollNotes.length ? pianoRollNotes[selIdx + 1] : null;

    const wrapsWithPrev = consonantWrapperEnabled && prev
      && CONSONANT_PHONEMES.has(prev.phoneme) && !CONSONANT_PHONEMES.has(note.phoneme)
      && Math.abs(prev.startBeat + prev.durBeats - note.startBeat) < 0.01
      && prev.midiNote === note.midiNote;
    const wrapsWithNext = consonantWrapperEnabled && next
      && CONSONANT_PHONEMES.has(note.phoneme) && !CONSONANT_PHONEMES.has(next.phoneme)
      && Math.abs(note.startBeat + note.durBeats - next.startBeat) < 0.01
      && note.midiNote === next.midiNote;

    if (wrapsWithPrev) {
      startPhone = prev.phoneme;
      startPhoneLength = unitsForNote(prev.durBeats, gridType, stepsPerBeat);
      endPhone = note.phoneme;
      endPhoneLength = unitsForNote(note.durBeats, gridType, stepsPerBeat);
      isWrappedGroup = true;
    } else if (wrapsWithNext) {
      startPhone = note.phoneme;
      startPhoneLength = unitsForNote(note.durBeats, gridType, stepsPerBeat);
      endPhone = next.phoneme;
      endPhoneLength = unitsForNote(next.durBeats, gridType, stepsPerBeat);
      isWrappedGroup = true;
    }

    let h = `<div style="font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;">Note Editor</div>`;
    h += `<label class="pe-label">Phoneme<br/>
            <input class="pe-input" id="prPhoneme" value="${escapeHtml(note.phoneme)}"/>
          </label>`;
    h += `<label class="pe-label">Pitch<br/>
            <input class="pe-input" id="prPitch" value="${escapeHtml(note.pitchName)}"/>
          </label>`;
    h += `<label class="pe-label">Start (${gridType})<br/>
            <input class="pe-input" type="number" step="0.001" id="prStart" value="${fmtNum(unitsForNote(note.startBeat, gridType, stepsPerBeat))}"/>
          </label>`;
    h += `<label class="pe-label">Length (${gridType})<br/>
            <input class="pe-input" type="number" step="0.001" id="prLen" value="${fmtNum(unitsForNote(note.durBeats, gridType, stepsPerBeat))}"/>
          </label>`;

    // When part of a wrapped group, allow editing the two halves separately.
    if (isWrappedGroup && startPhone != null && endPhone != null) {
      h += `<div style="margin-top:9px;padding-top:6px;border-top:1px dashed #ddd;">
              <div style="font-size:11px;color:#333;font-weight:bold;">Consonant+Vowel split</div>`;
      h += `<label class="pe-label">startPhone<br/>
              <input class="pe-input" id="prStartPhone" value="${escapeHtml(startPhone)}"/>
            </label>`;
      h += `<label class="pe-label">startPhoneLength (${gridType})<br/>
              <input class="pe-input" type="number" step="0.001" id="prStartPhoneLen" value="${fmtNum(startPhoneLength)}"/>
            </label>`;
      h += `<label class="pe-label">endPhone<br/>
              <input class="pe-input" id="prEndPhone" value="${escapeHtml(endPhone)}"/>
            </label>`;
      h += `<label class="pe-label">endPhoneLength (${gridType})<br/>
              <input class="pe-input" type="number" step="0.001" id="prEndPhoneLen" value="${fmtNum(endPhoneLength)}"/>
            </label>`;
      h += `</div>`;
    }

    h += `<button id="prDelete" class="pe-btn">Delete</button>`;
    h += `<button id="prDeselect" class="pe-btn">Deselect</button>`;
    pianoRollPanelEl.innerHTML = h;
    attachPhonemeBank();

    const parseBeatFromUnits = (units, gridType2, steps2) => {
      if (gridType2 === "steps") return units / steps2;
      if (gridType2 === "seconds") return units / ((parseFloat(container.querySelector("#bpm").value) || 120) / 60);
      return units;
    };

    const applySplit = () => {
      const sPhone = (pianoRollPanelEl.querySelector("#prStartPhone") || {}).value;
      const ePhone = (pianoRollPanelEl.querySelector("#prEndPhone") || {}).value;
      const sLen = parseFloat((pianoRollPanelEl.querySelector("#prStartPhoneLen") || {}).value);
      const eLen = parseFloat((pianoRollPanelEl.querySelector("#prEndPhoneLen") || {}).value);

      const targetA = wrapsWithPrev ? prev : note;
      const targetB = wrapsWithPrev ? note : next;
      if (sPhone != null && String(sPhone).trim()) targetA.phoneme = String(sPhone).trim().toLowerCase();
      if (ePhone != null && String(ePhone).trim()) targetB.phoneme = String(ePhone).trim().toLowerCase();
      if (Number.isFinite(sLen) && sLen > 0) targetA.durBeats = parseBeatFromUnits(sLen, gridType, stepsPerBeat);
      if (Number.isFinite(eLen) && eLen > 0) targetB.durBeats = parseBeatFromUnits(eLen, gridType, stepsPerBeat);
      updateTextFromPianoRoll();
      drawPianoRoll();
      updatePianoRollPanel();
    };

    const phonemeInput2 = pianoRollPanelEl.querySelector("#prPhoneme");
    if (phonemeInput2) phonemeInput2.addEventListener("change", () => {
      if (String(phonemeInput2.value).trim()) {
        note.phoneme = String(phonemeInput2.value).trim().toLowerCase();
        updateTextFromPianoRoll();
        drawPianoRoll();
        updatePianoRollPanel();
      }
    });
    const pitchInput = pianoRollPanelEl.querySelector("#prPitch");
    if (pitchInput) pitchInput.addEventListener("change", () => {
      const v = String(pitchInput.value).trim();
      const midi = pitchNameToMidi(v);
      if (midi !== null) {
        note.pitchName = v;
        note.midiNote = midi;
        updateTextFromPianoRoll();
        drawPianoRoll();
        updatePianoRollPanel();
      }
    });
    const startInput = pianoRollPanelEl.querySelector("#prStart");
    if (startInput) startInput.addEventListener("change", () => {
      const v = parseFloat(startInput.value);
      if (Number.isFinite(v)) {
        note.startBeat = parseBeatFromUnits(v, gridType, stepsPerBeat);
        updateTextFromPianoRoll();
        drawPianoRoll();
        updatePianoRollPanel();
      }
    });
    const lenInput = pianoRollPanelEl.querySelector("#prLen");
    if (lenInput) lenInput.addEventListener("change", () => {
      const v = parseFloat(lenInput.value);
      if (Number.isFinite(v) && v > 0) {
        note.durBeats = parseBeatFromUnits(v, gridType, stepsPerBeat);
        updateTextFromPianoRoll();
        drawPianoRoll();
        updatePianoRollPanel();
      }
    });

    const splitBtn = pianoRollPanelEl.querySelector("#prApplySplit");
    // If the split section is shown, wire its inputs to update on change.
    const anySplitInput = pianoRollPanelEl.querySelector("#prStartPhone") ||
      pianoRollPanelEl.querySelector("#prEndPhone") ||
      pianoRollPanelEl.querySelector("#prStartPhoneLen") ||
      pianoRollPanelEl.querySelector("#prEndPhoneLen");
    if (anySplitInput) {
      for (const el of [pianoRollPanelEl.querySelector("#prStartPhone"),
                        pianoRollPanelEl.querySelector("#prEndPhone"),
                        pianoRollPanelEl.querySelector("#prStartPhoneLen"),
                        pianoRollPanelEl.querySelector("#prEndPhoneLen")].filter(Boolean)) {
        el.addEventListener("change", applySplit);
      }
    }

    const deleteBtn = pianoRollPanelEl.querySelector("#prDelete");
    if (deleteBtn) deleteBtn.addEventListener("click", () => {
      if (wrapsWithPrev) {
        pianoRollNotes.splice(selIdx - 1, 2);
      } else if (wrapsWithNext) {
        pianoRollNotes.splice(selIdx, 2);
      } else {
        pianoRollNotes.splice(selIdx, 1);
      }
      selectedNoteIndexes.clear();
      selectedNoteIndex = -1;
      updateTextFromPianoRoll();
      drawPianoRoll();
      updatePianoRollPanel();
    });
    const ds2 = pianoRollPanelEl.querySelector("#prDeselect");
    if (ds2) ds2.addEventListener("click", () => {
      selectedNoteIndexes.clear();
      selectedNoteIndex = -1;
      drawPianoRoll();
      updatePianoRollPanel();
    });
  }

    */
  }
  const gridType = container.querySelector("#gridType").value || "beats";
  const stepsPerBeat = Math.max(
    1,
    parseInt(container.querySelector("#stepsPerBeat").value, 10) || 4
  );

  function updatePianoRollPanel() {
    if (!pianoRollPanelEl) return;
    const gridType = container.querySelector("#gridType").value || "beats";
    const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value, 10) || 4);
    let h = `<div style="font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;">Piano Roll Settings</div>`;
    h += `<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;"><input type="checkbox" id="prConsonantWrap" ${consonantWrapperEnabled ? "checked" : ""}/> Consonant wrapping</label>`;
    h += `<label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;"><input type="checkbox" id="prSnap" ${pianoRollSnap.checked ? "checked" : ""}/> Snap to grid</label>`;
    h += `<button id="prAdd" class="pe-btn">Add note</button>`;
    h += `<button id="prRefreshBtn" class="pe-btn">Refresh from text</button>`;

    const selected = selectedNoteIndexes.size === 1 ? pianoRollNotes[[...selectedNoteIndexes][0]] : null;
    if (selected) {
      selected.bracketSettings = { ...BRACKET_SETTING_DEFAULTS, ...(selected.bracketSettings || {}) };
      h += `<div class="pe-label">Phoneme<br/><input class="pe-input" id="prPhoneme" value="${escapeHtml(selected.phoneme)}"/></div>`;
      h += `<details style="margin-top:8px"><summary>Bracket settings []</summary>`;
      for (const key of Object.keys(BRACKET_SETTING_DEFAULTS)) {
        const defaultValue = key === "fs" ? "1" : "";
        h += `<label class="pe-label">${key}<br/><input class="pe-input pr-setting" data-setting="${key}" value="${escapeHtml(selected.bracketSettings[key] || defaultValue)}" placeholder="default"/></label>`;
      }
      h += `</details>`;
      h += `<button id="prDelete" class="pe-btn">Delete</button><button id="prDeselect" class="pe-btn">Deselect</button>`;
    } else if (selectedNoteIndexes.size > 1) {
      h += `<div class="pe-total">${selectedNoteIndexes.size} notes selected</div><button id="prDelete" class="pe-btn">Delete</button>`;
    }
    h += `<div class="pe-hint">Grid: ${gridType}, ${stepsPerBeat} steps per beat</div>`;
    pianoRollPanelEl.innerHTML = h;
    attachPhonemeBank();
    const wrap = pianoRollPanelEl.querySelector("#prConsonantWrap");
    wrap.addEventListener("change", event => { consonantWrapperEnabled = event.target.checked; drawPianoRoll(); updatePianoRollPanel(); });
    pianoRollPanelEl.querySelector("#prSnap").addEventListener("change", event => { pianoRollSnap.checked = event.target.checked; drawPianoRoll(); });
    pianoRollPanelEl.querySelector("#prAdd").addEventListener("click", () => {
      const startBeat = pianoRollNotes.reduce((end, note) => Math.max(end, note.startBeat + note.durBeats), 0);
      pianoRollNotes.push({ phoneme: "a", pitchName: "C4", midiNote: pitchNameToMidi("C4"), startBeat, durBeats: 1, bracketSettings: { ...BRACKET_SETTING_DEFAULTS } });
      pianoRollNotes.sort((a, b) => a.startBeat - b.startBeat || a.midiNote - b.midiNote);
      selectedNoteIndex = pianoRollNotes.length - 1;
      selectedNoteIndexes = new Set([selectedNoteIndex]);
      updateTextFromPianoRoll(); drawPianoRoll(); updatePianoRollPanel();
    });
    pianoRollPanelEl.querySelector("#prRefreshBtn").addEventListener("click", () => { selectedNoteIndex = -1; selectedNoteIndexes.clear(); drawPianoRoll(); updatePianoRollPanel(); });
    const phonemeInputEl = pianoRollPanelEl.querySelector("#prPhoneme");
    if (phonemeInputEl) phonemeInputEl.addEventListener("change", () => { selected.phoneme = phonemeInputEl.value.trim().toLowerCase() || selected.phoneme; updateTextFromPianoRoll(); drawPianoRoll(); updatePianoRollPanel(); });
    for (const input of pianoRollPanelEl.querySelectorAll(".pr-setting")) {
      input.addEventListener("input", () => {
        selected.bracketSettings[input.dataset.setting] = input.value.trim();
        updateTextFromPianoRoll();
      });
    }
    const deleteButton = pianoRollPanelEl.querySelector("#prDelete");
    if (deleteButton) deleteButton.addEventListener("click", deleteSelectedPianoRollNotes);
    const deselectButton = pianoRollPanelEl.querySelector("#prDeselect");
    if (deselectButton) deselectButton.addEventListener("click", () => { selectedNoteIndexes.clear(); selectedNoteIndex = -1; drawPianoRoll(); updatePianoRollPanel(); });
}

  // Update text input from piano roll notes
  function updateTextFromPianoRoll() {
    const gridType = container.querySelector("#gridType").value || "beats";
    const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
    const bpm = parseFloat(container.querySelector("#bpm").value) || 120;
    const beatLen = 60 / bpm;

    let tokens = [];
    let prevEndBeat = 0;
    let previousPitchName = null;
    for (const note of pianoRollNotes) {
      // Add rest if gap
      if (note.startBeat > prevEndBeat + 0.01) {
        const gap = note.startBeat - prevEndBeat;
        let gapUnits = gap;
        if (gridType === "steps") gapUnits = gap * stepsPerBeat;
        tokens.push(`rest <${gapUnits.toFixed(3)}>`);
      }

      let units = note.durBeats;
      if (gridType === "steps") units = note.durBeats * stepsPerBeat;
      const pitchPart = note.pitchName === previousPitchName ? "" : `${note.pitchName},`;
      const settings = note.bracketSettings || {};
      const bracket = Object.entries(settings).filter(([, value]) => value !== "" && value != null).map(([key, value]) => `${key}:${value}`).join(", ");
      tokens.push(`${bracket ? `[${bracket}] ` : ""}${note.phoneme} <${pitchPart}${units.toFixed(3)}>`);
      previousPitchName = note.pitchName;
      prevEndBeat = note.startBeat + note.durBeats;
    }

    container.querySelector("#phonemeInput").value = tokens.join(" ");
    rememberPianoRollChange();
  }

  // Hit test: find note at canvas coordinates
  function hitTestNotes(mouseX, mouseY) {
    const range = getMidiRange(pianoRollNotes);
    for (let i = pianoRollNotes.length - 1; i >= 0; i--) {
      const n = pianoRollNotes[i];
      const keyIndex = range.max - n.midiNote;
      const y = keyIndex * NOTE_HEIGHT + 5;
      const h = NOTE_HEIGHT - 2;
      const x = n.startPx;
      const w = n.durPx;

      // Check edge regions (left/right 5px)
      if (mouseY >= y && mouseY <= y + h) {
        if (mouseX >= x - 3 && mouseX <= x + 5) {
          return { noteIdx: i, action: "resizeLeft" };
        }
        if (mouseX >= x + w - 5 && mouseX <= x + w + 3) {
          return { noteIdx: i, action: "resizeRight" };
        }
        if (mouseX >= x && mouseX <= x + w) {
          return { noteIdx: i, action: "move" };
        }
      }
    }
    return null;
  }

  // Find the grid position from mouse coordinates
  function mouseToGrid(mouseX, mouseY) {
    const range = getMidiRange(pianoRollNotes);
    const x = mouseX - KEYBOARD_WIDTH;
    let beat = x / PIXELS_PER_BEAT;
    const gridType = container.querySelector("#gridType").value || "beats";
    const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
    const snapResolution = getPianoRollSnapResolution();

    if (pianoRollSnap.checked) {
      beat = snapToGrid(beat, snapResolution);
    }
    beat = Math.max(0, beat);

    const keyIndex = Math.round((mouseY - 5) / NOTE_HEIGHT);
    let midiNote = range.max - keyIndex;
    midiNote = Math.max(0, Math.min(127, midiNote));

    return { beat, midiNote, pitchName: midiToNoteName(midiNote) };
  }

// Mouse events
  pianoRollCanvas.addEventListener("mousedown", (e) => {
    pianoRollCanvas.focus();
    if (e.button === 2) {
      const rect = pianoRollCanvas.getBoundingClientRect();
      const scaleX = pianoRollCanvas.width / rect.width;
      const scaleY = pianoRollCanvas.height / rect.height;
      const hit = hitTestNotes((e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY);
      if (hit) {
        selectedNoteIndexes = new Set([hit.noteIdx]);
        selectedNoteIndex = hit.noteIdx;
        deleteSelectedPianoRollNotes();
      }
      e.preventDefault();
      return;
    }
    const rect = pianoRollCanvas.getBoundingClientRect();
    const scaleX = pianoRollCanvas.width / rect.width;
    const scaleY = pianoRollCanvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const hit = hitTestNotes(mouseX, mouseY);
    if (hit) {
      // Shift+Click toggles multi-selection; otherwise select only this note.
      if (e.shiftKey) {
        if (selectedNoteIndexes.has(hit.noteIdx)) {
          selectedNoteIndexes.delete(hit.noteIdx);
          if (selectedNoteIndexes.size === 0) selectedNoteIndex = -1;
        } else {
          selectedNoteIndexes.add(hit.noteIdx);
          selectedNoteIndex = hit.noteIdx;
        }
      } else {
        selectedNoteIndexes = new Set([hit.noteIdx]);
        selectedNoteIndex = hit.noteIdx;
      }

      const note = pianoRollNotes[hit.noteIdx];
      // Capture original positions for all selected notes so multi-select drag
      // moves/resizes them together from their original spot.
      const origPitches = [];
      for (const idx of selectedNoteIndexes) {
        const n = pianoRollNotes[idx];
        if (n) origPitches.push({ idx, startBeat: n.startBeat, midiNote: n.midiNote, durBeats: n.durBeats });
      }
      dragState = {
        type: hit.action,
        noteIdx: hit.noteIdx,
        startX: mouseX,
        startY: mouseY,
        origStartBeat: note.startBeat,
        origDurBeats: note.durBeats,
        origMidi: note.midiNote,
        origPitches,
        selectedNotes: [...selectedNoteIndexes].map(index => pianoRollNotes[index]).filter(Boolean)
      };
      skipReparse = true; // preserve absolute positions while dragging
      drawPianoRoll();
      updatePianoRollPanel();
      return;
    }

    // Click on empty space
    if (e.shiftKey) {
      // Shift+Drag on empty space draws a selection box (no note added).
      selectionState = { startX: mouseX, startY: mouseY, curX: mouseX, curY: mouseY };
      drawPianoRoll();
      return;
    }

    // Plain click on empty space: add a new note
    selectedNoteIndex = -1;
    selectedNoteIndexes.clear();
    const grid = mouseToGrid(mouseX, mouseY);
    if (mouseX > KEYBOARD_WIDTH) {
      const newNote = {
        phoneme: "a",
        pitchName: grid.pitchName,
        midiNote: grid.midiNote,
        startBeat: grid.beat,
        durBeats: 1.0
      };
      pianoRollNotes.push(newNote);
      pianoRollNotes.sort((a, b) => a.startBeat - b.startBeat || a.midiNote - b.midiNote);
      selectedNoteIndex = pianoRollNotes.indexOf(newNote);
      selectedNoteIndexes = new Set([selectedNoteIndex]);
      updateTextFromPianoRoll();
      drawPianoRoll();
      updatePianoRollPanel();
    }
  });

  pianoRollCanvas.addEventListener("mousemove", (e) => {
    if (e.buttons & 2) {
      const rect = pianoRollCanvas.getBoundingClientRect();
      const scaleX = pianoRollCanvas.width / rect.width;
      const scaleY = pianoRollCanvas.height / rect.height;
      const hit = hitTestNotes((e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY);
      if (hit) {
        selectedNoteIndexes = new Set([hit.noteIdx]);
        selectedNoteIndex = hit.noteIdx;
        deleteSelectedPianoRollNotes();
      }
      return;
    }
    const rect = pianoRollCanvas.getBoundingClientRect();
    const scaleX = pianoRollCanvas.width / rect.width;
    const scaleY = pianoRollCanvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // Edge hover detection
    const hit = hitTestNotes(mouseX, mouseY);
    if (hit && (hit.action === "resizeLeft" || hit.action === "resizeRight")) {
      pianoRollCanvas.style.cursor = "ew-resize";
      hoveredEdge = { noteIdx: hit.noteIdx, side: hit.action === "resizeLeft" ? "left" : "right" };
      drawPianoRoll();
    } else if (hit && hit.action === "move") {
      pianoRollCanvas.style.cursor = "grab";
      hoveredEdge = null;
      drawPianoRoll();
    } else {
      pianoRollCanvas.style.cursor = "crosshair";
      if (hoveredEdge) {
        hoveredEdge = null;
        drawPianoRoll();
      }
    }

// Selection box drawing while dragging on empty space
    if (selectionState) {
      selectionState.curX = mouseX;
      selectionState.curY = mouseY;
      drawPianoRoll();
      return;
    }

    // Drag handling (single note or multi-selection)
    if (dragState) {
      const note = pianoRollNotes[dragState.noteIdx];
      if (!note) return;

      const dxBeats = (mouseX - dragState.startX) / PIXELS_PER_BEAT;
      const gridType = container.querySelector("#gridType").value || "beats";
      const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
      const snapResolution = getPianoRollSnapResolution();

      if (dragState.type === "move") {
        let newStart = dragState.origStartBeat + dxBeats;
        if (pianoRollSnap.checked) newStart = snapToGrid(newStart, snapResolution);
        newStart = Math.max(0, newStart);

        // Change pitch based on vertical drag
        const dyKeys = Math.round((mouseY - dragState.startY) / NOTE_HEIGHT);
        let newMidi = dragState.origMidi - dyKeys;
        newMidi = Math.max(0, Math.min(127, newMidi));

        note.startBeat = newStart;
        note.midiNote = newMidi;
        note.pitchName = midiToNoteName(newMidi);

        // Move all other selected notes by the same horizontal/vertical delta.
        if (dragState.origPitches) {
          const dStart = newStart - dragState.origStartBeat;
          const dNote = newMidi - dragState.origMidi;
          for (const op of dragState.origPitches) {
            if (op.idx === dragState.noteIdx) continue;
            const n = pianoRollNotes[op.idx];
            if (!n) continue;
            n.startBeat = Math.max(0, op.startBeat + dStart);
            n.midiNote = Math.max(0, Math.min(127, op.midiNote + dNote));
            n.pitchName = midiToNoteName(n.midiNote);
          }
        }
      } else if (dragState.type === "resizeRight") {
        let newDur = dragState.origDurBeats + dxBeats;
        if (pianoRollSnap.checked) newDur = snapToGrid(newDur, snapResolution);
        newDur = Math.max(0.125, newDur);
        // Apply the same duration delta to every selected note.
        const dDur = newDur - dragState.origDurBeats;
        note.durBeats = newDur;
        if (dragState.origPitches) {
          for (const op of dragState.origPitches) {
            if (op.idx === dragState.noteIdx) continue;
            const n = pianoRollNotes[op.idx];
            if (!n) continue;
            n.durBeats = Math.max(0.125, op.durBeats + dDur);
          }
        }
      } else if (dragState.type === "resizeLeft") {
        let newStart = dragState.origStartBeat + dxBeats;
        let newDur = dragState.origDurBeats - dxBeats;
        if (pianoRollSnap.checked) {
          const snapped = snapToGrid(newDur, snapResolution);
          newDur = snapped;
          newStart = dragState.origStartBeat + (dragState.origDurBeats - snapped);
        }
        newStart = Math.max(0, newStart);
        newDur = Math.max(0.125, newDur);
        // Apply the same start+end delta to every selected note.
        const dStart = newStart - dragState.origStartBeat;
        const dDur = newDur - dragState.origDurBeats;
        note.startBeat = newStart;
        note.durBeats = newDur;
        if (dragState.origPitches) {
          for (const op of dragState.origPitches) {
            if (op.idx === dragState.noteIdx) continue;
            const n = pianoRollNotes[op.idx];
            if (!n) continue;
            n.startBeat = Math.max(0, op.startBeat + dStart);
            n.durBeats = Math.max(0.125, op.durBeats + dDur);
          }
        }
      }

      updateTextFromPianoRoll();
      drawPianoRoll();
    }
  });

  pianoRollCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

  pianoRollContainer.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = pianoRollCanvas.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const beatAtCursor = (cursorX + pianoRollContainer.scrollLeft - KEYBOARD_WIDTH) / PIXELS_PER_BEAT;
    const zoomFactor = Math.exp(-event.deltaY * 0.001);
    PIXELS_PER_BEAT = Math.max(40, Math.min(500, PIXELS_PER_BEAT * zoomFactor));
    drawPianoRoll();
    pianoRollContainer.scrollLeft = Math.max(0, KEYBOARD_WIDTH + beatAtCursor * PIXELS_PER_BEAT - cursorX);
  }, { passive: false });

  pianoRollSnapType.addEventListener("change", drawPianoRoll);

  window.addEventListener("mouseup", () => {
    if (dragState) {
      const draggedNotes = dragState.selectedNotes || [];
      dragState = null;
      skipReparse = false;
      pianoRollNotes.sort((a, b) => a.startBeat - b.startBeat || a.midiNote - b.midiNote);
      selectedNoteIndexes = new Set(draggedNotes.map(note => pianoRollNotes.indexOf(note)).filter(index => index >= 0));
      selectedNoteIndex = selectedNoteIndexes.size > 0 ? Math.min(...selectedNoteIndexes) : -1;
      updateTextFromPianoRoll();
      drawPianoRoll();
      updatePianoRollPanel();
    }
    if (selectionState) {
      // Finalize the marquee selection: select any notes whose rectangle
      // intersects the dragged box.
      const x0 = Math.min(selectionState.startX, selectionState.curX);
      const y0 = Math.min(selectionState.startY, selectionState.curY);
      const x1 = Math.max(selectionState.startX, selectionState.curX);
      const y1 = Math.max(selectionState.startY, selectionState.curY);
      const range = getMidiRange(pianoRollNotes);
      const newSel = new Set();
      for (let i = 0; i < pianoRollNotes.length; i++) {
        const n = pianoRollNotes[i];
        const keyIndex = range.max - n.midiNote;
        const ny = keyIndex * NOTE_HEIGHT + 5;
        const nh = NOTE_HEIGHT - 2;
        const nx = n.startPx;
        const nw = n.durPx;
        const overlaps = nx < x1 && (nx + nw) > x0 && ny < y1 && (ny + nh) > y0;
        if (overlaps) newSel.add(i);
      }
      selectedNoteIndexes = newSel;
      selectedNoteIndex = newSel.size > 0 ? Math.min(...newSel) : -1;
      selectionState = null;
      drawPianoRoll();
    }
  });

  // Double-click to edit phoneme
  pianoRollCanvas.addEventListener("dblclick", (e) => {
    const rect = pianoRollCanvas.getBoundingClientRect();
    const scaleX = pianoRollCanvas.width / rect.width;
    const scaleY = pianoRollCanvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const hit = hitTestNotes(mouseX, mouseY);
    if (hit && pianoRollNotes[hit.noteIdx]) {
      const note = pianoRollNotes[hit.noteIdx];
      const newPhoneme = prompt("Enter phoneme:", note.phoneme);
      if (newPhoneme && newPhoneme.trim()) {
        note.phoneme = newPhoneme.trim().toLowerCase();
        updateTextFromPianoRoll();
        drawPianoRoll();
      }
    }
  });

// Delete key to remove all selected notes
  document.addEventListener("keydown", (e) => {
    const pianoRollFocused = document.activeElement === pianoRollCanvas || pianoRollContainer.contains(document.activeElement);
    if (!pianoRollFocused) return;
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      const current = pianoRollSnapshot();
      const previous = pianoRollHistory.pop();
      if (previous) { pianoRollRedo.push(current); restorePianoRollSnapshot(previous); }
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      const current = pianoRollSnapshot();
      const next = pianoRollRedo.pop();
      if (next) { pianoRollHistory.push(current); restorePianoRollSnapshot(next); }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelectedPianoRollNotes();
    }
  });

  // Refresh from text input
  pianoRollRefreshBtn.addEventListener("click", () => {
    selectedNoteIndex = -1;
    drawPianoRoll();
  });

  // Auto-refresh when text input changes
  container.querySelector("#phonemeInput").addEventListener("input", () => {
    selectedNoteIndex = -1;
    drawPianoRoll();
  });

  // Refresh piano roll when BPM or grid changes
  container.querySelector("#bpm").addEventListener("change", drawPianoRoll);
  container.querySelector("#gridType").addEventListener("change", drawPianoRoll);
  container.querySelector("#stepsPerBeat").addEventListener("change", drawPianoRoll);

  // Initial draw
  drawPianoRoll();
  updatePianoRollPanel();

})();
