import { useMemo, useState } from "react";
import type { RobotDesign } from "../../core/schema/design";
import { CATEGORY_LABELS, type Check, type CheckCategory, type Status, type ValidationReport } from "../../core/validate/report";
import { buildBom, bomToCsv } from "../../core/bom";
import { library } from "../library";
import { setState, useStore } from "../store";
import { checksForPart, partInfo } from "./partInfo";

export const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v.toFixed(d)).toLocaleString());

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

// ---------------------------------------------------------------- hierarchy

export function Hierarchy({ design }: { design: RobotDesign }) {
  const hidden = useStore((s) => s.hidden);
  const isolated = useStore((s) => s.isolated);
  const selected = useStore((s) => s.selectedPart);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const subs = new Map<string, Map<string, { id: string; name: string }[]>>();
    for (const l of design.links)
      for (const p of l.parts) {
        const sub = subs.get(l.subsystem) ?? new Map();
        subs.set(l.subsystem, sub);
        const asm = p.assembly ?? l.name;
        const name = p.kind === "component" ? p.name ?? library.get(p.componentId)?.name ?? p.componentId : p.name;
        sub.set(asm, [...(sub.get(asm) ?? []), { id: p.id, name }]);
      }
    return subs;
  }, [design]);
  const toggle = (k: string) => setOpen((o) => new Set(o.has(k) ? [...o].filter((x) => x !== k) : [...o, k]));
  const toggleHidden = (ids: string[]) =>
    setState((s) => {
      const h = new Set(s.hidden);
      const allHidden = ids.every((i) => h.has(i));
      for (const i of ids) allHidden ? h.delete(i) : h.add(i);
      return { hidden: h };
    });
  const isolate = (ids: string[]) => setState({ isolated: new Set(ids) });
  const partIdsOf = (asms: Map<string, { id: string }[]>) => [...asms.values()].flat().map((p) => p.id);

  return (
    <div className="tree">
      <div className="tree-head">
        <strong>{design.name}</strong>
        {isolated && (
          <button className="link" onClick={() => setState({ isolated: null })}>
            show all
          </button>
        )}
        {hidden.size > 0 && (
          <button className="link" onClick={() => setState({ hidden: new Set() })}>
            unhide ({hidden.size})
          </button>
        )}
      </div>
      {[...tree.entries()].map(([sub, asms]) => {
        const subIds = partIdsOf(asms);
        return (
          <div key={sub} className="tree-node">
            <div className="tree-row">
              <button className="twisty" onClick={() => toggle(sub)}>
                {open.has(sub) ? "▾" : "▸"}
              </button>
              <span className="tree-label sub" onClick={() => toggle(sub)}>
                {sub}
              </span>
              <TreeActions ids={subIds} hidden={hidden} onHide={toggleHidden} onIsolate={isolate} />
            </div>
            {open.has(sub) &&
              [...asms.entries()].map(([asm, parts]) => {
                const key = `${sub}/${asm}`;
                const ids = parts.map((p) => p.id);
                return (
                  <div key={key} className="tree-node indent">
                    <div className="tree-row">
                      <button className="twisty" onClick={() => toggle(key)}>
                        {open.has(key) ? "▾" : "▸"}
                      </button>
                      <span className="tree-label" onClick={() => toggle(key)}>
                        {asm}
                      </span>
                      <TreeActions ids={ids} hidden={hidden} onHide={toggleHidden} onIsolate={isolate} />
                    </div>
                    {open.has(key) &&
                      parts.map((p) => (
                        <div key={p.id} className={`tree-row indent2 ${selected === p.id ? "sel" : ""}`}>
                          <span className="tree-label part" onClick={() => setState({ selectedPart: p.id, rightTab: "part" })}>
                            {p.name}
                          </span>
                          <TreeActions ids={[p.id]} hidden={hidden} onHide={toggleHidden} onIsolate={isolate} />
                        </div>
                      ))}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function TreeActions({ ids, hidden, onHide, onIsolate }: { ids: string[]; hidden: Set<string>; onHide: (ids: string[]) => void; onIsolate: (ids: string[]) => void }) {
  const allHidden = ids.every((i) => hidden.has(i));
  return (
    <span className="tree-actions">
      <button title={allHidden ? "Show" : "Hide"} onClick={() => onHide(ids)}>
        {allHidden ? "◌" : "●"}
      </button>
      <button title="Isolate" onClick={() => onIsolate(ids)}>
        ◎
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- part panel

export function PartPanel({ design, report }: { design: RobotDesign; report: ValidationReport | null }) {
  const selected = useStore((s) => s.selectedPart);
  if (!selected) return <p className="muted">Click a part in the 3D view or the tree to see its details.</p>;
  const info = partInfo(design, library, selected);
  if (!info) return <p className="muted">Unknown part.</p>;
  const checks = checksForPart(report, info, design);
  return (
    <div className="part-panel">
      <h3>{info.name}</h3>
      <div className="kv">
        <span>Real-world equivalent</span>
        <span>{info.realWorldEquivalent}</span>
        <span>Category</span>
        <span>{info.category}</span>
        {info.material && (
          <>
            <span>Material</span>
            <span>{info.material}</span>
          </>
        )}
        <span>Mass</span>
        <span>{fmt(info.mass_kg * 1000, 1)} g</span>
        <span>Dimensions</span>
        <span>{info.dimensions}</span>
        {info.cost_usd !== undefined && (
          <>
            <span>Approx. cost</span>
            <span>${fmt(info.cost_usd, 0)}</span>
          </>
        )}
        <span>Location</span>
        <span>
          {info.subsystem} › {info.assembly} › {info.linkName}
        </span>
        {info.joints.length > 0 && (
          <>
            <span>Drives joint</span>
            <span>
              {info.joints.map((j) => (
                <button key={j} className="link" onClick={() => setState({ selectedJoint: j, rightTab: "joint" })}>
                  {design.joints.find((x) => x.id === j)?.name ?? j}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
      {info.specs.length > 0 && (
        <>
          <h4>Specifications</h4>
          <table className="specs">
            <tbody>
              {info.specs.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {info.datasheetUrl && (
        <p>
          <a href={info.datasheetUrl} target="_blank" rel="noreferrer">
            Datasheet ↗
          </a>
        </p>
      )}
      {info.notes && <p className="muted small">{info.notes}</p>}
      <h4>Validation checks involving this part ({checks.length})</h4>
      {checks.length === 0 ? <p className="muted small">None directly.</p> : checks.map((c) => <CheckRow key={c.id} check={c} />)}
      <div className="row-buttons">
        <button onClick={() => setState({ isolated: new Set([info.id]) })}>Isolate</button>
        <button onClick={() => setState((s) => ({ hidden: new Set([...s.hidden, info.id]) }))}>Hide</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- validation

export function CheckRow({ check }: { check: Check }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`check check-${check.status}`}
      onMouseEnter={() => setState({ highlight: new Set(check.involves) })}
      onMouseLeave={() => setState({ highlight: new Set() })}
    >
      <div className="check-head" onClick={() => setOpen(!open)}>
        <StatusBadge status={check.status} />
        <span className="check-title">{check.title}</span>
      </div>
      <div className="check-msg">{check.message}</div>
      {open && check.metrics.length > 0 && (
        <table className="metrics">
          <tbody>
            {check.metrics.map((m, i) => (
              <tr key={i}>
                <td>{m.label}</td>
                <td>
                  {fmt(m.value, 3)} {m.unit}
                </td>
                <td className="muted">{m.limit !== undefined ? `${m.relation ?? ""} ${fmt(m.limit, 3)} ${m.unit}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ValidationPanel({ report }: { report: ValidationReport | null }) {
  const [filter, setFilter] = useState<Status | "all">("all");
  const [openCat, setOpenCat] = useState<Set<string>>(new Set());
  if (!report) return <p className="muted">No design loaded.</p>;
  const s = report.summary;
  const byCat = new Map<CheckCategory, Check[]>();
  for (const c of report.checks) if (filter === "all" || c.status === filter) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
  const order: Status[] = ["fail", "warn", "pass"];
  return (
    <div className="validation">
      <div className={`verdict verdict-${report.status}`}>
        <div className="verdict-title">{report.status === "pass" ? "Feasible" : report.status === "warn" ? "Feasible with warnings" : "Not feasible as designed"}</div>
        <div className="verdict-counts">
          {order.map((st) => (
            <button key={st} className={`count count-${st} ${filter === st ? "on" : ""}`} onClick={() => setFilter(filter === st ? "all" : st)}>
              {report.counts[st]} {st}
            </button>
          ))}
        </div>
      </div>
      <div className="summary-grid">
        <div>
          <label>Mass</label>
          <b>{fmt(s.totalMass_kg)} kg</b>
        </div>
        <div>
          <label>Bus</label>
          <b>{fmt(s.busVoltage_V, 1)} V</b>
        </div>
        <div>
          <label>Battery</label>
          <b>{fmt(s.batteryEnergy_Wh, 0)} Wh</b>
        </div>
        <div>
          <label>Avg power</label>
          <b>{fmt(s.averagePower_W, 1)} W</b>
        </div>
        <div>
          <label>Runtime</label>
          <b>{fmt(s.runtime_min, 0)} min</b>
        </div>
        <div>
          <label>Parts cost</label>
          <b>${fmt(s.totalCost_usd, 0)}</b>
        </div>
      </div>
      <h4>Torque budget</h4>
      <table className="torque-table">
        <thead>
          <tr>
            <th>Joint</th>
            <th title="Peak required (load factor applied) / available stall at output">Peak N·m</th>
            <th title="RMS required / continuous rating">RMS N·m</th>
            <th title="Required / no-load output speed">rad/s</th>
          </tr>
        </thead>
        <tbody>
          {s.joints.map((j) => {
            const peakR = j.availablePeakTorque_Nm ? j.requiredPeakTorque_Nm / j.availablePeakTorque_Nm : 1;
            return (
              <tr key={j.jointId} onClick={() => setState({ selectedJoint: j.jointId, rightTab: "joint" })}>
                <td>{j.jointId}</td>
                <td>
                  <Bar ratio={peakR} />
                  {fmt(j.requiredPeakTorque_Nm, 1)} / {fmt(j.availablePeakTorque_Nm, 1)}
                </td>
                <td>
                  {fmt(j.requiredRmsTorque_Nm, 1)} / {fmt(j.availableContinuousTorque_Nm, 1)}
                </td>
                <td>
                  {fmt(j.requiredSpeed_rad_s, 1)} / {fmt(j.noLoadSpeed_rad_s, 1)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {[...byCat.entries()]
        .sort((a, b) => order.indexOf(worstOf(a[1])) - order.indexOf(worstOf(b[1])))
        .map(([cat, checks]) => {
          const w = worstOf(checks);
          const isOpen = openCat.has(cat) || w !== "pass";
          return (
            <div key={cat} className="cat">
              <div className="cat-head" onClick={() => setOpenCat((o) => new Set(o.has(cat) ? [...o].filter((x) => x !== cat) : [...o, cat]))}>
                <StatusBadge status={w} /> {CATEGORY_LABELS[cat]} <span className="muted">({checks.length})</span>
              </div>
              {isOpen && checks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).map((c) => <CheckRow key={c.id} check={c} />)}
            </div>
          );
        })}
      <p className="muted small">Hover a check to highlight the parts it concerns. Checks are computed in your browser from the design and the component library.</p>
    </div>
  );
}

function worstOf(cs: Check[]): Status {
  return cs.some((c) => c.status === "fail") ? "fail" : cs.some((c) => c.status === "warn") ? "warn" : "pass";
}

export function Bar({ ratio }: { ratio: number }) {
  const r = Math.max(0, Math.min(1.2, ratio));
  return (
    <span className="bar">
      <span className={`bar-fill ${ratio > 1 ? "over" : ratio > 0.85 ? "near" : ""}`} style={{ width: `${(r / 1.2) * 100}%` }} />
    </span>
  );
}

// ---------------------------------------------------------------- BOM

export function BomPanel({ design }: { design: RobotDesign }) {
  const bom = useMemo(() => buildBom(design, library), [design]);
  const download = () => {
    const blob = new Blob([bomToCsv(bom.rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${design.id}-bom.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="bom">
      <div className="bom-head">
        <span>
          {bom.rows.length} line items · {fmt(bom.totalMass, 2)} kg · ≈ ${fmt(bom.totalCost, 0)}
        </span>
        <button onClick={download}>Export CSV</button>
      </div>
      <table className="bom-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Part</th>
            <th>Qty</th>
            <th>Mass</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {bom.rows.map((r) => (
            <tr key={r.item} onClick={() => setState({ selectedPart: r.partIds[0], rightTab: "part" })} onMouseEnter={() => setState({ highlight: new Set(r.partIds) })} onMouseLeave={() => setState({ highlight: new Set() })}>
              <td>{r.item}</td>
              <td>
                <div>{r.name}</div>
                <div className="muted small">
                  {r.type} · {r.source}
                </div>
              </td>
              <td>{r.type.startsWith("wire") ? `${fmt(r.qty, 2)} m` : r.qty}</td>
              <td>{fmt(r.totalMass_kg * 1000, 0)} g</td>
              <td>${fmt(r.totalCost_usd, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Costs are approximate: catalogue prices for components; raw material × a process factor for fabricated parts (labour excluded).</p>
    </div>
  );
}
