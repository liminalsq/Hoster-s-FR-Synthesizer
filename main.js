(async () => {
  const sampleRate = 44100;

  // voice cloning and gender variables
  let genderShift = 0; // -100 (male) to 100 (female)
  let clonedRatios = null; // ratios for formant scaling from cloned voice
  let clonedTimbre = { harmonics: 27, duty: 0.55 }; // default
  const standardFormants = [700, 1220, 2600]; // standard formants for 'a'

  // personal dictionary and dynamic mode
  let personalDict = {}; // word -> [phoneme1, phoneme2, ...]
  let dynamicMode = false;
  let consonantDuration = 0.1;

  // preview playback state (shared so re-synthesizing stops any playing preview)
  let actx = null;
  let prevSrc = null;
  let previewBuf = null;

  const stopPreview = () => {
    if (prevSrc) {
      try {
        prevSrc.onended = null;
        prevSrc.disconnect();
        prevSrc.stop();
      } catch (e) {}
      prevSrc = null;
    }
    previewBuf = null;
    if (actx) {
      try { if (actx.state === "running") actx.close(); } catch (e) {}
      actx = null;
    }
  };

  // personal dictionary persistence functions
  function savePersonalDict() {
    try {
      localStorage.setItem('personalDict', JSON.stringify(personalDict));
      console.log('Personal dictionary saved.');
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
      // apply cloned voice ratios
      f = f.map((freq, i) => freq * clonedRatios[i]);
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
    a: { f: [700, 1220, 2600], voiced: true },
    aa: { f: [900, 1300, 2650], voiced: true },
    e: { f: [500, 2300, 3000], voiced: true },
    i: { f: [350, 2200, 2900], voiced: true },
    ee: { f: [285, 2275, 2900], voiced: true },
    I: { f: [440, 1200, 2700], voiced: true },
    o: { f: [400, 1000, 2600], voiced: true },
    u: { f: [325, 700, 2530], voiced: true },
    y: { f: [300, 2000, 2800], voiced: true },
    w: { f: [400, 1000, 2200], voiced: true },
    r: { f: [450, 1300, 1700], voiced: true },
    l: { f: [500, 820, 2400], voiced: true },

    // consonants & sibilants (some flagged voiced/unvoiced)
    // Lower noise-related formant centers by ~50 to reduce harsh high-frequency energy.
    h: { f: [750, 1750, 3150], breathy: true, amp: 0.9, voiced: false, noiseAmp: 1 },
    s: { f: [2950, 4950, 3450], breathy: true, amp: 1.4, voiced: false, noiseAmp: 1 },
    z: { f: [2950, 4450, 4950], breathy: true, amp: 1.4, voiced: true, noiseAmp: 1 },
    t: { f: [950, 4450, 2950], burst: true, amp: 0.6, voiced: false, noiseAmp: 1, morphs: false },
    d: { f: [355, 3160, 1605], breathy: true, burst: true, amp: 0.55, voiced: true, short: true, noiseAmp: .15, morphs: false },
    k: { f: [1150, 1950, 3150], burst: true, short: true, voiced: false, noiseAmp: 1 },
    g: { f: [850, 1650, 2650], breathy: true, burst: true, voiced: true, short: true, noiseAmp: 0.3, morphs: false },

    // nasals: flagged nasal: true
    n: { f: [250, 1250, 2450], voiced: true, nasal: true, noiseAmp: 1 },
    m: { f: [200, 1050, 2050], voiced: true, nasal: true, noiseAmp: 1 },
    b: { f: [305, 1100, 2050], breathy: true, burst: true, voiced: true, short: true, noiseAmp: 0.25, morphs: false },
    p: { f: [950, 1750, 2650], burst: true, short: true, voiced: false, noiseAmp: 1 },
    f: { f: [1150, 2950, 4950], breathy: true, voiced: false, noiseAmp: 1 },
    v: { f: [255, 2100, 3255], breathy: true, voiced: true, noiseAmp: 0.125, amp: 0.575 },
    th: { f: [1150, 2150, 3450], breathy: true, voiced: false, noiseAmp: 1 },
    sh: { f: [2450, 3050, 3950], breathy: true, voiced: false, noiseAmp: 1 },
    ch: { f: [1950, 2950, 4450], breathy: true, burst: true, voiced: false, noiseAmp: 1 },
    uh: { f: [640, 945, 2550], voiced: true },

    // added phones / fallbacks
    er: { f: [550, 1200, 2450], morphTo: [450, 1300, 1700], voiced: true },
    j: { f: [450, 1550, 2550], voiced: true },
    ng: { f: [200, 850, 1950], voiced: true, nasal: true },
    oy: { f: [600, 850, 2550], morphTo: [350, 2200, 2900], voiced: true },
    ow: { f: [600, 1000, 2600], morphTo: [400, 1000, 2600], voiced: true },
    ou: { f: [400, 1000, 2600], morphTo: [325, 700, 2530], voiced: true },
    ay: { f: [650, 1250, 2550], morphTo: [350, 2200, 2900], voiced: true },
    aw: { f: [650, 1250, 2550], morphTo: [400, 1000, 2600], voiced: true },
    ew: { f: [300, 2000, 2800], morphTo: [325, 700, 2530], voiced: true },
    ey: { f: [500, 2300, 3000], morphTo: [300, 2000, 2800], voiced: true },
    uw: { f: [325, 700, 2530], morphTo: [325, 700, 2530], voiced: true },
    iw: { f: [300, 2000, 2800], morphTo: [325, 700, 2530], voiced: true },
    il: { f: [300, 2000, 2800], morphTo: [500, 820, 2400], voiced: true },
    rest: { f: [0, 0, 0], voiced: false, burst: false, short: false, breathy: false }
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
    "HH":["h"],"JH":["j"],"K":["k"],"L":["l"],"M":["m"],"N":["n"],
    "NG":["ng"],"P":["p"],"R":["r"],"S":["s"],"SH":["sh"],"T":["t"],
    "TH":["th"],"V":["v"],"W":["w"],"Y":["y"],"Z":["z"],"ZH":["z"]
  };

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
      ["ph", ["f"]], ["ng", ["ng"]], ["qu", ["k","w"]], ["wh", ["w"]],
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
  // phon <NOTE,duration>
  // phon <NOTE,duration,vibFreqHz,vibDelayBeats,vibFadeInBeats,vibSpeedBeats>
  // [settings] phon <NOTE,duration>  (brackets optional, applied to this phoneme only)
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
    const re = /\b(fs|vd|vf|vde|vfa|vfao)\s*:\s*([\d.]+)\b/gi;
    let m;
    while ((m = re.exec(s)) !== null) out[m[1].toLowerCase()] = parseFloat(m[2]);
    return out;
  };
  // Apply per-phoneme vibrato overrides from [settings] brackets and <...> extra
  // fields. Only fields that are explicitly provided are stored on the phoneme;
  // anything else falls back to the global vibrato settings at synthesis time.
  const applyPerNoteVibrato = (p, bracket, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats) => {
    if (vibFreqHz !== null && Number.isFinite(vibFreqHz)) p.vibFreq = vibFreqHz;
    if (vibSpeedBeats !== null && Number.isFinite(vibSpeedBeats)) p.vibFreq = vibSpeedBeats;
    if (vibDelayBeats !== null && Number.isFinite(vibDelayBeats)) p.vibDelay = vibDelayBeats * beatLen;
    if (vibFadeInBeats !== null && Number.isFinite(vibFadeInBeats)) p.vibFadeIn = vibFadeInBeats * beatLen;
    if (bracket.fs) {
      p.f = p.f.map(x => x * bracket.fs);
      if (p.morphTo) p.morphTo = p.morphTo.map(x => x * bracket.fs);
    }
    if (bracket.vf !== undefined) p.vibFreq = bracket.vf;
    if (bracket.vd !== undefined) p.vibDepth = bracket.vd;
    if (bracket.vde !== undefined) p.vibDelay = bracket.vde;
    if (bracket.vfa !== undefined) p.vibFadeIn = bracket.vfa;
    if (bracket.vfao !== undefined) p.vibFadeOut = bracket.vfao;
  };

    const regex = /(\[[^\]]*\])?\s*([a-zA-Z']+)\s*<\s*([\w#b]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?(?:\s*,\s*([\d.]+))?(?:\s*,\s*([\d.]+))?(?:\s*,\s*([\d.]+))?\s*>/gi;
    const result = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const bracket = parseBracketSettings(match[1] || "");
      const tokenRaw = match[2];
      const token = tokenRaw.toLowerCase();
      const pitchRaw = match[3];
      const units = parseFloat(match[4]);

      // Optional per-phoneme vibrato fields (beats-based):
      // match[5]=vibFreqHz, match[6]=vibDelayBeats, match[7]=vibFadeInBeats, match[8]=vibSpeedBeats
      const vibFreqHz = match[5] != null ? parseFloat(match[5]) : null;
      const vibDelayBeats = match[6] != null ? parseFloat(match[6]) : null;
      const vibFadeInBeats = match[7] != null ? parseFloat(match[7]) : null;
      const vibSpeedBeats = match[8] != null ? parseFloat(match[8]) : null;

      // compute duration from units based on grid type
      let dur = 0;
      if (gridType === "beats") dur = units * beatLen;
      else if (gridType === "steps") dur = (units / stepsPerBeat) * beatLen;
      else if (gridType === "seconds") dur = units;
      else dur = units * beatLen;

      // exact phoneme key match
      if (phonemeMap[token]) {
        let p = { key: token, ...phonemeMap[token], d: dur, pitch: noteToFreq(pitchRaw) };
        p.f = getAdjustedFormants(p.f);
        if (p.morphTo) p.morphTo = getAdjustedFormants(p.morphTo);

        applyPerNoteVibrato(p, bracket, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats);

        result.push(p);
        continue;
      }

      // otherwise treat token as a word and convert to phoneme keys
      const parts = await textToPhonemes(tokenRaw);
      if (!parts || parts.length === 0) continue;
      const partDur = dur / Math.max(1, parts.length);
      for (const part of parts) {
        const key = part.toLowerCase();
        if (phonemeMap[key]) {
          let p = { key, ...phonemeMap[key], d: partDur, pitch: noteToFreq(pitchRaw) };
          p.f = getAdjustedFormants(p.f);
          if (p.morphTo) p.morphTo = getAdjustedFormants(p.morphTo);

          applyPerNoteVibrato(p, bracket, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats);

          result.push(p);
        } else {
          const fallbackMap = {
            a: "a", e: "e", i: "i", o: "o", u: "u",
            h: "h", n: "n", m: "m", s: "s", t: "t", d: "d", r: "r", l: "l",
            b: "b", p: "p", k: "k", g: "g", f: "f", v: "v", y: "y", j: "j",
            ng: "ng", er: "er", oy: "oy", aw: "aw"
          };
          const fm = (fallbackMap[key] || "rest");
          let p = { key: fm, ...phonemeMap[fm], d: partDur, pitch: noteToFreq(pitchRaw) };
          p.f = getAdjustedFormants(p.f);
          if (p.morphTo) p.morphTo = getAdjustedFormants(p.morphTo);

          applyPerNoteVibrato(p, bracket, beatLen, vibFreqHz, vibDelayBeats, vibFadeInBeats, vibSpeedBeats);

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
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * amp;
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
      data[i] = pink * amp;
    }
    return buffer;
  };

  // Kept for back-compat, but now defaults to WHITE (unvoiced).
  const createWhisperNoiseBuffer = (ctx, duration, amp = 0.09) => createWhiteNoiseBuffer(ctx, duration, amp);

  // Pick noise type by phonation.
  // voiced fricatives/aspiration => pink
  // unvoiced fricatives/bursts => white
  const createFricativeNoiseBuffer = (ctx, duration, { voiced = false, amp = 0.0 } = {}) => {
    return voiced ? createPinkNoiseBuffer(ctx, duration, amp) : createWhiteNoiseBuffer(ctx, duration, amp);
  };

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
  const createRosenbergGlottalWave = (ctx, numHarmonics = 27, openQuotient = 0.55, returnQuotient = 0.2) => {
    const N = 1024; // samples per period for the numeric pulse
    const u = new Float64Array(N);

    // Clamp open quotient to a sane vocal range and keep the return phase from
    // overlapping the next period.
    const OQ = Math.min(0.95, Math.max(0.1, openQuotient));
    const RQ = Math.min(0.4, Math.max(0.02, returnQuotient));
    const Topen = Math.max(1, Math.round(N * OQ));
    const Tret = Math.max(1, Math.round(N * Math.min(RQ, 1 - OQ)));
    const Tclose = N - Topen - Tret;

    // 1) Build one period of the glottal flow.
    for (let n = 0; n < Topen; n++) {
      const x = n / Math.max(1, Topen - 1);
      u[n] = 3 * x * x - 2 * x * x * x; // Rosenberg open phase: 0 -> 1
    }
    for (let n = 0; n < Tret; n++) {
      const a = n / Math.max(1, Tret - 1); // 0..1 across the return phase
      u[Topen + n] = Math.exp(-6 * a);      // fast exponential return to ~0.25%
    }
    // Closed phase is zero by default (u array initialized to 0).

    // 2) Glottal flow derivative via backward difference.
    const d = new Float64Array(N);
    let maxAbs = 0;
    for (let n = 1; n < N; n++) {
      d[n] = u[n] - u[n - 1];
      if (Math.abs(d[n]) > maxAbs) maxAbs = Math.abs(d[n]);
    }
    d[0] = d[N - 1]; // wrap for periodicity
    if (maxAbs > 0) for (let n = 0; n < N; n++) d[n] /= maxAbs;

    // 3) DFT to harmonic real/imag coefficients (amplitude roughly ~1/n roll-off
    //    for the derivative, but with the correct phase relationships of a real
    //    glottal pulse).
    const nH = Math.max(1, numHarmonics | 0);
    const real = new Float32Array(nH);
    const imag = new Float32Array(nH);
    const scale = 2 / N;
    for (let k = 1; k < nH; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const ph = 2 * Math.PI * k * n / N;
        re += d[n] * Math.cos(ph);
        im += d[n] * Math.sin(ph);
      }
      real[k] = re * scale;
      imag[k] = im * scale;
    }

    // Normalize against the fundamental so output level is consistent regardless
    // of open quotient, then strip DC.
    const f0mag = Math.hypot(real[1], imag[1]) || 1;
    for (let k = 1; k < nH; k++) {
      real[k] /= f0mag;
      imag[k] /= f0mag;
    }
    real[0] = 0;
    imag[0] = 0;

    return ctx.createPeriodicWave(real, imag);
  };



  // synthesize with nasal-aware transitions and humanizing features
  const synthesize = async (ctx, phonemeSeq, mode, vibFreq, vibDepth, vibDelay, morphTime = 0.05, morphEnabled = true, slideTime = 0.08, persistentVib = true, dynamicMode = false, consonantDuration = 0.1) => {
    // Preprocess phonemeSeq for humanizing features
    const processedSeq = [];
    for (let i = 0; i < phonemeSeq.length; i++) {
      const p = phonemeSeq[i];
      const prev = processedSeq.length > 0 ? processedSeq[processedSeq.length - 1] : null;
      const hasPrevVoiced = prev && prev.voiced;

      // Feature 3: If b or p and no previous voiced, prepend m
      if ((p.key === 'b' || p.key === 'p') && !hasPrevVoiced) {
        // Prepend a brief m, but keep it quieter to avoid loud noise bursts.
        // 40% quieter than normal m -> amp scale 0.6
        const mDur = Math.min(0.05, p.d * 0.1); // short m
        const mPhoneme = { key: 'm', ...phonemeMap['m'], d: mDur, pitch: p.pitch, amp: (phonemeMap['m'].amp ?? 1) * 0.6 };
        processedSeq.push(mPhoneme);
        p.d -= mDur; // trim p/b duration
      }



      // Feature 2: If t,b,p,k after s or z, add silence delay
      if ((p.key === 't' || p.key === 'b' || p.key === 'p' || p.key === 'k') && prev && (prev.key === 's' || prev.key === 'z')) {
        const silenceDur = Math.min(0.02, prev.d * 0.1); // slight silence
        prev.d -= silenceDur; // trim s/z
        p.d -= silenceDur; // trim consonant
        // silence is implicit by delaying start
      }

      // Dynamic mode: set consonant duration and extend next phoneme to preserve total duration
      if (dynamicMode && !p.voiced && i + 1 < phonemeSeq.length) {
        const originalD = p.d;
        if (originalD > consonantDuration) {
          p.d = consonantDuration;
          const extend = originalD - consonantDuration;
          phonemeSeq[i + 1].d += extend;
        }
      }

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
    for (let i = 0; i < numFormants; i++) {
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.Q.value = 15;
      f.frequency.value = 0;
      const g = ctx.createGain();
      g.gain.value = 1; // normal full vowel energy
      f.connect(g);
      g.connect(master);
      voiceFilters.push(f);
      voiceGains.push(g);
    }

    // Feature 4: Sine wave for bass/timbre backing the pulse train, affected by formant filters
    const bassOsc = ctx.createOscillator();
    bassOsc.type = "sine";
    const bassGain = ctx.createGain();
    bassGain.gain.value = 0.1; // subtle bass
    // Route bass through formant filters for integration
    for (let idx = 0; idx < numFormants; idx++) {
      bassGain.connect(voiceFilters[idx]);
    }
    // Will set frequency and start/stop later

    // shared noise filters for breathy vowel/noise path
    const sharedNoiseFilters = [];
    for (let i = 0; i < numFormants; i++) {
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.Q.value = 15;
      f.frequency.value = 0;
      f.connect(master);
      sharedNoiseFilters.push(f);
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
      lfoGain.gain.value = vibDepth; // Hz depth
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
          const cur = getFreqAt(param, t);
          param.setValueAtTime(cur != null ? cur : onset, t);
          param.linearRampToValueAtTime(onset, tOnset);
        }
        param.setValueAtTime(onset, tOnset);
      } catch (e) {}
    };
    // Ramp onset -> target across [tOnset, endTime] (used by hasMorphTo).
    const rampFreq = (param, t, isRunStart, onset, target, endTime) => {
      try {
        anchorStart(param, t, isRunStart, onset);
        param.linearRampToValueAtTime(target, endTime);
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
      src.buffer = createFricativeNoiseBuffer(ctx, dur + 0.02, { voiced: true, amp: 0.1 });

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
      const playConsonantNoise = (t, d, fArr, amp = 1, noiseAmp = 1) => {
      if (d <= 0 || !fArr || fArr.length === 0) return;
      const src = ctx.createBufferSource();
        // unvoiced fricatives/bursts => WHITE
      // quiet base so voice dominates (fixes nasal artifact audibility)
      // amp param is used only for envelope peak.
      src.buffer = createFricativeNoiseBuffer(ctx, d, { voiced: false, amp: 0.08 * noiseAmp });


      const consonantGain = ctx.createGain();
      consonantGain.gain.setValueAtTime(0, t);
      consonantGain.gain.linearRampToValueAtTime(amp * noiseAmp, t + 0.01); // subtle fade-in over 0.01s
      const consonantFilters = fArr.map(freq => {
        const bf = ctx.createBiquadFilter();
        bf.type = "bandpass";
        bf.Q.value = 20;
        bf.frequency.value = freq || 0;
        bf.connect(master);
        return bf;
      });
      src.connect(consonantGain);
      for (const bf of consonantFilters) consonantGain.connect(bf);
      src.start(t);
      src.stop(t + d + 0.005);
    };


    // main play routine
    const play = (t, d, f, opt = {}, nextVoiced = null, immediateNext = null) => {
      const { breathy = false, amp = 0.9, burst = false, voiced = true, pitch = 220, short = false } = opt;
      if (d <= 0) return;

      // If current phoneme is consonant/unvoiced or purely breathy/burst -> produce consonant-filtered noise
      if (opt.breathy || opt.burst) {
        playConsonantNoise(t, d, f, amp, opt.noiseAmp ?? 1);
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
      const hasMorphTo = morphEnabled && opt.morphTo && opt.morphTo.length === numFormants;

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
      } else {
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
      const vibFadeInForNoteSec = Number.isFinite(opt.vibFadeIn) ? opt.vibFadeIn : 0;
      const vibSpeedForNote = Number.isFinite(opt.vibSpeed) ? opt.vibSpeed : null;

      const vibForThis = (vibFreqForNote > 0 && vibDepth > 0 && mode !== "whisper");
      if (vibForThis && lfoGain && persistentVib) {
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

      // slide: only when immediate next (direct next) is voiced and slideTime > 0
      const canSlide = slideTime > 0 && immediateNext && immediateNext.voiced && immediateNext.pitch && voiced;
      if (canSlide) {
        const rampStart = Math.max(t, t + d - slideTime);
        pitchParam.setValueAtTime(pitch, t);
        pitchParam.setValueAtTime(pitch, rampStart);
        pitchParam.linearRampToValueAtTime(immediateNext.pitch, t + d);
      } else {
        pitchParam.setValueAtTime(pitch, t);
      }

      // route oscillator through per-formant filters/gains
      const oscGain = ctx.createGain();
      const fadeTime = 0.01;
      oscGain.gain.setValueAtTime(0, t);
      oscGain.gain.linearRampToValueAtTime(0.89 * amp, t + fadeTime);
      oscGain.gain.setValueAtTime(0.89 * amp, t + d - fadeTime);
      oscGain.gain.linearRampToValueAtTime(0, t + d);
      for (let idx = 0; idx < numFormants; idx++) {
        osc.connect(oscGain).connect(voiceFilters[idx]);
      }

// If breathy component, route a noise source via sharedNoiseFilters as well
      if (opt.breathy) {
        const noiseSrc = ctx.createBufferSource();
        // voiced-ish breathy component/aspiration => PINK
        const breathyNoiseAmp = (opt.noiseAmp ?? 1);
        noiseSrc.buffer = createFricativeNoiseBuffer(ctx, d, { voiced: true, amp: 0.05 * breathyNoiseAmp });
        for (const nf of sharedNoiseFilters) noiseSrc.connect(nf);
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
    // Tracks whether the global persistent LFO is currently connected to the
    // active oscillator's frequency param, so we can connect/disconnect it per
    // note (needed for per-phoneme bracket vibrato overrides and [vf:0] off).
    let vibConnected = false;

    // schedule phonemes
    let t = 0;
    for (let i = 0; i < processedSeq.length; i++) {
      const p = processedSeq[i];
      const immediateNext = processedSeq[i + 1] || null;
      const nextVoiced = findNextVoiced(i);

      if (p.voiced && mode !== "whisper") {
        const isRunStart = !currentOsc;
        if (!currentOsc) {
          // start new oscillator for voiced sequence
          currentOsc = ctx.createOscillator();
          const numHarmonics = 27;
          const real = new Float32Array(numHarmonics);
          const imag = new Float32Array(numHarmonics);
          for (let n = 1; n < numHarmonics; n++) {
            real[n] = 1 / (n * n);
          }
          const glottalWave = ctx.createPeriodicWave(real, imag);
          currentOsc.setPeriodicWave(glottalWave);

          oscGain = ctx.createGain();
          const fadeTime = 0.01;
          const amp = isNaN(p.amp) ? 1 : p.amp;
          oscGain.gain.setValueAtTime(0, t);
          oscGain.gain.linearRampToValueAtTime(0.89 * amp, t + fadeTime);
          currentAmp = amp;
          for (let idx = 0; idx < numFormants; idx++) {
            currentOsc.connect(oscGain).connect(voiceFilters[idx]);
          }
          currentOsc.start(t);
        }

        // schedule pitch
        const pitchParam = currentOsc.frequency;
        pitchParam.setValueAtTime(p.pitch, t);

        // vibrato — per-phoneme aware: uses p.vib* fields from bracket overrides,
        // falls back to global parameters. Handles persistent LFO connect/disconnect
        // via vibConnected tracker.
        const vibFreqForNote = Number.isFinite(p.vibFreq) ? p.vibFreq : vibFreq;
        const vibDepthForNote = Number.isFinite(p.vibDepth) ? p.vibDepth : vibDepth;
        const vibDelayForNoteSec = Number.isFinite(p.vibDelay) ? p.vibDelay : vibDelay;
        const vibFadeInForNoteSec = Number.isFinite(p.vibFadeIn) ? p.vibFadeIn : 0;
        const vibFadeOutForNoteSec = Number.isFinite(p.vibFadeOut) ? p.vibFadeOut : 0;
        const vibSpeedForNote = Number.isFinite(p.vibSpeed) ? p.vibSpeed : null;

        // Determine if vibrato should be active for this note (requires freq>0, depth>0, not whisper)
        const vibeOnForThis = (vibFreqForNote > 0 && vibDepthForNote > 0 && mode !== "whisper");

        if (vibeOnForThis && lfoGain && persistentVib) {
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
        if (vibeOnForThis && !(lfoGain && persistentVib)) {
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

        // slide
        const canSlide = slideTime > 0 && immediateNext && immediateNext.voiced && immediateNext.pitch && p.voiced;
        if (canSlide) {
          const rampStart = Math.max(t, t + p.d - slideTime);
          pitchParam.setValueAtTime(p.pitch, t);
          pitchParam.setValueAtTime(p.pitch, rampStart);
          pitchParam.linearRampToValueAtTime(immediateNext.pitch, t + p.d);
        } else {
          pitchParam.setValueAtTime(p.pitch, t);
        }

        // update lastVoicedEnd
        lastVoicedEnd = t + p.d;

        // morphing logic
        // morphTo: ramp formants from p.f -> p.morphTo across the FULL phoneme duration
        // (bypasses morphTime). This provides diphthong-style transitions like "ew".
        const hasMorphTo = morphEnabled && p.morphTo && p.morphTo.length === numFormants;
        const hasVoicedTarget = morphEnabled && morphTime > 0 && nextVoiced && nextVoiced.voiced && nextVoiced.morphs !== false;
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
        } else {
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
          noiseSrc.buffer = createFricativeNoiseBuffer(ctx, p.d, { voiced: true, amp: 0.05 * breathyNoiseAmp });
          for (const nf of sharedNoiseFilters) noiseSrc.connect(nf);
          noiseSrc.start(t);
          noiseSrc.stop(t + p.d + 0.005);
        }


      } else {
        // non-voiced or whisper
        if (currentOsc) {
          // stop the oscillator with fade-out
          const fadeTime = 0.01;
          oscGain.gain.setValueAtTime(0.89 * currentAmp, lastVoicedEnd - fadeTime);
          oscGain.gain.linearRampToValueAtTime(0, lastVoicedEnd);
          currentOsc.stop(lastVoicedEnd);
          currentOsc = null;
          oscGain = null;
        }

        // play consonant noise
        if (!p.voiced || mode === "whisper") {
          playConsonantNoise(t, p.d, p.f, p.amp, p.noiseAmp ?? 1);
        }
      }

      t += p.d;
    }

    // stop any remaining oscillator
    if (currentOsc) {
      const fadeTime = 0.01;
      oscGain.gain.setValueAtTime(1 * currentAmp, lastVoicedEnd - fadeTime);
      oscGain.gain.linearRampToValueAtTime(0, lastVoicedEnd);
      currentOsc.stop(lastVoicedEnd);
    }

    master.connect(ctx.destination);
    return await ctx.startRendering();
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
    <h3 style="margin:0 0 8px 0">HOSTERS FR SYNTHESIZER</h3>
    <div style="font-size:12px;margin-bottom:8px">HOSTERS VERY HUMAN SYNTHESIZER</div>
    <label style="display:block">Melody / Text:<br/>
      <textarea id="phonemeInput" rows="4" style="width:100%;font-family:monospace;">d<c2,0.1> o<c2,0.9> r<d2,0.1> e<d2,0.9> m<e2,0.1> i<e2,0.9> f<f2,0.1> a<f2,0.9> s<g2,0.1> o<g2,0.9> l<a2,0.1> a<a2,0.9> t<b2,0.1> i<b2,0.9> d<c3,0.1> o<c3,0.9></textarea>
    </label>
    <div style="margin-top:6px">
      <label>Voice mode:
        <select id="voiceMode"><option value="voiced" selected>Voiced</option><option value="whisper">Whisper</option></select>
      </label>
      <label style="margin-left:8px">BPM: <input type="number" id="bpm" value="120" style="width:80px"/></label>
      <label style="margin-left:8px">Grid:
        <select id="gridType"><option value="beats" selected>Beats</option><option value="steps">Steps</option><option value="seconds">Seconds</option></select>
      </label>
      <label id="stepsPerBeatLabel" style="margin-left:8px">Steps/Beat: <input type="number" id="stepsPerBeat" value="4" min="1" style="width:60px"/></label>
    </div>
    <div style="margin-top:6px">
      <label>Vibrato Freq (Hz): <input type="number" id="vibFreq" value="6" step="0.1" style="width:80px"/></label>
      <label style="margin-left:8px">Depth (Hz): <input type="number" id="vibDepth" value="5" step="0.1" style="width:80px"/></label>
      <label style="margin-left:8px">Delay (s): <input type="number" id="vibDelay" value="0.1" step="0.01" style="width:80px"/></label>
      <label style="margin-left:8px"><input type="checkbox" id="persistentVib" checked/> Persistent Vibrato</label>
    </div>
    <div style="margin-top:6px">
      <label>Formant Morph time (s): <input type="number" id="morphTime" value="0.06" step="0.01" style="width:80px"/></label>
      <label style="margin-left:8px"><input type="checkbox" id="enableMorph" checked/> Enable Morph</label>
      <label style="margin-left:8px">Slide time (s): <input type="number" id="slideTime" value="0.08" step="0.01" style="width:80px"/></label>
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
      <label>Gender Shift: <input type="range" id="genderShift" min="-100" max="100" value="0" style="width:200px"/></label>
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
          <button id="pianoRollRefreshBtn" style="margin-left:6px; padding:2px 6px; font-size:11px;">Refresh from text</button>
        </div>
      </div>
      <div id="pianoRollContainer" style="position:relative; border:1px solid #999; overflow:auto; width:100%; height:350px; background:#f8f8f8;">
        <canvas id="pianoRollCanvas" style="display:block;"></canvas>
      </div>
      <div style="font-size:11px; margin-top:4px; color:#555;">
        Click grid to add note | Drag note to move | Drag edges to resize | Delete key removes selected | Double-click to edit phoneme
      </div>
    </div>
  `;
  document.body.appendChild(container);

  const gridTypeEl = container.querySelector("#gridType");
  const stepsLabel = container.querySelector("#stepsPerBeatLabel");
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
    const restPitch = "C4";

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
        tokens.push(`rest <${restPitch},${fmtDur(durToken)}> `);
      } else {

        const noteName = midiNoteNumberToName(seg.noteNumber);
        const durToken = midiDurationUnitsToToken(durSec, gridType, 60 / bpm, stepsPerBeat);
        // phoneme is always 'a'
        tokens.push(`a <${noteName},${fmtDur(durToken)}>`);
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
      // Token format: <phonemeKey> <pitchName,tokenDuration>
      const existingTokens = (phonemeInputEl.value || "").split(/\s+/).filter(Boolean);
      const midiTokens = midiText.split(/\s+/).filter(Boolean);

      const parseToken = (tok) => {
        // e.g. "a <G4,0.4>" or "rest <C4,1>"
        const m = tok.match(/^([a-zA-Z']+)\s*<\s*([^,>\s]+)\s*,\s*([^>\s]+)\s*>$/);
        if (!m) return null;
        return { key: m[1], pitch: m[2], dur: m[3] };
      };

      const midiParsed = midiTokens.map(parseToken).filter(Boolean);
      let midiIdx = 0;

      const outTokens = [];
      for (const tok of existingTokens) {
        const p = parseToken(tok);
        if (!p) continue;

        const mp = midiParsed[midiIdx];
        // If we ran out of MIDI tokens, keep remaining original tokens.
        if (!mp) {
          outTokens.push(tok);
          continue;
        }

        // Only replace pitches/durations for tokens that actually look like phoneme+pitch.
        outTokens.push(`${p.key} <${mp.pitch},${mp.dur}>`);
        midiIdx++;
      }

      phonemeInputEl.value = outTokens.join(" ");
      statusEl.textContent = "MIDI pitches replaced (phonemes preserved). Ready to synthesize.";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "MIDI import failed: " + (err.message || err);
    }
  };

  synthBtn.onclick = async () => {
    stopPreview();
    outputControls.innerHTML = ""; statusEl.textContent = "Parsing...";
    try {
      const text = container.querySelector("#phonemeInput").value;
      const mode = container.querySelector("#voiceMode").value;
      const bpm = parseFloat(container.querySelector("#bpm").value) || 120;
      const beatLen = 60 / bpm;
      const gridType = container.querySelector("#gridType").value || "beats";
      const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
      const vibratoFreq = parseFloat(container.querySelector("#vibFreq").value) || 0;
      const vibratoDepth = parseFloat(container.querySelector("#vibDepth").value) || 0;
      const vibratoDelay = parseFloat(container.querySelector("#vibDelay").value) || 0;
      const persistentVib = !!container.querySelector("#persistentVib").checked;
      const morphTime = Math.max(0, parseFloat(container.querySelector("#morphTime").value) || 0.06);
      const enableMorph = !!container.querySelector("#enableMorph").checked;
      const slideTime = Math.max(0, parseFloat(container.querySelector("#slideTime").value) || 0.08);

      const phonemeSeq = await parseInput(text, beatLen, gridType, stepsPerBeat);
      if (!phonemeSeq || phonemeSeq.length === 0) { statusEl.textContent = "Parsed no phonemes â€” check input."; return; }

      const totalDuration = phonemeSeq.reduce((a,p) => a + p.d, 0);
      statusEl.textContent = `Rendering ${totalDuration.toFixed(2)}s...`;
      const offlineCtx = new OfflineAudioContext(1, Math.ceil(totalDuration * sampleRate) + 128, sampleRate);

      const renderedBuffer = await synthesize(offlineCtx, phonemeSeq, mode, vibratoFreq, vibratoDepth, vibratoDelay, morphTime, enableMorph, slideTime, persistentVib, dynamicMode, consonantDuration);
      statusEl.textContent = "Done";

      // WAV creation & preview
      const audioDataRaw = renderedBuffer.getChannelData(0);

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
      playBtn.onclick = () => {
        stopPreview();
        actx = new (window.AudioContext || window.webkitAudioContext)();
        prevSrc = actx.createBufferSource();
        // Preview should match the downloaded WAV (normalized if enabled).
        previewBuf = actx.createBuffer(1, audioData.length, sampleRate);
        previewBuf.getChannelData(0).set(audioData);
        prevSrc.buffer = previewBuf;
        prevSrc.onended = () => {
          // natural-end cleanup: free shared preview state so a new preview can start
          prevSrc = null;
          previewBuf = null;
          if (actx) {
            try { actx.close(); } catch (e) {}
            actx = null;
          }
        };
        prevSrc.connect(actx.destination);
        prevSrc.start();
      };

      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Stop Preview"; stopBtn.style = "margin-top:8px;padding:6px 12px;";
      stopBtn.onclick = () => {
        stopPreview();
      };

      outputControls.appendChild(playBtn);
      outputControls.appendChild(stopBtn);

    } catch (err) {
      console.error(err);
      statusEl.textContent = "Error: " + (err.message || err);
    }
  };

  // ======== PIANO ROLL IMPLEMENTATION ========
  const pianoRollContainer = container.querySelector("#pianoRollContainer");
  const pianoRollCanvas = container.querySelector("#pianoRollCanvas");
  const ctx = pianoRollCanvas.getContext("2d");
  const pianoRollRefreshBtn = container.querySelector("#pianoRollRefreshBtn");
  const pianoRollSnap = container.querySelector("#pianoRollSnap");

  // Piano roll constants
  const KEYBOARD_WIDTH = 50;
  const NOTE_HEIGHT = 14;
  const PIXELS_PER_BEAT = 120;
  const MIN_NOTE_DURATION_PX = 8;
  const NOTE_RADIUS = 4;

  // Note names for display (C0-based for internal, but we show C2-C6)
  const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  // Piano roll state
  let pianoRollNotes = []; // { phoneme, pitchName, midiNote, startBeat, durBeats, startPx, durPx }
  let selectedNoteIndex = -1;
  let dragState = null; // { type: 'move'|'resizeLeft'|'resizeRight', noteIdx, startX, startY, origStartBeat, origDurBeats, origPitch }
  let hoveredEdge = null; // { noteIdx, side: 'left'|'right' }

  // Parse the text input and build piano roll notes
  function parsePianoRollFromText(text, bpm, gridType, stepsPerBeat) {
    const beatLen = 60 / bpm;
    const regex = /([a-zA-Z']+)\s*<\s*([\w#b]+)\s*,\s*([\d.]+)/gi;
    const notes = [];
    let match;
    let startBeat = 0;
    while ((match = regex.exec(text)) !== null) {
      const phoneme = match[1].toLowerCase();
      const pitchRaw = match[2];
      const units = parseFloat(match[3]);

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
          durBeats
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

  function drawPianoRoll() {
    const text = container.querySelector("#phonemeInput").value;
    const bpm = parseFloat(container.querySelector("#bpm").value) || 120;
    const gridType = container.querySelector("#gridType").value || "beats";
    const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
    const beatLen = 60 / bpm;

    pianoRollNotes = parsePianoRollFromText(text, bpm, gridType, stepsPerBeat);
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
    const snapResolution = gridType === "steps" ? 1.0 / stepsPerBeat : 1.0;
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

    // Draw notes
    for (let idx = 0; idx < pianoRollNotes.length; idx++) {
      const note = pianoRollNotes[idx];
      const keyIndex = range.max - note.midiNote;
      const x = KEYBOARD_WIDTH + note.startBeat * PIXELS_PER_BEAT;
      const y = keyIndex * NOTE_HEIGHT + 5;
      const w = Math.max(MIN_NOTE_DURATION_PX, note.durBeats * PIXELS_PER_BEAT);
      const h = NOTE_HEIGHT - 2;

      // Store pixel positions for hit-testing
      note.startPx = x;
      note.durPx = w;

      const isSelected = idx === selectedNoteIndex;

      // Note color based on phoneme type
      const phonType = getPhonemeType(note.phoneme);
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

      // Phoneme label
      c.fillStyle = "#fff";
      c.font = "10px monospace";
      c.fillText(note.phoneme, x + 4, y + 10);
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
  }

  // Get phoneme type for coloring
  function getPhonemeType(phon) {
    const vowels = ["a","aa","e","i","ee","I","o","u","y","w","r","l","uh","er","oy","aw","ew"];
    const nasals = ["m","n","ng"];
    if (vowels.includes(phon)) return "vowel";
    if (nasals.includes(phon)) return "nasal";
    return "consonant";
  }

  // Update text input from piano roll notes
  function updateTextFromPianoRoll() {
    const gridType = container.querySelector("#gridType").value || "beats";
    const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
    const bpm = parseFloat(container.querySelector("#bpm").value) || 120;
    const beatLen = 60 / bpm;

    let tokens = [];
    let prevEndBeat = 0;
    for (const note of pianoRollNotes) {
      // Add rest if gap
      if (note.startBeat > prevEndBeat + 0.01) {
        const gap = note.startBeat - prevEndBeat;
        let gapUnits = gap;
        if (gridType === "steps") gapUnits = gap * stepsPerBeat;
        tokens.push(`rest <C4,${gapUnits.toFixed(3)}>`);
      }

      let units = note.durBeats;
      if (gridType === "steps") units = note.durBeats * stepsPerBeat;
      tokens.push(`${note.phoneme} <${note.pitchName},${units.toFixed(3)}>`);
      prevEndBeat = note.startBeat + note.durBeats;
    }

    container.querySelector("#phonemeInput").value = tokens.join(" ");
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
    const snapResolution = gridType === "steps" ? 1.0 / stepsPerBeat : 0.25;

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
    const rect = pianoRollCanvas.getBoundingClientRect();
    const scaleX = pianoRollCanvas.width / rect.width;
    const scaleY = pianoRollCanvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const hit = hitTestNotes(mouseX, mouseY);
    if (hit) {
      selectedNoteIndex = hit.noteIdx;
      const note = pianoRollNotes[hit.noteIdx];
      dragState = {
        type: hit.action,
        noteIdx: hit.noteIdx,
        startX: mouseX,
        startY: mouseY,
        origStartBeat: note.startBeat,
        origDurBeats: note.durBeats,
        origMidi: note.midiNote
      };
      drawPianoRoll();
      return;
    }

    // Click on empty space: add a new note
    selectedNoteIndex = -1;
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
      updateTextFromPianoRoll();
      drawPianoRoll();
    }
  });

  pianoRollCanvas.addEventListener("mousemove", (e) => {
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

    // Drag handling
    if (dragState) {
      const note = pianoRollNotes[dragState.noteIdx];
      if (!note) return;

      const dxBeats = (mouseX - dragState.startX) / PIXELS_PER_BEAT;
      const gridType = container.querySelector("#gridType").value || "beats";
      const stepsPerBeat = Math.max(1, parseInt(container.querySelector("#stepsPerBeat").value) || 4);
      const snapResolution = gridType === "steps" ? 1.0 / stepsPerBeat : 0.25;

      if (dragState.type === "move") {
        let newStart = dragState.origStartBeat + dxBeats;
        if (pianoRollSnap.checked) newStart = snapToGrid(newStart, snapResolution);
        newStart = Math.max(0, newStart);
        note.startBeat = newStart;

        // Change pitch based on vertical drag
        const dyKeys = Math.round((mouseY - dragState.startY) / NOTE_HEIGHT);
        let newMidi = dragState.origMidi - dyKeys;
        newMidi = Math.max(0, Math.min(127, newMidi));
        note.midiNote = newMidi;
        note.pitchName = midiToNoteName(newMidi);
      } else if (dragState.type === "resizeRight") {
        let newDur = dragState.origDurBeats + dxBeats;
        if (pianoRollSnap.checked) newDur = snapToGrid(newDur, snapResolution);
        newDur = Math.max(0.125, newDur);
        note.durBeats = newDur;
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
        note.startBeat = newStart;
        note.durBeats = newDur;
      }

      updateTextFromPianoRoll();
      drawPianoRoll();
    }
  });

  window.addEventListener("mouseup", () => {
    if (dragState) {
      dragState = null;
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

  // Delete key to remove selected note
  document.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      // Only if piano roll is visible and focused
      if (document.activeElement === pianoRollCanvas || document.activeElement === pianoRollContainer) {
        e.preventDefault();
        if (selectedNoteIndex >= 0 && selectedNoteIndex < pianoRollNotes.length) {
          pianoRollNotes.splice(selectedNoteIndex, 1);
          selectedNoteIndex = -1;
          updateTextFromPianoRoll();
          drawPianoRoll();
        }
      }
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

})();
