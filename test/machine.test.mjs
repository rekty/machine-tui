import test from "node:test";
import assert from "node:assert/strict";
import {
  blankState,
  systemPrompt,
  parseReply,
  trimState,
  trimScreen,
  estimateCost,
  formatPollen,
  MAX_FILES,
  MAX_SCREEN_LINES,
} from "../shared/machine.js";

test("blank state is a machine that can answer LS", () => {
  const state = blankState();
  assert.equal(state.cwd, "/");
  assert.ok(Object.keys(state.files).length >= 1);
  assert.ok(Array.isArray(state.procs));
});

test("system prompt carries the current files and cwd", () => {
  const state = { ...blankState(), cwd: "/GAMES", files: { "/GAMES/ZORK.TXT": "west of house" } };
  const prompt = systemPrompt(state);
  assert.match(prompt, /PETI-64/);
  assert.match(prompt, /\/GAMES\/ZORK\.TXT/);
  assert.match(prompt, /"cwd":"\/GAMES"/);
  assert.match(prompt, /ONE JSON object/);
});

test("parseReply reads a clean object", () => {
  const prev = blankState();
  const reply = JSON.stringify({
    screen: "A> READY",
    state: { cwd: "/A", files: { "/A/X": "y" }, procs: ["init"], time: 4, mood: "calm", notes: "" },
    crashed: false,
  });
  const out = parseReply(reply, prev);
  assert.equal(out.structured, true);
  assert.equal(out.screen, "A> READY");
  assert.equal(out.state.cwd, "/A");
  assert.equal(out.crashed, false);
});

test("parseReply survives a fenced object with chatter around it", () => {
  const prev = blankState();
  const raw = 'Sure:\n```json\n{"screen":"OK","state":{"cwd":"/x"}}\n```\nDone.';
  const out = parseReply(raw, prev);
  assert.equal(out.structured, true);
  assert.equal(out.screen, "OK");
  assert.equal(out.state.cwd, "/x");
  assert.deepEqual(out.state.files, prev.files, "missing files keep the previous files");
});

test("parseReply falls back to plain text and keeps the state", () => {
  const prev = blankState();
  const out = parseReply("? UNKNOWN COMMAND", prev);
  assert.equal(out.structured, false);
  assert.equal(out.screen, "? UNKNOWN COMMAND");
  assert.deepEqual(out.state.files, prev.files);
});

test("parseReply does not lose state on broken JSON", () => {
  const prev = { ...blankState(), cwd: "/KEEP" };
  const out = parseReply('{"screen":"hi","state":{', prev);
  assert.equal(out.structured, false);
  assert.equal(out.state.cwd, "/KEEP");
});

test("trimState clamps huge or hostile state", () => {
  const files = {};
  for (let i = 0; i < 40; i += 1) files[`/F${i}`] = "x".repeat(900);
  const state = trimState({ files, procs: Array(30).fill("p"), time: -5, cwd: "relative" }, blankState());
  assert.equal(Object.keys(state.files).length, MAX_FILES);
  assert.equal(state.files["/F0"].length, 240);
  assert.equal(state.procs.length, 8);
  assert.notEqual(state.cwd, "relative");
});

test("trimScreen bounds lines and columns", () => {
  const screen = Array(40).fill("y".repeat(200)).join("\n");
  const out = trimScreen(screen);
  const rows = out.split("\n");
  assert.equal(rows.length, MAX_SCREEN_LINES);
  assert.equal(rows[0].length, 76);
});

test("cost maths uses the token prices the API publishes", () => {
  const usage = { prompt_tokens: 500, completion_tokens: 200 };
  const pricing = { promptTextTokens: "0.00000005", completionTextTokens: "0.00000018" };
  const cost = estimateCost(usage, pricing);
  assert.ok(cost > 0);
  assert.equal(cost.toFixed(8), (500 * 0.00000005 + 200 * 0.00000018).toFixed(8));
});

test("cost is null without usage and formats readably", () => {
  assert.equal(estimateCost(null, { promptTextTokens: 1 }), null);
  assert.equal(formatPollen(null), "—");
  assert.equal(formatPollen(0), "0");
  assert.equal(formatPollen(0.0000001), "<0,00001");
  assert.match(formatPollen(0.0042), /^0,00420$/);
});
