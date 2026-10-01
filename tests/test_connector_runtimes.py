"""Unit tests for the connector runtime adapter registry.

These tests are connector-only and require no real CLI to be installed.
"""
from __future__ import annotations

import sys

import pytest

from connector import runtimes
from connector.pty_session import resolve_cmd


# ---------------------------------------------------------------------------
# Registry: uniqueness and lookup
# ---------------------------------------------------------------------------

def test_registry_ids_are_unique():
    ids = runtimes.runtime_ids()
    assert len(ids) == len(set(ids)), "runtime ids must be unique"


def test_expected_runtimes_registered():
    for rid in ("claude-code", "copilot-cli", "codex-cli"):
        assert runtimes.has(rid)
        assert runtimes.get(rid).id == rid
    assert not runtimes.has("mock")


def test_surface_lookup_accepts_family_and_legacy_adapter_ids():
    assert runtimes.get_for_surface("claude-code", "structured").id == "claude-code-structured"
    assert runtimes.get_for_surface("claude-code", "terminal").id == "claude-code"
    assert runtimes.get_for_surface("claude-code-structured", "terminal").id == "claude-code"


def test_surface_lookup_never_falls_back_to_another_surface():
    with pytest.raises(runtimes.UnknownRuntimeError):
        runtimes.get_for_surface("codex-cli", "structured")


def test_adapter_declares_personal_and_project_skill_roots(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    claude = runtimes.get("claude-code")
    personal = {path.replace("\\", "/") for path in claude.skill_roots()}
    project = {path.replace("\\", "/") for path in claude.skill_roots(str(tmp_path / "repo"))}
    assert any(path.endswith("/.claude/skills") for path in personal)
    assert any(path.endswith("/.agents/skills") for path in personal)
    assert any(path.endswith("/.claude/skills") for path in project)
    assert any(path.endswith("/.agents/skills") for path in project)
    assert claude.capabilities(installed=True)["features"]["skills"] is True


def test_register_rejects_duplicate():
    existing = runtimes.get("claude-code")
    with pytest.raises(ValueError):
        runtimes.register(runtimes.RuntimeAdapter(
            id="claude-code", label="dup", base_argv=("claude",)))
    # Original untouched.
    assert runtimes.get("claude-code") is existing


def test_get_unknown_raises_unknown_runtime():
    with pytest.raises(runtimes.UnknownRuntimeError):
        runtimes.get("does-not-exist")


def test_build_command_unknown_runtime_fails():
    with pytest.raises(runtimes.UnknownRuntimeError):
        runtimes.build_command("nope")


# ---------------------------------------------------------------------------
# Exact command argv per runtime / model / permission mode
# ---------------------------------------------------------------------------

def test_claude_default_is_base_argv():
    # No model / permission -> exactly the historical base command.
    assert runtimes.build_command("claude-code") == ["claude"]


def test_claude_model_and_permission_argv():
    assert runtimes.build_command(
        "claude-code", model="opus", permission_mode="plan") == [
        "claude", "--model", "opus", "--permission-mode", "plan"]


def test_claude_bypass_permissions_argv():
    assert runtimes.build_command(
        "claude-code", permission_mode="bypassPermissions") == [
        "claude", "--dangerously-skip-permissions"]


def test_copilot_model_and_allow_all_argv():
    assert runtimes.build_command(
        "copilot-cli", model="gpt-5.6-sol", permission_mode="allowAll") == [
        "copilot", "--model", "gpt-5.6-sol", "--allow-all-tools"]


def test_codex_full_auto_argv():
    assert runtimes.build_command(
        "codex-cli", model="gpt-5-codex", permission_mode="full-auto") == [
        "codex", "--model", "gpt-5-codex",
        "--ask-for-approval", "never", "--sandbox", "workspace-write"]


def test_codex_default_permission_argv():
    assert runtimes.build_command("codex-cli", permission_mode="default") == [
        "codex", "--ask-for-approval", "on-request"]


def test_custom_model_is_allowed_but_unsafe_model_is_rejected():
    assert runtimes.build_command(
        "claude-code", model="new-provider-model")[-2:] == [
            "--model", "new-provider-model"]
    with pytest.raises(runtimes.InvalidCommandError):
        runtimes.build_command("claude-code", model="unsafe\nmodel")


def test_unsupported_permission_mode_rejected():
    with pytest.raises(runtimes.InvalidCommandError):
        runtimes.build_command("claude-code", permission_mode="fake-mode")


# ---------------------------------------------------------------------------
# Security: executable / argv validation, no shell metacharacters
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [
    "claude; rm -rf /", "cla ude", "../bin/claude", "a|b", "$(x)", "a&b", "",
])
def test_validate_executable_rejects_bad_names(bad):
    with pytest.raises(runtimes.InvalidCommandError):
        runtimes.validate_executable(bad)


