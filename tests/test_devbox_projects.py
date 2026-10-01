import importlib
import os
import tempfile
from unittest.mock import patch


_tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)


def build_app():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("AGENTBRIDGE_", "DEEPBOX_"))}
    dbfile = tempfile.mktemp(suffix=".db", dir=_tmpdir.name)
    env["DEEPBOX_DATA_DIR"] = tempfile.mkdtemp(dir=_tmpdir.name)
    env.update({
        "DEEPBOX_DATABASE_URL": f"sqlite:///{dbfile.replace(os.sep, '/')}",
        "DEEPBOX_REGISTRATION_ENABLED": "true",
        "DEEPBOX_ENV": "test",
    })
    with patch.dict(os.environ, env, clear=True):
        import server.app.config as config
        import server.app.models as models
        import server.app.main as main
        importlib.reload(config)
        importlib.reload(models)
        importlib.reload(main)
        from fastapi.testclient import TestClient
        return TestClient(main.app), main


def register(client, username="owner"):
    response = client.post("/api/auth/register", json={
        "username": username, "password": "strong-password"})
    assert response.status_code == 200, response.text


def create_devbox(client, name="box"):
    response = client.post("/api/devboxes", json={"name": name})
    assert response.status_code == 200, response.text
    payload = response.json()
    return payload["devbox"], payload["token"]


def test_connector_project_report_migrates_legacy_cwd_without_uploading_paths():
    client, main = build_app()
    with client:
        register(client)
        devbox, token = create_devbox(client)
        legacy_path = r"C:\Code\private-repository"
        created = client.post(f"/api/devboxes/{devbox['id']}/agents", json={
            "handle": "claude", "display_name": "Claude",
            "runtime": "claude-code", "cwd": legacy_path,
        })
        assert created.status_code == 200, created.text
        agent = created.json()
        auth = {"authorization": f"Bearer {token}"}

        report = client.post(
            f"/api/devboxes/{devbox['id']}/projects",
            headers=auth,
            json={
                "projects": [{"id": "project-1", "name": "Deepbox"}],
                "migrations": [{
                    "agent_id": agent["id"], "local_project_id": "project-1"}],
            },
        )
        assert report.status_code == 200, report.text
        assert report.json() == {"ok": True, "projects": 1, "migrations": 1}

        me = client.get("/api/me", headers=auth)
        assert me.status_code == 200, me.text
        payload = me.json()
        assert payload["projects"] == [{
            "id": "project-1", "name": "Deepbox", "runtime_config": {}}]
        assert payload["agents"][0]["local_project_id"] == "project-1"
        assert payload["agents"][0]["cwd"] is None
        assert legacy_path not in me.text

        listed = client.get("/api/devboxes")
        assert listed.status_code == 200
        listed_agent = listed.json()[0]["agents"][0]
        assert listed_agent["local_project_id"] == "project-1"
        assert listed_agent["cwd"] is None
        assert listed.json()[0]["projects"][0]["name"] == "Deepbox"

        with main.models.SessionLocal() as database:
            stored = database.get(main.models.Agent, agent["id"])
            assert stored.cwd is None
            assert stored.local_project_id == "project-1"

        selected = client.post(f"/api/devboxes/{devbox['id']}/agents", json={
            "handle": "codex", "runtime": "codex-cli",
            "local_project_id": "project-1",
            "runtime_config": {"model": "gpt-5"},
        })
        assert selected.status_code == 200, selected.text
        assert selected.json()["runtime_config"] == {"model": "gpt-5"}

        cleared = client.post(
            f"/api/devboxes/{devbox['id']}/projects",
            headers=auth, json={"projects": [], "migrations": []})
        assert cleared.status_code == 200, cleared.text
        after = client.get("/api/me", headers=auth).json()
        assert after["projects"] == []
        assert all(item["local_project_id"] is None for item in after["agents"])


def test_project_report_rejects_paths_and_cross_devbox_project_ids():
    client, _ = build_app()
    with client:
        register(client)
        first, first_token = create_devbox(client, "first")
        second, second_token = create_devbox(client, "second")
        first_auth = {"authorization": f"Bearer {first_token}"}
        second_auth = {"authorization": f"Bearer {second_token}"}

        leaked = client.post(
            f"/api/devboxes/{first['id']}/projects", headers=first_auth,
            json={"projects": [{
                "id": "shared-id", "name": "Private",
                "path": r"C:\private"}], "migrations": []})
        assert leaked.status_code == 422

        accepted = client.post(
            f"/api/devboxes/{first['id']}/projects", headers=first_auth,
            json={"projects": [{"id": "shared-id", "name": "One"}],
                  "migrations": []})
        assert accepted.status_code == 200, accepted.text

        collision = client.post(
            f"/api/devboxes/{second['id']}/projects", headers=second_auth,
            json={"projects": [{"id": "shared-id", "name": "Two"}],
                  "migrations": []})
        assert collision.status_code == 422

        wrong_token = client.post(
            f"/api/devboxes/{first['id']}/projects", headers=second_auth,
            json={"projects": [], "migrations": []})
        assert wrong_token.status_code == 403

        invalid_agent = client.post(
            f"/api/devboxes/{second['id']}/agents",
            json={"handle": "bad", "runtime": "codex-cli",
                  "local_project_id": "shared-id"})
        assert invalid_agent.status_code == 422
