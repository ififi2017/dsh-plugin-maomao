// A person sends the next bubble after typing it. The pause grows with length,
// stays short enough to feel live, and jitters so bursts do not look scripted.
export function typingPause(text, { min = 350, perChar = 45, max = 2200, random = Math.random } = {}) {
  const base = Math.min(max, min + Array.from(String(text)).length * perChar);
  return Math.round(base * (0.8 + random() * 0.4));
}
