import { Matrix4, Vector3 } from "three";
import type { Analysis } from "./analysis";
import { maxAbs, rms, robotComNominal } from "./analysis";
import { fmt, grade, worst, type Check, type Status } from "./report";
import { outputNoLoadSpeed, outputTorqueAt, stageTorqueLimit, motorElectrical, type ResolvedDrivetrain } from "../drivetrain";
import { forwardKinematics, poseToMatrix, subtreeLinks } from "../math/frames";
import { sectionProperties, shapeHalfExtents } from "../math/shapes";
import { makeOBB, obbOverlap, type OBB } from "../math/obb";
import { pointOnLink } from "../math/ik";
import type { ComponentPart, Part } from "../schema/design";

type C = Omit<Check, "id"> & { id?: string };
const out = (list: Check[], c: C) => list.push({ id: c.id ?? `${c.category}:${list.length}`, ...c });

// ---------------------------------------------------------------- integrity
export function integrityChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const d = a.design;
  const errs: string[] = [...a.topo.errors];
  const ids = new Set<string>();
  for (const l of d.links)
    for (const p of l.parts) {
      if (ids.has(p.id)) errs.push(`Duplicate part id '${p.id}'`);
      ids.add(p.id);
      if (p.kind === "component" && !a.lib.get(p.componentId)) errs.push(`Part '${p.id}' uses unknown component '${p.componentId}'`);
      if (p.kind === "fabricated" && !a.lib.material(p.material)) errs.push(`Part '${p.id}' uses unknown material '${p.material}'`);
    }
  for (const id of d.links.map((l) => l.id)) if (ids.has(id)) errs.push(`Link id '${id}' collides with a part id`);
  errs.push(...a.drivetrainErrors);

  const dtByJoint = new Map<string, number>();
  for (const dt of d.drivetrains) {
    const j = a.topo.joints.get(dt.jointId);
    if (!j) errs.push(`Drivetrain '${dt.id}' references unknown joint '${dt.jointId}'`);
    else if (j.type === "fixed") errs.push(`Drivetrain '${dt.id}' drives fixed joint '${j.id}'`);
    dtByJoint.set(dt.jointId, (dtByJoint.get(dt.jointId) ?? 0) + 1);
    for (const ref of [dt.driverPartId, dt.encoderPartId, ...dt.bearingPartIds].filter(Boolean) as string[])
      if (!a.parts.has(ref)) errs.push(`Drivetrain '${dt.id}' references unknown part '${ref}'`);
  }
  const unactuated: string[] = [];
  for (const j of d.joints) {
    if (j.type === "fixed") continue;
    const n = dtByJoint.get(j.id) ?? 0;
    if (n === 0) unactuated.push(j.id);
    if (n > 1) errs.push(`Joint '${j.id}' has ${n} drivetrains`);
    if (j.type !== "continuous" && !j.limits) errs.push(`Joint '${j.id}' (${j.type}) needs limits`);
    if (j.limits && j.limits.lower >= j.limits.upper) errs.push(`Joint '${j.id}' has lower limit >= upper limit`);
    const nom = d.behavior.nominalPose[j.id];
    if (j.limits && nom !== undefined && j.type !== "continuous" && (nom < j.limits.lower || nom > j.limits.upper))
      errs.push(`Nominal pose of '${j.id}' (${fmt(nom)}) is outside its limits`);
  }
  for (const jid of Object.keys(d.behavior.nominalPose)) if (!a.topo.joints.has(jid)) errs.push(`Nominal pose references unknown joint '${jid}'`);
  const g = d.behavior.gait;
  if (d.behavior.mode === "legged_gait") {
    if (!g) errs.push("Behaviour mode 'legged_gait' requires a gait spec");
    for (const leg of g?.legs ?? []) {
      for (const jid of leg.jointIds) if (!a.topo.joints.has(jid)) errs.push(`Gait leg '${leg.name}' references unknown joint '${jid}'`);
      const fl = a.topo.links.get(leg.footLinkId);
      if (!fl) errs.push(`Gait leg '${leg.name}' references unknown foot link '${leg.footLinkId}'`);
      else if (!fl.contact) errs.push(`Foot link '${leg.footLinkId}' has no contact definition`);
    }
  }
  if (d.behavior.mode === "wheeled" && !d.behavior.wheels) errs.push("Behaviour mode 'wheeled' requires a wheels spec");
  if (d.behavior.mode === "manipulator" && !d.behavior.manipulator) errs.push("Behaviour mode 'manipulator' requires waypoints");
  for (const id of d.power.batteryPartIds) {
    const p = a.parts.get(id)?.part;
    if (!p || p.kind !== "component" || !a.lib.getAs(p.componentId, "battery")) errs.push(`Power battery '${id}' is not a battery component part`);
  }
  if (!d.rootFixed && !d.links.some((l) => l.contact)) errs.push("Free-standing robot has no ground contact links");
  const ikWorst = Math.max(0, ...a.samples.map((s) => s.ikError));

  out(list, {
    id: "integrity:references",
    category: "integrity",
    title: "Kinematic tree and references",
    status: errs.length ? "fail" : "pass",
    message: errs.length ? errs.slice(0, 12).join("; ") + (errs.length > 12 ? ` (+${errs.length - 12} more)` : "") : `${d.links.length} links, ${d.joints.length} joints, ${d.drivetrains.length} drivetrains; all references resolve.`,
    metrics: [{ label: "Problems", value: errs.length, unit: "", limit: 0, relation: "=" }],
    involves: [],
  });
  out(list, {
    id: "integrity:actuation",
    category: "integrity",
    title: "Every moving joint is actuated",
    status: unactuated.length ? "fail" : "pass",
    message: unactuated.length ? `No drivetrain (infinite-torque joints are not allowed): ${unactuated.join(", ")}` : "All non-fixed joints have a motor drivetrain.",
    metrics: [],
    involves: unactuated,
  });
  if (d.behavior.mode === "legged_gait") {
    out(list, {
      id: "integrity:gait_reach",
      category: "integrity",
      title: "Gait foot trajectory is reachable",
      status: ikWorst > 0.01 ? "fail" : ikWorst > 0.002 ? "warn" : "pass",
      message:
        ikWorst > 0.002
          ? `Inverse kinematics cannot reach the commanded foot path (worst error ${fmt(ikWorst * 1000, 1)} mm): stride/step height exceed the leg workspace or joint limits.`
          : "All foot targets over the gait cycle are reachable within joint limits.",
      metrics: [{ label: "Worst IK error", value: ikWorst * 1000, unit: "mm", limit: 2, relation: "≤" }],
      involves: (d.behavior.gait?.legs ?? []).flatMap((l) => l.jointIds),
    });
  }
  return list;
}

// ---------------------------------------------------------------- mass
export function massChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const req = a.design.requirements;
  const m = a.totalMass;
  if (req.maxMass_kg) {
    out(list, {
      id: "mass:budget",
      category: "mass",
      title: "Total mass vs budget",
      status: grade(m, req.maxMass_kg, 0.95),
      message: `Total mass ${fmt(m)} kg (incl. ${fmt(req.payload_kg)} kg payload) against a ${fmt(req.maxMass_kg)} kg budget.`,
      metrics: [{ label: "Mass", value: m, unit: "kg", limit: req.maxMass_kg, relation: "≤" }],
      involves: [],
    });
  } else {
    out(list, {
      id: "mass:budget",
      category: "mass",
      title: "Total mass",
      status: "pass",
      message: `Total mass ${fmt(m)} kg including ${fmt(req.payload_kg)} kg payload (no explicit budget set).`,
      metrics: [{ label: "Mass", value: m, unit: "kg" }],
      involves: [],
    });
  }
  const zeroMass = [...a.linkMP.entries()].filter(([, mp]) => mp.mass <= 1e-6).map(([id]) => id);
  if (zeroMass.length)
    out(list, {
      id: "mass:zero",
      category: "mass",
      title: "Links without mass",
      status: "fail",
      message: `Links with no parts/mass cannot be simulated: ${zeroMass.join(", ")}`,
      metrics: [],
      involves: zeroMass,
    });
  return list;
}

