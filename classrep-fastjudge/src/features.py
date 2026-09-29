"""Text featurization: jieba tokens + char n-grams for TfidfVectorizer."""
from __future__ import annotations

import jieba


def format_example(row: dict) -> str:
    """Message-dominant text. Context is truncated so ACK in busy threads don't inherit schedule n-grams."""
    ctx_parts = []
    for c in (row.get("context") or [])[-3:]:
        text = str(c.get("text") or "").strip()
        if not text:
            continue
        # drop pure ack from context to reduce leakage
        if text in {"收到", "好的", "好滴", "ok", "OK", "+1", "谢谢", "1", "嗯", "啊啊啊"}:
            continue
        ctx_parts.append(f"{c.get('sender_name', '')}:{text[:80]}")
    ctx = " | ".join(ctx_parts)
    msg = row["message"]
    mtxt = f"{msg.get('sender_name', '')}:{msg.get('text', '')}"
    # repeat message to up-weight relative to context in TF-IDF
    return f"[MSG] {mtxt} [MSG] {mtxt} [MSG] {mtxt} [CTX] {ctx}"


def tokenize(text: str) -> list[str]:
    words = [w for w in jieba.cut(text) if w.strip()]
    chars = [c for c in text if not c.isspace()]
    grams: list[str] = []
    for n in (2, 3, 4):
        for i in range(max(0, len(chars) - n + 1)):
            grams.append("".join(chars[i : i + n]))
    wgrams = list(words)
    for i in range(len(words) - 1):
        wgrams.append(words[i] + words[i + 1])
    return wgrams + grams
