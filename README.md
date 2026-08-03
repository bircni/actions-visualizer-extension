# Actions Visualizer

Visualize GitHub Actions and Gitea Actions workflow files as a dependency graph, right next to the
YAML. It is the graph GitHub shows you after a run — except you get it while you are still writing
the file.

## What It Does

- Draws the workflow the way GitHub does: jobs at the same depth grouped into one card, matrix jobs
  in their own tabbed card, and the triggers in the header rather than as boxes in the graph
- **Simulates a run.** Pick an event, choose a ref, fill in `workflow_dispatch` inputs — every job
  whose `if:` depends on them updates instantly. Jobs that would be skipped dim in place, so nothing
  moves as you toggle
- Updates live as you type, so a `needs:` change takes effect immediately
- Click a job to jump to the matching line in the YAML
- Flags problems the YAML does not: `needs:` pointing at a job that does not exist, and circular
  dependencies
- Works with both GitHub (`.github/workflows`) and Gitea (`.gitea/workflows`) — the syntax is the same
- Exports the graph as a standalone SVG

## Simulating A Run

The header is interactive. Click a trigger to simulate that event, and the graph re-evaluates every
job's `if:` against it:

- A job that **would run** keeps its green check.
- A job that **would be skipped** is dimmed and struck through, with the reason on hover. It stays
  exactly where it was, so the layout never jumps.
- A job that **cannot be decided** — its condition depends on a secret, a step output or a job's
  outputs — gets a `?` marker rather than a guess.

Skips propagate along `needs:` the way GitHub does, and `always()` / `!cancelled()` opt out of that.

The evaluator implements GitHub's expression language: contexts, property and index access, the `*`
object filter, all the comparison and logical operators with GitHub's coercion rules (including
case-insensitive string equality and `&&`/`||` returning an operand), and the built-in functions
`contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON` and `fromJSON`.

## How To Use

1. Open a workflow file under `.github/workflows/` or `.gitea/workflows/`.
2. Click the graph icon in the editor title bar, or run **Actions Visualizer: Open Workflow Graph to
   the Side** from the Command Palette.
3. Click a trigger chip in the header to simulate that event; fill in any inputs it declares.
4. Click a job to jump to it in the YAML; `Alt`-click to expand its steps.
5. Pan by dragging, zoom with the wheel or `+` / `-`, and press `0` to fit the graph to the view.

The preview also works on a workflow draft outside a workflows directory, as long as the file has
both `on:` and `jobs:` keys.

## Reading The Graph

| Element | Meaning |
| --- | --- |
| A card | One or more jobs at the same depth sharing the same `needs:` |
| `Matrix: build` tab | A matrix job; click the row to expand it into one row per combination |
| Green check | The job would run for the simulated event |
| Dashed grey circle, struck-through name | The job would be skipped; hover for why |
| Amber `?` | The condition cannot be decided statically |
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
| `Actions Visualizer: Open Workflow Graph to the Side` | Opens the graph beside the YAML |
| `Actions Visualizer: Open Workflow Graph` | Opens the graph in the current column |
| `Actions Visualizer: Export Workflow Graph as SVG` | Saves the current graph as an SVG file |

## Notes

- Layout runs in the extension host, not the webview, so the graph is computed once and the webview
  only draws it. Large workflows stay responsive.
- A workflow that does not parse shows the YAML error rather than a blank panel, so the preview stays
  useful while you are mid-edit.
- Matrix expansion is capped at 50 rows; when a matrix is larger, the graph says so instead of
  silently dropping combinations.
- The simulation is static. It never runs anything and never contacts GitHub or Gitea, so anything
  that only a real run knows stays marked unknown rather than guessed.

## Testing

```bash
npm test           # unit tests
npm run test:e2e   # extension host tests plus the Playwright webview tests
npm run validate   # everything CI runs
```

## Install

Install **Actions Visualizer** from the VS Code Marketplace or the Open VSX Registry, or build it
locally with `npm run install:code:debug`.

## Feedback

Please report bugs and feature requests at
https://github.com/bircni/actions-visualizer-extension/issues.

## License

MIT — see [LICENSE](LICENSE).
