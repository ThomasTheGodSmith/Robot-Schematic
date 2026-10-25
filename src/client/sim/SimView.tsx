import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { RobotDesign } from "../../core/schema/design";
import type { ScenarioId, SimCommand, SimEvent, SimFrame, WorldDescriptor } from "../../sim/types";
import { Viewer } from "../viewer/Viewer";
import { Bar, fmt } from "../panels/Panels";

const SCENARIOS: { id: ScenarioId; label: string }[] = [
  { id: "flat", label: "Flat ground" },
  { id: "slope", label: "Slope" },
  { id: "steps", label: "Steps" },
  { id: "push", label: "Push disturbance" },
  { id: "payload", label: "Payload" },
];

const SPEEDS = [0.1, 0.25, 0.5, 1, 2];

interface History {
  t: number[];
  power: number[];
  height: number[];
  speed: number[];
  soc: number[];
}

export function SimView({ design }: { design: RobotDesign }) {
  const worker = useRef<Worker | null>(null);
  const [world, setWorld] = useState<WorldDescriptor | null>(null);
  const [frame, setFrame] = useState<SimFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [scenario, setScenario] = useState<ScenarioId>("flat");
  const hist = useRef<History>({ t: [], power: [], height: [], speed: [], soc: [] });
  const [, bump] = useState(0);

  const send = (c: SimCommand) => worker.current?.postMessage(c);

  useEffect(() => {
    const w = new Worker(new URL("../../sim/worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (ev: MessageEvent<SimEvent>) => {
      const e = ev.data;
      if (e.type === "ready") {
        setWorld(e.world);
        setError(null);
        hist.current = { t: [], power: [], height: [], speed: [], soc: [] };
      } else if (e.type === "frame") {
        const f = e.frame;
        const h = hist.current;
        if (h.t.length && f.t < h.t[h.t.length - 1]) hist.current = { t: [], power: [], height: [], speed: [], soc: [] };
        const hh = hist.current;
        hh.t.push(f.t);
        hh.power.push(f.power_W);
        hh.height.push(f.base.height);
        hh.speed.push(f.base.forwardSpeed);
        hh.soc.push(f.battery.soc);
        if (hh.t.length > 900) for (const k of Object.keys(hh) as (keyof History)[]) hh[k].shift();
        setFrame(f);
        bump((x) => x + 1);
        if (f.status === "fallen" || f.status === "stalled") setPlaying(false);
      } else if (e.type === "error") setError(e.message);
    };
    w.onerror = (e) => setError(e.message || "Simulation worker crashed");
    send({ type: "init", design, scenario });
    setPlaying(false);
    return () => w.terminate();
    // scenario changes are sent as commands; the worker is re-created only for a new design
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design]);

  const togglePlay = () => {
    send({ type: playing ? "pause" : "play" });
    setPlaying(!playing);
  };
  const changeScenario = (id: ScenarioId) => {
    setScenario(id);
    setPlaying(false);
    send({ type: "scenario", id });
  };

  const danger = useMemo(() => new Set(frame?.overLimitParts ?? []), [frame?.overLimitParts?.join(",")]);
  const linkPoses = frame?.links;
  const q = useMemo(() => Object.fromEntries(Object.entries(frame?.joints ?? {}).map(([k, v]) => [k, v.q])), [frame]);

  return (
    <div className="sim">
      <div className="sim-canvas">
        <Viewer design={design} q={q} linkPoses={linkPoses} danger={danger} showWires={false} followRoot={!design.rootFixed} groundTilt={world ? (world.ground.slope_deg * Math.PI) / 180 : 0}>
          {world && <WorldObjects world={world} />}
          {frame && <ComMarker com={frame.com} />}
        </Viewer>
        <div className="sim-controls">
          <button className="primary" onClick={togglePlay} disabled={!world}>
            {playing ? "❚❚ Pause" : "▶ Run"}
          </button>
          <button onClick={() => send({ type: "step", steps: 10 })} disabled={playing || !world} title="Advance 10 physics steps">
            Step
          </button>
          <button onClick={() => (send({ type: "reset" }), setPlaying(false))}>Reset</button>
          <select value={speed} onChange={(e) => (setSpeed(Number(e.target.value)), send({ type: "speed", value: Number(e.target.value) }))} title="Time scale">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s === 1 ? "real time" : `${s}× ${s < 1 ? "slow-mo" : "fast"}`}
              </option>
            ))}
          </select>
          <select value={scenario} onChange={(e) => changeScenario(e.target.value as ScenarioId)}>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button onClick={() => send({ type: "push" })} disabled={design.rootFixed} title="Shove the robot sideways">
            Push
          </button>
        </div>
        {frame && <StatusBanner frame={frame} />}
        {error && <div className="sim-banner fallen">Simulation error: {error}</div>}
      </div>
      <Telemetry frame={frame} design={design} hist={hist.current} />
    </div>
  );
}

function StatusBanner({ frame }: { frame: SimFrame }) {
  if (frame.status === "running" || frame.status === "ok") return <div className="sim-time">t = {frame.t.toFixed(2)} s</div>;
  return (
    <div className={`sim-banner ${frame.status}`}>
      {frame.status === "fallen" ? "Robot fell" : "Battery exhausted"} at t = {frame.t.toFixed(2)} s{frame.message ? ` — ${frame.message}` : ""}
    </div>
  );
}

