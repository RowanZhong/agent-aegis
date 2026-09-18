# Opt-in live checks

These scripts are deliberately outside CI. Use a full installed Hermes Python
environment and an **unmodified v2026.8.19 checkout**. `--hermes-root` selects the
source to import; the Python interpreter supplies its dependencies. Build this
plugin with `npm test` first. Every output directory/case must be new.

```sh
# Set these to your reviewed checkout and full Hermes environment.
HERMES_TEST_PYTHON=/absolute/path/to/hermes/venv/bin/python
HERMES_TEST_ROOT=/absolute/path/to/hermes-v2026.8.19

"$HERMES_TEST_PYTHON" tests/manual/hermes_live_matrix.py \
  --hermes-root "$HERMES_TEST_ROOT" --output /tmp/aegis-new-run \
  --mode native --case inline_path

# Actual provider inference using Hermes' native credential resolver.
"$HERMES_TEST_PYTHON" tests/manual/hermes_live_matrix.py \
  --hermes-root "$HERMES_TEST_ROOT" --output /tmp/aegis-new-run \
  --mode model --case encoded_result_base64

"$HERMES_TEST_PYTHON" tests/manual/hermes_cli_live.py \
  --hermes-root "$HERMES_TEST_ROOT" --output /tmp/aegis-new-cli

"$HERMES_TEST_PYTHON" tests/manual/hermes_lifecycle_live.py \
  --hermes-root "$HERMES_TEST_ROOT" --output /tmp/aegis-new-lifecycle --check-ttl

node tests/manual/scanner_live.mjs /tmp/aegis-new-scanner

# Actual Anthropic HTTP request capture against a local deterministic endpoint.
"$HERMES_TEST_PYTHON" tests/manual/hermes_prompt_capture.py \
  --hermes-root "$HERMES_TEST_ROOT" --output /tmp/aegis-new-prompt-capture
```

`model` uses real inference and real tools. `native` constructs calls for the
real `AIAgent` executor; it does not run a model or substitute tool handlers.
The CLI test uses `hermes chat` and the configured Anthropic model. A model may
decline or choose a different tool; a failed scenario assertion must then be
reported as not exercised, not silently counted as an Aegis veto. Read the
actual tool calls, events and filesystem/network outcomes in `report.json` and
`transcript.json`. Failed assertions return nonzero. The historical 2026-09-18
runs before that exit-code addition must be assessed by their report fields.

Matrix cases:

- Modes: `command_enforce`, `command_observe`, `command_off`, `global_off`.
- Paths: `protected_read`, `protected_write`, `protected_patch`,
  `protected_symlink`, `protected_move`, `protected_delete`, `outside_delete`,
  `inline_path`, `config_write`, `multi_patch`, `skill_write`, `plugin_write`.
- Memory: `memory_safe`, `memory_poison`, `memory_batch`, `memory_chars`,
  `memory_lines`, `memory_boundary`, `memory_file`.
- Other guards: `obfuscation`, `provenance`, `loop`, `worker_failure`.
- Results/network: `result_injection`, `result_budget`, `encoded_result_base64`,
  `encoded_result_base32`, `encoded_result_hex`, `encoded_result_url`,
  `encoded_result_double`, `exfiltration`, `exfiltration_off`, `ssrf_probe`.
- Model-only output/turn probes: `redaction`, `redaction_encoded`, `dispatch`.

`ssrf_probe` is **observational**: successful local delivery demonstrates that
the chain detector is not a general private-address firewall. It must not be
included in a count of prevented attacks. `checks` contains assertion outcomes;
for example, `checks.marker_exists=true` can mean that the assertion expecting
the marker **not** to exist passed. The filesystem fact is `actual.marker_exists`.

The lifecycle script checks real startup/turn scanning, persistence/reload,
static prompt stability, integrity fingerprints, observed-secret isolation,
reset and process cleanup. It explicitly supplies final-output text to the
native hook; this is not model inference. `--check-ttl` additionally waits 301
real seconds without substituting a clock. The scanner script uses the real
engine worker and terminates only that owned worker for fault injection; it
does not run a Hermes conversation.

The prompt capture script runs four real Hermes turns and records five actual
Anthropic SDK HTTP request bodies. A loopback endpoint supplies deterministic
SSE replies and one real file-tool call. Synthetic credentials are fixed in the
test process so native credential refresh cannot change API-key/OAuth identity
formatting between requests. It checks the actual system/tools fields, dynamic
context placement and replay, not provider cache hit statistics. Request headers
are not persisted. There is no external inference in this transport probe.

## False-positive regression checks

```sh
# Real AIAgent executor: 2 prints, 6 blocked fixture operations, audit probes.
"$HERMES_TEST_PYTHON" tests/manual/hermes_false_positive_live.py \
  --hermes-root "$HERMES_TEST_ROOT" --output /tmp/aegis-new-fp-native --mode native

# Real Claude Sonnet 5 inference and two exact terminal commands.
"$HERMES_TEST_PYTHON" tests/manual/hermes_false_positive_live.py \
  --hermes-root "$HERMES_TEST_ROOT" --output /tmp/aegis-new-fp-model --mode model
```

The native result-notification probes explicitly invoke the registered hook;
they are not model-generated injection attempts. Check `report.json` for every
assertion. `model` fails if the model refuses, changes or omits either command.
The model must stop on a block; the script does not ask it to work around guards.
See the [results and limitations](../../docs/false-positive-improvements-2026-09-18.md).

For the duplicate-alert UI check, copy the native run's `defense-events.jsonl`
to the disposable Web state directory described below. Expect 10 raw records:
6 individual blocks and 4 scan observations. With `collapse=true`, expect 8 rows,
including two scan groups of 2. Verify the checkbox restores all 10 rows, the
weak group shows Info/信息, and language switching retains the expected counts.

All payload effects target new disposable files. The pipe-to-shell fixture
only prints/writes a marker. Provenance and encoded fixtures contain inert text
that is never executed. Network sinks bind only to loopback. Never substitute
real credentials, production paths or destructive-system commands as fixtures.
Observed-secret tests disable Hermes' earlier redactor only in their isolated
process so that Aegis can see the synthetic key. Normal provider credentials are
resolved in memory and are not saved in reports.

## Web checks

Build the existing `web` workspace and start its API with `AEGIS_CONFIG_DIR`
pointing to a disposable directory containing a copy of `openclaw.plugin.json`,
and `AEGIS_STATE_DIR` to a disposable `state` subdirectory. Use loopback and a
free test port. Do not use a production profile or a Hermes YAML configuration.

The API probe expects one disposable trusted-skill record plus a real blocked
event and self-integrity record copied from the native tests. Run it once:

```sh
"$HERMES_TEST_PYTHON" tests/manual/web_live.py \
  --config /tmp/aegis-web-fixture --url http://127.0.0.1:39081
```

It saves/resets only that fixture's configuration and appends a canary event.
Browser checks are manual: enter the generated local token, inspect dashboard,
add/save a protected test path and reload, filter blocked events, show/filter
actual skill-scan records, and remove the disposable trust record. Stop the
test server and close the test tab afterwards. HTTP/API checks are separate
from browser checks; one does not prove the other.
