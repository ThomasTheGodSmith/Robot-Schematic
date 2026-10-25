import { useSyncExternalStore } from "react";
import type { RobotDesign } from "../core/schema/design";
import type { ValidationReport } from "../core/validate/report";
import type { JointPositions } from "../core/math/frames";
import { defaultJointPositions } from "../core/math/frames";
import { validateDesign } from "../core/validate";
import { library } from "./library";

export type Mode = "studio" | "inspect" | "simulate";
export type RightTab = "validation" | "part" | "joint" | "bom";

export interface ClipState {
  enabled: boolean;
  axis: "x" | "y" | "z";
  /** -1..1 across the robot's bounding box */
  offset: number;
  flip: boolean;
}

export interface AppState {
  mode: Mode;
  design: RobotDesign | null;
  designLabel: string;
  report: ValidationReport | null;
  /** Inspection-mode joint positions */
  q: JointPositions;
  /** Joint velocity implied by the last slider move (rad/s), for the live drivetrain readout */
  qd: JointPositions;
  inspecting: boolean;
  selectedPart: string | null;
  selectedJoint: string | null;
  hidden: Set<string>;
  isolated: Set<string> | null;
  explode: number;
  xray: boolean;
  clip: ClipState;
  blueprint: boolean;
  showWires: boolean;
  rightTab: RightTab;
  /** Parts highlighted from the validation panel (hover/click on a check) */
  highlight: Set<string>;
  playBehavior: boolean;
}

const initial: AppState = {
  mode: "inspect",
  design: null,
  designLabel: "",
  report: null,
  q: {},
  qd: {},
  inspecting: false,
  selectedPart: null,
  selectedJoint: null,
  hidden: new Set(),
  isolated: null,
  explode: 0,
  xray: false,
  clip: { enabled: false, axis: "y", offset: 0, flip: false },
  blueprint: false,
  showWires: true,
  rightTab: "validation",
  highlight: new Set(),
  playBehavior: false,
};

let state: AppState = initial;
const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

/** Load a design: validate it, reset the inspection state. */
export function loadDesign(design: RobotDesign, label: string) {
  const report = validateDesign(design, library);
  setState({
    design,
    designLabel: label,
    report,
    q: defaultJointPositions(design),
    qd: {},
    selectedPart: null,
    selectedJoint: null,
    hidden: new Set(),
    isolated: null,
    explode: 0,
    highlight: new Set(),
    playBehavior: false,
    rightTab: "validation",
  });
}

export function setJoint(id: string, value: number) {
  setState((s) => {
    const prev = s.q[id] ?? 0;
    const now = performance.now();
    const dt = Math.max(1e-3, (now - (lastMove.get(id) ?? now - 50)) / 1000);
    lastMove.set(id, now);
    return { q: { ...s.q, [id]: value }, qd: { ...s.qd, [id]: Math.max(-50, Math.min(50, (value - prev) / dt)) } };
  });
}
const lastMove = new Map<string, number>();