// ---------------------------------------------------------------- torque / speed / gearing
export function actuatorChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const SF = a.design.requirements.safetyFactor;
  for (const j of a.design.joints) {
    if (j.type === "fixed") continue;
    const rd = a.drivetrains.get(j.id);
    const o = a.ops.get(j.id);
    if (!rd || !o) continue;
    const involves = [j.id, rd.id, rd.motor.partId, ...rd.stages.map((s) => s.partId).filter(Boolean) as string[]];
    const unit = j.type === "prismatic" ? "N" : "N·m";

    // Worst operating point against the speed-dependent torque curve.
    let worstRatio = 0, worstIdx = 0;
    o.torquePeak.forEach((t, i) => {
      const avail = outputTorqueAt(rd, o.speed[i], "peak");
      const r = (Math.abs(t) * SF) / Math.max(1e-9, avail);
      if (r > worstRatio) {
        worstRatio = r;
        worstIdx = i;
      }
    });
    const tPeak = maxAbs(o.torquePeak);
    const tW = Math.abs(o.torquePeak[worstIdx] ?? 0), wW = Math.abs(o.speed[worstIdx] ?? 0);
    const availW = outputTorqueAt(rd, wW, "peak");
    out(list, {
      id: `torque:peak:${j.id}`,
      category: "torque",
      title: `${j.name}: peak torque`,
      status: grade(tW * SF, availW, 0.9),
      message: `Worst operating point needs ${fmt(tW)} ${unit} at ${fmt(wW)} rad/s (×${SF} safety = ${fmt(tW * SF)}); drivetrain delivers ${fmt(availW)} ${unit} at that speed (${rd.motor.name}, ratio ${fmt(rd.totalRatio, 1)}:1, η ${fmt(rd.totalEfficiency)}).`,
      metrics: [
        { label: "Required × SF", value: tW * SF, unit, limit: availW, relation: "≤" },
        { label: "Max required (any speed)", value: tPeak, unit },
        { label: "Stall torque at output", value: outputTorqueAt(rd, 0, "peak"), unit },
      ],
      involves,
    });

    const tRms = rms(o.torqueStatic);
    const cont = outputTorqueAt(rd, rms(o.speed), "continuous");
    out(list, {
      id: `torque:continuous:${j.id}`,
      category: "torque",
      title: `${j.name}: continuous torque`,
      status: grade(tRms, cont, 0.85),
      message: `RMS torque over the behaviour cycle is ${fmt(tRms)} ${unit}; continuous rating at output is ${fmt(cont)} ${unit}.`,
      metrics: [{ label: "RMS torque", value: tRms, unit, limit: cont, relation: "≤" }],
      involves,
    });

    const noLoad = outputNoLoadSpeed(rd);
    const reqSpeed = Math.max(maxAbs(o.speed), j.limits?.velocity ?? 0);
    out(list, {
      id: `speed:${j.id}`,
      category: "speed",
      title: `${j.name}: speed`,
      status: grade(reqSpeed, noLoad, 0.8),
      message: `Needs ${fmt(reqSpeed)} rad/s (gait/limits); no-load output speed is ${fmt(noLoad)} rad/s at ${fmt(rd.motor.nominalVoltage_V, 0)} V.`,
      metrics: [{ label: "Required speed", value: reqSpeed, unit: j.type === "prismatic" ? "m/s" : "rad/s", limit: noLoad, relation: "≤" }],
      involves,
    });

    // Gear stage ratings
    const sp = stageTorqueLimit(rd, "peak");
    const sr = stageTorqueLimit(rd, "rated");
    if (Number.isFinite(sp.limit)) {
      const st = worst([grade(tPeak * SF, sp.limit, 0.9), grade(tRms, sr.limit, 0.9)]);
      out(list, {
        id: `gearing:${j.id}`,
        category: "gearing",
        title: `${j.name}: gear stage ratings`,
        status: st,
        message: `Weakest stage for peak load: ${sp.stage?.label} (${fmt(sp.limit)} ${unit} at the joint); for continuous load: ${sr.stage?.label ?? "n/a"} (${fmt(sr.limit)} ${unit}).`,
        metrics: [
          { label: "Peak × SF", value: tPeak * SF, unit, limit: sp.limit, relation: "≤" },
          { label: "RMS", value: tRms, unit, limit: sr.limit, relation: "≤" },
        ],
        involves: [j.id, ...(sp.stage?.partId ? [sp.stage.partId] : [])],
      });
    }
    let inSpeed = reqSpeed;
    const speedIssues: string[] = [];
    for (let i = rd.stages.length - 1; i >= 0; i--) {
      inSpeed *= rd.stages[i].ratio;
      const mx = rd.stages[i].maxInputSpeed;
      if (mx && inSpeed > mx) speedIssues.push(`${rd.stages[i].label}: input ${fmt(inSpeed, 0)} rad/s > ${fmt(mx, 0)} rad/s`);
    }
    if (speedIssues.length)
      out(list, {
        id: `gearing:speed:${j.id}`,
        category: "gearing",
        title: `${j.name}: gearbox input speed`,
        status: "fail",
        message: speedIssues.join("; "),
        metrics: [],
        involves: [j.id],
      });

    // Linkage transmission angle
    for (const s of rd.stages)
      if (s.kind === "linkage" && s.linkage)
        out(list, {
          id: `gearing:linkage:${j.id}`,
          category: "gearing",
          title: `${j.name}: linkage`,
          status: "pass",
          message: `Four-bar ratio ${fmt(s.ratio)} at the nominal crank angle. ${s.notes ?? ""}`,
          metrics: [],
          involves: [j.id],
        });
  }
  return list;
}

// ---------------------------------------------------------------- electrical
function compOf(a: Analysis, partId: string) {
  const p = a.parts.get(partId)?.part;
  return p && p.kind === "component" ? a.lib.get(p.componentId) : undefined;
}

/** Supply voltage seen by a part: a regulator output if one lists it, else the battery bus. */
function supplyVoltage(a: Analysis, partId: string): number | null {
  for (const r of a.design.power.regulators) {
    if (r.loadPartIds.includes(partId)) {
      const c = compOf(a, r.partId);
      if (c?.category === "regulator") return c.specs.output_V;
    }
  }
  return a.busVoltage;
}

/** Typical (and peak) electrical power of non-motor consumers. */
export function electronicsPower(a: Analysis): { typical: number; peak: number; byPart: Map<string, { typical: number; peak: number }> } {
  const byPart = new Map<string, { typical: number; peak: number }>();
  let typical = 0, peak = 0;
  for (const [id, ref] of a.parts) {
    if (ref.part.kind !== "component") continue;
    const c = a.lib.get(ref.part.componentId);
    if (!c) continue;
    let t = 0, p = 0;
    if (c.category === "compute") (t = c.specs.typicalPower_W), (p = c.specs.peakPower_W);
    else if (c.category === "sensor") t = p = c.specs.power_W;
    else if (c.category === "lighting") (t = c.specs.power_W * 0.6), (p = c.specs.power_W);
    else if (c.category === "driver") t = p = c.specs.idlePower_W;
    else if (c.category === "electrical" && c.specs.power_W > 0) t = p = c.specs.power_W;
    else continue;
    byPart.set(id, { typical: t, peak: p });
    typical += t;
    peak += p;
  }
  return { typical, peak, byPart };
}

