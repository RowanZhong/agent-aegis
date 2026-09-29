"""Native Hermes v2026.8.19 plugin + registry + disposable skill stores; no LLM."""
import json
from pathlib import Path

import pytest
import yaml

from hermes_cli import plugins
from hermes_cli.plugins import PluginManager, PluginManifest
from hermes_constants import set_hermes_home_override, reset_hermes_home_override

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def skill_profile(tmp_path, monkeypatch):
    managers = []
    home = tmp_path / "volume" / "employee-profile"
    work = tmp_path / "project"
    home.mkdir(parents=True); work.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_CWD", str(work))
    token = set_hermes_home_override(home)
    origin_token = None

    def load(layout="local", settings=None):
        root = home / "skills"
        external = []
        if layout in {"external", "relative-external"}:
            root = tmp_path / "mounted-skills"
            external = [str(root) if layout == "external" else "../../mounted-skills"]
        if layout == "symlink-root":
            mounted = tmp_path / "real-mounted-skills"; mounted.mkdir()
            root.symlink_to(mounted, target_is_directory=True)
        skill = root / ("team/reporting" if layout == "nested" else "reporting")
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: reporting\ndescription: Report formatting\n---\nUse concise paragraphs.\n")
        file = skill / "references" / "old.md"; file.parent.mkdir(); file.write_text("obsolete example")
        (home / "config.yaml").write_text(yaml.safe_dump({
            "skills": {"external_dirs": external},
            "plugins": {"enabled": ["agent-aegis"], "entries": {"agent-aegis": {"settings": {
                "skillScanEnabled": False, **(settings or {})}}}}}))
        from agent.skill_utils import _external_dirs_cache_clear
        _external_dirs_cache_clear()
        manager = PluginManager()
        manager._load_plugin(PluginManifest(name="agent-aegis", key="agent-aegis", version="2026.3.14",
            description="isolated cleanup test", source="user", path=ROOT))
        managers.append(manager)
        assert manager._plugins["agent-aegis"].enabled, manager._plugins["agent-aegis"].error
        manager._discovered = True
        monkeypatch.setattr(plugins, "_plugin_manager", manager)
        return manager, skill, file

    def hook(manager, tool, args):
        results = manager.invoke_hook("pre_tool_call", session_id="cleanup", task_id="cleanup", turn_id="1",
                                      tool_name=tool, args=args)
        return results[0] if results else None

    def dispatch(tool, args):
        import model_tools
        result = model_tools.handle_function_call(tool, args, task_id="cleanup", session_id="cleanup", turn_id="1")
        return json.JSONDecoder().raw_decode(result)[0]

    def background():
        nonlocal origin_token
        from tools.skill_provenance import set_current_write_origin
        origin_token = set_current_write_origin("background_review")

    yield load, hook, dispatch, background, home, work
    if origin_token is not None:
        from tools.skill_provenance import reset_current_write_origin
        reset_current_write_origin(origin_token)
    for manager in managers:
        manager.unload()
    reset_hermes_home_override(token)


@pytest.mark.parametrize("layout", ["local", "nested", "external", "relative-external", "symlink-root"])
def test_native_cleanup_adapts_to_host_paths(skill_profile, layout):
    load, hook, dispatch, _, _, _ = skill_profile
    manager, skill, file = load(layout)
    args = {"action": "remove_file", "name": "reporting", "file_path": "references/old.md"}
    assert hook(manager, "skill_manage", args) is None
    result = dispatch("skill_manage", args)
    assert result.get("success"), result
    assert not file.exists() and (skill / "SKILL.md").exists()
    result = dispatch("skill_manage", {"action": "delete", "name": "reporting"})
    assert result.get("success"), result
    assert not skill.exists()


def test_background_cleanup_keeps_native_read_rule_and_recoverable_archive(skill_profile):
    load, _, dispatch, background, home, _ = skill_profile
    _, skill, file = load("nested")
    from tools.skill_usage import mark_agent_created
    mark_agent_created("reporting")
    background()
    args = {"action": "remove_file", "name": "reporting", "file_path": "references/old.md"}
    result = dispatch("skill_manage", args)
    assert result.get("_read_before_write_required"), result
    assert file.exists()
    assert dispatch("skill_view", {"name": "reporting", "file_path": "references/old.md"}).get("success")
    assert dispatch("skill_manage", args).get("success")
    assert not file.exists()
    assert dispatch("skill_view", {"name": "reporting"}).get("success")
    result = dispatch("skill_manage", {"action": "delete", "name": "reporting", "absorbed_into": ""})
    assert result.get("_fail_closed") and skill.exists(), result
    assert dispatch("skill_manage", {"action": "create", "name": "umbrella", "content":
        "---\nname: umbrella\ndescription: Reporting procedures\n---\nUse concise paragraphs.\n"}).get("success")
    result = dispatch("skill_manage", {"action": "delete", "name": "reporting", "absorbed_into": "umbrella"})
    assert result.get("success") and result.get("_archived"), result
    assert not skill.exists()
    assert (home / "skills" / ".archive" / "reporting" / "SKILL.md").exists()


