<div align="center">

<img src="assets/icon.png" alt="" width="88" height="88" />

# Actions Visualizer

**See your GitHub and Gitea Actions workflows as a graph — and simulate a run before you push.**

It is the graph GitHub shows you after a run, except you get it while you are still writing the file.

[![CI](https://github.com/bircni/actions-visualizer-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/bircni/actions-visualizer-extension/actions/workflows/ci.yml)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.105-0098FF?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

![The Actions Visualizer panel open beside ci.yml. The header shows the workflow name, its push and
pull_request triggers with pull_request selected, and the ref being simulated. Below it a card lists
the ci, e2e and security jobs, with ci expanded to show its steps.](assets/example/preview.png)

---

## Highlights

|  | |
| --- | --- |
| **Laid out like GitHub** | Jobs at the same depth share a card, matrix jobs get their own tabbed card, and triggers live in the header rather than as boxes in the graph. |
| **Simulates a run** | Pick an event, a ref and any `workflow_dispatch` inputs. Every job whose `if:` depends on them updates instantly. |
| **Honest about the unknown** | A condition that depends on a secret or a step output is marked undecided rather than guessed at — and you can pin a value to decide it. |
| **Catches real mistakes** | Missing `needs:` targets, circular dependencies, always-false conditions and job conditions using a context GitHub only gives to steps — in the Problems panel, not just the graph. |
| **Live** | Re-renders as you type; click any job to jump to its line in the YAML. |
| **Fully keyboard accessible** | Arrow keys, `Enter` to reveal, `Space` to expand, with labels for screen readers. |
| **GitHub and Gitea** | `.github/workflows` and `.gitea/workflows` — the syntax is the same. |

## Getting started

1. Open a workflow file under `.github/workflows/` or `.gitea/workflows/`.
2. Click the graph icon in the editor title bar, or run **Actions Visualizer: Open Workflow Graph to
   the Side** from the Command Palette.
3. Click a trigger chip in the header to simulate that event. Fill in any inputs, the ref, and any
   values the preview cannot work out on its own.
4. Click a job to jump to it in the YAML. `Alt`-click to expand its steps.

The preview follows your active editor: opening another workflow moves the existing panel rather than
adding a second one, and switching to a file that is not a workflow leaves the graph as it was. It
also works on a draft outside a workflows directory, as long as the file has both `on:` and `jobs:`.

### Keyboard and pointer

| | |
| --- | --- |
| Move between jobs | <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd>, or <kbd>Home</kbd> / <kbd>End</kbd> |
| Reveal a job in the YAML | <kbd>Enter</kbd>, or click |
| Expand a job's steps | <kbd>Space</kbd>, or <kbd>Alt</kbd>-click |
| Zoom | <kbd>+</kbd> <kbd>-</kbd>, or the mouse wheel |
| Fit the graph to the view | <kbd>0</kbd> |
| Pan | drag |

## Simulating a run

The header is interactive. Click a trigger and the graph re-evaluates every job's `if:` against it:

- A job that **would run** keeps its green check.
- A job that **would be skipped** is dimmed and struck through, with the reason on hover. It stays
  exactly where it was, so nothing moves as you toggle.
- A job that **cannot be decided** gets an amber `?` rather than a guess.

Steps are evaluated too, against the wider set of contexts GitHub gives them. Skips propagate along
`needs:` the way GitHub does, and `always()` / `!cancelled()` opt out of that.

Type a ref that the workflow's `branches:` or `tags:` filters reject and the graph says the event
would not fire at all, instead of pretending everything runs.

When a condition depends on something no preview can know — a secret, a step output, another job's
output — the header offers a field for it. Fill it in and every condition that depends on it decides.

<details>
<summary><strong>What the expression evaluator supports</strong></summary>

The full GitHub Actions expression language: contexts, property and index access, the `*` object
filter, and every comparison and logical operator with GitHub's coercion rules — including
case-insensitive string equality, cross-type numeric casting, and `&&` / `||` returning an operand
rather than a boolean. Built-in functions: `contains`, `startsWith`, `endsWith`, `format`, `join`,
`toJSON`, `fromJSON`, and the status functions `success`, `always`, `failure` and `cancelled`.

Context availability is modelled too. A job-level `if:` sees only `github`, `needs`, `vars` and
`inputs`; a step-level one additionally sees `env`, `matrix`, `job`, `runner`, `steps` and
`strategy`. Using the wrong one is reported as a problem, because GitHub evaluates it as empty.

</details>

## Reading the graph

| Element | Meaning |
| --- | --- |
| A card | One or more jobs at the same depth sharing the same `needs:` |
| `Matrix: build` tab | A matrix job; click the row to expand it into one row per combination |
| Green check | The job would run for the simulated event |
| Dashed grey circle, struck-through name | The job would be skipped; hover for why |
| Amber `?` | The condition cannot be decided statically; pin its value in the header |
| Red dashed card | A `needs:` reference to a job that does not exist |
| Solid line with end dots | A `needs:` dependency |
| Faded dashed line | Every job behind this dependency is skipped |
| Right-hand grey text | The job's `runs-on` |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `actions-visualizer.showSteps` | `collapsed` | How much step detail job rows start with: `collapsed`, `expanded` or `never`. |
| `actions-visualizer.expandMatrix` | `false` | Expand every matrix card to one row per combination by default. |
| `actions-visualizer.direction` | `LR` | Direction the graph flows in: `LR` or `TB`. |
| `actions-visualizer.liveUpdate` | `true` | Re-render the graph while you edit the workflow file. |
| `actions-visualizer.updateDelayMs` | `300` | Debounce in milliseconds before a live update re-renders. |

## Commands

| Command | Description |
| --- | --- |
| **Actions Visualizer: Open Workflow Graph to the Side** | Opens the graph beside the YAML |
| **Actions Visualizer: Open Workflow Graph** | Opens the graph in the current column |
| **Actions Visualizer: Export Workflow Graph as SVG** | Saves the current graph as an SVG file |

## Good to know

- **Nothing ever runs.** The simulation is entirely static and never contacts GitHub or Gitea, so
  anything only a real run could know stays marked unknown rather than guessed.
- **Layout happens in the extension host**, not the webview, so the graph is computed once and the
  webview only draws it. Large workflows stay responsive.
- **A workflow that does not parse** shows the YAML error rather than a blank panel, so the preview
  stays useful mid-edit.
- **Matrix expansion is capped at 50 rows.** When a matrix is larger the graph says so, rather than
  silently dropping combinations.

## Contributing

```bash
npm install
npm test           # unit tests
npm run test:e2e   # extension host tests plus the Playwright webview tests
npm run validate   # everything CI runs
```

See [AGENTS.md](AGENTS.md) for the architecture and the conventions to follow.

## Feedback

Bugs and feature requests are welcome in
[the issue tracker](https://github.com/bircni/actions-visualizer-extension/issues).

## License

MIT — see [LICENSE](LICENSE).