export function electricalChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const bus = a.busVoltage;
  if (bus === null) {
    out(list, { id: "electrical:battery", category: "electrical", title: "Battery", status: "fail", message: "No valid battery found in power.batteryPartIds.", metrics: [], involves: a.design.power.batteryPartIds });
    return list;
  }
  // Motors and drivers vs bus
  const driverLoads = new Map<string, string[]>();
  for (const dt of a.design.drivetrains) {
    const rd = a.drivetrains.get(dt.jointId);
    if (!rd) continue;
    driverLoads.set(dt.driverPartId, [...(driverLoads.get(dt.driverPartId) ?? []), dt.id]);
    const mc = compOf(a, rd.motor.partId);
    const mv = supplyVoltage(a, rd.motor.partId) ?? bus;
    const issues: string[] = [];
    let st: Status = "pass";
    if (mc?.category === "servo") {
      const [lo, hi] = mc.specs.voltageRange_V;
      if (mv < lo || mv > hi) (st = "fail"), issues.push(`servo accepts ${lo}-${hi} V but is fed ${fmt(mv, 1)} V`);
    } else if (mc?.category === "motor") {
      const r = mv / mc.specs.nominalVoltage_V;
      if (r > 1.6) (st = "fail"), issues.push(`bus ${fmt(mv, 1)} V is ${fmt(r, 1)}× the motor's ${mc.specs.nominalVoltage_V} V rating`);
      else if (r < 0.6) (st = worst([st, "warn"])), issues.push(`bus ${fmt(mv, 1)} V is well below the motor's ${mc.specs.nominalVoltage_V} V rating; speed derates proportionally`);
    }
    const dc = compOf(a, dt.driverPartId);
    if (!dc || dc.category !== "driver") {
      st = "fail";
      issues.push(`driver part '${dt.driverPartId}' is not a driver component`);
    } else {
      const [lo, hi] = dc.specs.voltageRange_V;
      const dv = supplyVoltage(a, dt.driverPartId) ?? bus;
      if (dv < lo || dv > hi) (st = "fail"), issues.push(`${dc.name} accepts ${lo}-${hi} V, fed ${fmt(dv, 1)} V`);
      const need = mc?.category === "servo" ? "servo" : mc?.category === "motor" ? mc.specs.motorType : "";
      if (need && !dc.specs.supports.includes(need as never)) (st = "fail"), issues.push(`${dc.name} cannot drive a ${need}`);
      // Current
      const o = a.ops.get(dt.jointId)!;
      const peakI = Math.max(...o.torquePeak.map((t, i) => motorElectrical(rd, t, o.speed[i]).current));
      const rmsI = rms(o.torqueStatic.map((t, i) => motorElectrical(rd, t, o.speed[i]).current));
      if (mc?.category !== "servo" || dc.specs.driverType !== "servo_bus") {
        // dedicated driver channel: phase current limits
        if (peakI > dc.specs.peakCurrent_A) (st = "fail"), issues.push(`peak motor current ${fmt(peakI, 1)} A exceeds driver peak ${dc.specs.peakCurrent_A} A`);
        if (rmsI > dc.specs.continuousCurrent_A) (st = "fail"), issues.push(`RMS current ${fmt(rmsI, 1)} A exceeds driver continuous ${dc.specs.continuousCurrent_A} A`);
      }
      if (peakI > rd.motor.peakCurrent * 1.05) (st = "fail"), issues.push(`peak current ${fmt(peakI, 1)} A exceeds motor peak ${fmt(rd.motor.peakCurrent, 1)} A`);
    }
    out(list, {
      id: `electrical:${dt.id}`,
      category: "electrical",
      title: `${a.topo.joints.get(dt.jointId)?.name ?? dt.jointId}: motor/driver compatibility`,
      status: st,
      message: issues.length ? issues.join("; ") : `Motor, driver and ${fmt(mv, 1)} V supply are compatible; currents within driver and motor limits.`,
      metrics: [],
      involves: [dt.jointId, dt.motorPartId, dt.driverPartId],
    });
  }
  // Driver channel counts and shared-bus current (servo buses sum their servo currents)
  for (const [driverId, dts] of driverLoads) {
    const dc = compOf(a, driverId);
    if (!dc || dc.category !== "driver") continue;
    const st: Status[] = [];
    const msgs: string[] = [];
    if (dts.length > dc.specs.channels) st.push("fail"), msgs.push(`${dts.length} motors on a ${dc.specs.channels}-channel driver`);
    if (dc.specs.driverType === "servo_bus") {
      let peak = 0;
      const n = a.motorPowerPeak.length;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (const dtid of dts) {
          const dt = a.design.drivetrains.find((d) => d.id === dtid)!;
          const rd = a.drivetrains.get(dt.jointId);
          const o = a.ops.get(dt.jointId);
          if (rd && o && o.torquePeak[i] !== undefined) s += motorElectrical(rd, o.torquePeak[i], o.speed[i]).electricalPower / (a.busVoltage ?? 1);
        }
        peak = Math.max(peak, s);
      }
      st.push(grade(peak, dc.specs.continuousCurrent_A, 0.85));
      msgs.push(`shared supply current peaks at ${fmt(peak, 1)} A vs ${dc.specs.continuousCurrent_A} A rating`);
    }
    out(list, {
      id: `electrical:driver:${driverId}`,
      category: "electrical",
      title: `${dc.name}: channels and supply`,
      status: worst(st),
      message: msgs.join("; ") || `${dts.length}/${dc.specs.channels} channels used.`,
      metrics: [{ label: "Channels used", value: dts.length, unit: "", limit: dc.specs.channels, relation: "≤" }],
      involves: [driverId],
    });
  }
  // Electronics supply voltages and regulators
  const ep = electronicsPower(a);
  const vIssues: string[] = [];
  const vInvolves: string[] = [];
  for (const [id] of ep.byPart) {
    const c = compOf(a, id)!;
    const v = supplyVoltage(a, id) ?? bus;
    let ok = true;
    if (c.category === "compute") ok = v >= c.specs.voltageRange_V[0] * 0.98 && v <= c.specs.voltageRange_V[1] * 1.02;
    else if (c.category === "sensor") ok = Math.abs(v - c.specs.voltage_V) / c.specs.voltage_V < 0.55 && v <= c.specs.voltage_V * 1.55; // 3.3V parts commonly have onboard LDOs from 5V
    else if (c.category === "lighting") ok = Math.abs(v - c.specs.voltage_V) / c.specs.voltage_V < 0.1;
    else if (c.category === "electrical") ok = v >= c.specs.voltageRange_V[0] && v <= c.specs.voltageRange_V[1];
    if (!ok) vIssues.push(`${c.name} (${id}) fed ${fmt(v, 1)} V`), vInvolves.push(id);
  }
  out(list, {
    id: "electrical:supply_rails",
    category: "electrical",
    title: "Electronics supply rails",
    status: vIssues.length ? "fail" : "pass",
    message: vIssues.length ? `Wrong supply voltage (add/route a regulator): ${vIssues.join("; ")}` : "All compute, sensor, lighting and powered electrical loads see a compatible supply voltage.",
    metrics: [],
    involves: vInvolves,
  });
  for (const r of a.design.power.regulators) {
    const c = compOf(a, r.partId);
    if (!c || c.category !== "regulator") {
      out(list, { category: "electrical", title: `Regulator ${r.partId}`, status: "fail", message: `'${r.partId}' is not a regulator component`, metrics: [], involves: [r.partId] });
      continue;
    }
    let load = 0;
    for (const id of r.loadPartIds) load += ep.byPart.get(id)?.peak ?? 0;
    // servo/motor loads on a regulator rail
    for (const dt of a.design.drivetrains)
      if (r.loadPartIds.includes(dt.motorPartId)) load += Math.max(...(a.ops.get(dt.jointId)?.torquePeak ?? [0]).map((t, i) => motorElectrical(a.drivetrains.get(dt.jointId)!, t, a.ops.get(dt.jointId)!.speed[i]).electricalPower));
    const I = load / c.specs.output_V;
    const inOk = bus >= c.specs.inputRange_V[0] && bus <= c.specs.inputRange_V[1];
    out(list, {
      id: `electrical:reg:${r.partId}`,
      category: "electrical",
      title: `${c.name}: load`,
      status: inOk ? grade(I, c.specs.maxCurrent_A, 0.8) : "fail",
      message: inOk
        ? `${fmt(I, 2)} A peak on the ${c.specs.output_V} V rail (rated ${c.specs.maxCurrent_A} A).`
        : `Input ${fmt(bus, 1)} V outside regulator range ${c.specs.inputRange_V.join("-")} V.`,
      metrics: [{ label: "Rail current", value: I, unit: "A", limit: c.specs.maxCurrent_A, relation: "≤" }],
      involves: [r.partId, ...r.loadPartIds],
    });
  }
  return list;
}

