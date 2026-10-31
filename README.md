# Teo — Workflow Supervisor for Pi

Teo is a CLI and [Pi](https://github.com/badlogic/pi-mono) extension that guides long-running tasks through configurable workflows. A workflow defines stages, agent roles, tools, models, validation rules, and allowed transitions. Teo keeps durable task state, coordinates agent and supervisor sessions, and records an auditable event history.

The project uses Pi SDK 1.4.0 and supports both an interactive terminal interface and native `/teo` commands inside Pi.

## Features

- Markdown-based workflow definitions stored in `~/.pi/teo/`
- Goal mode for tasks that do not need a custom workflow
- Persistent task state and append-only event history in `.teo/`
- Project locking with heartbeat and recovery support
- Separate agent and supervisor sessions with evidence-based transitions
- Model profiles with automatic fallback on quota and rate-limit errors
- Interactive Ink UI and plain output for scripts and pipes
- Recovery tools for interrupted sessions, changed policies, and damaged state
- Secret redaction for common token, credential, and authorization formats
- Pi extension lifecycle support, including pause, resume, waiting timers, and session restoration

## Requirements

- Node.js 22.19 or newer
- npm
- Git
- Pi coding agent 1.4.0
- Docker, OrbStack, or Colima for the containerized development workflow

## Installation from Source

Clone the repository, install dependencies, build the project, and link the CLI:

```bash
git clone https://github.com/britjair/pi-supervisor-teo.git
cd pi-supervisor-teo
npm ci
npm run build
npm link
```

This makes the `teo` command available globally. To remove the link later, run:

```bash
npm unlink -g pi-supervisor-teo
```

### Install the Pi Extension

Build the project first, then either load the extension for one session or install it permanently:

```bash
pi -e /path/to/pi-supervisor-teo
pi install /path/to/pi-supervisor-teo
```

The package provides both `dist/cli.js` and `dist/extension.js`.

## Quick Start

Create the workflow directory and copy one of the examples:

```bash
mkdir -p ~/.pi/teo
cp examples/processes/dev.md ~/.pi/teo/dev.md
```

Validate the environment and start the interactive CLI:

```bash
cd /path/to/your/project
teo doctor
teo
```

Create a task interactively. Teo asks whether a Jira issue already exists, accepts its URL/key, or offers to create one from the initial description:

```bash
teo new
```

The explicit legacy form is still available for scripts:

```bash
teo new PROJECT-123 --process dev --title "Title" --description-file requirements.md
```

Create a task from a goal without a custom workflow:

```bash
teo new PROJECT-123 --goal "Add structured JSON logging"
```

## CLI Commands

| Command | Description |
| --- | --- |
| `teo` | Open the interactive task menu |
| `teo new [KEY]` | Interactively start from Jira or create a task; explicit KEY keeps the script-friendly form |
| `teo resume KEY` | Resume an existing task |
| `teo sessions` | List task sessions and resume one by number |
| `teo status` | Show task status |
| `teo history KEY` | Show task history |
| `teo cancel KEY` | Cancel a task |
| `teo recover KEY` | Recover an interrupted or inconsistent task |
| `teo doctor` | Validate workflows, dependencies, and local state |
| `teo doctor --fix` | Repair supported local-state problems interactively |

Use `--plain` when running commands in a pipe or a non-interactive environment.

## Pi Commands

When the extension is loaded, the following commands are available inside Pi:

```text
/teo start [KEY]
/teo goal <goal>
/teo sessions
/teo resume [KEY or session number]
/teo next
/teo pause
/teo recover KEY
/teo stop
/teo status
/teo history KEY
/teo help
```

Teo binds a task to the current Pi session, applies the stage-specific role, tools, and model, and asks a separate supervisor session to evaluate evidence after each turn. Jira setup is documented in [`docs/09-jira.md`](docs/09-jira.md).

## Workflow Files

Workflow files are Markdown documents with YAML front matter. Store them in `~/.pi/teo/` and select one with `teo new --process <name>`.

Examples are available in [`examples/processes/`](examples/processes/):

- [`dev.md`](examples/processes/dev.md) — software development workflow
- [`car-selection.md`](examples/processes/car-selection.md) — multi-stage demonstration workflow

Teo validates the workflow schema and transition graph before starting a task. Each task stores a policy snapshot and detects incompatible workflow changes before continuing.

## Model Profiles

Optional model chains can be configured in `~/.pi/teo/models.md`. Teo can switch to a fallback model when a provider reports a usage limit, quota exhaustion, or rate limit. If every configured model is unavailable, the task enters a timed waiting state and can retry later.

See [`docs/08-model-profiles.md`](docs/08-model-profiles.md) for the current configuration format.

## Development

Development dependencies, builds, and tests can run inside the provided container environment without installing an additional Node.js toolchain on the host.

```bash
scripts/dev.sh npm ci
scripts/dev.sh npm run check
scripts/dev.sh npm test
```

Rebuild the development image when necessary:

```bash
TEO_DEV_REBUILD=1 scripts/dev.sh true
```

The main verification command runs type checking, linting, a production build, and the standard test suite:

```bash
scripts/dev.sh npm run check
```

### End-to-End Tests

Real Pi end-to-end tests make model calls and may incur provider costs:

```bash
scripts/e2e.sh
```

The script mounts only the required Pi configuration files as read-only input, copies them into an isolated container, and removes installed package and extension entries from the temporary settings.

## Project Structure

```text
src/policy/       Workflow loading, validation, snapshots, and diffs
src/state/        Durable task state, event storage, indexes, and locks
src/workflow/     Workflow execution and supervisor decisions
src/agents/       Agent runtimes, prompts, tools, and session handling
src/extension/    Pi extension commands and lifecycle integration
src/ui/           Interactive and plain terminal interfaces
test/             Unit, integration, and end-to-end tests
```

## Design Documentation

Detailed design and implementation documents are available in [`docs/`](docs/README.md). The original project specification is available in [`SDLC_CLI_SPEC.md`](SDLC_CLI_SPEC.md).
