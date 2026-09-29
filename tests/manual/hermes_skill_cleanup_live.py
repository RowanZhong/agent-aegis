"""Real AIAgent executor, background provenance, disposable skills; no inference.

--repo can select the previous checkout for an enforce-mode before/after run.
Only fixture files are created/deleted. Production profile and credentials are
never loaded. Native ownership/read-before-write/consolidation guards stay on.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--hermes-root", type=Path, required=True)
p.add_argument("--output", type=Path, required=True)
p.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
p.add_argument("--expect-cleanup", choices=["allowed", "blocked"], default="allowed")
p.add_argument("--plugin-disabled", action="store_true", help="Control for native read-mark context loss")
a = p.parse_args()
repo = a.repo.resolve(); out = a.output.resolve(); out.mkdir(mode=0o700)
home = out / "volume" / "employee-profile"; home.mkdir(parents=True)
work = out / "project"; work.mkdir()
os.environ.update(HERMES_HOME=str(home), TERMINAL_CWD=str(work), TERMINAL_ENV="local",
                  HERMES_SKIP_UPDATE_CHECK="1", HERMES_DISABLE_TELEMETRY="1")
os.chdir(work); sys.path.insert(0, str(a.hermes_root.resolve()))
import yaml
plugin = home / "plugins" / "agent-aegis"; plugin.mkdir(parents=True)
for name in ["__init__.py", "hermes_adapter.py", "plugin.yaml", "openclaw.plugin.json", "package.json"]:
    shutil.copy2(repo / name, plugin / name)
shutil.copytree(repo / "src", plugin / "src", ignore=shutil.ignore_patterns("*.ts"))
(home / "config.yaml").write_text(yaml.safe_dump({
    "plugins": {"enabled": [] if a.plugin_disabled else ["agent-aegis"], "entries": {"agent-aegis": {"settings": {
        "defaultBlockingMode": "enforce", "skillScanEnabled": False}}}},
    "terminal": {"backend": "local", "cwd": str(work)},
    "tools": {"tool_search": {"enabled": "off"}},
    "memory": {"memory_enabled": True, "user_profile_enabled": True}}))
from run_agent import AIAgent
from hermes_cli.plugins import get_plugin_manager, set_thread_tool_whitelist, clear_thread_tool_whitelist
from tools.skill_provenance import set_current_write_origin, reset_current_write_origin
from agent import background_review
from openai.types.chat import ChatCompletionMessage, ChatCompletionMessageFunctionToolCall
from openai.types.chat.chat_completion_message_function_tool_call import Function

agent = AIAgent(provider="anthropic", api_mode="anthropic_messages", api_key="unused-native-fixture",
    model="claude-sonnet-5", enabled_toolsets=["memory", "skills"], quiet_mode=True,
    save_trajectories=False, skip_context_files=True, skip_background_review=True,
    platform="cli", session_id="cleanup", parent_session_id="parent", max_iterations=4)
manager = get_plugin_manager()
assert a.plugin_disabled or manager._plugins["agent-aegis"].enabled
agent._current_turn_id = "review"
agent._memory_write_origin = "background_review"
agent._memory_write_context = "background_review"
# build_turn_context normally sets this for a real review conversation; this
# deterministic run invokes its tool executor without making an API request.
origin = set_current_write_origin("background_review")
from tools.skill_manager_tool import _reset_background_review_read_marks
_reset_background_review_read_marks()
set_thread_tool_whitelist({"memory", "skill_manage", "skill_view", "skills_list"})
messages = []; cases = []; checks = {}


def execute(label, tool, args):
    call = ChatCompletionMessageFunctionToolCall(id=f"cleanup_{len(cases)}", type="function",
        function=Function(name=tool, arguments=json.dumps(args)))
    message = ChatCompletionMessage(role="assistant", content=None, tool_calls=[call])
    start = len(messages)
    messages.append({"role": "assistant", "content": None, "tool_calls": [call.model_dump()]})
    agent._execute_tool_calls(message, messages, "cleanup")
    results = [m for m in messages[start:] if m.get("role") == "tool"]
    assert len(results) == 1, results
    result = json.JSONDecoder().raw_decode(results[0]["content"])[0]
    cases.append({"case": label, "tool": tool, "args": args, "result": result})
    return result


def skill_content(name, body="Use concise paragraphs."):
    return f"---\nname: {name}\ndescription: Local reporting procedures\n---\n{body}\n"


try:
    for name in ["_MEMORY_REVIEW_PROMPT", "_SKILL_REVIEW_PROMPT", "_COMBINED_REVIEW_PROMPT"]:
        result = manager.invoke_hook("pre_llm_call", session_id="cleanup", task_id="cleanup", turn_id="review",
            platform="cli", parent_session_id="parent", user_message=getattr(background_review, name))
        checks[name] = not result
    for label, args in [
        ("memory_add", {"action": "add", "content": "Prefers concise Chinese responses."}),
        ("memory_replace", {"action": "replace", "old_text": "Prefers concise Chinese responses.", "content": "Prefers concise responses with examples."}),
        ("memory_remove", {"action": "remove", "old_text": "Prefers concise responses with examples."}),
    ]:
        checks[label] = execute(label, "memory", {"target": "user", **args}).get("success") is True
    checks["skill_create"] = execute("skill_create", "skill_manage", {
        "action": "create", "name": "reporting", "category": "team", "content": skill_content("reporting")}).get("success") is True
    checks["skill_read"] = execute("skill_read", "skill_view", {"name": "reporting"}).get("success") is True
    # v2026.8.19 relay_tools executes in a copied Context, losing skill_view's
    # ContextVar read mark. Keep this host failure explicit, including in the
    # plugin-disabled control; do not seed marks or bypass the native guard.
    patched = execute("skill_patch", "skill_manage", {"action": "patch", "name": "reporting",
        "old_string": "Use concise paragraphs.", "new_string": "Use concise paragraphs and examples."})
    checks["host_read_mark_loss_after_skill_view"] = patched.get("_read_before_write_required") is True
    checks["reference_write"] = execute("reference_write", "skill_manage", {"action": "write_file", "name": "reporting",
        "file_path": "references/old.md", "file_content": "Obsolete reporting example."}).get("success") is True
    remove = {"action": "remove_file", "name": "reporting", "file_path": "references/old.md"}
    first = execute("remove_before_read", "skill_manage", remove)
    blocked = a.expect_cleanup == "blocked"
    checks["remove_before_read"] = "安全限制" in first.get("error", "") if blocked else first.get("_read_before_write_required") is True
    checks["reference_read"] = execute("reference_read", "skill_view", {"name": "reporting", "file_path": "references/old.md"}).get("success") is True
    removed = execute("remove_after_read", "skill_manage", remove)
    checks["remove_after_read"] = "安全限制" in removed.get("error", "") if blocked else removed.get("_read_before_write_required") is True
    skill = home / "skills/team/reporting"
    checks["reference_disk"] = (skill / "references/old.md").exists()
    bare = execute("bare_background_delete", "skill_manage", {"action": "delete", "name": "reporting", "absorbed_into": ""})
    checks["bare_background_delete"] = "安全限制" in bare.get("error", "") if blocked else bare.get("_fail_closed") is True
    checks["umbrella_create"] = execute("umbrella_create", "skill_manage", {"action": "create", "name": "umbrella",
        "content": skill_content("umbrella", "Use concise paragraphs and examples.")}).get("success") is True
    archived = execute("verified_consolidation", "skill_manage", {"action": "delete", "name": "reporting", "absorbed_into": "umbrella"})
    checks["verified_consolidation"] = "安全限制" in archived.get("error", "") if blocked else archived.get("success") is True and archived.get("_archived") is True
    checks["source_disk"] = skill.exists() == blocked
    checks["archive_disk"] = (home / "skills/.archive/reporting/SKILL.md").exists() != blocked
    assert all(checks.values()), checks
finally:
    clear_thread_tool_whitelist(); reset_current_write_origin(origin)
    agent.close(); manager.unload()
    (out / "report.json").write_text(json.dumps({"method": "native AIAgent tools with background provenance and whitelist; no inference",
        "expect_cleanup": a.expect_cleanup, "plugin_disabled": a.plugin_disabled,
        "host_limitation": "v2026.8.19 relay_tools copies Context: prior skill_view marks do not survive to patch/remove_file. Explicitly tested, not bypassed.",
        "checks": checks, "cases": cases}, ensure_ascii=False, indent=2))
print(json.dumps({"passed": sum(bool(v) for v in checks.values()), "checks": checks}, ensure_ascii=False))