// ---------------------------------------------------------------- power & runtime
export function powerChecks(a: Analysis): { checks: Check[]; avgPower: number | null; peakPower: number | null; runtime: number | null } {
  const list: Check[] = [];
  const b = a.battery;
  if (!b) return { checks: list, avgPower: null, peakPower: null, runtime: null };
  const req = a.design.requirements;
  const ep = electronicsPower(a);
  const cycleAvg = a.motorPowerStatic.length ? a.motorPowerStatic.reduce((s, x) => s + x, 0) / a.motorPowerStatic.length : 0;
  // Idle (holding the nominal pose) power: first static sample torque at zero speed
  let idle = 0;
  for (const [jid, rd] of a.drivetrains) {
    const o = a.ops.get(jid);
    if (o) idle += motorElectrical(rd, rms(o.torqueStatic), 0).electricalPower;
  }
  const avg = req.dutyCycle * cycleAvg + (1 - req.dutyCycle) * idle + ep.typical;
  const peak = Math.max(0, ...a.motorPowerPeak) + ep.peak;
  const usable = b.energy_Wh * 0.8;
  const runtime = (usable / Math.max(avg, 1e-6)) * 60;
  const Iavg = avg / b.voltage, Ipeak = peak / b.voltage;
  const sag = Ipeak * b.internalResistance;
  out(list, {
    id: "power:runtime",
    category: "power",
    title: "Battery runtime",
    status: req.minRuntime_min > 0 ? grade(req.minRuntime_min, runtime, 0.9) : "pass",
    message: `Average draw ${fmt(avg, 1)} W (motors ${fmt(cycleAvg, 1)} W while moving, ${fmt(idle, 1)} W holding, electronics ${fmt(ep.typical, 1)} W, duty ${fmt(req.dutyCycle * 100, 0)}%) from ${fmt(b.energy_Wh, 0)} Wh (80% usable) gives ${fmt(runtime, 0)} min.`,
    metrics: [
      { label: "Runtime", value: runtime, unit: "min", limit: req.minRuntime_min || undefined, relation: "≥" },
      { label: "Average power", value: avg, unit: "W" },
    ],
    involves: b.partIds,
  });
  out(list, {
    id: "power:continuous_current",
    category: "power",
    title: "Battery continuous discharge",
    status: grade(Iavg, b.maxContinuous_A, 0.8),
    message: `Average battery current ${fmt(Iavg, 1)} A vs ${fmt(b.maxContinuous_A, 0)} A continuous rating.`,
    metrics: [{ label: "Average current", value: Iavg, unit: "A", limit: b.maxContinuous_A, relation: "≤" }],
    involves: b.partIds,
  });
  out(list, {
    id: "power:peak_current",
    category: "power",
    title: "Battery peak discharge",
    status: worst([grade(Ipeak, b.peak_A, 0.85), b.voltage - sag < b.minVoltage ? "warn" : "pass"]),
    message: `Peak battery current ${fmt(Ipeak, 1)} A (all joints at their simultaneous worst point, ×${req.dynamicLoadFactor} load factor) vs ${fmt(b.peak_A, 0)} A burst rating; voltage sag ${fmt(sag, 2)} V.`,
    metrics: [
      { label: "Peak current", value: Ipeak, unit: "A", limit: b.peak_A, relation: "≤" },
      { label: "Peak power", value: peak, unit: "W" },
    ],
    involves: b.partIds,
  });
  list.push(...protectionChecks(a, Iavg, Ipeak));
  return { checks: list, avgPower: avg, peakPower: peak, runtime };
}

/** Fuse, main switch / e-stop and power distribution between the battery and the loads. */
function protectionChecks(a: Analysis, Iavg: number, Ipeak: number): Check[] {
  const list: Check[] = [];
  const b = a.battery!;
  const parts = [...a.parts.keys()]
    .map((id) => ({ id, c: compOf(a, id) }))
    .filter((x): x is { id: string; c: Extract<NonNullable<ReturnType<typeof compOf>>, { category: "electrical" }> } => x.c?.category === "electrical");
  const ofType = (...t: string[]) => parts.filter((x) => t.includes(x.c.specs.electricalType));
  const fuses = ofType("fuse");
  const switches = ofType("switch", "estop", "power_distribution");

  if (!fuses.length)
    out(list, { id: "power:fuse", category: "power", title: "Battery fuse", status: "warn", message: "No fuse between the battery and the loads; a short anywhere would be limited only by the battery's burst current.", metrics: [], involves: b.partIds });
  for (const f of fuses) {
    const s = f.c.specs;
    const st: Status[] = [];
    const msgs: string[] = [];
    if (b.maxVoltage > s.voltageRange_V[1]) st.push("fail"), msgs.push(`fully charged pack ${fmt(b.maxVoltage, 1)} V exceeds the fuse's ${s.voltageRange_V[1]} V rating`);
    if (s.currentRating_A < Iavg * 1.25) st.push("fail"), msgs.push(`rating is below 1.25× the ${fmt(Iavg, 1)} A average draw, so it would blow in normal use`);
    else if (Ipeak > s.currentRating_A * 2) st.push("warn"), msgs.push(`peak draw ${fmt(Ipeak, 1)} A is over twice the rating and may blow it on load spikes`);
    // The fuse must open before the wire directly after it overheats
    for (const w of a.design.power.wiring.filter((w) => w.from === f.id && w.kind === "power")) {
      const wc = a.lib.getAs(w.wireComponentId, "wire");
      if (wc && wc.specs.maxCurrent_A < s.currentRating_A) st.push("warn"), msgs.push(`wire '${w.id}' (${wc.specs.maxCurrent_A} A ampacity) is smaller than the fuse protecting it`);
    }
    out(list, {
      id: `power:fuse:${f.id}`,
      category: "power",
      title: `${f.c.name}`,
      status: worst(st),
      message: msgs.length ? msgs.join("; ") : `${s.currentRating_A} A fuse carries the ${fmt(Iavg, 1)} A average and ${fmt(Ipeak, 1)} A peak draw, and is rated for the ${fmt(b.maxVoltage, 1)} V charged pack.`,
      metrics: [{ label: "Average current", value: Iavg, unit: "A", limit: s.currentRating_A / 1.25, relation: "≤" }],
      involves: [f.id],
    });
  }

  if (!switches.length)
    out(list, { id: "power:switch", category: "power", title: "Main power switch", status: "warn", message: "No main power switch, e-stop or switched power distribution board; the robot can only be turned off by unplugging the battery.", metrics: [], involves: b.partIds });
  for (const sw of switches) {
    const s = sw.c.specs;
    // An e-stop drives a distribution board's switch input, so it only sees signal current.
    const Irated = sw.c.specs.electricalType === "estop" ? null : s.currentRating_A;
    const st: Status[] = [];
    const msgs: string[] = [];
    if (b.maxVoltage > s.voltageRange_V[1]) st.push("fail"), msgs.push(`fully charged pack ${fmt(b.maxVoltage, 1)} V exceeds its ${s.voltageRange_V[1]} V rating`);
    if (s.electricalType === "power_distribution" && b.voltage < s.voltageRange_V[0]) st.push("fail"), msgs.push(`pack ${fmt(b.voltage, 1)} V is below its ${s.voltageRange_V[0]} V minimum`);
    if (Irated !== null) st.push(grade(Ipeak, Irated, 0.85));
    out(list, {
      id: `power:switch:${sw.id}`,
      category: "power",
      title: `${sw.c.name}`,
      status: worst(st),
      message: msgs.length
        ? msgs.join("; ")
        : Irated === null
          ? `Switches the power distribution board's enable input; rated for the ${fmt(b.maxVoltage, 1)} V charged pack.`
          : `Peak draw ${fmt(Ipeak, 1)} A vs ${Irated} A rating at up to ${fmt(b.maxVoltage, 1)} V.`,
      metrics: Irated === null ? [] : [{ label: "Peak current", value: Ipeak, unit: "A", limit: Irated, relation: "≤" }],
      involves: [sw.id],
    });
  }
  return list;
}

