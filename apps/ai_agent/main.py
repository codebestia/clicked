import json
import logging
import os
from typing import Literal, cast

import uvicorn
import weaviate
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from weaviate.classes.query import Filter

try:
    from openai import APIError, APITimeoutError, OpenAI
except ImportError:  # pragma: no cover - exercised when the dependency is absent
    OpenAI = None  # type: ignore[assignment, misc]
    APIError = Exception  # type: ignore[assignment, misc]
    APITimeoutError = Exception  # type: ignore[assignment, misc]

OPENAI_CHAT_MODEL = os.environ.get("OPENAI_CHAT_MODEL", "gpt-4o-mini")
OPENAI_EMBEDDING_MODEL = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")

logger = logging.getLogger(__name__)

app = FastAPI(title="AI Agent API")

_SYSTEM_PROMPT = (
    "You are an AI assistant for Clicked, a decentralised messaging and payment "
    "platform built on the Stellar blockchain. Clicked lets users send token "
    "payments inside chat conversations, manage group treasuries, and participate "
    "in DAO-style governance. Help users with questions about transactions, wallet "
    "management, group finances, and platform features."
)

_HIGH_VALUE_THRESHOLD = 10_000.0

# Input limits. Free text is forwarded to paid OpenAI calls, so cap its size.
MAX_TEXT_LEN = 4_000
MAX_SHORT_TEXT_LEN = 200

_SEARCH_UNAVAILABLE = "Search backend unavailable"


# ── Request / response models ─────────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    conversation_id: str = Field(min_length=1, max_length=MAX_SHORT_TEXT_LEN)


class ChatResponse(BaseModel):
    reply: str


class TransferAnalyseRequest(BaseModel):
    amount: float = Field(gt=0, allow_inf_nan=False)
    sender: str = Field(min_length=1, max_length=MAX_SHORT_TEXT_LEN)
    recipient: str = Field(min_length=1, max_length=MAX_SHORT_TEXT_LEN)
    memo: str = Field(max_length=MAX_SHORT_TEXT_LEN)


class TransferAnalyseResponse(BaseModel):
    flagged: bool
    reason: str | None
    confidence: float


class IndexMessageRequest(BaseModel):
    messageId: str = Field(min_length=1, max_length=MAX_SHORT_TEXT_LEN)
    conversationId: str = Field(min_length=1, max_length=MAX_SHORT_TEXT_LEN)
    senderId: str = Field(min_length=1, max_length=MAX_SHORT_TEXT_LEN)
    content: str = Field(min_length=1, max_length=MAX_TEXT_LEN)


RiskLevel = Literal["low", "medium", "high"]


class ProposalSummariseRequest(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_SHORT_TEXT_LEN)
    description: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    amount: float = Field(gt=0, allow_inf_nan=False)


class ProposalSummariseResponse(BaseModel):
    summary: str
    risk: RiskLevel


# ── Helpers ───────────────────────────────────────────────────────────────────


def _openai_client():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")
    if OpenAI is None:
        raise HTTPException(status_code=500, detail="openai package is not installed")

    return OpenAI(api_key=api_key)


def _weaviate_client() -> weaviate.WeaviateClient:
    """Return a connected Weaviate client using environment-configured coordinates.

    Reads WEAVIATE_HOST (default: localhost), WEAVIATE_HTTP_PORT (default: 8080),
    and WEAVIATE_GRPC_PORT (default: 50051) so that deployments can point the
    agent at any Weaviate instance without code changes.
    """
    host = os.environ.get("WEAVIATE_HOST", "localhost")
    http_port = int(os.environ.get("WEAVIATE_HTTP_PORT", "8080"))
    grpc_port = int(os.environ.get("WEAVIATE_GRPC_PORT", "50051"))
    try:
        return weaviate.connect_to_local(host=host, port=http_port, grpc_port=grpc_port)
    except HTTPException:
        raise
    except Exception:
        logger.exception("Weaviate connection failed")
        raise HTTPException(status_code=503, detail="Weaviate connection failed")


def _close_search_backend(client: weaviate.WeaviateClient) -> None:
    try:
        client.close()
    except Exception:
        # A cleanup failure must not hide the operation's response or cause a write retry.
        logger.exception("Closing Weaviate connection failed")


# ── Endpoints ─────────────────────────────────────────────────────────────────


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    client = _openai_client()
    try:
        response = client.chat.completions.create(
            model=OPENAI_CHAT_MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": request.message},
            ],
            timeout=30,
        )
    except APITimeoutError:
        raise HTTPException(status_code=504, detail="OpenAI request timed out")
    except APIError:
        raise HTTPException(status_code=502, detail="OpenAI API error")

    content = response.choices[0].message.content
    if not content or not content.strip():
        raise HTTPException(status_code=502, detail="LLM did not return a reply")
    return ChatResponse(reply=content)


