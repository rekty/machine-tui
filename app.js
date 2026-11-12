import { connected, startDevice, pollDevice, useKey, signOut, models, turn } from "./shared/pollen.js";
import { blankState, systemPrompt, parseReply, estimateCost, formatPollen } from "./shared/machine.js";

const STATE_KEY = "peti.state";
const MODEL_KEY = "peti.model";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

const el = (id) => document.getElementById(id);
const screen = el("screen");
const input = el("input");
const meter = el("meter");

const prices = new Map();

let state = loadState();
let model = localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
let pricing = null;
let running = false;
let total = 0;
let turns = 0;
let controller = null;
const history = [];
let historyAt = -1;

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return parseReply("", JSON.parse(raw)).state;
  } catch {
    /* fall through to a fresh machine */
  }
  return blankState();
}

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked — the machine still works for this tab */
  }
}

function line(text) {
  const node = document.createElement("span");
  node.textContent = text + "\n";
  screen.appendChild(node);
  screen.scrollTop = screen.scrollHeight;
  return node;
}

function promptText() {
  return `guest@peti64:${state.cwd}$`;
}

function refreshPrompt() {
  el("prompt").textContent = promptText();
}

function boot() {
  screen.textContent = "";
  [
    "PETI-64 BIOS 2.7 ................ WORD KERNEL",
    "MEMORY TEST: 640K OF LANGUAGE ..... OK",
    `MOUNT ${state.cwd}: ${Object.keys(state.files).length} FILE(S) ...... OK`,
    "KEYBOARD: 1 HUMAN ................. OK",
    "",
    "READY. TYPE HELP. NOTHING YOU TYPE IS EXECUTED.",
    "",
  ].forEach((row) => line(row));
  refreshPrompt();
}

function setMeter(text) {
  meter.innerHTML = text;
}

function connectedUI() {
  const on = connected();
  const button = el("pollen");
  button.textContent = on ? "Pollen connected" : "Connect Pollen";
  button.dataset.on = on ? "1" : "0";
}

function openModal(html) {
  el("modal-body").innerHTML = html;
  el("modal").hidden = false;
}

function closeModal() {
  el("modal").hidden = true;
}