// ---------------------------------------------------------------- wiring
export function wiringChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const wiring = a.design.power.wiring;
  if (!wiring.length) {
    out(list, { id: "wiring:none", category: "wiring", title: "Wiring topology", status: "warn", message: "No power wiring defined; wire gauge and voltage drop cannot be verified.", metrics: [], involves: [] });
    return list;
  }
  const ep = electronicsPower(a);
  const bus = a.busVoltage ?? 12;
  // Per-motor current/power series over the behaviour cycle (static = RMS basis, peak = burst basis).
  const series = new Map<string, { pStatic: number[]; pPeak: number[]; iStatic: number[]; iPeak: number[] }>();
  for (const dt of a.design.drivetrains) {
    const rd = a.drivetrains.get(dt.jointId);
    const o = a.ops.get(dt.jointId);
    if (!rd || !o) continue;
    const st = o.torqueStatic.map((t, i) => motorElectrical(rd, t, o.speed[i]));
    const pk = o.torquePeak.map((t, i) => motorElectrical(rd, t, o.speed[i]));
    series.set(dt.motorPartId, { pStatic: st.map((e) => e.electricalPower), pPeak: pk.map((e) => e.electricalPower), iStatic: st.map((e) => e.current), iPeak: pk.map((e) => e.current) });
  }
  const n = Math.max(1, ...[...series.values()].map((s) => s.pStatic.length));
  for (const w of wiring) {
    const wc = a.lib.getAs(w.wireComponentId, "wire");
    if (!wc || !a.parts.has(w.from) || !a.parts.has(w.to)) {
      out(list, { id: `wiring:${w.id}`, category: "wiring", title: `Wire ${w.id}`, status: "fail", message: `Unknown wire component or endpoint (${w.wireComponentId}, ${w.from} → ${w.to}).`, metrics: [], involves: [w.id] });
      continue;
    }
    const pa = new Vector3().setFromMatrixPosition(a.partWorld0.get(w.from)!);
    const pb = new Vector3().setFromMatrixPosition(a.partWorld0.get(w.to)!);
    const len = w.length_m ?? Math.max(0.05, pa.distanceTo(pb) * 1.3);
    const V = supplyVoltage(a, w.to) ?? bus;
    const iS: number[] = [], iP: number[] = [];
    for (let k = 0; k < n; k++) {
      let s = 0, p = 0;
      for (const id of w.loadPartIds) {
        const m = series.get(id);
        const e = ep.byPart.get(id);
        if (w.kind === "phase") {
          s += m?.iStatic[k] ?? 0;
          p += m?.iPeak[k] ?? 0;
        } else {
          s += ((m?.pStatic[k] ?? 0) + (e?.typical ?? 0)) / V;
          p += ((m?.pPeak[k] ?? 0) + (e?.peak ?? 0)) / V;
        }
      }
      iS.push(w.kind === "signal" ? 0.05 : s);
      iP.push(w.kind === "signal" ? 0.05 : p);
    }
    const Irms = rms(iS), Ipk = Math.max(...iP);
    const drop = Ipk * wc.specs.resistance_ohm_per_m * 2 * len;
    const dropPct = (drop / V) * 100;
    // Ampacity is a continuous (thermal) rating; short bursts up to 2x are tolerated by silicone-insulated wire.
    const st = worst([grade(Irms, wc.specs.maxCurrent_A, 0.85), grade(Ipk, 2 * wc.specs.maxCurrent_A, 0.9), dropPct > 10 ? "fail" : dropPct > 5 ? "warn" : "pass"]);
    out(list, {
      id: `wiring:${w.id}`,
      category: "wiring",
      title: `${w.name ?? w.id} (${wc.specs.awg} AWG)`,
      status: st,
      message: `${fmt(Irms, 1)} A RMS / ${fmt(Ipk, 1)} A peak over ${fmt(len, 2)} m (${w.kind}); ampacity ${wc.specs.maxCurrent_A} A continuous; ${fmt(dropPct, 1)}% drop at peak.`,
      metrics: [
        { label: "RMS current", value: Irms, unit: "A", limit: wc.specs.maxCurrent_A, relation: "≤" },
        { label: "Peak current", value: Ipk, unit: "A", limit: 2 * wc.specs.maxCurrent_A, relation: "≤" },
        { label: "Voltage drop", value: dropPct, unit: "%", limit: 5, relation: "≤" },
      ],
      involves: [w.id, w.from, w.to, ...w.loadPartIds],
    });
  }
  // Consumers not fed by any wire
  const fed = new Set(wiring.flatMap((w) => [...w.loadPartIds, w.to]));
  const unfed = [...series.keys(), ...ep.byPart.keys()].filter((id) => !fed.has(id));
  if (unfed.length)
    out(list, {
      id: "wiring:unfed",
      category: "wiring",
      title: "Unpowered consumers",
      status: "warn",
      message: `${unfed.length} consumers are not listed on any wire run: ${unfed.slice(0, 10).join(", ")}${unfed.length > 10 ? "…" : ""}`,
      metrics: [],
      involves: unfed,
    });
  return list;
}

// ---------------------------------------------------------------- thermal
export function thermalChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const amb = a.design.requirements.ambientTemp_C;
  for (const [jid, rd] of a.drivetrains) {
    const o = a.ops.get(jid);
    if (!o) continue;
    const Irms = rms(o.torqueStatic.map((t, i) => motorElectrical(rd, t, o.speed[i]).current));
    const loss = Irms * Irms * rd.motor.resistance;
    const T = amb + loss * rd.motor.thermalResistance;
    const margin = rd.motor.maxWindingTemp - amb;
    out(list, {
      id: `thermal:${jid}`,
      category: "thermal",
      title: `${a.topo.joints.get(jid)?.name ?? jid}: winding temperature`,
      status: grade(T - amb, margin, 0.8),
      message: `RMS current ${fmt(Irms, 2)} A → ${fmt(loss, 1)} W copper loss → steady-state winding ${fmt(T, 0)} °C (limit ${rd.motor.maxWindingTemp} °C, ambient ${amb} °C).`,
      metrics: [{ label: "Winding temperature", value: T, unit: "°C", limit: rd.motor.maxWindingTemp, relation: "≤" }],
      involves: [jid, rd.motor.partId],
    });
  }
  return list;
}

