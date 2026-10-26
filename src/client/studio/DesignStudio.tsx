import { useEffect, useMemo, useRef, useState } from "react";
import { DesignBrief, feasibilitySummary, type Capability } from "../../core/schema/brief";
import type { RobotDesign } from "../../core/schema/design";
import type { Check, ValidationReport } from "../../core/validate/report";
import { loadDesign, setState } from "../store";
import { CheckRow, StatusBadge } from "../panels/Panels";

/** Shapes of the server-sent events from /api/research and /api/design (see server/events.ts). */
type AgentEvent =
  | { type: "status"; agent: string; message: string }
  | { type: "thinking"; agent: string; text: string }
  | { type: "text"; agent: string; text: string }
  | { type: "search"; agent: string; query: string }
  | { type: "source"; agent: string; url: string; title: string }
  | { type: "brief"; brief: DesignBrief; feasibility: { achievable: number; compromise: number; infeasible: number } }
  | { type: "design"; iteration: number; design: RobotDesign }
  | { type: "validation"; iteration: number; report: ValidationReport }
  | { type: "result"; design: RobotDesign; report: ValidationReport; iterations: number; unresolved: Check[] }
  | { type: "error"; message: string }
  | { type: "done" };

interface LogLine {
  kind: "status" | "search" | "source" | "error" | "text";
  agent: string;
  text: string;
  url?: string;
}

interface Iteration {
  n: number;
  design?: RobotDesign;
  report?: ValidationReport;
}

interface Health {
  ok: boolean;
  hasApiKey: boolean;
  models: { researcher: string; designer: string };
  maxIterations: number;
}

/** POST a JSON body and consume the SSE response stream. */
async function streamEvents(url: string, body: unknown, onEvent: (e: AgentEvent) => void, signal: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(t);
      msg = j.issues ? `Invalid input: ${j.issues.join("; ")}` : j.error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5).trim()));
    }
  }
}

const BLANK_BRIEF: DesignBrief = {
  title: "New robot",
  originalPrompt: "",
  interpretation: "",
  purpose: "",
  environment: { setting: "indoor", terrain: ["flat floor"] },
  sizeClass: "small",
  targetMass_kg: { min: 2, max: 10 },
  approxDimensions_m: { length: 0.5, width: 0.3, height: 0.35 },
  locomotion: "quadruped",
  payload_kg: 0,
  runtime_min: 20,
  behaviours: ["walk on flat ground"],
  capabilities: [{ capability: "Walking", requested: "walk", verdict: "achievable", rationale: "" }],
  styling: {
    styleName: "Utility",
    silhouette: "",
    proportions: "",
    panelLines: "",
    colorScheme: { primary: "#d8dde3", secondary: "#2b2f36", accent: "#ff7a1a", emissive: "#7fe7ff" },
    finish: "matte",
    distinctiveFeatures: [],
  },
  references: [],
  constraints: [],
  openQuestions: [],
};

