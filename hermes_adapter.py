"""Synchronous Hermes hooks backed by one private, persistent Node process.

No socket, shell execution, global monkey patches, or per-call process startup.
Hooks are serialized across Hermes worker threads to preserve request ordering.
"""

from __future__ import annotations

import atexit
import hashlib
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


def _dws_source_fingerprints(value: Any) -> list[str]:
    """Summarize source rows actually present in a transported tool result.

    Content is transient and bounded. A retained tool ID alone is insufficient
    because Hermes compression can replace its body with a placeholder.
    """
    try:
        for _ in range(4):
            if isinstance(value, str):
                if len(value.encode("utf-8")) > 65536:
                    return []
                # Hermes may append Aegis review text after the original JSON.
                value, _end = json.JSONDecoder().raw_decode(value.lstrip())
                continue
            if isinstance(value, list):
                if len(value) != 1 or value[0].get("type") != "text":
                    return []
                value = value[0].get("text")
                continue
            if not isinstance(value, dict) or value.get("error") or value.get("success") is False:
                return []
            if "exit_code" in value:
                if value["exit_code"] != 0:
                    return []
                value = value.get("output")
                continue
            break
        if not isinstance(value, dict) or value.get("success") is not True:
            return []
        rows = value.get("messages")
        if not isinstance(rows, list) or len(rows) > 32:
            return []
        fingerprints = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            keys = [row.get("messageId"), row.get("conversationId"),
                    row.get("senderOpenDingTalkId"), row.get("senderUserId"), row.get("text")]
            if not all(isinstance(keys[i], str) and keys[i] for i in (0, 1, 4)):
                continue
            if any(v is not None and (not isinstance(v, str) or len(v) > 256) for v in keys[:4]):
                continue
            encoded = json.dumps(keys, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) <= 65536:
                fingerprints.append(hashlib.sha256(encoded).hexdigest())
        return fingerprints
    except (ValueError, TypeError, AttributeError):
        return []


class BridgeError(RuntimeError):
    """A bridge failure must never silently authorize a tool."""


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


def _skill_deletion_scope(args: dict, skill_dir: Path) -> dict | None:
    """Describe a native skill operation, never trust scope fields in tool args.

    Failure only withholds the exception; the ordinary guards still run.
    Ownership, pinning and read-before-write remain the native tool's job.
    """
    try:
        action = args.get("action")
        if action not in {"delete", "remove_file"}:
            return None
        from agent.skill_utils import get_all_skills_dirs
        from tools import skill_manager_tool as skills
        from tools.registry import registry

        entry = registry.get_entry("skill_manage")
        if not entry or entry.handler.__module__ != skills.__name__:
            return None  # An overriding/custom tool does not get native privileges.
        roots = [p.resolve(strict=True) for p in get_all_skills_dirs() if p.is_dir()]
        directory = skill_dir.resolve(strict=True)
        if directory in roots or not any(directory.is_relative_to(p) for p in roots):
            return None
        if not (directory / "SKILL.md").is_file():
            return None
        archive_dir = None
        if action == "delete":
            if skills._validate_delete_target(skill_dir):
                return None
            target = directory
            from tools.skill_provenance import is_background_review
            if is_background_review():
                from tools.skill_usage import _archive_dir
                archive_dir = _archive_dir().resolve()
                if archive_dir in roots or not any(archive_dir.is_relative_to(p) for p in roots):
                    return None
        else:
            file_path = args.get("file_path")
            if not isinstance(file_path, str) or skills._validate_file_path(file_path):
                return None
            target, error = skills._resolve_skill_target(skill_dir, file_path)
            if error or target is None or not target.is_file():
                return None
            target = target.resolve(strict=True)
            if target == directory or not target.is_relative_to(directory):
                return None
        return {"action": action, "name": args.get("name"), "skillDir": str(directory),
                "roots": [str(p) for p in roots], "target": str(target),
                "archiveDir": str(archive_dir) if archive_dir else None}
    except Exception:
        return None


