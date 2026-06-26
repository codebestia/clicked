from fastapi.testclient import TestClient
from unittest.mock import MagicMock, patch

from main import app

client = TestClient(app)

BASE_PAYLOAD = {
    "messageId": "msg-123",
    "conversationId": "conv-456",
    "senderId": "sender-789",
    "content": "Hello Web3 world",
}


def _make_embeddings_response():
    fake_response = MagicMock()
    fake_response.data = [MagicMock(embedding=[0.1, 0.2, 0.3])]
    return fake_response


def test_index_message_returns_503_when_weaviate_connection_fails():
    with patch("main.weaviate.connect_to_local", side_effect=RuntimeError("connection failed")):
        response = client.post("/index/message", json=BASE_PAYLOAD)

    assert response.status_code == 503
    assert response.json()["detail"] == "Weaviate connection failed"


def test_index_message_creates_collection_if_missing():
    mock_client = MagicMock()
    mock_client.collections.exists.return_value = False
    collection = MagicMock()
    collection.data.exists.return_value = False
    mock_client.collections.get.return_value = collection
    mock_client.collections.create.return_value = None

    mock_openai = MagicMock()
    mock_openai.embeddings.create.return_value = _make_embeddings_response()

    with patch("main.weaviate.connect_to_local", return_value=mock_client), patch(
        "main._openai_client", return_value=mock_openai
    ):
        response = client.post("/index/message", json=BASE_PAYLOAD)

    assert response.status_code == 200
    assert mock_client.collections.create.call_count == 1
    mock_client.collections.create.assert_called_once_with(name="Message")


def test_index_message_inserts_new_message_when_missing():
    mock_client = MagicMock()
    mock_client.collections.exists.return_value = True
    collection = MagicMock()
    collection.data.exists.return_value = False
    mock_client.collections.get.return_value = collection

    mock_openai = MagicMock()
    mock_openai.embeddings.create.return_value = _make_embeddings_response()

    with patch("main.weaviate.connect_to_local", return_value=mock_client), patch(
        "main._openai_client", return_value=mock_openai
    ):
        response = client.post("/index/message", json=BASE_PAYLOAD)

    assert response.status_code == 200
    collection.data.insert.assert_called_once_with(
        uuid=BASE_PAYLOAD["messageId"],
        properties={
            "conversationId": BASE_PAYLOAD["conversationId"],
            "messageId": BASE_PAYLOAD["messageId"],
            "senderId": BASE_PAYLOAD["senderId"],
            "content": BASE_PAYLOAD["content"],
        },
        vector=[0.1, 0.2, 0.3],
    )
    collection.data.replace.assert_not_called()


def test_index_message_replaces_existing_message():
    mock_client = MagicMock()
    mock_client.collections.exists.return_value = True
    collection = MagicMock()
    collection.data.exists.return_value = True
    mock_client.collections.get.return_value = collection

    mock_openai = MagicMock()
    mock_openai.embeddings.create.return_value = _make_embeddings_response()

    with patch("main.weaviate.connect_to_local", return_value=mock_client), patch(
        "main._openai_client", return_value=mock_openai
    ):
        response = client.post("/index/message", json=BASE_PAYLOAD)

    assert response.status_code == 200
    collection.data.replace.assert_called_once_with(
        uuid=BASE_PAYLOAD["messageId"],
        properties={
            "conversationId": BASE_PAYLOAD["conversationId"],
            "messageId": BASE_PAYLOAD["messageId"],
            "senderId": BASE_PAYLOAD["senderId"],
            "content": BASE_PAYLOAD["content"],
        },
        vector=[0.1, 0.2, 0.3],
    )
    collection.data.insert.assert_not_called()


def test_index_message_closes_weaviate_on_success():
    mock_client = MagicMock()
    mock_client.collections.exists.return_value = True
    collection = MagicMock()
    collection.data.exists.return_value = False
    mock_client.collections.get.return_value = collection

    mock_openai = MagicMock()
    mock_openai.embeddings.create.return_value = _make_embeddings_response()

    with patch("main.weaviate.connect_to_local", return_value=mock_client), patch(
        "main._openai_client", return_value=mock_openai
    ):
        response = client.post("/index/message", json=BASE_PAYLOAD)

    assert response.status_code == 200
    mock_client.close.assert_called_once()


def test_index_message_closes_weaviate_on_error():
    mock_client = MagicMock()
    mock_client.collections.exists.return_value = True
    collection = MagicMock()
    collection.data.exists.return_value = False
    mock_client.collections.get.return_value = collection

    mock_openai = MagicMock()
    mock_openai.embeddings.create.side_effect = RuntimeError("embedding failure")

    with patch("main.weaviate.connect_to_local", return_value=mock_client), patch(
        "main._openai_client", return_value=mock_openai
    ):
        response = client.post("/index/message", json=BASE_PAYLOAD)

    assert response.status_code == 503
    mock_client.close.assert_called_once()


def test_index_message_missing_fields_returns_422():
    response = client.post("/index/message", json={"messageId": "msg-123"})
    assert response.status_code == 422
