# TODO

## Documentation

- Update [README.md](README.md) to reflect the current rule surface:
  - `FF005` snapshot-gate
  - `FF006` needs-gate
  - `FF007` output-gate
- Document that evaluation is now YAML-backed rather than line-walker based.
- Document reusable-workflow secret handling, including `secrets: inherit`.
- Document that `secrets.GITHUB_TOKEN` is intentionally allowed.
- Refresh the CLI output examples so they match the current grouped, rule-based formatter.

## Propagation Policy

- Revisit how aggressive auto-fixes should be for:
  - `FF006` needs-gate
  - `FF007` output-gate
- Decide where the tool should automatically propagate upstream guards versus only report them.
- Keep the policy conservative and explicit, since this is product behavior, not just parser behavior.

## Regression Coverage

- Add more real-world workflow fixtures derived from sampled repositories.
- Prefer fixture coverage for weird workflow shapes over only synthetic unit cases.
- Capture representative cases for:
  - nested matrix runner selection
  - reusable-workflow secret passing
  - output-gated downstream steps/jobs
  - runner groups and inherited secrets

## Formatter Cleanup

- Continue tightening the formatter around YAML-derived locations.
- Keep presentation logic separate from evaluation logic.
- Look for remaining cases where finding notes or snippets are technically correct but still awkward to read.
