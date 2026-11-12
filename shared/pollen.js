// Bring Your Own Pollen over the device flow: no redirect, no backend, no secret.
// The key stays in this tab's session storage and is only ever sent to gen.pollinations.ai.

export const ENDPOINTS = {
  gen: "https://gen.pollinations.ai",
  enter: "https://enter.pollinations.ai",
};

// Publishable App Key: names the app on the consent screen and can spend nothing.
export const APP_KEY = "";

const STORE_KEY = "peti.key";
const DEVICE_KEY = "peti.device";
const UNTIL_KEY = "peti.until";

function store() {
  try {
    const s = globalThis.sessionStorage;
    if (s) return s;
  } catch {
    /* private mode */
  }
  const memory = new Map();
  return {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, v),
    removeItem: (k) => memory.delete(k),
  };
}

const box = store();

async function json(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function httpError(response, body) {
  const message = body?.error?.message || body?.message || body?.error || `HTTP ${response.status}`;
  const error = new Error(String(message));
  if (response.status === 401 || response.status === 403) error.code = "auth";
  if (response.status === 402 || response.status === 429) error.code = "quota";
  return error;
}

export function connected() {
  return Boolean(box.getItem(STORE_KEY));
}

export function useKey(value) {
  const key = String(value || "").trim();
  if (!/^sk_/.test(key)) throw new Error("that is not an sk_ key");
  box.setItem(STORE_KEY, key);
  return true;
}

export function signOut() {
  for (const k of [STORE_KEY, DEVICE_KEY, UNTIL_KEY]) box.removeItem(k);
}

export async function startDevice(send = globalThis.fetch) {
  const response = await send(`${ENDPOINTS.enter}/api/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(APP_KEY ? { client_id: APP_KEY } : {}),
  });
  const body = await json(response);
  if (!response.ok || !body.device_code) throw httpError(response, body);
  box.setItem(DEVICE_KEY, body.device_code);
  box.setItem(UNTIL_KEY, String(Date.now() + (body.expires_in || 1800) * 1000));
  return {
    userCode: body.user_code,
    verify: body.verification_uri_complete || body.verification_uri,
  };
}

export async function pollDevice(send = globalThis.fetch) {
  const device = box.getItem(DEVICE_KEY);
  if (!device) return { state: "idle" };
  if (Date.now() > Number(box.getItem(UNTIL_KEY) || 0)) {
    box.removeItem(DEVICE_KEY);
    return { state: "expired" };
  }
  const response = await send(`${ENDPOINTS.enter}/api/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: device }),
  });
  const body = await json(response);
  if (body.access_token) {
    box.removeItem(DEVICE_KEY);
    box.removeItem(UNTIL_KEY);
    box.setItem(STORE_KEY, body.access_token);
    return { state: "connected" };
  }
  if (body.error === "authorization_pending" || response.status === 428) return { state: "pending" };
  box.removeItem(DEVICE_KEY);
  return { state: "error", message: body.error_description || body.error || `HTTP ${response.status}` };
}

export async function models(send = globalThis.fetch) {
  const response = await send(`${ENDPOINTS.gen}/models`);
  const body = await json(response);
  if (!response.ok) throw httpError(response, body);
  return Array.isArray(body) ? body : body.data || [];
}

/** One machine turn: a single chat completion, timed, with the usage the API reports. */
export async function turn({ model, messages, maxTokens = 420, temperature = 0.6, signal }) {
  const key = box.getItem(STORE_KEY);
  if (!key) {
    const error = new Error("connect your Pollen first");
    error.code = "auth";
    throw error;
  }
  const started = performance.now();
  const response = await fetch(`${ENDPOINTS.gen}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    signal,
  });
  const body = await json(response);
  const ms = Math.round(performance.now() - started);
  if (!response.ok) {
    const error = httpError(response, body);
    error.ms = ms;
    throw error;
  }
  const choice = body.choices?.[0];
  const text = choice?.message?.content;
  if (!text) {
    const reason = choice?.finish_reason === "length" ? "ran out of tokens mid-screen" : "printed nothing";
    throw new Error(`the machine ${reason}`);
  }
  return { text, usage: body.usage || null, ms, model };
}
