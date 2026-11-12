# PETI-64

A fictional 1980s computer whose operating system is a language model. You type shell commands at
it; **nothing executes**. One Pollinations chat completion per command writes what the machine
prints and returns the machine's next state as JSON — files, working directory, processes, clock,
mood. That object is the computer.

Live: <https://rekty.github.io/machine-tui/>

Built for Pollinations quest **#19179 — an app or game where a model plays a machine**.

## Why it is a machine and not a chatbot

| Chatbot | PETI-64 |
|---|---|
| Replies in prose | Prints terminal output only |
| No persistent internals | Carries `{cwd, files, procs, time, mood}` between turns |
| Forgets what it made | A file created in turn 3 is readable in turn 9 |
| Cannot fail | `CAT /NOPE` fails because `/NOPE` is not in its state |

The page never invents a line of machine output. If the model breaks format, the raw text is shown
and flagged (`! the model answered outside the machine format`).

## How it works

- `index.html`, `style.css` — CRT shell, keyboard, model picker.
- `app.js` — one turn per command: `systemPrompt(state)` → chat completion → `parseReply()` →
  render `screen`, keep `state`, persist it in `localStorage`.
- `shared/machine.js` — pure helpers (prompt, tolerant JSON parsing, state clamping, cost maths).
- `shared/pollen.js` — Bring Your Own Pollen over the device flow; the `sk_` key stays in this
  tab's session storage and is sent only to `gen.pollinations.ai`.
- `test/machine.test.mjs` — `node --test`, covers parsing, clamping, fallbacks and cost.

State is deliberately bounded (12 files × 240 chars, 8 processes, 18×76 screen) so one turn stays
cheap and a misbehaving model cannot blow up the next prompt.

## Run locally

```bash
cd machine-tui
python -m http.server 8080     # ES modules need http(s), not file://
# open http://localhost:8080
```

Tests:

```bash
node --test
```

## Kernel notes (measured, not assumed)

Every kernel is a text model, but not every model keeps the JSON contract. Measured against
`/v1/chat/completions` with this app's own system prompt:

| Kernel | Result |
|---|---|
| `openai/gpt-5.4-nano` (default) | object returned, `/NOTES.TXT` created, `CAT` reads it back |
| `z-ai/glm-5.3-flash` | object returned, state kept |
| `openai/gpt-oss-20b` | HTTP 400 — not usable as a kernel |

A model that drifts out of the format gets one strict retry; if it drifts twice the raw text is
shown and flagged, so the machine never silently loses its memory.

## Cost

Every command is one chat completion paid from the reader's own Pollen. The default kernel
(`openai/gpt-oss-20b`) is one of the cheapest text models on the gateway; the footer shows the
price of the last turn and the running total, computed from the usage the API reports and the
per-token prices in `/models`.

## License

MIT
