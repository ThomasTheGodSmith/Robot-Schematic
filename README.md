# Robot Design Engine

Describe a robot in plain language ("a quadruped that can climb stairs", "a
humanoid that looks like Iron Man"). Two Claude agents turn the request into a
design built only from real components and fabricated parts. A validator checks
the design against engineering limits, and the result is shown as an
interactive 3D blueprint and run in a rigid-body physics simulation.

"Feasible" is something the code checks, with numbers you can trace, not
something the design simply asserts.

## Running it

```bash
cd robot-design-engine
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY to enable the agents
npm run dev                 # API on :8787, web app on http://localhost:5173
```

- `npm test` runs the unit and integration tests: validator, drivetrain and kinematics math, simulator, and agent loops against a fake model.
- `npm run typecheck`
- `npm run build && npm start` serves the production build from the Node server.
- `npx tsx scripts/validate.ts examples/quadruped-trotter.json [--all]` validates a design from the CLI.
- `npm run schemas` regenerates `schemas/*.schema.json` from the Zod source.

You don't need an API key for the viewer, validator, simulator or example
designs. Only the Design Studio agents use the key, and it never leaves the
server.

## Architecture

| Layer | Where | Notes |
|---|---|---|
| Contracts | `src/core/schema/` | Zod schemas for the **Design Brief**, the **Robot Design Document** and the component library. JSON Schema exports are in `schemas/`. |
| Component library | `data/components/*.json`, `data/materials.json` | 96 components (motors, smart servos and integrated actuators, gearboxes, bearings, batteries, drivers, compute, sensors, regulators, fasteners, wire, wheels and propellers, lighting) and 14 materials. To extend it, edit the JSON; no code changes are needed. |
| Engineering core | `src/core/` | URDF-style kinematics, mass and inertia from geometry, damped-least-squares IK, four-bar solver, drivetrain model, statics, BOM. All isomorphic: the same code runs in the browser, the worker and Node. |
| Validator | `src/core/validate/` | About 15 categories of checks. Each result is pass, warn or fail, with metrics and the ids of the parts involved. |
| Simulator | `src/sim/` | Rapier rigid-body physics in a Web Worker, with an actuator model, a controller built from the design's behaviour spec, scenarios and telemetry. |
| Agents | `server/` | Express backend. The Researcher (`claude-sonnet-5-5`) and Designer (`claude-opus-5-5`) stream progress over SSE. |
| UI | `src/client/` | React + React Three Fiber: Design Studio, Blueprint & inspect, Simulate. |

### Agent pipeline

1. **Researcher** (`server/agents/researcher.ts`) takes the prompt and optional reference images.
   - It uses web search and web fetch to find visual references and related real robots.
   - It sorts every requested capability into achievable, compromise or infeasible, with the reasoning.
   - It submits a schema-validated Design Brief. A reference is marked `verified` only if its URL actually appeared in that session's search results.
2. You review and edit the brief, either in the form or as raw JSON.
3. **Designer** (`server/agents/designer.ts`) gets the brief, the full catalogue and one example design, and submits a Robot Design Document.
   - Each submission is schema-checked and then run through the validator. Failures go back to the model as structured feedback, up to `MAX_DESIGN_ITERATIONS` (default 3).
   - It returns the best design and lists anything still unresolved.

Model IDs, effort levels and the iteration cap are configured with environment
variables (see `.env.example`). Both agents use adaptive thinking, streamed as
summaries. Server-side refusal fallbacks are on by default
(`ROBOT_ENGINE_FALLBACKS=off` disables them). Forced `tool_choice` isn't
available on these models, so the agents use `auto` plus an instruction, and
every tool input is validated with Zod.

### What the validator checks

| Category | Check |
|---|---|
| Integrity | Kinematic tree, references, every moving joint has a real drivetrain, the gait is reachable by IK. |
| Torque | Every operating point of the behaviour cycle (load factor × safety factor) against the drivetrain's speed-dependent torque curve, capped by driver current and gear ratings. RMS torque against the continuous rating. |
| Speed | Required joint speed against the output no-load speed. |
| Gearing | Stage ratings: gearbox datasheet values, Lewis bending for spur gears, belt tension. Gearbox input speed. |
| Electrical | Motor and driver voltage and type compatibility, phase current against motor and driver limits, driver channels, regulator rails. |
| Power | Average and peak draw, runtime from 80% of usable energy, battery continuous and burst C-rating, voltage sag. |
| Wiring | RMS and peak current against ampacity, voltage drop. |
| Thermal | Steady-state winding temperature from RMS copper loss. |
| Structure | Von Mises stress in the loaded members of each link, from joint reaction moments. |
| Bearings and fasteners | Static load and L10 life; bolt shear on output flanges. |
| Range of motion | Self-intersection at the nominal pose, over the behaviour cycle, and across each joint's limits. |
| Stability | Support-polygon margin, tip-over angle against the required slope, gait support, ground clearance. |
| Propulsion | Thrust-to-weight for propellers; wheel load, climb torque and traction. |

## Example designs (fixtures and demo)

| File | Design | Validation |
|---|---|---|
| `examples/quadruped-trotter.json` | ~11 kg quadruped: 12 quasi-direct-drive actuators, belt-driven knees, 6S LiPo, trotting gait. | 151 pass, 1 warn. The warning: a trot is dynamically, not statically, stable. In simulation it stands, trots at about 0.38 m/s, climbs a 15° slope, recovers from pushes, and carries 2 kg. It stalls at a 5 cm step without falling. |
| `examples/desk-arm.json` | 4-DOF Dynamixel arm with a 3:1 steel spur stage on the shoulder and a four-bar gripper. Runs a pick-and-place cycle. | All checks pass. |

## Simplified or approximated

- **Structural stress** is a beam model at each link's root. Parallel members share the load in proportion to their strength. There is no FEA, and there are no stress concentrations, fatigue or buckling checks.
- **Loads** are quasi-static, multiplied by a dynamic load factor. Inertial torques are not computed in the validator; the simulator shows the real dynamic peaks (it measured roughly 2–3× body weight on impacts).
- **Thermal** uses a single lumped thermal resistance per motor. Battery and driver heating are not modelled.
- **Motors** use a linear torque–speed line with current limits. Stepper pull-out curves and field weakening are not modelled.
- **Smart-servo rotor inertia** is estimated, because datasheets don't give it. In the simulator, reflected rotor inertia is added to the child link rather than to the joint's relative motion.
- **Range-of-motion checks** use oriented bounding boxes of the parts, so they are conservative for round parts.
- **Rendering** is procedural and approximate: gear teeth are trapezoids, not involutes. Section cuts have no caps.
- **Prismatic joints** are treated as fixed in the simulator. Gripper clamping force is not validated.
- **Battery voltage** falls linearly with charge, and regenerative braking is not credited.
- **Agents:** the loops are tested against a scripted fake model. They have not been exercised against the live API in this environment.