// ---------------------------------------------------------------- structure
export function structuralChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const SF = a.design.requirements.safetyFactor;
  const d = a.design;
  for (const link of d.links) {
    const structural = link.parts.filter((p): p is Extract<Part, { kind: "fabricated" }> => p.kind === "fabricated" && p.role === "structure");
    if (!structural.length) continue;
    // Bending moment carried at the link's root
    let M: Vector3 | null = null;
    const pj = a.topo.parentJoint.get(link.id);
    if (pj) {
      const pl = a.peakLoads.get(pj.id);
      if (pl) M = pl.moment.clone();
    } else {
      // Root/torso: moment across its mid-section from contact forces ahead of the COM
      const com = a.linkMP.get(link.id)!.com.clone().applyMatrix4(a.T0.get(link.id)!);
      let best = 0;
      for (const cs of a.peakContacts) {
        const m = new Vector3();
        for (const c of cs) if (c.point.x > com.x) m.add(c.point.clone().sub(com).cross(c.force));
        if (m.length() > best) (best = m.length()), (M = m);
      }
    }
    if (!M || M.length() < 1e-6) continue;
    // Members whose long axes are parallel act as parallel load paths and share the
    // moment in proportion to their strength; groups along different axes are in
    // series, so each group must carry the full moment. The weakest group governs.
    type Member = { p: (typeof structural)[number]; s: NonNullable<ReturnType<typeof sectionProperties>>; mat: NonNullable<ReturnType<Analysis["lib"]["material"]>>; axisW: Vector3 };
    const unit = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };
    const members: Member[] = [];
    for (const p of structural) {
      const s = sectionProperties(p.shape), mat = a.lib.material(p.material);
      if (!s || !mat) continue;
      const axisW = unit[s.axis].clone().transformDirection(a.T0.get(link.id)!.clone().multiply(poseToMatrix(p.pose)));
      members.push({ p, s, mat, axisW });
    }
    const groups: Member[][] = [];
    for (const m of members) {
      const g = groups.find((g) => Math.abs(g[0].axisW.dot(m.axisW)) > 0.9);
      if (g) g.push(m);
      else groups.push([m]);
    }
    let governing: { vm: number; yieldS: number; group: Member[]; bending: number; torsion: number } | null = null;
    for (const g of groups) {
      const ref = g.reduce((b, m) => (m.mat.yieldStrength_MPa < b.mat.yieldStrength_MPa ? m : b));
      const yieldS = ref.mat.yieldStrength_MPa;
      const Z = g.reduce((s, m) => s + (m.s.sectionModulus * m.mat.yieldStrength_MPa) / yieldS, 0);
      const Zt = g.reduce((s, m) => s + (m.s.torsionModulus * m.mat.yieldStrength_MPa) / yieldS, 0);
      const ax = g[0].axisW;
      const torsion = Math.abs(M.dot(ax));
      const bending = M.clone().sub(ax.clone().multiplyScalar(M.dot(ax))).length();
      const vm = Math.sqrt((bending / Z) ** 2 + 3 * (torsion / Zt) ** 2) / 1e6;
      if (!governing || vm / yieldS > governing.vm / governing.yieldS) governing = { vm, yieldS, group: g, bending, torsion };
    }
    if (!governing) continue;
    const { vm, yieldS, group, bending, torsion } = governing;
    const st: Status = vm > yieldS ? "fail" : vm * SF > yieldS ? "warn" : "pass";
    const names = [...new Set(group.map((m) => m.p.name))].join(", ");
    out(list, {
      id: `structure:${link.id}`,
      category: "structure",
      title: `${link.name}: member stress`,
      status: st,
      message: `Peak root moment ${fmt(M.length(), 2)} N·m; governing member group ${names} (${group[0].mat.name}): bending ${fmt(bending, 2)} N·m, torsion ${fmt(torsion, 2)} N·m → von Mises ${fmt(vm, 1)} MPa vs yield ${yieldS} MPa (SF ${SF} → allowable ${fmt(yieldS / SF, 0)} MPa).`,
      metrics: [
        { label: "Von Mises stress", value: vm, unit: "MPa", limit: yieldS / SF, relation: "≤" },
        { label: "Safety factor achieved", value: yieldS / Math.max(vm, 1e-9), unit: "" },
      ],
      involves: [link.id, ...group.map((m) => m.p.id)],
    });
  }
  return list;
}

// ---------------------------------------------------------------- bearings & fasteners
export function bearingFastenerChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const SF = a.design.requirements.safetyFactor;
  for (const dt of a.design.drivetrains) {
    const j = a.topo.joints.get(dt.jointId);
    const pl = a.peakLoads.get(dt.jointId);
    if (!j || !pl) continue;
    const rd = a.drivetrains.get(dt.jointId);
    if (dt.bearingPartIds.length) {
      const brgs = dt.bearingPartIds.map((id) => compOf(a, id)).filter((c) => c?.category === "bearing") as Extract<NonNullable<ReturnType<typeof compOf>>, { category: "bearing" }>[];
      if (!brgs.length) continue;
      const P = pl.reaction / brgs.length;
      const C0 = Math.min(...brgs.map((b) => b.specs.staticLoad_N));
      const C = Math.min(...brgs.map((b) => b.specs.dynamicLoad_N));
      const L10 = (C / Math.max(P, 1e-6)) ** 3; // million revolutions
      out(list, {
        id: `bearings:${dt.jointId}`,
        category: "bearings",
        title: `${j.name}: bearing load`,
        status: P * SF <= C0 ? "pass" : P <= C0 ? "warn" : "fail",
        message: `${fmt(pl.reaction, 0)} N peak joint reaction shared by ${brgs.length} × ${brgs[0].name}: ${fmt(P, 0)} N each vs static rating ${C0} N; L10 ${L10 > 1e4 ? ">10,000" : fmt(L10, 0)} million rev. Moment loads are not modelled.`,
        metrics: [{ label: "Load per bearing × SF", value: P * SF, unit: "N", limit: C0, relation: "≤" }],
        involves: [dt.jointId, ...dt.bearingPartIds],
      });
    } else {
      const hasInternal = rd?.motor.kind === "servo" || rd?.stages.some((s) => s.kind === "gearbox");
      out(list, {
        id: `bearings:${dt.jointId}`,
        category: "bearings",
        title: `${j.name}: bearing load`,
        status: hasInternal ? "pass" : "warn",
        message: hasInternal
          ? `Joint is carried by the actuator/gearbox output bearing (${fmt(pl.reaction, 0)} N peak reaction); not separately verified.`
          : `No bearing specified for a ${fmt(pl.reaction, 0)} N joint reaction — the motor shaft would carry it.`,
        metrics: [],
        involves: [dt.jointId],
      });
    }
    if (dt.fasteners) {
      const fc = a.lib.getAs(dt.fasteners.componentId, "fastener");
      if (!fc) {
        out(list, { category: "fasteners", title: `${j.name}: fasteners`, status: "fail", message: `Unknown fastener '${dt.fasteners.componentId}'`, metrics: [], involves: [dt.jointId] });
        continue;
      }
      const shear = (pl.torque * SF) / (dt.fasteners.count * dt.fasteners.boltCircleRadius_m) + pl.reaction / dt.fasteners.count;
      out(list, {
        id: `fasteners:${dt.jointId}`,
        category: "fasteners",
        title: `${j.name}: output bolts`,
        status: grade(shear, fc.specs.shearCapacity_N, 0.8),
        message: `${dt.fasteners.count} × ${fc.name} on a ${fmt(dt.fasteners.boltCircleRadius_m * 1000, 0)} mm bolt circle: ${fmt(shear, 0)} N shear per bolt (torque × SF + reaction) vs ${fc.specs.shearCapacity_N} N.`,
        metrics: [{ label: "Shear per bolt", value: shear, unit: "N", limit: fc.specs.shearCapacity_N, relation: "≤" }],
        involves: [dt.jointId],
      });
    }
  }
  return list;
}