def test_validate_program_allows_paths_but_blocks_metachars():
    # Absolute interpreter path is fine.
    assert runtimes.validate_program(sys.executable) == sys.executable
    with pytest.raises(runtimes.InvalidCommandError):
        runtimes.validate_program("/bin/sh; echo hi")


@pytest.mark.parametrize("tok", ["a;b", "a|b", "`x`", "$(x)", "a\nb", ""])
def test_validate_argv_rejects_bad_tokens(tok):
    with pytest.raises(runtimes.InvalidCommandError):
        runtimes.validate_argv(["claude", tok])


def test_register_rejects_pathy_executable():
    with pytest.raises(runtimes.InvalidCommandError):
        runtimes.register(runtimes.RuntimeAdapter(
            id="pathy", label="x", base_argv=("/bin/sh",)))


# ---------------------------------------------------------------------------
# Adding an adapter is localized (no edits to builder/other adapters needed)
# ---------------------------------------------------------------------------

def test_adding_adapter_is_localized():
    before = set(runtimes.runtime_ids())
    assert "temp-runtime" not in before
    new = runtimes.RuntimeAdapter(
        id="temp-runtime",
        label="Temp",
        base_argv=("mytool",),
        model_flag="-m",
        models=("x1",),
        permission_modes={"": (), "safe": ("--safe",)},
    )
    try:
        runtimes.register(new)
        # The *shared* builder handles it with zero changes.
        assert runtimes.build_command("temp-runtime") == ["mytool"]
        assert runtimes.build_command(
            "temp-runtime", model="x1", permission_mode="safe") == [
            "mytool", "-m", "x1", "--safe"]
        # Every other adapter's output is unchanged.
        assert runtimes.build_command("claude-code") == ["claude"]
    finally:
        runtimes._REGISTRY.pop("temp-runtime", None)
    assert set(runtimes.runtime_ids()) == before


# ---------------------------------------------------------------------------
# resolve_cmd integration preserves CLI behavior
# ---------------------------------------------------------------------------

def test_resolve_cmd_defaults_preserved():
    assert resolve_cmd("claude-code", None) == ["claude"]


def test_resolve_cmd_unknown_runtime_raises():
    with pytest.raises(runtimes.UnknownRuntimeError):
        resolve_cmd("bogus", None)


def test_resolve_cmd_explicit_launch_cmd_wins_and_is_validated():
    assert resolve_cmd("claude-code", "claude --model opus") == [
        "claude", "--model", "opus"]
    with pytest.raises(runtimes.InvalidCommandError):
        resolve_cmd("claude-code", "claude; rm -rf /")
    # Explicit, validated overrides do not require a registered runtime id.
    assert resolve_cmd("custom-runtime", "native-agent --safe") == [
        "native-agent", "--safe"]
    with pytest.raises(runtimes.InvalidCommandError):
        resolve_cmd("custom-runtime", "native-agent | other")


def test_resolve_cmd_passes_model_and_permission():
    assert resolve_cmd("codex-cli", None, model="o4-mini",
                       permission_mode="auto") == [
        "codex", "--model", "o4-mini", "--ask-for-approval", "on-failure"]


def test_capabilities_blob_has_no_secrets():
    caps = runtimes.get("claude-code").capabilities(installed=True, version="1.2.3")
    assert caps["runtime"] == "claude-code"
    assert caps["installed"] is True
    assert "features" in caps
    # Sanity: nothing that looks like a token/secret key.
    text = repr(caps).lower()
    assert "token" not in text and "secret" not in text and "password" not in text