function WorldObjects({ world }: { world: WorldDescriptor }) {
  const slope = (world.ground.slope_deg * Math.PI) / 180;
  return (
    <group>
      {slope !== 0 && (
        <mesh rotation={[0, -slope, 0]} position={[0, 0, -0.0005]} receiveShadow>
          <planeGeometry args={[12, 6]} />
          <meshStandardMaterial color="#56606e" transparent opacity={0.55} />
        </mesh>
      )}
      {world.obstacles.map((o) => (
        <mesh key={o.id} position={o.p as [number, number, number]} quaternion={new THREE.Quaternion(...(o.q as [number, number, number, number]))} castShadow receiveShadow>
          <boxGeometry args={o.size as [number, number, number]} />
          <meshStandardMaterial color="#7a8696" />
        </mesh>
      ))}
    </group>
  );
}

function ComMarker({ com }: { com: number[] }) {
  return (
    <group>
      <mesh position={com as [number, number, number]}>
        <sphereGeometry args={[0.012, 16, 12]} />
        <meshBasicMaterial color="#ffd400" depthTest={false} />
      </mesh>
      <mesh position={[com[0], com[1], 0.001]}>
        <ringGeometry args={[0.012, 0.018, 24]} />
        <meshBasicMaterial color="#ffd400" />
      </mesh>
    </group>
  );
}

function Spark({ data, color, label, unit, digits = 1 }: { data: number[]; color: string; label: string; unit: string; digits?: number }) {
  const w = 220, h = 44;
  if (data.length < 2)
    return (
      <div className="spark">
        <div className="spark-label">{label}</div>
      </div>
    );
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`).join(" ");
  return (
    <div className="spark">
      <div className="spark-label">
        {label}: <b>{fmt(data[data.length - 1], digits)}</b> {unit} <span className="muted">(min {fmt(min, digits)}, max {fmt(max, digits)})</span>
      </div>
      <svg width={w} height={h}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      </svg>
    </div>
  );
}

function Telemetry({ frame, design, hist }: { frame: SimFrame | null; design: RobotDesign; hist: History }) {
  if (!frame) return <aside className="telemetry muted">Initialising physics…</aside>;
  const deg = (r: number) => (r * 180) / Math.PI;
  return (
    <aside className="telemetry">
      <div className="tele-grid">
        <div>
          <label>Power</label>
          <b>{fmt(frame.power_W, 1)} W</b>
        </div>
        <div>
          <label>Battery</label>
          <b>
            {fmt(frame.battery.soc * 100, 1)}% · {fmt(frame.battery.voltage, 2)} V
          </b>
        </div>
        <div>
          <label>Current</label>
          <b>{fmt(frame.battery.current_A, 2)} A</b>
        </div>
        <div>
          <label>Base height</label>
          <b>{fmt(frame.base.height * 1000, 0)} mm</b>
        </div>
        <div>
          <label>Roll / pitch</label>
          <b>
            {fmt(deg(frame.base.roll), 1)}° / {fmt(deg(frame.base.pitch), 1)}°
          </b>
        </div>
        <div>
          <label>Speed · distance</label>
          <b>
            {fmt(frame.base.forwardSpeed, 2)} m/s · {fmt(frame.base.distance, 2)} m
          </b>
        </div>
        <div>
          <label>COM</label>
          <b className="mono">{frame.com.map((c) => fmt(c, 3)).join(", ")}</b>
        </div>
      </div>
      <Spark data={hist.power} color="#ff9f43" label="Power" unit="W" />
      <Spark data={hist.height.map((x) => x * 1000)} color="#4dabf7" label="Base height" unit="mm" digits={0} />
      {!design.rootFixed && <Spark data={hist.speed} color="#51cf66" label="Forward speed" unit="m/s" digits={2} />}
      <h4>Joints (applied torque vs available)</h4>
      <table className="tele-joints">
        <tbody>
          {Object.entries(frame.joints).map(([id, j]) => (
            <tr key={id} className={j.saturated || j.overheated ? "sat" : ""}>
              <td title={id}>{design.joints.find((x) => x.id === id)?.name ?? id}</td>
              <td>
                <Bar ratio={Math.abs(j.torque) / Math.max(1e-6, j.torqueLimit)} />
                <span className="mono">
                  {fmt(j.torque, 2)}/{fmt(j.torqueLimit, 1)}
                </span>
              </td>
              <td className="mono">{fmt(j.current_A, 1)} A</td>
              <td className={`mono ${j.overheated ? "hot" : ""}`}>{fmt(j.temp_C, 0)}°C</td>
            </tr>
          ))}
        </tbody>
      </table>
      {frame.contacts.length > 0 && (
        <>
          <h4>Contact forces</h4>
          <table className="tele-joints">
            <tbody>
              {frame.contacts.map((c) => (
                <tr key={c.linkId}>
                  <td>{design.links.find((l) => l.id === c.linkId)?.name ?? c.linkId}</td>
                  <td>
                    <Bar ratio={c.force_N / Math.max(1, frame.contacts.reduce((s, x) => s + x.force_N, 0))} />
                    <span className="mono">{fmt(c.force_N, 1)} N</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted small">Torques are clamped by each drivetrain's torque–speed curve, driver current limit, gear ratings and winding temperature. Parts turn red when their joint saturates or overheats.</p>
    </aside>
  );
}