@app.post("/transfers/analyse", response_model=TransferAnalyseResponse)
def analyse_transfer(request: TransferAnalyseRequest):
    # Rule-based: high-value transfers are always flagged with high confidence.
    if request.amount > _HIGH_VALUE_THRESHOLD:
        return TransferAnalyseResponse(
            flagged=True,
            reason=f"Amount {request.amount} XLM exceeds {_HIGH_VALUE_THRESHOLD} XLM threshold",
            confidence=0.99,
        )

    client = _openai_client()
    prompt = (
        "Analyse this Stellar transfer for fraud risk.\n"
        f"Amount: {request.amount} XLM\n"
        f"Sender: {request.sender}\n"
        f"Recipient: {request.recipient}\n"
        f"Memo: {request.memo}\n\n"
        "Reply with JSON only using keys: flagged (bool), reason (string under 100 chars or null), "
        "confidence (float 0-1). Flag if suspicious patterns are detected."
    )
    response = client.chat.completions.create(
        model=OPENAI_CHAT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        timeout=10,
    )

    try:
        result = json.loads(response.choices[0].message.content)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=502, detail="LLM did not return valid JSON")

    # Clamp confidence to [0, 1], default to 0.0
    try:
        confidence = float(result.get("confidence", 0.0))
        confidence = max(0.0, min(1.0, confidence))
    except (ValueError, TypeError):
        confidence = 0.0

    return TransferAnalyseResponse(
        flagged=bool(result.get("flagged", False)),
        reason=result.get("reason"),
        confidence=confidence,
    )


@app.post("/proposals/summarise", response_model=ProposalSummariseResponse)
def summarise_proposal(request: ProposalSummariseRequest):
    client = _openai_client()
    prompt = (
        "Summarise this Clicked governance proposal for a frontend reader and "
        "rate its risk level.\n"
        f"Title: {request.title}\n"
        f"Description: {request.description}\n"
        f"Amount: {request.amount} XLM\n\n"
        "Reply with JSON only using keys: summary (a plain-English summary of "
        'exactly 2 sentences), risk (one of "low", "medium", "high"). '
        'Use "high" for large amounts, unclear intent, or obvious red flags; '
        '"low" for small, well-scoped, low-impact proposals; otherwise "medium".'
    )
    response = client.chat.completions.create(
        model=OPENAI_CHAT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        timeout=10,
    )

    try:
        result = json.loads(response.choices[0].message.content)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=502, detail="LLM did not return a summary")

    summary = (result.get("summary") or "").strip()
    if not summary:
        raise HTTPException(status_code=502, detail="LLM did not return a summary")

    risk = str(result.get("risk", "")).strip().lower()
    if risk not in ("low", "medium", "high"):
        # Defensive fallback: never return an invalid risk level to the caller.
        risk = "medium"

    # Pydantic re-validates via response_model before the response is sent.
    return ProposalSummariseResponse(
        summary=summary, risk=cast(Literal["low", "medium", "high"], risk)
    )


@app.post("/index/message")
def index_message(request: IndexMessageRequest):
    client = _weaviate_client()

    try:
        if not client.collections.exists("Message"):
            client.collections.create(name="Message")

        collection = client.collections.get("Message")

        # Get embedding via OpenAI
        openai_client = _openai_client()
        res = openai_client.embeddings.create(input=request.content, model=OPENAI_EMBEDDING_MODEL)
        vector = res.data[0].embedding

        # Upsert
        if collection.data.exists(request.messageId):
            collection.data.replace(
                uuid=request.messageId,
                properties={
                    "conversationId": request.conversationId,
                    "messageId": request.messageId,
                    "senderId": request.senderId,
                    "content": request.content,
                },
                vector=vector,
            )
        else:
            collection.data.insert(
                uuid=request.messageId,
                properties={
                    "conversationId": request.conversationId,
                    "messageId": request.messageId,
                    "senderId": request.senderId,
                    "content": request.content,
                },
                vector=vector,
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Indexing message failed")
        raise HTTPException(status_code=503, detail=_SEARCH_UNAVAILABLE)
    finally:
        _close_search_backend(client)

    return {"status": "ok"}


@app.get("/search")
def search_messages(
    q: str = Query(min_length=1, max_length=MAX_TEXT_LEN),
    conversationId: str = Query(min_length=1, max_length=MAX_SHORT_TEXT_LEN),
):
    client = _weaviate_client()

    try:
        if not client.collections.exists("Message"):
            return {"results": []}

        collection = client.collections.get("Message")

        # Get embedding for query
        openai_client = _openai_client()
        res = openai_client.embeddings.create(input=q, model=OPENAI_EMBEDDING_MODEL)
        vector = res.data[0].embedding

        results = collection.query.near_vector(
            near_vector=vector,
            limit=5,
            filters=Filter.by_property("conversationId").equal(conversationId),
        )

        hits = []
        for obj in results.objects:
            hits.append(
                {
                    "messageId": obj.properties.get("messageId"),
                    "conversationId": obj.properties.get("conversationId"),
                    "senderId": obj.properties.get("senderId"),
                    "content": obj.properties.get("content"),
                }
            )

        return {"results": hits}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Message search failed")
        raise HTTPException(status_code=503, detail=_SEARCH_UNAVAILABLE)
    finally:
        _close_search_backend(client)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