class TestStructuredControls:
    def test_capabilities_publish_generic_controls_without_local_path(self):
        cap = runtimes.get("claude-code-structured").capabilities(
            installed=True, version="1.2.3", path="C:/private/claude.exe")
        assert "path" not in cap
        controls = cap["features"]["controls"]
        assert [c["key"] for c in controls] == [
            "model", "reasoning_effort", "attachments"]
        assert controls[0]["scope"] == "turn"
        assert controls[0]["choices"] == ["sonnet", "opus", "haiku"]
        assert controls[0]["allow_custom"] is False
        assert controls[2]["kind"] == "file"

    def test_claude_model_changes_compile_to_live_control_requests(self):
        assert runtimes.live_control_requests(
            "claude-code-structured",
            {"model": "sonnet"}, {"model": "opus"}) == [{
                "subtype": "set_model", "model": "opus"}]
        assert runtimes.live_control_requests(
            "claude-code-structured",
            {"model": "opus"}, {"model": "opus"}) == []
        with pytest.raises(runtimes.InvalidCommandError, match="cannot be reset"):
            runtimes.live_control_requests(
                "claude-code-structured", {"model": "opus"}, {})
        assert runtimes.sanitize_options(
            "claude-code-structured", {"model": "opus-4.8"}) == {}

    def test_copilot_uses_documented_reasoning_choices_and_nonblocking_auth(self):
        adapter = runtimes.get("copilot-cli-structured")
        expected_models = (
            "claude-sonnet-5",
            "claude-sonnet-4.6",
            "claude-sonnet-4.5",
            "claude-haiku-4.5",
            "claude-opus-4.8",
            "claude-opus-4.7",
            "claude-opus-4.6",
            "claude-opus-4.5",
            "gpt-5.6-sol",
        )
        assert adapter.models == expected_models
        assert runtimes.get("copilot-cli").models == expected_models
        assert adapter.auth_argv == ()
        reasoning = next(
            control for control in adapter.controls
            if control.key == "reasoning_effort")
        assert reasoning.choices == ("low", "medium", "high", "xhigh", "max")
        assert runtimes.get("copilot-cli").auth_argv == ()
        assert adapter.install_url == (
            "https://docs.github.com/en/copilot/how-tos/copilot-cli/"
            "set-up-copilot-cli/install-copilot-cli")

    def test_sanitize_and_argv_ignore_undeclared_or_invalid_options(self):
        clean = runtimes.sanitize_options("copilot-cli-structured", {
            "model": "gpt-5.6-sol",
            "reasoning_effort": "high",
            "evil": "--run-anything",
            "attachments": [{"name": "a.txt", "data": "YQ=="}],
        })
        assert "evil" not in clean
        assert runtimes.control_argv(
            "copilot-cli-structured", clean, ("C:/tmp/a.txt",)) == [
                "--reasoning-effort", "high", "--attachment", "C:/tmp/a.txt"]
        assert runtimes.sanitize_options("copilot-cli-structured", {
            "model": "new-provider-model", "reasoning_effort": "ultra"}) == {
                "model": "new-provider-model"}

    def test_permission_mode_is_sanitized_for_structured_turns(self):
        assert runtimes.sanitize_options(
            "claude-code-structured", {"permission_mode": "plan"}) == {
                "permission_mode": "plan"}
        assert runtimes.sanitize_options(
            "claude-code-structured",
            {"permission_mode": "not-a-mode"}) == {}

    def test_claude_file_control_uses_prompt_transport(self):
        control = runtimes.attachment_control("claude-code-structured")
        assert control is not None
        assert control.flag is None
        assert control.max_total_bytes == 1024 * 1024


class TestNativeContextContinuity:
    """Continuity is declared per runtime, so a new adapter needs no new code."""

    @pytest.mark.parametrize("runtime_id,scope", [
        ("claude-code-structured", "cwd"),
        ("copilot-cli-structured", "machine"),
    ])
    def test_structured_runtimes_declare_native_resume_and_its_scope(
            self, runtime_id, scope):
        context = runtimes.get(runtime_id).capabilities(
            installed=True, version="1.2.3")["features"]["context"]
        assert context == {
            "continuity": "native_resume", "available": True,
            "resume_scope": scope, "explicit_resume": True}

    def test_capabilities_report_no_resume_when_the_runtime_is_missing(self):
        context = runtimes.get("claude-code-structured").capabilities(
            installed=False)["features"]["context"]
        assert context["available"] is False

    def test_terminal_runtimes_report_process_scoped_context(self):
        # A terminal keeps its context only while its process lives, so the
        # capability must not claim the transcript can be resumed later.
        context = runtimes.get("claude-code").capabilities(
            installed=True, version="1.2.3")["features"]["context"]
        assert context["continuity"] == "process"
        assert context["resume_scope"] == "process"

    @pytest.mark.parametrize("runtime_id,flag", [
        ("claude-code-structured", "--session-id"),
        ("copilot-cli-structured", "--session-id"),
    ])
    def test_first_turn_names_the_session_and_later_turns_resume_it(
            self, runtime_id, flag):
        session_id = "018f9c1e-3b7a-7c21-9f0b-2f4c9e51a7d3"
        assert runtimes.control_argv(
            runtime_id, {}, session_id=session_id) == [flag, session_id]
        assert runtimes.control_argv(
            runtime_id, {}, session_id=session_id, resume_context=True) == [
                "--resume", session_id]

    def test_turn_options_and_context_flags_compose(self):
        argv = runtimes.control_argv(
            "copilot-cli-structured", {"reasoning_effort": "high"},
            ("C:/tmp/a.txt",), session_id="abc", resume_context=True)
        assert argv == ["--reasoning-effort", "high",
                        "--attachment", "C:/tmp/a.txt", "--resume", "abc"]

    def test_a_session_id_can_never_inject_extra_arguments(self):
        for hostile in ("", "ok\nrm -rf /", "a\tb", "x\x00y"):
            with pytest.raises(runtimes.InvalidCommandError):
                runtimes.control_argv(
                    "claude-code-structured", {}, session_id=hostile)

    def test_runtimes_without_context_support_ignore_session_ids(self):
        assert runtimes.control_argv("codex-cli", {}, session_id="abc") == []
