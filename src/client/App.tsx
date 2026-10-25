import { useEffect, useRef } from "react";
import { parseDesign } from "../core/validate";
import { examples } from "./library";
import { getState, loadDesign, setState, useStore, type RightTab } from "./store";
import { Viewer } from "./viewer/Viewer";
import { BomPanel, Hierarchy, PartPanel, StatusBadge, ValidationPanel } from "./panels/Panels";
import { JointPanel } from "./panels/JointPanel";
import { DesignStudio } from "./studio/DesignStudio";
import { SimView } from "./sim/SimView";

function loadExample(id: string) {
  const ex = examples.find((e) => e.id === id);
  if (!ex) return;
  const { design, issues } = parseDesign(ex.raw);
  if (design) loadDesign(design, design.name);
  else alert(`Example ${id} is invalid:\n${issues.join("\n")}`);
}

export function App() {
  const mode = useStore((s) => s.mode);
  const design = useStore((s) => s.design);
  const report = useStore((s) => s.report);

  useEffect(() => {
    if (!getState().design && examples.length) loadExample(examples.find((e) => e.id.includes("quadruped"))?.id ?? examples[0].id);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Robot Design Engine <span className="muted small">feasible by construction</span>
        </div>
        <nav className="modes">
          {(
            [
              ["studio", "Design studio"],
              ["inspect", "Blueprint & inspect"],
              ["simulate", "Simulate"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setState({ mode: m })} disabled={m !== "studio" && !design}>
              {label}
            </button>
          ))}
        </nav>
        <DesignPicker />
        {design && report && (
          <div className="design-status">
            <StatusBadge status={report.status} /> {design.name}
          </div>
        )}
      </header>
      <main className="main">
        <div style={{ display: mode === "studio" ? "contents" : "none" }}>
          <DesignStudio />
        </div>
        {mode === "inspect" && design && <InspectView />}
        {mode === "simulate" && design && <SimView design={design} />}
        {mode !== "studio" && !design && <p className="muted pad">Load an example or create a design in the studio.</p>}
      </main>
    </div>
  );
}

function DesignPicker() {
  const design = useStore((s) => s.design);
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const { design: d, issues } = parseDesign(JSON.parse(await f.text()));
      if (d) loadDesign(d, f.name);
      else alert(`Not a valid Robot Design Document:\n${issues.slice(0, 15).join("\n")}`);
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const save = () => {
    if (!design) return;
    const blob = new Blob([JSON.stringify(design, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${design.id}.json`;
    a.click();
  };
  return (
    <div className="picker">
      <select value="" onChange={(e) => (loadExample(e.target.value), setState({ mode: getState().mode === "studio" ? "inspect" : getState().mode }))}>
        <option value="">Load example…</option>
        {examples.map((e) => (
          <option key={e.id} value={e.id}>
            {e.id}
          </option>
        ))}
      </select>
      <button onClick={() => fileRef.current?.click()}>Open JSON</button>
      <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      <button onClick={save} disabled={!design}>
        Save JSON
      </button>
    </div>
  );
}

function InspectView() {
  const s = useStore((x) => x);
  const design = s.design!;
  const tabs: [RightTab, string][] = [
    ["validation", "Validation"],
    ["part", "Part"],
    ["joint", "Joints & drivetrain"],
    ["bom", "Bill of materials"],
  ];
  return (
    <div className="inspect">
      {s.inspecting && (
        <aside className="left">
          <Hierarchy design={design} />
        </aside>
      )}
      <div className="center">
        <Viewer
          design={design}
          q={s.q}
          explode={s.inspecting ? s.explode : 0}
          xray={s.xray}
          hidden={s.hidden}
          isolated={s.isolated}
          selected={s.selectedPart}
          highlight={s.highlight}
          blueprint={s.blueprint}
          clip={s.clip}
          showWires={s.showWires}
          playBehavior={s.playBehavior}
          onPick={(id) => {
            if (!s.inspecting) setState({ inspecting: true, selectedPart: id, rightTab: id ? "part" : s.rightTab });
            else setState({ selectedPart: id, rightTab: id ? "part" : s.rightTab });
          }}
          onBackground={() => s.inspecting && setState({ selectedPart: null })}
        />
        {!s.inspecting && (
          <div className="hint">
            Click the robot to open it up · drag to orbit · scroll to zoom
          </div>
        )}
        {s.inspecting && <InspectToolbar />}
      </div>
      <aside className="right">
        <div className="tabs">
          {tabs.map(([t, label]) => (
            <button key={t} className={s.rightTab === t ? "on" : ""} onClick={() => setState({ rightTab: t, inspecting: t === "validation" ? s.inspecting : true })}>
              {label}
            </button>
          ))}
        </div>
        <div className="tab-body">
          {s.rightTab === "validation" && <ValidationPanel report={s.report} />}
          {s.rightTab === "part" && <PartPanel design={design} report={s.report} />}
          {s.rightTab === "joint" && <JointPanel design={design} report={s.report} />}
          {s.rightTab === "bom" && <BomPanel design={design} />}
        </div>
      </aside>
    </div>
  );
}

function InspectToolbar() {
  const explode = useStore((s) => s.explode);
  const xray = useStore((s) => s.xray);
  const clip = useStore((s) => s.clip);
  const blueprint = useStore((s) => s.blueprint);
  const wires = useStore((s) => s.showWires);
  return (
    <div className="toolbar">
      <button onClick={() => setState({ inspecting: false, selectedPart: null, explode: 0, isolated: null, hidden: new Set(), blueprint: false, xray: false, clip: { ...clip, enabled: false } })}>✕ Close</button>
      <label className="tool">
        Explode
        <input type="range" min={0} max={1.5} step={0.01} value={explode} onChange={(e) => setState({ explode: Number(e.target.value) })} />
      </label>
      <label className="tool">
        <input type="checkbox" checked={clip.enabled} onChange={(e) => setState({ clip: { ...clip, enabled: e.target.checked } })} /> Section
        <select value={clip.axis} onChange={(e) => setState({ clip: { ...clip, axis: e.target.value as "x" | "y" | "z" } })} disabled={!clip.enabled}>
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
        <input type="range" min={-1} max={1} step={0.01} value={clip.offset} disabled={!clip.enabled} onChange={(e) => setState({ clip: { ...clip, offset: Number(e.target.value) } })} />
        <button disabled={!clip.enabled} onClick={() => setState({ clip: { ...clip, flip: !clip.flip } })} title="Flip side">
          ⇄
        </button>
      </label>
      <label className="tool">
        <input type="checkbox" checked={xray} onChange={(e) => setState({ xray: e.target.checked })} /> X-ray shell
      </label>
      <label className="tool">
        <input type="checkbox" checked={blueprint} onChange={(e) => setState({ blueprint: e.target.checked })} /> Blueprint
      </label>
      <label className="tool">
        <input type="checkbox" checked={wires} onChange={(e) => setState({ showWires: e.target.checked })} /> Wiring
      </label>
    </div>
  );
}
