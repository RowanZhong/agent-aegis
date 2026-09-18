"""Synchronous Hermes hooks backed by one private, persistent Node process.

No socket, shell execution, global monkey patches, or per-call process startup.
Hooks are serialized across Hermes worker threads to preserve request ordering.
"""

from __future__ import annotations

import atexit
import json
import logging
import math
from pathlib import Path
import queue
import shutil
import subprocess
import threading
from typing import Any

LOG = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent
MAX_FRAME_BYTES = 8 * 1024 * 1024
UNAVAILABLE = "[AgentAegis] Security engine unavailable; tool execution is blocked. Restart Hermes after fixing the plugin."


class BridgeError(RuntimeError):
    """A bridge failure must never silently authorize a tool."""


class HookDispatchError(RuntimeError):
    """The host must deliver overlapping security inspections, not skip them."""


class NodeBridge:
    def __init__(self, *, node: str, timeout: float, initialization: dict):
        self.node = node
        self.timeout = timeout
        self.initialization = initialization
        self.process: subprocess.Popen | None = None
        self.lock = threading.RLock()
        self.responses: queue.Queue = queue.Queue()
        self.sequence = 0
        self.failure: str | None = None

    def start(self) -> dict:
        with self.lock:
            if self.process is not None:
                raise BridgeError("bridge already started")
            executable = shutil.which(self.node)
            if not executable:
                raise BridgeError("Node.js 22+ is required; configure nodeExecutable or add node to PATH")
            self.process = subprocess.Popen(
                [executable, str(ROOT / "src" / "hermes-bridge.js")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=ROOT, bufsize=0,
            )
            threading.Thread(target=self._read_responses, args=(self.process,), daemon=True).start()
            threading.Thread(target=self._read_logs, args=(self.process,), daemon=True).start()
            return self.call("initialize", self.initialization)

    def _read_responses(self, process: subprocess.Popen) -> None:
        try:
            while True:
                line = process.stdout.readline(MAX_FRAME_BYTES + 1)
                if not line:
                    raise BridgeError("security engine exited")
                if len(line) > MAX_FRAME_BYTES or not line.endswith(b"\n"):
                    raise BridgeError("invalid security engine response frame")
                self.responses.put(json.loads(line))
        except Exception as exc:
            self.responses.put(BridgeError(str(exc)))

    @staticmethod
    def _read_logs(process: subprocess.Popen) -> None:
        # Drain stderr even when logging is disabled; never let a full pipe
        # deadlock tool dispatch. Do not echo potentially sensitive event data.
        try:
            while process.stderr.read(4096):
                pass
        except (OSError, ValueError):
            pass  # The owner closed the process during unload or timeout.

    def call(self, method: str, payload: dict) -> Any:
        with self.lock:
            if self.failure:
                raise BridgeError(self.failure)
            if self.process is None or self.process.poll() is not None:
                raise BridgeError("security engine is not running")
            self.sequence += 1
            try:
                frame = (json.dumps({"id": self.sequence, "method": method, "payload": payload},
                                    ensure_ascii=False) + "\n").encode("utf-8")
                if len(frame) > MAX_FRAME_BYTES:
                    raise BridgeError("security request exceeds 8 MiB")
                # Writing as well as reading is bounded: a stopped worker can
                # fill stdin before we ever reach the response timeout.
                written: queue.Queue = queue.Queue(maxsize=1)

                def write() -> None:
                    try:
                        view = memoryview(frame)
                        while view:
                            count = self.process.stdin.write(view)
                            if not count:
                                raise BridgeError("security engine closed stdin")
                            view = view[count:]
                        written.put(None)
                    except Exception as exc:
                        written.put(exc)

                threading.Thread(target=write, daemon=True).start()
                error = written.get(timeout=self.timeout)
                if error:
                    raise error
                reply = self.responses.get(timeout=self.timeout)
                if isinstance(reply, Exception):
                    raise reply
                if not isinstance(reply, dict) or reply.get("id") != self.sequence:
                    raise BridgeError("security engine response id mismatch")
                if "error" in reply:
                    raise BridgeError(reply["error"])
                return reply.get("result")
            except Exception as exc:
                # Never restart mid-session: that would lose secret/provenance
                # evidence and let a failed inspection be bypassed by retrying.
                self.failure = str(exc) or "security engine timed out"
                self.close()
                raise BridgeError(self.failure) from exc

    def close(self) -> None:
        with self.lock:
            process = self.process
            if process is None:
                return
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()


class HermesAegis:
    def __init__(self, bridge: NodeBridge):
        self.bridge = bridge
        self.turns: dict[str, str] = {}
        self.lock = threading.RLock()

    def hook(self, method: str, **kwargs: Any) -> Any:
        with self.lock:
            try:
                payload = {key: kwargs[key] for key in (
                    "session_id", "task_id", "turn_id", "user_message", "tool_name", "args",
                    "result", "status", "error_message", "duration_ms", "response_text", "model",
                ) if key in kwargs}
                if isinstance(payload.get("user_message"), list):
                    payload["user_message"] = "\n".join(
                        block if isinstance(block, str) else block.get("text", "")
                        for block in payload["user_message"]
                        if isinstance(block, str) or (
                            isinstance(block, dict) and isinstance(block.get("text"), str)
                        )
                    )
                session = payload.get("session_id") or payload.get("task_id")
                if method == "pre_llm_call" and session:
                    self.turns[session] = payload.get("turn_id") or payload.get("task_id") or session
                if session and not payload.get("turn_id"):
                    payload["turn_id"] = self.turns.get(session, "")
                if method in {"pre_tool_call", "post_tool_call"}:
                    # Use Hermes' own resolver (including per-session cd and
                    # worktree overrides), not the gateway process's cwd.
                    from tools.file_tools import _resolve_base_dir
                    payload["workspace_dir"] = str(_resolve_base_dir(payload.get("task_id") or session or "default"))
                if payload.get("tool_name") == "skill_manage":
                    from tools.skill_manager_tool import _find_skill
                    found = _find_skill((payload.get("args") or {}).get("name", ""))
                    if found:
                        payload["skill_dir"] = str(found["path"])
                return self.bridge.call(method, payload)
            except Exception as exc:
                LOG.error("AgentAegis %s failed: %s", method, type(exc).__name__)
                if method == "pre_tool_call":
                    return {"action": "block", "message": UNAVAILABLE}
                if method == "pre_llm_call":
                    return {"context": UNAVAILABLE}
                if method in {"transform_tool_result", "transform_llm_output"}:
                    return UNAVAILABLE
                return None
            finally:
                if method in {"on_session_end", "on_session_finalize", "on_session_reset"}:
                    session = kwargs.get("session_id") or kwargs.get("task_id")
                    self.turns.pop(session, None)


def _register(ctx) -> None:
    from hermes_constants import get_hermes_home
    from agent.skill_utils import get_all_skills_dirs, get_project_skills_dirs

    schema = json.loads((ROOT / "openclaw.plugin.json").read_text(encoding="utf-8"))
    config = {}
    for key in schema["configSchema"]["properties"]:
        value = ctx.get_config(key)
        if value is not None:
            config[key] = value
    if config.get("allDefensesEnabled") is False:
        return
    from hermes_cli import plugins
    hook_timeout = getattr(plugins, "_resolve_hook_callback_timeout", None)
    if callable(hook_timeout) and hook_timeout() != 0:
        raise HookDispatchError(
            "Set plugins.hook_callback_timeout: 0 in the active profile's config.yaml "
            "and restart Hermes. Its bounded hook dispatcher can skip overlapping "
            "security callbacks; AgentAegis bounds its own Node bridge I/O."
        )
    timeout = ctx.get_config("bridgeTimeoutSeconds", 10)
    if isinstance(timeout, bool) or not isinstance(timeout, (float, int)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("bridgeTimeoutSeconds must be a finite positive number")
    protected_skills = []
    if isinstance(config.get("protectedSkills"), list):
        from tools.skill_manager_tool import _find_skill
        for name in config["protectedSkills"]:
            found = _find_skill(name)
            if found:
                protected_skills.append(str(found["path"]))
    bridge = NodeBridge(node=ctx.get_config("nodeExecutable", "node"), timeout=timeout,
                        initialization={"home": str(get_hermes_home()),
                                        "state_dir": str(ctx.state.data_dir / "runtime"),
                                        # Project roots take precedence over profile/external roots.
                                        # Both resolvers exist before and after Hermes' Sep 2026
                                        # removal of the combined scan-order helper.
                                        "skill_roots": [str(p) for p in (
                                            *get_project_skills_dirs(), *get_all_skills_dirs())],
                                        "protectedSkillPaths": protected_skills, "config": config})
    ctx.on_unload(bridge.close)
    atexit.register(bridge.close)
    ctx.on_unload(lambda: atexit.unregister(bridge.close))
    adapter = HermesAegis(bridge)
    # Install guards even if startup fails: Hermes isolates register exceptions,
    # so throwing here would otherwise leave an enabled agent unprotected.
    for name in ("pre_llm_call", "pre_tool_call", "post_tool_call", "transform_tool_result",
                 "transform_llm_output", "on_session_end", "on_session_finalize", "on_session_reset"):
        ctx.register_hook(name, lambda _method=name, **kw: adapter.hook(_method, **kw))
    try:
        initialized = bridge.start()
        if initialized.get("staticContext"):
            ctx.register_system_prompt_section("agent-aegis", initialized["staticContext"], max_chars=4000)
    except Exception as exc:
        bridge.close()
        LOG.error("AgentAegis startup failed: %s; tool calls remain blocked", exc)


def register(ctx) -> None:
    try:
        _register(ctx)
    except Exception as exc:
        # Hermes removes registrations when register() raises. Keep a visible
        # deny guard on configuration/setup failure instead of disappearing.
        message = f"{UNAVAILABLE} {exc}" if isinstance(exc, HookDispatchError) else UNAVAILABLE
        LOG.error("AgentAegis configuration failed (%s); %s", type(exc).__name__, message)
        ctx.register_hook("pre_tool_call", lambda **_: {"action": "block", "message": message})
        ctx.register_hook("pre_llm_call", lambda **_: {"context": message})
        ctx.register_hook("transform_tool_result", lambda **_: message)
        ctx.register_hook("transform_llm_output", lambda **_: message)
