# Code map

Where everything in this project lives, grouped by what you want to find or change.
For how to run the app, see [README.md](README.md).

## Quick reference

| I want to... | Go to |
|---|---|
| Read the project overview and how to run it | [README.md](README.md) |
| Start the app without a terminal | [Start Robot Design Engine.bat](Start%20Robot%20Design%20Engine.bat) |
| Set the API key and AI model settings | `.env` (your own copy, not uploaded to git), template in [.env.example](.env.example) |
| Change how the AI designs a robot | [server/agents/prompts.ts](server/agents/prompts.ts) |
| Look at or edit the pre-made robots | [examples/](examples/) |
| Add or change a real part (motor, battery...) | [data/components/](data/components/) |
| Change what counts as a feasible design | [src/core/validate/checks.ts](src/core/validate/checks.ts) |
| Change the 3D view | [src/client/viewer/](src/client/viewer/) |
| Change how robots move in the simulator | [src/sim/simulator.ts](src/sim/simulator.ts) |
| Run or add tests | [tests/](tests/) |

## Making a robot with the AI (Design Studio)

The two-step AI pipeline: the **Researcher** turns your request into a design brief, then the **Designer** builds the robot and the validator checks it, sending failures back for another attempt.

| File | What it does |
|---|---|
| [src/client/studio/DesignStudio.tsx](src/client/studio/DesignStudio.tsx) | The Design Studio page: the request box, the editable brief, and the live progress log |
| [server/index.ts](server/index.ts) | The backend. `/api/research` runs the Researcher, `/api/design` runs the Designer, `/api/validate` checks a design |
| [server/agents/researcher.ts](server/agents/researcher.ts) | Researcher agent: searches the web for references and writes the design brief |
| [server/agents/designer.ts](server/agents/designer.ts) | Designer agent: builds the robot from the brief and retries until it passes validation (up to `MAX_DESIGN_ITERATIONS`) |
| [server/agents/prompts.ts](server/agents/prompts.ts) | The instructions given to both agents. Edit this to change how they design |
| [server/agents/llm.ts](server/agents/llm.ts) | Calls the Claude API and streams the replies |
| [server/agents/common.ts](server/agents/common.ts) | Shared agent helpers: tool schemas, refusal and error handling |
| [server/config.ts](server/config.ts) | Reads `.env`: API key, model names, effort levels, iteration limit, port |
| [server/events.ts](server/events.ts), [server/sse.ts](server/sse.ts) | The progress messages streamed from the server to the Design Studio |
| [src/core/schema/brief.ts](src/core/schema/brief.ts) | The format of a design brief |

## Pre-made robots

| File | What it is |
|---|---|
| [examples/quadruped-trotter.json](examples/quadruped-trotter.json) | Trotter Q9, the ~13 kg four-legged robot loaded by default |
| [examples/desk-arm.json](examples/desk-arm.json) | A 4-joint desk robot arm with a gripper |

Any `.json` file added to [examples/](examples/) appears in the app's **Load example…** menu automatically.

## What a robot design is made of

| File | What it defines |
|---|---|
| [src/core/schema/design.ts](src/core/schema/design.ts) | The robot design format: links, parts, joints, drivetrains, power and wiring, behaviour, requirements |
| [src/core/schema/library.ts](src/core/schema/library.ts) | The format of parts-library entries, with the specs for each category |
| [src/core/schema/common.ts](src/core/schema/common.ts) | Shared building blocks: positions, rotations, shapes, colours (all SI units) |
| [schemas/](schemas/) | The same formats exported as JSON Schema. Regenerate with `npm run schemas` ([scripts/export-schemas.ts](scripts/export-schemas.ts)) |

## Parts library (real components)

| File | Contents |
|---|---|
| [data/components/](data/components/) | One JSON file per category: motors, servos, gearboxes, bearings, batteries, drivers, compute, sensors, regulators, fasteners, wires, wheels and propellers, lighting, electrical (fuses, switches, e-stops, power boards, bus transceivers) |
| [data/materials.json](data/materials.json) | Materials for fabricated parts (aluminium, carbon fibre, PETG...) |
| [src/core/library.ts](src/core/library.ts) | Loads and checks the parts library |
| [src/core/library-node.ts](src/core/library-node.ts), [src/client/library.ts](src/client/library.ts) | Load the library and examples on the server and in the browser |

To add a part, add an entry to the matching JSON file. No code changes are needed.

## Checking a design (validator)