class HermesAegis:
    def __init__(self, bridge: NodeBridge, reply_enabled: bool = False):
        self.bridge = bridge
        self.reply_enabled = reply_enabled
        self.turns: dict[str, str] = {}
        self.lock = threading.RLock()

    def hook(self, method: str, **kwargs: Any) -> Any:
        if method in {"pre_api_request", "post_api_request"} and not self.reply_enabled:
            return None
        with self.lock:
            try:
                payload = {key: kwargs[key] for key in (
                    "session_id", "task_id", "turn_id", "user_message", "tool_name", "args",
                    "result", "status", "error_message", "duration_ms", "response_text", "model",
                    "tool_call_id", "api_request_id", "platform", "sender_id", "parent_session_id",
                ) if key in kwargs}
                if method in {"pre_api_request", "post_api_request"}:
                    payload = {key: payload[key] for key in (
                        "session_id", "task_id", "turn_id", "api_request_id",
                    ) if key in payload}
                if method == "pre_api_request":
                    # Summarize actual transport messages, not pre_llm_call counts.
                    # Do not ship prompts/provider credentials or raw request objects.
                    messages = kwargs.get("request_messages")
                    ids = []
                    fingerprints = {}
                    total_bytes = 0
                    def remember(tool_id, content):
                        nonlocal total_bytes
                        if not isinstance(tool_id, str) or not tool_id or len(tool_id) > 512:
                            return False
                        ids.append(tool_id)
                        if isinstance(content, str) and len(content)<=65536:
                            total_bytes += len(content.encode("utf-8"))
                        elif isinstance(content, str):
                            return False
                        else:
                            # Unknown structured content cannot establish this edge.
                            return True
                        if total_bytes > 65536:
                            return False
                        fingerprints[tool_id] = _dws_source_fingerprints(content)
                        return True
                    complete = isinstance(messages, list) and len(messages) <= 128
                    if complete:
                        for message in messages:
                            if not complete:
                                break
                            if not isinstance(message, dict):
                                complete = False
                                break
                            if message.get("role") == "tool":
                                complete = remember(message.get("tool_call_id"), message.get("content")) and complete
                            elif message.get("type") == "function_call_output":
                                complete = remember(message.get("call_id"), message.get("output")) and complete
                            content = message.get("content")
                            if isinstance(content, list):
                                if len(content) > 128:
                                    complete = False
                                    break
                                for block in content:
                                    if not complete:
                                        break
                                    if isinstance(block, dict) and block.get("type") == "tool_result":
                                        complete = remember(block.get("tool_use_id"), block.get("content")) and complete
                    complete = complete and len(ids) <= 128 and all(isinstance(x, str) and x for x in ids)
                    payload.update(tool_result_ids=ids if complete else [],
                                   tool_result_fingerprints=fingerprints if complete else {},
                                   retry_count=kwargs.get("retry_count"), reply_evidence_complete=complete)
                elif method == "post_api_request":
                    message = kwargs.get("assistant_message")
                    calls = message.get("tool_calls") if isinstance(message, dict) else getattr(message, "tool_calls", None)
                    calls = calls or []
                    complete = isinstance(calls, list) and len(calls) <= 32
                    ids = [(c.get("id") if isinstance(c, dict) else getattr(c, "id", None)) for c in calls] if complete else []
                    complete = complete and all(isinstance(x, str) and x for x in ids)
                    payload.update(tool_call_ids=ids if complete else [], reply_evidence_complete=complete)
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
                        if method == "pre_tool_call":
                            payload["skill_deletion"] = _skill_deletion_scope(
                                payload.get("args") or {}, found["path"])
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
    from agent.skill_utils import get_scan_ordered_skills_dirs

    schema = json.loads((ROOT / "openclaw.plugin.json").read_text(encoding="utf-8"))
    config = {}
    for key in schema["configSchema"]["properties"]:
        value = ctx.get_config(key)
        if value is not None:
            config[key] = value
    if config.get("allDefensesEnabled") is False:
        return
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
                                        "skill_roots": [str(p) for p in get_scan_ordered_skills_dirs()],
                                        "protectedSkillPaths": protected_skills, "config": config})
    ctx.on_unload(bridge.close)
    atexit.register(bridge.close)
    ctx.on_unload(lambda: atexit.unregister(bridge.close))
    reply_mode = config.get("dwsReplyGuardMode")
    if reply_mode not in ("off", "observe", "enforce"):
        reply_mode = config.get("defaultBlockingMode", "enforce")
    adapter = HermesAegis(bridge, reply_enabled=config.get("dwsReplyGuardEnabled") is True
                         and reply_mode != "off")
    # Install guards even if startup fails: Hermes isolates register exceptions,
    # so throwing here would otherwise leave an enabled agent unprotected.
    for name in ("pre_llm_call", "pre_tool_call", "post_tool_call", "transform_tool_result",
                 "transform_llm_output", "on_session_end", "on_session_finalize", "on_session_reset",
                 "pre_api_request", "post_api_request"):
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
        LOG.error("AgentAegis configuration failed (%s); tool calls remain blocked", type(exc).__name__)
        ctx.register_hook("pre_tool_call", lambda **_: {"action": "block", "message": UNAVAILABLE})
        ctx.register_hook("pre_llm_call", lambda **_: {"context": UNAVAILABLE})
        ctx.register_hook("transform_tool_result", lambda **_: UNAVAILABLE)
        ctx.register_hook("transform_llm_output", lambda **_: UNAVAILABLE)