async function connectFlow() {
  openModal(`<p>Starting the device flow…</p>`);
  let device;
  try {
    device = await startDevice();
  } catch (error) {
    openModal(`
      <p>Could not reach enter.pollinations.ai: ${escapeHtml(error.message)}</p>
      <p>You can still paste an <code>sk_</code> key made at
        <a href="https://enter.pollinations.ai/keys" target="_blank" rel="noopener">enter.pollinations.ai/keys</a>.</p>
      <p><input id="manual-key" type="text" placeholder="sk_…" autocomplete="off" /></p>
      <p><button id="manual-save" class="pill" type="button">Use this key</button></p>`);
    wireManualKey();
    return;
  }
  openModal(`
    <p>Open this page and approve PETI-64:</p>
    <p><a href="${device.verify}" target="_blank" rel="noopener">${device.verify}</a></p>
    <p>Or enter the code there:</p>
    <p><span class="code">${device.userCode}</span></p>
    <p id="device-state">Waiting for approval…</p>`);
  const tick = setInterval(async () => {
    if (el("modal").hidden) return clearInterval(tick);
    const result = await pollDevice().catch((error) => ({ state: "error", message: error.message }));
    if (result.state === "connected") {
      clearInterval(tick);
      closeModal();
      connectedUI();
      line("*** POLLEN CONNECTED — PRESS ENTER ON A COMMAND ***");
      input.focus();
    } else if (result.state === "error" || result.state === "expired") {
      clearInterval(tick);
      const note = el("device-state");
      if (note) note.textContent = `Stopped: ${result.message || result.state}`;
    }
  }, 2200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function wireManualKey() {
  const save = el("manual-save");
  if (!save) return;
  save.addEventListener("click", () => {
    try {
      useKey(el("manual-key").value);
      closeModal();
      connectedUI();
      line("*** POLLEN CONNECTED ***");
    } catch (error) {
      alert(error.message);
    }
  });
}

async function loadModels() {
  const select = el("model");
  try {
    const list = await models();
    const text = list
      .filter((m) => (m.output_modalities || []).includes("text") && !m.paid_only)
      .map((m) => ({ id: m.name || m.id, price: m.pricing || {} }))
      .filter((m) => m.id)
      .sort((a, b) => Number(a.price.completionTextTokens || 0) - Number(b.price.completionTextTokens || 0));
    const options = text.slice(0, 40);
    if (!options.some((m) => m.id === model)) options.unshift({ id: model, price: {} });
    options.forEach((m) => prices.set(m.id, m.price));
    select.innerHTML = options
      .map((m) => {
        const out = Number(m.price.completionTextTokens || 0);
        const label = out ? `${m.id} — ${out.toFixed(6).replace(".", ",")}/tok` : m.id;
        return `<option value="${escapeHtml(m.id)}"${m.id === model ? " selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    pricing = prices.get(model) || null;
  } catch {
    select.innerHTML = `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`;
  }
}

async function runCommand(command) {
  if (running) return;
  running = true;
  input.disabled = true;
  line(`${promptText()} ${command}`);
  const pending = line("…");

  const started = performance.now();
  const ticker = setInterval(() => {
    pending.textContent = `… ${((performance.now() - started) / 1000).toFixed(1)}s\n`;
  }, 200);

  controller = new AbortController();
  try {
    const reply = await turn({
      model,
      messages: [
        { role: "system", content: systemPrompt(state) },
        { role: "user", content: `command: ${command}` },
      ],
      signal: controller.signal,
    });
    clearInterval(ticker);
    pending.remove();

    const parsed = parseReply(reply.text, state);
    const chunks = parsed.screen.split("\n");
    chunks.forEach((row) => line(row));
    if (parsed.crashed) {
      state = blankState();
      saveState();
      line("");
      line("*** MACHINE REBOOTED — STATE WIPED ***");
    } else {
      state = parsed.state;
      saveState();
    }
    refreshPrompt();

    turns += 1;
    const cost = estimateCost(reply.usage, pricing);
    if (cost != null) total += cost;
    setMeter(
      `Turn <b>${turns}</b> · ${(reply.ms / 1000).toFixed(1)}s · this turn <b>${formatPollen(cost)}</b> · ` +
      `total <b>${formatPollen(total)}</b> Pollen`,
    );
    if (!parsed.structured) line("! the model answered outside the machine format — output shown as-is");
  } catch (error) {
    clearInterval(ticker);
    pending.remove();
    if (error.name === "AbortError") {
      line("! turn cancelled");
    } else {
      const node = line(`! ${error.message}`);
      node.className = "err";
      if (error.code === "auth") {
        line("! connect your Pollen first");
        connectFlow();
      }
      if (error.code === "quota") line("! out of Pollen — top up at enter.pollinations.ai");
    }
  } finally {
    clearInterval(ticker);
    controller = null;
    running = false;
    input.disabled = false;
    input.focus();
  }
}

el("cmd").addEventListener("submit", (event) => {
  event.preventDefault();
  const command = input.value.trim();
  if (!command) return;
  history.push(command);
  historyAt = history.length;
  input.value = "";
  runCommand(command);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!history.length) return;
    historyAt = Math.max(0, historyAt - 1);
    input.value = history[historyAt] || "";
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!history.length) return;
    historyAt = Math.min(history.length, historyAt + 1);
    input.value = history[historyAt] || "";
  } else if (event.key === "Escape" && running && controller) {
    controller.abort();
  }
});

el("model").addEventListener("change", (event) => {
  model = event.target.value;
  localStorage.setItem(MODEL_KEY, model);
  pricing = prices.get(model) || null;
  line(`*** KERNEL SWAPPED TO ${model} ***`);
});

el("reset").addEventListener("click", () => {
  state = blankState();
  saveState();
  total = 0;
  turns = 0;
  boot();
  setMeter("Machine reset. No turn run yet.");
  input.focus();
});

el("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(screen.textContent || "");
    setMeter("Screen copied to clipboard.");
  } catch {
    setMeter("Could not copy — select the screen manually.");
  }
});

el("pollen").addEventListener("click", () => {
  if (connected()) {
    signOut();
    connectedUI();
    line("*** POLLEN DISCONNECTED ***");
    return;
  }
  connectFlow();
});

el("modal-close").addEventListener("click", closeModal);
el("modal").addEventListener("click", (event) => {
  if (event.target === el("modal")) closeModal();
});

boot();
connectedUI();
loadModels();
input.focus();