// ---------------------------------------------------------------- range of motion / clearance
interface Box {
  partId: string;
  linkId: string;
  local: Matrix4;
  half: [number, number, number];
}

function collisionBoxes(a: Analysis): Box[] {
  const boxes: Box[] = [];
  for (const l of a.design.links)
    for (const p of l.parts) {
      if (!p.collide) continue;
      const shape = p.kind === "fabricated" ? p.shape : a.lib.get((p as ComponentPart).componentId)?.envelope;
      if (!shape) continue;
      boxes.push({ partId: p.id, linkId: l.id, local: poseToMatrix(p.pose), half: shapeHalfExtents(shape) });
    }
  return boxes;
}

export function collidingPairs(a: Analysis, boxes: Box[], q: Record<string, number>, onlyLinks?: Set<string>): [string, string][] {
  const T = forwardKinematics(a.topo, q);
  const obbs: (OBB & { b: Box })[] = boxes.map((b) => ({ ...makeOBB(T.get(b.linkId)!.clone().multiply(b.local), b.half, 0.001), b }));
  const adjacent = (x: string, y: string) => a.topo.parentJoint.get(x)?.parent === y || a.topo.parentJoint.get(y)?.parent === x;
  const pairs: [string, string][] = [];
  for (let i = 0; i < obbs.length; i++)
    for (let k = i + 1; k < obbs.length; k++) {
      const A = obbs[i], B = obbs[k];
      if (A.b.linkId === B.b.linkId || adjacent(A.b.linkId, B.b.linkId)) continue;
      if (onlyLinks && !onlyLinks.has(A.b.linkId) && !onlyLinks.has(B.b.linkId)) continue;
      if (obbOverlap(A, B)) pairs.push([A.b.partId, B.b.partId]);
    }
  return pairs;
}

export function rangeOfMotionChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const boxes = collisionBoxes(a);
  const nominal = collidingPairs(a, boxes, a.q0);
  out(list, {
    id: "rom:nominal",
    category: "range_of_motion",
    title: "No self-intersection at nominal pose",
    status: nominal.length ? "fail" : "pass",
    message: nominal.length ? `Overlapping parts in the nominal pose: ${nominal.slice(0, 6).map((p) => p.join(" ↔ ")).join("; ")}` : `${boxes.length} collision parts are clear of each other in the nominal pose.`,
    metrics: [{ label: "Overlapping pairs", value: nominal.length, unit: "", limit: 0, relation: "=" }],
    involves: nominal.flat(),
  });
  // Operating range: the poses actually used by the behaviour
  const used = new Set<string>();
  for (const s of a.samples) for (const p of collidingPairs(a, boxes, s.q)) used.add(p.join(" ↔ "));
  for (const p of nominal) used.delete(p.join(" ↔ "));
  out(list, {
    id: "rom:behaviour",
    category: "range_of_motion",
    title: "Behaviour cycle is collision-free",
    status: used.size ? "fail" : "pass",
    message: used.size ? `Parts collide during the ${a.design.behavior.mode.replace("_", " ")} cycle: ${[...used].slice(0, 6).join("; ")}` : `All ${a.samples.length} sampled behaviour poses are collision-free.`,
    metrics: [],
    involves: [...used].flatMap((s) => s.split(" ↔ ")),
  });
  // Full joint ranges, one joint at a time
  for (const j of a.design.joints) {
    if (j.type === "fixed" || j.type === "continuous" || !j.limits) continue;
    const sub = new Set(subtreeLinks(a.topo, j.child));
    const hits: number[] = [];
    const N = 13;
    for (let i = 0; i < N; i++) {
      const qv = j.limits.lower + ((j.limits.upper - j.limits.lower) * i) / (N - 1);
      const pairs = collidingPairs(a, boxes, { ...a.q0, [j.id]: qv }, sub).filter((p) => !nominal.some((n) => n[0] === p[0] && n[1] === p[1]));
      if (pairs.length) hits.push(qv);
    }
    if (!hits.length) continue;
    out(list, {
      id: `rom:${j.id}`,
      category: "range_of_motion",
      title: `${j.name}: limit sweep`,
      status: "warn",
      message: `Collides when swept alone between ${fmt(Math.min(...hits))} and ${fmt(Math.max(...hits))} rad (limits ${fmt(j.limits.lower)}…${fmt(j.limits.upper)}); tighten the software limits or add clearance.`,
      metrics: [],
      involves: [j.id],
    });
  }
  return list;
}

// ---------------------------------------------------------------- stability
function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const x of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], x) <= 0) lower.pop();
    lower.push(x);
  }
  for (const x of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], x) <= 0) upper.pop();
    upper.push(x);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Signed distance from point to convex polygon boundary (positive inside). */
export function supportMargin(poly: [number, number][], pt: [number, number]): number {
  if (poly.length < 3) {
    if (poly.length === 2) {
      const [a, b] = poly;
      const ab = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * ab[0] + (pt[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)));
      return -Math.hypot(pt[0] - a[0] - t * ab[0], pt[1] - a[1] - t * ab[1]);
    }
    if (poly.length === 1) return -Math.hypot(pt[0] - poly[0][0], pt[1] - poly[0][1]);
    return -Infinity;
  }
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    const d = (ex * (pt[1] - a[1]) - ey * (pt[0] - a[0])) / len; // left of CCW edge is inside
    m = Math.min(m, d);
  }
  return m;
}

export function stabilityChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const d = a.design;
  const { com } = robotComNominal(a);
  if (d.rootFixed) {
    out(list, { id: "stability:fixed", category: "stability", title: "Base mounting", status: "pass", message: "Robot is bolted to the world; tip-over does not apply.", metrics: [], involves: [] });
    return list;
  }
  const contacts = d.links.filter((l) => l.contact).map((l) => ({ id: l.id, p: pointOnLink(a.T0, l.id, l.contact!.point), r: l.contact!.radius }));
  if (!contacts.length) return list;
  const groundZ = Math.min(...contacts.map((c) => c.p.z - c.r));
  const height = com.z - groundZ;
  // Expand each contact into a small ring so pads/feet contribute their footprint.
  const ring = (c: (typeof contacts)[number]) =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [c.p.x + c.r * Math.cos((k * Math.PI) / 4), c.p.y + c.r * Math.sin((k * Math.PI) / 4)] as [number, number]);
  const hull = convexHull(contacts.flatMap(ring));
  const margin = supportMargin(hull, [com.x, com.y]);
  const tipAngle = (Math.atan2(Math.max(margin, 0), height) * 180) / Math.PI;
  const slope = d.requirements.maxSlope_deg;
  out(list, {
    id: "stability:static",
    category: "stability",
    title: "Static stability (all contacts down)",
    status: margin <= 0 ? "fail" : slope > 0 ? (tipAngle < slope ? "fail" : tipAngle < slope * 1.3 ? "warn" : "pass") : margin < 0.01 ? "warn" : "pass",
    message: `COM ${fmt(height * 1000, 0)} mm above ground; projection is ${fmt(margin * 1000, 0)} mm inside the support polygon → static tip-over angle ${fmt(tipAngle, 1)}°${slope ? ` (required slope ${slope}°)` : ""}.`,
    metrics: [
      { label: "Stability margin", value: margin * 1000, unit: "mm", limit: 0, relation: ">" },
      { label: "Tip-over angle", value: tipAngle, unit: "°", limit: slope || undefined, relation: "≥" },
      { label: "COM height", value: height * 1000, unit: "mm" },
    ],
    involves: contacts.map((c) => c.id),
  });
  // Gait: minimum stance support during the cycle
  if (d.behavior.mode === "legged_gait" && d.behavior.gait) {
    let minMargin = Infinity;
    let minStance = Infinity;
    for (const s of a.samples) {
      minStance = Math.min(minStance, s.stanceLinks.length);
      const T = forwardKinematics(a.topo, s.q);
      const pts = s.stanceLinks.map((id) => {
        const l = a.topo.links.get(id)!;
        return { id, p: pointOnLink(T, id, l.contact!.point), r: l.contact!.radius };
      });
      const hullS = convexHull(pts.flatMap(ring));
      const c = robotComNominal({ ...a, T0: T } as Analysis).com;
      minMargin = Math.min(minMargin, supportMargin(hullS, [c.x, c.y]));
    }
    const dynamic = minMargin <= 0.005;
    out(list, {
      id: "stability:gait",
      category: "stability",
      title: "Gait support",
      status: dynamic ? (d.behavior.gait.balanceGain > 0 ? "warn" : "fail") : "pass",
      message: dynamic
        ? `The gait leaves as few as ${minStance} feet down; the COM leaves the support polygon by up to ${fmt(-minMargin * 1000, 0)} mm, so the gait is dynamically (not statically) stable and depends on the balance controller (gain ${d.behavior.gait.balanceGain}). Verify in simulation.`
        : `COM stays ≥ ${fmt(minMargin * 1000, 0)} mm inside the stance polygon throughout the gait (statically stable gait).`,
      metrics: [{ label: "Worst gait margin", value: minMargin * 1000, unit: "mm", limit: 0, relation: ">" }],
      involves: d.behavior.gait.legs.map((l) => l.footLinkId),
    });
  }
  // Ground clearance: nothing but contacts should be lowest
  const low: string[] = [];
  for (const [pid, Tw] of a.partWorld0) {
    const ref = a.parts.get(pid)!;
    if (a.topo.links.get(ref.linkId)?.contact) continue;
    const shape = ref.part.kind === "fabricated" ? ref.part.shape : a.lib.get(ref.part.componentId)?.envelope;
    if (!shape) continue;
    const h = shapeHalfExtents(shape);
    const e = Tw.elements;
    const zExt = Math.abs(e[2]) * h[0] + Math.abs(e[6]) * h[1] + Math.abs(e[10]) * h[2];
    const bottom = e[14] - zExt;
    if (bottom < groundZ + 0.005) low.push(pid);
  }
  out(list, {
    id: "stability:clearance",
    category: "stability",
    title: "Ground clearance",
    status: low.length ? "fail" : "pass",
    message: low.length ? `Non-contact parts reach the ground plane: ${low.slice(0, 8).join(", ")}` : "Only designated contact links touch the ground in the nominal pose.",
    metrics: [],
    involves: low,
  });
  return list;
}

