import type { ErrorJson, Outcome } from "./engine.ts";
import { EXAMPLES } from "./examples.ts";
import type { ToPage, ToWorker } from "./protocol.ts";
import { type Line, reportLines } from "./render.ts";

/** A run longer than this is stopped: PGlite can't cancel a query, so the worker is replaced. */
const WATCHDOG_MS = 20_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const migration = $<HTMLTextAreaElement>("migration");
const seed = $<HTMLTextAreaElement>("seed");
const runButton = $<HTMLButtonElement>("run");
const status = $<HTMLParagraphElement>("status");
const beam = $<HTMLDivElement>("output-beam");
const beamFill = $<HTMLDivElement>("beam-fill");
const results = $<HTMLDivElement>("results");
const meta = $<HTMLParagraphElement>("meta");

let worker: Worker;
let ready = false;
let running: { id: number; watchdog?: ReturnType<typeof setTimeout> } | undefined;
let nextId = 1;
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

// ---- Examples ----

const examples = $<HTMLParagraphElement>("examples");
EXAMPLES.forEach((ex, i) => {
  if (i) examples.append(el("span", "examples-sep", "·"));
  const b = el("button", "example", ex.label) as HTMLButtonElement;
  b.type = "button";
  b.dataset.id = ex.id;
  b.setAttribute("aria-pressed", "false");
  b.addEventListener("click", () => {
    migration.value = ex.migration;
    seed.value = ex.seed;
    markExample(ex.id);
    if (ready) run();
  });
  examples.append(b);
});
// The first screen shows a real finding with zero clicks: the leaky example runs once Postgres is ready.
const FIRST = EXAMPLES[0];
let runWhenReady = false;
if (FIRST) {
  migration.value = FIRST.migration;
  seed.value = FIRST.seed;
  runWhenReady = true;
}

function markExample(id?: string): void {
  for (const b of examples.querySelectorAll<HTMLButtonElement>(".example"))
    b.setAttribute("aria-pressed", String(b.dataset.id === id));
}
markExample(FIRST?.id);
for (const t of [migration, seed]) t.addEventListener("input", () => markExample());

// ---- Engine ----

function startWorker(): void {
  ready = false;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<ToPage>) => onMessage(ev.data);
  worker.onerror = () => showStatus("The engine failed to start. Reload the page to try again.");
  post({ type: "boot", base: document.baseURI });
  beam.classList.add("loading");
  beamFill.style.width = "0";
  showStatus("Loading Postgres…");
}

const post = (m: ToWorker) => worker.postMessage(m);

function onMessage(m: ToPage): void {
  switch (m.type) {
    case "progress": {
      const pct = Math.round((100 * m.loaded) / m.total);
      beamFill.style.width = `${pct}%`;
      showStatus("Postgres is loading…");
      meta.textContent = `loading · ${pct}%`;
      return;
    }
    case "starting":
      showStatus("Starting Postgres and loading Supabase’s roles and schemas…");
      meta.textContent = "starting";
      return;
    case "ready":
      ready = true;
      beam.classList.remove("loading");
      meta.textContent = "";
      runButton.disabled = false;
      showIdle();
      if (runWhenReady) {
        runWhenReady = false;
        run();
      }
      return;
    case "failed":
      showStatus(`The engine failed to start: ${m.message}`);
      return;
    case "started":
      if (running?.id === m.id) running.watchdog = setTimeout(() => stop(true), WATCHDOG_MS);
      return;
    case "result":
      if (running?.id !== m.id) return;
      clearTimeout(running.watchdog);
      running = undefined;
      runButton.disabled = false;
      showOutcome(m.outcome);
      showIdle();
  }
}

function run(): void {
  if (!ready || running) return;
  running = { id: nextId++ };
  runButton.disabled = true;
  results.classList.add("stale");
  status.replaceChildren("Checking… ");
  const stopButton = el("button", "stop", "stop") as HTMLButtonElement;
  stopButton.type = "button";
  stopButton.addEventListener("click", () => stop(false));
  status.append(stopButton);
  post({ type: "run", id: running.id, migration: migration.value, seed: seed.value });
}

/** The kill switch: drop the worker (and whatever it's stuck on) and start a fresh one. */
function stop(timedOut: boolean): void {
  if (running) clearTimeout(running.watchdog);
  running = undefined;
  worker.terminate();
  runButton.disabled = true;
  results.classList.remove("stale");
  meta.textContent = "";
  results.replaceChildren(
    para(
      "empty",
      timedOut
        ? `Stopped after ${WATCHDOG_MS / 1000} seconds. Something in the migration kept running, and Postgres in the browser can’t cancel a query, so the engine was restarted.`
        : "Stopped. The engine is restarting.",
    ),
  );
  startWorker();
}

// ---- Output ----

function showOutcome(o: Outcome): void {
  results.classList.remove("stale");
  meta.textContent = `${o.ms < 1000 ? `${o.ms} ms` : `${(o.ms / 1000).toFixed(1)} s`}`;
  results.replaceChildren(...renderLines(o.ok ? reportLines(o.report) : errorLines(o.error)));
}

/** How the CLI prints an error (src/cli/io.ts printError), as lines. */
function errorLines(e: ErrorJson): Line[] {
  const lines: Line[] = [
    [
      { text: "error", tone: "error" },
      { text: " ", tone: "text" },
      { text: e.code, tone: "object" },
      { text: `: ${e.message}`, tone: "text" },
    ],
  ];
  if (e.cause)
    lines.push([
      { text: "  likely cause: ", tone: "meta" },
      { text: e.cause, tone: "text" },
    ]);
  const next = e.hint?.split("try: ")[1];
  if (next)
    lines.push([
      { text: "  try: ", tone: "meta" },
      { text: next, tone: "object" },
    ]);
  if (e.details) {
    lines.push([]);
    for (const d of e.details.split("\n")) lines.push([{ text: `  ${d}`, tone: "meta" }]);
  }
  return lines;
}

function renderLines(lines: Line[]): HTMLElement[] {
  return lines.map((line, i) => {
    if (!line.length) return el("div", "gap");
    const p = el("p", "line");
    if (/^ {8}/.test(line[0]?.text ?? "") && i > 0) p.classList.add("line-message");
    else if (/^(error|warn|info|-)\s*$/.test(line[1]?.text ?? "")) p.classList.add("line-head");
    for (const span of line)
      p.append(
        span.tone === "text" && !span.text.trim()
          ? span.text
          : el("span", `t-${span.tone}`, span.text),
      );
    return p;
  });
}

function showIdle(): void {
  status.replaceChildren(el("span", "status-key", `${mac ? "⌘" : "Ctrl"} + Enter to check`));
}

function showStatus(text: string): void {
  status.textContent = text;
}

// ---- Small helpers ----

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const para = (cls: string, text: string) => el("p", cls, text);

runButton.addEventListener("click", run);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
});

// Load the engine after the page has loaded, so it shows before the engine download (about 5 MB compressed) starts.
// (Not requestAnimationFrame: it never fires in a background tab.)
if (document.readyState === "complete") setTimeout(startWorker, 0);
else addEventListener("load", () => setTimeout(startWorker, 0), { once: true });
