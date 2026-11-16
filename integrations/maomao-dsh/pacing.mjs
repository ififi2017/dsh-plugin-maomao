// A person sends the next bubble after typing it. The pause grows with length,
// stays short enough to feel live, and jitters so bursts do not look scripted.
export function typingPause(text, { min = 350, perChar = 45, max = 2200, random = Math.random } = {}) {
  const base = Math.min(max, min + Array.from(String(text)).length * perChar);
  return Math.round(base * (0.8 + random() * 0.4));
}

// Before joining a group conversation unprompted: read the line, then type the first bubble.
// Usually 3–8 seconds in all; the caller subtracts the time already spent thinking.
export function joinInPause(heard, reply, { random = Math.random } = {}) {
  const reading = Math.min(3000, 600 + Array.from(String(heard ?? '')).length * 40);
  const typing = typingPause(reply, { min: 800, perChar: 140, max: 5000, random });
  return Math.round(reading * (0.8 + random() * 0.4)) + typing;
}
