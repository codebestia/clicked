from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_health_returns_200():
    response = client.get("/health")
    assert response.status_code == 200


def test_health_response_body():
    response = client.get("/health")
    assert response.json() == {"status": "ok"}


def test_health_works_without_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
