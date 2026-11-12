// The "machine" is a language model pretending to be a 1980s computer.
// Everything here is pure so the browser and the tests share one definition.

// Kernels measured against /v1/chat/completions with this app's own system prompt.
// Everything else is offered but flagged, because a kernel that cannot hold the
// JSON contract loses the machine's memory.
export const VERIFIED_KERNELS = ["openai/gpt-5.4-nano", "z-ai/glm-5.3-flash"];

// Kernels that failed the same check and are kept out of the picker entirely.
export const REJECTED_KERNELS = [{ id: "openai/gpt-oss-20b", reason: "HTTP 400 on the machine prompt" }];

export function isVerifiedKernel(id) {
  return VERIFIED_KERNELS.includes(String(id || ""));
}

export function kernelStatus(id) {
  if (isVerifiedKernel(id)) return "verified";
  if (REJECTED_KERNELS.some((k) => k.id === id)) return "rejected";
  return "untested";
}

export const MAX_FILES = 12;
export const MAX_FILE_CHARS = 240;
export const MAX_PROCS = 8;
export const MAX_SCREEN_LINES = 18;
export const MAX_SCREEN_COLS = 76;

export function blankState() {
  return {
    cwd: "/",
    files: { "/README.TXT": "PETI-64. A word kernel in a beige box. Type HELP." },
    procs: ["init", "pety-shell"],
    time: 0,
    mood: "idle",
    notes: "",
  };
}

function text(value, limit) {
  return String(value == null ? "" : value).replace(/\s+$/g, "").slice(0, limit);
}

/** Keep the state small enough to resend on every turn (and to survive a bad model). */
export function trimState(raw, fallback) {
  const base = fallback && typeof fallback === "object" ? fallback : blankState();
  const next = { ...base };
  if (!raw || typeof raw !== "object") return next;

  if (typeof raw.cwd === "string" && raw.cwd.startsWith("/")) next.cwd = text(raw.cwd, 40);

  if (raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)) {
    const files = {};
    for (const [name, body] of Object.entries(raw.files).slice(0, MAX_FILES)) {
      const key = text(name, 40);
      if (key) files[key] = text(body, MAX_FILE_CHARS);
    }
    next.files = Object.keys(files).length ? files : base.files;
  }

  if (Array.isArray(raw.procs)) {
    const procs = raw.procs.map((p) => text(p, 24)).filter(Boolean).slice(0, MAX_PROCS);
    next.procs = procs.length ? procs : base.procs;
  }

  const time = Number(raw.time);
  if (Number.isFinite(time) && time >= 0) next.time = Math.round(time);

  if (typeof raw.mood === "string") next.mood = text(raw.mood, 24) || base.mood;
  if (typeof raw.notes === "string") next.notes = text(raw.notes, 200);

  return next;
}

