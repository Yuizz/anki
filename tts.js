// Audio con la Web Speech API.

const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
let voices = [];
let loaded = false;
const listeners = new Set();

const norm = (l) => String(l || '').replace('_', '-').toLowerCase();

function load() {
  if (!supported) return;
  voices = speechSynthesis.getVoices() || [];
  if (voices.length) loaded = true;
  listeners.forEach((fn) => fn());
}

export function initTTS(onChange) {
  if (onChange) listeners.add(onChange);
  if (!supported) {
    loaded = true;
    return;
  }
  load();
  speechSynthesis.addEventListener?.('voiceschanged', load);
  // Algunos navegadores nunca disparan voiceschanged si no hay voces.
  setTimeout(() => {
    loaded = true;
    load();
  }, 1500);
}

export const ttsSupported = () => supported;
export const voicesLoaded = () => loaded;
export const frenchVoices = () => voices.filter((v) => /^fr(-|$)/.test(norm(v.lang)));
export const hasFrenchVoice = () => frenchVoices().length > 0;

export function pickVoice(settings = {}) {
  const fr = frenchVoices();
  if (settings.voiceURI) {
    const v = fr.find((x) => x.voiceURI === settings.voiceURI);
    if (v) return v;
  }
  const lang = norm(settings.voiceLang || 'fr-FR');
  return fr.find((v) => norm(v.lang) === lang) || fr.find((v) => norm(v.lang) === 'fr-fr') || fr[0] || null;
}

export function speak(text, settings = {}) {
  if (!supported || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(settings);
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  } else {
    u.lang = settings.voiceLang || 'fr-FR';
  }
  u.rate = Number(settings.rate) || 1;
  speechSynthesis.speak(u);
}