export function DesignStudio() {
  const [health, setHealth] = useState<Health | null>(null);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<{ name: string; mediaType: string; data: string }[]>([]);
  const [phase, setPhase] = useState<"idle" | "researching" | "brief" | "designing" | "done">("idle");
  const [log, setLog] = useState<LogLine[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [brief, setBrief] = useState<DesignBrief | null>(null);
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [result, setResult] = useState<{ design: RobotDesign; report: ValidationReport; iterations: number; unresolved: Check[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "status":
        setLog((l) => [...l, { kind: "status", agent: e.agent, text: e.message }]);
        break;
      case "search":
        setLog((l) => [...l, { kind: "search", agent: e.agent, text: e.query }]);
        break;
      case "source":
        setLog((l) => [...l, { kind: "source", agent: e.agent, text: e.title || e.url, url: e.url }]);
        break;
      case "thinking":
      case "text":
        setNotes((n) => ({ ...n, [e.agent]: (n[e.agent] ?? "") + e.text }));
        break;
      case "brief":
        setBrief(e.brief);
        setPhase("brief");
        break;
      case "design":
        setIterations((its) => upsert(its, e.iteration, { design: e.design }));
        break;
      case "validation":
        setIterations((its) => upsert(its, e.iteration, { report: e.report }));
        break;
      case "result":
        setResult({ design: e.design, report: e.report, iterations: e.iterations, unresolved: e.unresolved });
        setPhase("done");
        break;
      case "error":
        setError(e.message);
        setLog((l) => [...l, { kind: "error", agent: "server", text: e.message }]);
        break;
    }
  };

  const run = async (url: string, body: unknown, next: () => void) => {
    setError(null);
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      await streamEvents(url, body, onEvent, ac.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      next();
    }
  };

  const research = () => {
    setPhase("researching");
    setLog([]);
    setNotes({});
    setBrief(null);
    setIterations([]);
    setResult(null);
    run("/api/research", { prompt, images: images.map(({ mediaType, data }) => ({ mediaType, data })) }, () => setPhase((p) => (p === "researching" ? "idle" : p)));
  };

  const design = () => {
    if (!brief) return;
    setPhase("designing");
    setIterations([]);
    setResult(null);
    setNotes((n) => ({ ...n, designer: "" }));
    run("/api/design", { brief }, () => setPhase((p) => (p === "designing" ? "brief" : p)));
  };

  const stop = () => {
    abort.current?.abort();
    setPhase(brief ? "brief" : "idle");
  };

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    const out: typeof images = [];
    for (const f of Array.from(files).slice(0, 6)) {
      const data = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.readAsDataURL(f);
      });
      out.push({ name: f.name, mediaType: f.type, data });
    }
    setImages((i) => [...i, ...out].slice(0, 6));
  };

  const open = (d: RobotDesign, label: string) => {
    loadDesign(d, label);
    setState({ mode: "inspect" });
  };

  const busy = phase === "researching" || phase === "designing";

  return (
    <div className="studio">
      <section className="studio-col">
        <h2>1 · Describe the robot</h2>
        {health && !health.hasApiKey && (
          <div className="notice warn">The server has no ANTHROPIC_API_KEY, so the agents can't run. You can still write a brief by hand below, inspect and simulate the example designs.</div>
        )}
        {!health && <div className="notice warn">Backend not reachable (start it with <code>npm run dev</code>). The viewer, validator and simulator work offline.</div>}
        {health && (
          <p className="muted small">
            Researcher: <code>{health.models.researcher}</code> · Designer: <code>{health.models.designer}</code> · up to {health.maxIterations} design iterations
          </p>
        )}
        <textarea className="prompt" placeholder='e.g. "a quadruped that can climb stairs" or "a humanoid that looks like Iron Man"' value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} />
        <div className="row-buttons">
          <label className="file-btn">
            + Reference images
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(e) => addImages(e.target.files)} hidden />
          </label>
          {images.map((im, i) => (
            <span key={i} className="chip">
              {im.name}
              <button onClick={() => setImages(images.filter((_, k) => k !== i))}>×</button>
            </span>
          ))}
        </div>
        <div className="row-buttons">
          <button className="primary" disabled={busy || prompt.trim().length < 3} onClick={research}>
            Research &amp; write brief
          </button>
          <button disabled={busy} onClick={() => (setBrief({ ...BLANK_BRIEF, originalPrompt: prompt }), setPhase("brief"))}>
            Write brief by hand
          </button>
          {busy && <button onClick={stop}>Stop</button>}
        </div>
        {error && <div className="notice error">{error}</div>}
        <ProgressLog log={log} notes={notes} busy={busy} />
      </section>

      <section className="studio-col wide">
        <h2>2 · Design brief {brief && <span className="muted small">(editable — the Designer gets exactly this)</span>}</h2>
        {!brief && <p className="muted">The Researcher's structured brief will appear here for you to review and edit before anything is designed.</p>}
        {brief && <BriefEditor brief={brief} onChange={setBrief} />}
        {brief && (
          <div className="row-buttons sticky-bottom">
            <button className="primary" disabled={busy} onClick={design}>
              Send brief to Designer →
            </button>
          </div>
        )}
      </section>

      <section className="studio-col">
        <h2>3 · Design &amp; validate</h2>
        {iterations.length === 0 && !result && <p className="muted">Each design attempt is validated against the component library; failures are fed back to the Designer automatically.</p>}
        {iterations.map((it) => (
          <div key={it.n} className="iteration">
            <div className="iteration-head">
              <strong>Iteration {it.n}</strong>
              {it.report ? (
                <span>
                  <StatusBadge status={it.report.status} /> {it.report.counts.fail} fail · {it.report.counts.warn} warn · {it.report.counts.pass} pass
                </span>
              ) : (
                <span className="muted">validating…</span>
              )}
              {it.design && (
                <button className="link" onClick={() => open(it.design!, `${it.design!.name} (iteration ${it.n})`)}>
                  view
                </button>
              )}
            </div>
            {it.report && it.report.counts.fail > 0 && (
              <ul className="small">
                {it.report.checks
                  .filter((c) => c.status === "fail")
                  .slice(0, 5)
                  .map((c) => (
                    <li key={c.id}>{c.title}</li>
                  ))}
              </ul>
            )}
          </div>
        ))}
        {result && (
          <div className="result">
            <h3>{result.design.name}</h3>
            <p>{result.design.description}</p>
            <p>
              <StatusBadge status={result.report.status} /> after {result.iterations} iteration{result.iterations === 1 ? "" : "s"} · {result.report.summary.totalMass_kg.toFixed(2)} kg · ≈ ${result.report.summary.totalCost_usd.toFixed(0)}
            </p>
            <button className="primary" onClick={() => open(result.design, result.design.name)}>
              Open in viewer
            </button>
            {result.unresolved.length > 0 && (
              <>
                <h4>Unresolved ({result.unresolved.length})</h4>
                {result.unresolved.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function upsert(its: Iteration[], n: number, patch: Partial<Iteration>): Iteration[] {
  const i = its.findIndex((x) => x.n === n);
  if (i < 0) return [...its, { n, ...patch }].sort((a, b) => a.n - b.n);
  const copy = [...its];
  copy[i] = { ...copy[i], ...patch };
  return copy;
}

function ProgressLog({ log, notes, busy }: { log: LogLine[]; notes: Record<string, string>; busy: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup function
    end.current?.scrollIntoView({ block: "nearest" });
  }, [log.length]);
  const [showNotes, setShowNotes] = useState(false);
  if (!log.length && !busy) return null;
  return (
    <div className="log">
      {log.map((l, i) => (
        <div key={i} className={`log-line log-${l.kind}`}>
          <span className="log-agent">{l.agent}</span>
          {l.kind === "search" && "🔎 "}
          {l.url ? (
            <a href={l.url} target="_blank" rel="noreferrer">
              {l.text}
            </a>
          ) : (
            l.text
          )}
        </div>
      ))}
      {busy && <div className="log-line muted">working…</div>}
      <div ref={end} />
      {Object.keys(notes).length > 0 && (
        <div className="notes">
          <button className="link" onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? "Hide" : "Show"} agent reasoning summaries
          </button>
          {showNotes &&
            Object.entries(notes).map(([agent, text]) => (
              <div key={agent}>
                <div className="log-agent">{agent}</div>
                <pre className="notes-text">{text}</pre>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function BriefEditor({ brief, onChange }: { brief: DesignBrief; onChange: (b: DesignBrief) => void }) {
  const [raw, setRaw] = useState<string | null>(null);
  const issues = useMemo(() => {
    const r = DesignBrief.safeParse(brief);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  }, [brief]);
  const f = feasibilitySummary(brief);
  const up = (patch: Partial<DesignBrief>) => onChange({ ...brief, ...patch });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const setCap = (i: number, patch: Partial<Capability>) => up({ capabilities: brief.capabilities.map((c, k) => (k === i ? { ...c, ...patch } : c)) });

  if (raw !== null) {
    let parseErr: string | null = null;
    try {
      JSON.parse(raw);
    } catch (e) {
      parseErr = (e as Error).message;
    }
    return (
      <div className="brief">
        <div className="row-buttons">
          <button
            disabled={!!parseErr}
            onClick={() => {
              onChange(JSON.parse(raw));
              setRaw(null);
            }}
          >
            Apply JSON
          </button>
          <button onClick={() => setRaw(null)}>Cancel</button>
        </div>
        {parseErr && <div className="notice error">{parseErr}</div>}
        <textarea className="json-edit" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
      </div>
    );
  }

  return (
    <div className="brief">
      <div className="feasibility">
        Feasibility: <span className="badge badge-pass">{f.achievable} achievable</span> <span className="badge badge-warn">{f.compromise} compromised</span>{" "}
        <span className="badge badge-fail">{f.infeasible} infeasible</span>
        <button className="link" onClick={() => setRaw(JSON.stringify(brief, null, 2))}>
          edit raw JSON
        </button>
      </div>
      {issues.length > 0 && <div className="notice error">Brief does not match the schema: {issues.slice(0, 5).join("; ")}</div>}
      <div className="form-grid">
        <label>Title</label>
        <input value={brief.title} onChange={(e) => up({ title: e.target.value })} />
        <label>Interpretation</label>
        <textarea rows={3} value={brief.interpretation} onChange={(e) => up({ interpretation: e.target.value })} />
        <label>Purpose</label>
        <input value={brief.purpose} onChange={(e) => up({ purpose: e.target.value })} />
        <label>Locomotion</label>
        <select value={brief.locomotion} onChange={(e) => up({ locomotion: e.target.value as DesignBrief["locomotion"] })}>
          {["quadruped", "biped", "hexapod", "wheeled", "tracked", "stationary_arm", "mobile_manipulator", "other"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <label>Size class</label>
        <select value={brief.sizeClass} onChange={(e) => up({ sizeClass: e.target.value as DesignBrief["sizeClass"] })}>
          {["desktop", "small", "medium", "large", "human_scale"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <label>Target mass (kg)</label>
        <span className="pair">
          <input type="number" value={brief.targetMass_kg.min} onChange={(e) => up({ targetMass_kg: { ...brief.targetMass_kg, min: num(e.target.value) } })} />
          –
          <input type="number" value={brief.targetMass_kg.max} onChange={(e) => up({ targetMass_kg: { ...brief.targetMass_kg, max: num(e.target.value) } })} />
        </span>
        <label>Dimensions L×W×H (m)</label>
        <span className="pair">
          {(["length", "width", "height"] as const).map((k) => (
            <input key={k} type="number" step={0.01} value={brief.approxDimensions_m[k]} onChange={(e) => up({ approxDimensions_m: { ...brief.approxDimensions_m, [k]: num(e.target.value) } })} />
          ))}
        </span>
        <label>Payload (kg) / runtime (min)</label>
        <span className="pair">
          <input type="number" value={brief.payload_kg} onChange={(e) => up({ payload_kg: num(e.target.value) })} />
          <input type="number" value={brief.runtime_min} onChange={(e) => up({ runtime_min: num(e.target.value) })} />
        </span>
        <label>Speed (m/s) / slope (°) / step (m)</label>
        <span className="pair">
          <input type="number" step={0.05} value={brief.speed_m_s ?? ""} onChange={(e) => up({ speed_m_s: e.target.value === "" ? undefined : num(e.target.value) })} />
          <input type="number" value={brief.maxSlope_deg ?? ""} onChange={(e) => up({ maxSlope_deg: e.target.value === "" ? undefined : num(e.target.value) })} />
          <input type="number" step={0.01} value={brief.stepHeight_m ?? ""} onChange={(e) => up({ stepHeight_m: e.target.value === "" ? undefined : num(e.target.value) })} />
        </span>
        <label>Behaviours</label>
        <textarea rows={2} value={brief.behaviours.join("\n")} onChange={(e) => up({ behaviours: e.target.value.split("\n").filter(Boolean) })} />
        <label>Constraints</label>
        <textarea rows={3} value={brief.constraints.join("\n")} onChange={(e) => up({ constraints: e.target.value.split("\n").filter(Boolean) })} />
      </div>

      <h4>Capabilities &amp; feasibility</h4>
      <table className="caps">
        <tbody>
          {brief.capabilities.map((c, i) => (
            <tr key={i} className={`cap-${c.verdict}`}>
              <td>
                <input value={c.capability} onChange={(e) => setCap(i, { capability: e.target.value })} />
                <div className="muted small">{c.requested}</div>
              </td>
              <td>
                <select value={c.verdict} onChange={(e) => setCap(i, { verdict: e.target.value as Capability["verdict"] })}>
                  <option value="achievable">achievable</option>
                  <option value="compromise">compromise</option>
                  <option value="infeasible">infeasible</option>
                </select>
              </td>
              <td>
                <textarea rows={2} value={c.rationale} onChange={(e) => setCap(i, { rationale: e.target.value })} />
                {c.verdict !== "achievable" && <textarea rows={2} placeholder="What will be built instead" value={c.compromise ?? ""} onChange={(e) => setCap(i, { compromise: e.target.value })} />}
              </td>
              <td>
                <button onClick={() => up({ capabilities: brief.capabilities.filter((_, k) => k !== i) })}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => up({ capabilities: [...brief.capabilities, { capability: "", requested: "", verdict: "achievable", rationale: "" }] })}>+ capability</button>

      <h4>Styling</h4>
      <div className="form-grid">
        <label>Style</label>
        <input value={brief.styling.styleName} onChange={(e) => up({ styling: { ...brief.styling, styleName: e.target.value } })} />
        <label>Silhouette</label>
        <input value={brief.styling.silhouette} onChange={(e) => up({ styling: { ...brief.styling, silhouette: e.target.value } })} />
        <label>Panel lines</label>
        <input value={brief.styling.panelLines} onChange={(e) => up({ styling: { ...brief.styling, panelLines: e.target.value } })} />
        <label>Colours</label>
        <span className="pair">
          {(["primary", "secondary", "accent", "emissive"] as const).map((k) => (
            <input
              key={k}
              type="color"
              title={k}
              value={brief.styling.colorScheme[k] ?? "#7fe7ff"}
              onChange={(e) => up({ styling: { ...brief.styling, colorScheme: { ...brief.styling.colorScheme, [k]: e.target.value } } })}
            />
          ))}
        </span>
        <label>Features</label>
        <textarea rows={2} value={brief.styling.distinctiveFeatures.join("\n")} onChange={(e) => up({ styling: { ...brief.styling, distinctiveFeatures: e.target.value.split("\n").filter(Boolean) } })} />
      </div>

      {brief.references.length > 0 && (
        <>
          <h4>References</h4>
          <div className="refs">
            {brief.references.map((r, i) => (
              <a key={i} className="ref" href={r.url} target="_blank" rel="noreferrer" title={r.notes}>
                {r.imageUrl && <img src={r.imageUrl} alt={r.title} loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}
                <div className="ref-title">{r.title}</div>
                <div className="muted small">
                  {r.kind} · {r.attribution} {r.verified ? <span className="badge badge-pass">found in search</span> : <span className="badge badge-warn">unverified</span>}
                </div>
                <div className="small">{r.notes}</div>
              </a>
            ))}
          </div>
        </>
      )}
      {brief.openQuestions.length > 0 && (
        <>
          <h4>Open questions</h4>
          <ul className="small">
            {brief.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