| File | What it does |
|---|---|
| [src/core/validate/index.ts](src/core/validate/index.ts) | Runs every check in order and builds the report |
| [src/core/validate/checks.ts](src/core/validate/checks.ts) | All the checks: torque, speed, gearing, electrical, power, fuse and switch, wiring, heat, structure, bearings, collisions, stability, propulsion |
| [src/core/validate/analysis.ts](src/core/validate/analysis.ts) | Works out the shared numbers the checks use: masses, joint loads, battery pack |
| [src/core/validate/report.ts](src/core/validate/report.ts) | The format of the pass/warn/fail report |
| [src/core/drivetrain.ts](src/core/drivetrain.ts) | Motor, gearbox, belt and gear calculations |
| [src/core/statics.ts](src/core/statics.ts) | Forces and torques on each joint |
| [src/core/behavior.ts](src/core/behavior.ts) | Walking steps and arm movements, shared by the validator and the simulator |
| [src/core/bom.ts](src/core/bom.ts) | The bill of materials (part list and cost) |
| [scripts/validate.ts](scripts/validate.ts) | Check a design from the command line: `npx tsx scripts/validate.ts examples/quadruped-trotter.json` |

## Maths helpers ([src/core/math/](src/core/math/))

| File | What it does |
|---|---|
| [frames.ts](src/core/math/frames.ts) | Positions and rotations of each link (URDF-style kinematics) |
| [ik.ts](src/core/math/ik.ts) | Inverse kinematics: joint angles needed to put a foot or hand somewhere |
| [massprops.ts](src/core/math/massprops.ts) | Mass, centre of mass and inertia |
| [shapes.ts](src/core/math/shapes.ts) | Volume, inertia and cross-section of each shape |
| [fourbar.ts](src/core/math/fourbar.ts) | Four-bar linkage solver (used by the gripper) |
| [obb.ts](src/core/math/obb.ts) | Box overlap tests for collision checks |

## The app (what you see in the browser)

| File | What it does |
|---|---|
| [index.html](index.html), [src/client/main.tsx](src/client/main.tsx) | Page entry point |
| [src/client/App.tsx](src/client/App.tsx) | Top bar, tab switching, and the Blueprint & inspect layout and toolbar (Explode, Section, X-ray) |
| [src/client/store.ts](src/client/store.ts) | App state: current design, selected part, view settings |
| [src/client/styles.css](src/client/styles.css) | All styling |
| [src/client/panels/Panels.tsx](src/client/panels/Panels.tsx) | Side panels: parts list, Part details, Validation, Bill of materials |
| [src/client/panels/JointPanel.tsx](src/client/panels/JointPanel.tsx) | The Joints & drivetrain panel |
| [src/client/panels/partInfo.ts](src/client/panels/partInfo.ts) | Gathers the details shown for a selected part |

### 3D view ([src/client/viewer/](src/client/viewer/))

| File | What it does |
|---|---|
| [Viewer.tsx](src/client/viewer/Viewer.tsx) | The 3D scene: camera, clicking parts, section cut, explode, blueprint dimensions |
| [rig.ts](src/client/viewer/rig.ts) | Builds the robot model from a design, plus colours, X-ray and highlighting |
| [geometry.ts](src/client/viewer/geometry.ts) | The 3D shape drawn for each part type (motors, boards, gears, e-stop...) |
| [mechanisms.ts](src/client/viewer/mechanisms.ts) | Moving details: spinning gears, belts, linkages and wires |
| [DomLabels.tsx](src/client/viewer/DomLabels.tsx) | Text labels in the 3D view |

## Simulator

| File | What it does |
|---|---|
| [src/sim/simulator.ts](src/sim/simulator.ts) | Physics world, motor model and walking controller (balance, heading hold, slope following), plus the scenarios: flat, slope, steps, push, payload |
| [src/sim/worker.ts](src/sim/worker.ts) | Runs the simulator in the background so the page stays responsive |
| [src/sim/types.ts](src/sim/types.ts) | Messages passed between the simulator and the page |
| [src/client/sim/SimView.tsx](src/client/sim/SimView.tsx) | The Simulate page: scenario buttons, 3D playback, live readouts |

## Tests ([tests/](tests/))

Run them all with `npm test`.

| File | What it covers |
|---|---|
| [validator.test.ts](tests/validator.test.ts) | Parts library, example designs, and that the validator catches bad designs |
| [sim.test.ts](tests/sim.test.ts) | Simulator: standing, walking, the slope, falls, the desk arm |
| [drivetrain.test.ts](tests/drivetrain.test.ts) | Gear, belt and motor calculations |
| [math.test.ts](tests/math.test.ts) | Shapes, mass, kinematics, joint forces, four-bar, collision boxes and step trajectories |
| [agents.test.ts](tests/agents.test.ts) | The Researcher and Designer agents and the server endpoints, using a fake model (no API key needed) |

## Setup and config

| File | What it is |
|---|---|
| [package.json](package.json) | Dependencies and the `npm run ...` commands |
| [vite.config.ts](vite.config.ts) | Web dev server (port 5173) and test settings |
| [tsconfig.json](tsconfig.json) | TypeScript settings |
| [.env.example](.env.example) | Template for `.env` |
| [.gitignore](.gitignore) | Files git ignores, including `.env` |