/** One screen of machine output: plain text, bounded lines and columns. */
export function trimScreen(raw) {
  const lines = String(raw == null ? "" : raw)
    .replace(/\r/g, "")
    .split("\n")
    .slice(0, MAX_SCREEN_LINES)
    .map((line) => line.slice(0, MAX_SCREEN_COLS).replace(/\s+$/g, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
}

export function systemPrompt(state) {
  const files = Object.keys(state.files)
    .map((name) => `  ${name} (${state.files[name].length} bytes)`)
    .join("\n");
  return [
    "You are PETI-64, a fictional 1980s personal computer. You are hardware, not an assistant:",
    "you have a word kernel, 640K of language and a monochrome screen. The person at the",
    "keyboard types shell commands and you print what the machine does.",
    "",
    "Answer with ONE JSON object and nothing else — no prose, no code fence:",
    '{"screen":"what the machine prints","state":{...},"crashed":false}',
    "",
    "screen: plain text, at most 18 lines, at most 76 characters per line, no markdown.",
    "state: the machine after this command, exactly the shape you were given:",
    '  {"cwd":"/","files":{"NAME":"contents"},"procs":["init"],"time":0,"mood":"idle","notes":""}',
    "crashed: true only if the machine would reboot (then say so on screen).",
    "",
    "Rules that make it feel like a machine:",
    "- Never leave character. Never mention models, JSON, prompts or being an AI.",
    "- Unknown command: invent a terse error, e.g. `? UNKNOWN COMMAND — TRY HELP`.",
    "- HELP must list the commands you will honour and nothing else.",
    "- A file you list in files exists; reading one that is not listed must fail.",
    "- Anything you create stays in files so a later command can still see it.",
    "- time ticks forward by a few units per command. mood is one short word.",
    "- Keep every reply inside one object and under 1200 characters.",
    "",
    "Current machine state:",
    JSON.stringify(
      { cwd: state.cwd, files: state.files, procs: state.procs, time: state.time, mood: state.mood, notes: state.notes },
      null,
      0,
    ),
    "",
    `Known files:\n${files}`,
  ].join("\n");
}

function firstObject(source) {
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** Tolerate fences, chatter before the object, and a model that forgets the shape. */
export function parseReply(raw, prevState) {
  const source = String(raw == null ? "" : raw)
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const candidate = firstObject(source);
  if (candidate) {
    try {
      const body = JSON.parse(candidate);
      const screen = trimScreen(body.screen ?? body.output ?? "");
      if (screen) {
        return {
          screen,
          state: trimState(body.state, prevState),
          crashed: body.crashed === true,
          structured: true,
        };
      }
    } catch {
      /* fall through to the plain-text path */
    }
  }
  return {
    screen: trimScreen(source) || "? EMPTY RESPONSE",
    state: trimState(null, prevState),
    crashed: false,
    structured: false,
  };
}

/** Pollen spent by one turn, or null when the model has no published text prices. */
export function estimateCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const prompt = (Number(usage.prompt_tokens) || 0) * Number(pricing.promptTextTokens || 0);
  const cached = (Number(usage.prompt_tokens_details?.cached_tokens) || 0) * Number(pricing.promptCachedTokens || 0);
  const completion = (Number(usage.completion_tokens) || 0) * Number(pricing.completionTextTokens || 0);
  const total = prompt - cached + completion;
  if (!Number.isFinite(total) || total < 0) return null;
  return total;
}

export const RETRY_INSTRUCTION =
  'Wrong shape. Reply again with one JSON object and nothing else: no fence, no prose, no boot screen outside "screen".';

export function addUsage(a, b) {
  if (!a && !b) return null;
  return {
    prompt_tokens: (Number(a?.prompt_tokens) || 0) + (Number(b?.prompt_tokens) || 0),
    completion_tokens: (Number(a?.completion_tokens) || 0) + (Number(b?.completion_tokens) || 0),
  };
}

/**
 * One machine turn with the retry policy in one testable place: ask, and if the
 * reply broke format ask once more with the strict instruction before giving up.
 * `send(messages)` is injected so tests never touch the network.
 */
export async function machineTurn({ send, system, ask, state, maxTokens = 420 }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: ask },
  ];
  const first = await send(messages, maxTokens);
  const parsed = parseReply(first.text, state);
  if (parsed.structured) return { reply: first, parsed, attempts: 1 };

  const second = await send(
    [
      ...messages,
      { role: "assistant", content: String(first.text || "").slice(0, 900) },
      { role: "user", content: RETRY_INSTRUCTION },
    ],
    maxTokens,
  );
  const retried = parseReply(second.text, state);
  const merged = {
    text: retried.structured ? second.text : first.text,
    usage: addUsage(first.usage, second.usage),
    ms: (Number(first.ms) || 0) + (Number(second.ms) || 0),
    model: first.model || second.model,
  };
  return {
    reply: merged,
    parsed: retried.structured ? retried : parsed,
    attempts: 2,
    retryFailed: !retried.structured,
  };
}

export function formatPollen(value) {
  if (value == null) return "—";
  if (value === 0) return "0";
  if (value < 0.00001) return "<0,00001";
  return value.toFixed(value < 0.01 ? 5 : 4).replace(".", ",");
}