// ---------------------------------------------------------------- propulsion
export function propulsionChecks(a: Analysis): Check[] {
  const list: Check[] = [];
  const d = a.design;
  const W = a.totalMass * 9.81;
  const props: { id: string; thrust: number; power: number }[] = [];
  const wheels: { id: string; linkId: string; r: number; maxLoad?: number; mu?: number }[] = [];
  for (const [id, ref] of a.parts) {
    if (ref.part.kind !== "component") continue;
    const c = a.lib.getAs(ref.part.componentId, "propulsion");
    if (!c) continue;
    if (c.specs.propulsionType === "propeller" || c.specs.propulsionType === "ducted_fan") props.push({ id, thrust: c.specs.maxThrust_N ?? 0, power: c.specs.powerAtMaxThrust_W ?? 0 });
    else wheels.push({ id, linkId: ref.linkId, r: c.specs.radius_m, maxLoad: c.specs.maxLoad_N, mu: c.specs.friction });
  }
  if (props.length) {
    const T = props.reduce((s, p) => s + p.thrust, 0);
    const tw = T / W;
    const hoverP = props.reduce((s, p) => s + p.power, 0) * Math.pow(1 / Math.max(tw, 1e-6), 1.5);
    const bat = a.battery;
    const hoverMin = bat ? ((bat.energy_Wh * 0.8) / hoverP) * 60 : 0;
    out(list, {
      id: "propulsion:thrust",
      category: "propulsion",
      title: "Thrust-to-weight",
      status: tw >= 2 ? "pass" : tw >= 1.2 ? "warn" : "fail",
      message: `${props.length} thrusters give ${fmt(T, 0)} N for ${fmt(W, 0)} N weight (T/W ${fmt(tw, 2)}; ≥2 needed for controllable flight). Estimated hover power ${fmt(hoverP, 0)} W → ${fmt(hoverMin, 1)} min hover.`,
      metrics: [{ label: "Thrust/weight", value: tw, unit: "", limit: 2, relation: "≥" }],
      involves: props.map((p) => p.id),
    });
  }
  if (d.behavior.mode === "wheeled" && d.behavior.wheels) {
    const wb = d.behavior.wheels;
    const driven = [...wb.left, ...wb.right];
    const nContacts = d.links.filter((l) => l.contact).length || driven.length;
    const perWheel = (W * d.requirements.dynamicLoadFactor) / nContacts;
    for (const w of wheels)
      if (w.maxLoad)
        out(list, {
          id: `propulsion:load:${w.id}`,
          category: "propulsion",
          title: `Wheel load ${w.id}`,
          status: grade(perWheel, w.maxLoad, 0.85),
          message: `${fmt(perWheel, 0)} N per wheel (incl. load factor) vs ${w.maxLoad} N rating.`,
          metrics: [{ label: "Wheel load", value: perWheel, unit: "N", limit: w.maxLoad, relation: "≤" }],
          involves: [w.id],
        });
    const th = (d.requirements.maxSlope_deg * Math.PI) / 180;
    const accel = 0.5;
    const Freq = a.totalMass * (9.81 * (Math.sin(th) + 0.02 * Math.cos(th)) + accel);
    const r = wb.wheelRadius_m;
    const tauPer = (Freq * r) / driven.length;
    const speed = (d.requirements.targetSpeed_m_s ?? wb.targetSpeed_m_s) / r;
    const mu = Math.min(...wheels.map((w) => w.mu ?? 0.8), 0.8);
    const traction = mu * W * Math.cos(th) * (driven.length / nContacts);
    for (const jid of driven) {
      const rd = a.drivetrains.get(jid);
      if (!rd) continue;
      const avail = outputTorqueAt(rd, speed, "peak");
      out(list, {
        id: `propulsion:drive:${jid}`,
        category: "propulsion",
        title: `${a.topo.joints.get(jid)?.name ?? jid}: climb + acceleration torque`,
        status: grade(tauPer * d.requirements.safetyFactor, avail, 0.9),
        message: `${fmt(d.requirements.maxSlope_deg, 0)}° slope + 0.5 m/s² needs ${fmt(tauPer, 2)} N·m per driven wheel at ${fmt(speed, 1)} rad/s; available ${fmt(avail, 2)} N·m.`,
        metrics: [{ label: "Required × SF", value: tauPer * d.requirements.safetyFactor, unit: "N·m", limit: avail, relation: "≤" }],
        involves: [jid, rd.motor.partId],
      });
    }
    out(list, {
      id: "propulsion:traction",
      category: "propulsion",
      title: "Traction",
      status: grade(Freq, traction, 0.85),
      message: `Driving force ${fmt(Freq, 0)} N vs available traction ${fmt(traction, 0)} N (μ=${mu}).`,
      metrics: [{ label: "Tractive force", value: Freq, unit: "N", limit: traction, relation: "≤" }],
      involves: driven,
    });
  }
  return list;
}

export function costCheck(total: number, byCategory: Record<string, number>): Check {
  return {
    id: "cost:total",
    category: "cost",
    title: "Bill of materials cost",
    status: "pass",
    message: `Approximate parts cost $${fmt(total, 0)} (${Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} $${fmt(v, 0)}`)
      .join(", ")}). Excludes machining labour.`,
    metrics: [{ label: "Parts cost", value: total, unit: "USD" }],
    involves: [],
  };
}

