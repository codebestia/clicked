from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

VALID_PAYLOAD = {
    "messageId": "msg-1",
    "conversationId": "conv-1",
    "senderId": "user-1",
    "content": "Hello, world!",
}

EMBEDDING_DIM = 1536


def _mock_embedding(mock_openai):
    mock_openai.return_value.embeddings.create.return_value = _fake_embedding_response()


def _fake_embedding_response():
    resp = MagicMock()
    resp.data = [MagicMock()]
    resp.data[0].embedding = [0.1] * EMBEDDING_DIM
    return resp


class TestIndexMessage:
    def test_weaviate_connection_failure_returns_503(self):
        with patch("main.weaviate.connect_to_local", side_effect=Exception("no weaviate")):
            resp = client.post("/index/message", json=VALID_PAYLOAD)

        assert resp.status_code == 503
        assert resp.json()["detail"] == "Weaviate connection failed"

    def test_creates_collection_if_missing(self):
        mock_client = MagicMock()
        mock_client.collections.exists.return_value = False
        collection = MagicMock()
        collection.data.exists.return_value = False
        mock_client.collections.get.return_value = collection

        with (
            patch("main.weaviate.connect_to_local", return_value=mock_client),
            patch("main._openai_client") as mock_openai,
        ):
            _mock_embedding(mock_openai)
            resp = client.post("/index/message", json=VALID_PAYLOAD)

        assert resp.status_code == 200
        mock_client.collections.create.assert_called_once_with(name="Message")

    def test_inserts_new_message(self):
        mock_client = MagicMock()
        mock_client.collections.exists.return_value = True
        collection = MagicMock()
        collection.data.exists.return_value = False
        mock_client.collections.get.return_value = collection

        with (
            patch("main.weaviate.connect_to_local", return_value=mock_client),
            patch("main._openai_client") as mock_openai,
        ):
            _mock_embedding(mock_openai)
            resp = client.post("/index/message", json=VALID_PAYLOAD)

        assert resp.status_code == 200
        collection.data.insert.assert_called_once()
        collection.data.replace.assert_not_called()

    def test_replaces_existing_message(self):
        mock_client = MagicMock()
        mock_client.collections.exists.return_value = True
        collection = MagicMock()
        collection.data.exists.return_value = True
        mock_client.collections.get.return_value = collection

        with (
            patch("main.weaviate.connect_to_local", return_value=mock_client),
            patch("main._openai_client") as mock_openai,
        ):
            _mock_embedding(mock_openai)
            resp = client.post("/index/message", json=VALID_PAYLOAD)

        assert resp.status_code == 200
        collection.data.replace.assert_called_once()
        collection.data.insert.assert_not_called()

    def test_closes_weaviate_on_success(self):
        mock_client = MagicMock()
        mock_client.collections.exists.return_value = True
        collection = MagicMock()
        collection.data.exists.return_value = False
        mock_client.collections.get.return_value = collection

        with (
            patch("main.weaviate.connect_to_local", return_value=mock_client),
            patch("main._openai_client") as mock_openai,
        ):
            _mock_embedding(mock_openai)
            resp = client.post("/index/message", json=VALID_PAYLOAD)

        assert resp.status_code == 200
        mock_client.close.assert_called_once()

    def test_closes_weaviate_on_error(self):
        mock_client = MagicMock()
        mock_client.collections.exists.side_effect = Exception("boom")

        with patch("main.weaviate.connect_to_local", return_value=mock_client):
            resp = client.post("/index/message", json=VALID_PAYLOAD)

        assert resp.status_code == 503
        mock_client.close.assert_called_once()

    def test_missing_fields_returns_422(self):
        resp = client.post("/index/message", json={})
        assert resp.status_code == 422