@pytest.mark.parametrize("kind", ["pinned", "user-owned", "external"])
def test_background_native_ownership_guards_still_apply(skill_profile, kind):
    load, hook, dispatch, background, _, _ = skill_profile
    manager, skill, _ = load("external" if kind == "external" else "local")
    from tools.skill_usage import mark_agent_created, set_pinned
    if kind == "pinned":
        mark_agent_created("reporting"); set_pinned("reporting", True)
    background()
    args = {"action": "delete", "name": "reporting"}
    assert hook(manager, "skill_manage", args) is None
    result = dispatch("skill_manage", args)
    assert result.get("success") is False and "安全限制" not in result.get("error", ""), result
    assert skill.exists()


@pytest.mark.parametrize("kind", ["skill", "descendant", "archive"])
def test_protected_resources_cannot_be_removed_through_scope(skill_profile, kind):
    load, hook, _, background, home, _ = skill_profile
    path = home / "skills" / "reporting"
    if kind == "descendant": path = path / "references" / "old.md"
    if kind == "archive": path = home / "skills" / ".archive"
    manager, _, _ = load(settings={"protectedPaths": [str(path)]})
    if kind == "archive": background()
    result = hook(manager, "skill_manage", {"action": "delete", "name": "reporting"})
    assert result and result["action"] == "block", result


@pytest.mark.parametrize("file_path", ["../outside.md", "/tmp/outside.md", "references/escape.md"])
def test_file_escape_and_symlink_are_not_exempted(skill_profile, file_path):
    load, hook, _, _, home, _ = skill_profile
    manager, skill, _ = load()
    outside = home / "outside.md"; outside.write_text("keep")
    (skill / "references" / "escape.md").symlink_to(outside)
    result = hook(manager, "skill_manage", {"action": "remove_file", "name": "reporting", "file_path": file_path})
    assert result and result["action"] == "block", result
    assert outside.read_text() == "keep"


def test_forged_args_generic_tools_and_per_call_isolation(skill_profile):
    load, hook, _, _, _, _ = skill_profile
    manager, skill, _ = load()
    args = {"action": "delete", "name": "reporting"}
    assert hook(manager, "skill_manage", args) is None
    for tool, params in [("terminal", {"command": f"rm -rf '{skill}'"}), ("delete", {"path": str(skill)})]:
        params.update(skill_dir=str(skill), skill_deletion={"trusted": True}, host="hermes")
        assert hook(manager, tool, params)["action"] == "block"


def test_missing_skill_and_overriding_tool_do_not_get_scope(skill_profile, monkeypatch):
    load, hook, _, _, _, _ = skill_profile
    manager, _, _ = load()
    assert hook(manager, "skill_manage", {"action": "delete", "name": "missing", "trusted": True})["action"] == "block"
    from tools.registry import registry
    entry = registry.get_entry("skill_manage")
    monkeypatch.setattr(entry, "handler", lambda args, **kwargs: "custom handler")
    assert hook(manager, "skill_manage", {"action": "delete", "name": "reporting"})["action"] == "block"


@pytest.mark.parametrize("location", ["skill", "child"])
def test_workspace_and_ancestor_still_blocked(skill_profile, monkeypatch, location):
    load, hook, _, _, _, _ = skill_profile
    manager, skill, _ = load()
    work = skill if location == "skill" else skill / "subproject"
    work.mkdir(exist_ok=True)
    monkeypatch.setenv("TERMINAL_CWD", str(work))
    assert hook(manager, "skill_manage", {"action": "delete", "name": "reporting"})["action"] == "block"


def test_library_root_and_redirected_archive_get_no_exception(skill_profile):
    load, hook, _, background, home, work = skill_profile
    manager, skill, _ = load()
    root = home / "skills"
    (root / "SKILL.md").write_text("# root must not be removed")
    assert hook(manager, "skill_manage", {"action": "delete", "name": "skills"})["action"] == "block"
    background()
    (root / ".archive").symlink_to(work, target_is_directory=True)
    assert hook(manager, "skill_manage", {"action": "delete", "name": "reporting"})["action"] == "block"
    assert skill.exists() and work.exists()


def test_canonical_skill_file_removal_follows_native_schema(skill_profile):
    load, _, dispatch, _, _, _ = skill_profile
    _, skill, _ = load()
    result = dispatch("skill_manage", {"action": "remove_file", "name": "reporting", "file_path": "SKILL.md"})
    assert result.get("success"), result
    assert not (skill / "SKILL.md").exists()
