# -*- coding: utf-8 -*-
r"""本地 OpenAI 兼容推理服务器（transformers 版，动态批处理）。

llama-server 二进制被墙时的验收替代：加载合并后的 SFT 模型，
暴露 /v1/chat/completions（eval.ts 只依赖这个端点）。
核心设计：请求入队 → 主推理线程每 ~80ms 收集一批（left-pad 拼批）→
一次 generate 批量出结果 → 各请求并行返回。单卡上 6 路并发的
生产 pipeline 也能全部落在 60s 客户端超时内。

用法：
    $env:PYTHONPATH="$PWD\train\pylibs-gpu"
    python train\env\serve_hf.py --model train\models\qwen3-1.7b-sft-bf16 --port 8080
然后 .env: LLM_BASE_URL=http://127.0.0.1:8080/v1  LLM_MODEL=extract
"""
import argparse
import json
import queue
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_tok = None
_model = None
_q: "queue.Queue[_Job]" = None  # type: ignore[assignment]
_MAX_BATCH = 8
_BATCH_WAIT_S = 0.35


@dataclass
class _Job:
    prompt_ids: list
    max_tokens: int
    temperature: float
    done: threading.Event
    json_mode: bool = False      # 请求带 response_format={'type':'json_object'}
    wants_events: bool = False   # prompt 里含 "events" 契约（提取类）→ 前缀锁 {"events": [
    text: str = ""
    error: str = ""
    n_out: int = 0
    n_in: int = 0
    dt: float = 0.0


def load(model_dir: str) -> None:
    global _tok, _model
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    _tok = AutoTokenizer.from_pretrained(model_dir)
    _model = AutoModelForCausalLM.from_pretrained(
        model_dir, torch_dtype="auto", device_map="cuda",
    )
    _model.eval()
    print(f"模型加载完成：{model_dir}（{_model.dtype}，cuda）", flush=True)


def _run_batch(jobs: list[_Job]) -> None:
    """左 padding 拼批，一次 generate 出全部请求。"""
    import torch
    from transformers import LogitsProcessor

    t0 = time.time()
    _tok.padding_side = "left"
    if _tok.pad_token_id is None:
        _tok.pad_token = _tok.eos_token_id
    prompts = [_tok.decode(j.prompt_ids) for j in jobs]
    enc = _tok(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to("cuda")
    max_new = max(j.max_tokens for j in jobs)
    greedy = all(j.temperature <= 0 for j in jobs)
    prompt_len = int(enc["input_ids"].shape[1])

    class _JsonPrefix(LogitsProcessor):
        """response_format=json_object 服务端约束（等价 llama.cpp 的 JSON 语法模式）。

        生产 extract.ts 每个请求都带 response_format={'type':'json_object'} 并期望服务端
        保证 JSON；llama-server 会据此施加语法约束。本替身服务器此前忽略该参数，
        导致 1.7B 模型在复杂批次上偶发输出 ```json 围栏 + 裸数组（OOD schema）。
        这里强制首个 token 走指定前缀：提取类请求（prompt 含 "events" 契约）
        锁 `{"events": [`，其他 JSON 请求只锁 `{`。
        """

        def __init__(self, prefix_ids: list[int], prompt_len: int) -> None:
            self.prefix_ids = prefix_ids
            self.prompt_len = prompt_len

        def __call__(self, input_ids, scores):
            step = input_ids.shape[1] - self.prompt_len
            if step < len(self.prefix_ids):
                forced = self.prefix_ids[step]
                mask = torch.full_like(scores, float("-inf"))
                mask[:, forced] = 0.0
                return mask
            return scores

    # 约束只在"整批都是 JSON 模式且期望同一前缀"时施加（避免跨请求串味）
    procs = []
    # 约束只在"整批 JSON 模式且期望同一前缀"时施加（避免跨请求串味）
    prefixes = [('{"events": [' if j.wants_events else "{") for j in jobs] if all(j.json_mode for j in jobs) else []
    if prefixes and len(set(prefixes)) == 1:
        procs = [_JsonPrefix(_tok(prefixes[0], add_special_tokens=False)["input_ids"], prompt_len)]

    with torch.no_grad():
        out = _model.generate(
            **enc,
            max_new_tokens=max_new,
            do_sample=not greedy,
            temperature=None if greedy else max(max(j.temperature for j in jobs), 1e-4),
            top_p=0.95 if not greedy else None,
            pad_token_id=_tok.eos_token_id,
            logits_processor=procs if procs else None,
        )
    gen = out[:, prompt_len:]
    for i, j in enumerate(jobs):
        toks = gen[i]
        # 截掉 EOS 之后的填充（EOS 出现后全部视为结束）
        ids = []
        for t in toks.tolist():
            if t == _tok.eos_token_id:
                break
            ids.append(t)
        text = _tok.decode(ids, skip_special_tokens=True)
        j.text = text
        j.n_in = prompt_len
        j.n_out = int(len(ids))
        j.dt = time.time() - t0
        j.done.set()


def _infer_loop() -> None:
    """主推理线程：收批 → 批量推理 → 派发结果。"""
    import torch  # noqa: F401

    while True:
        first = _q.get()
        jobs = [first]
        # 短窗收集并发请求凑批
        t_end = time.time() + _BATCH_WAIT_S
        while len(jobs) < _MAX_BATCH and time.time() < t_end:
            try:
                jobs.append(_q.get(timeout=max(0.0, t_end - time.time())))
            except queue.Empty:
                break
        try:
            _run_batch(jobs)
        except Exception as e:  # noqa: BLE001
            print(f"[serve] 批量生成失败：{type(e).__name__}: {e}", file=sys.stderr)
            for j in jobs:
                j.error = f"{type(e).__name__}: {e}"
                j.done.set()
        for j in jobs:
            print(f"[serve] in={j.n_in} out={j.n_out} {j.dt:.1f}s batch={len(jobs)} head={j.text[:44]!r}", flush=True)


def handle_chat(body: dict) -> dict:
    """OpenAI chat completions 兼容（动态批处理，非流式）。"""
    msgs = body.get("messages", [])
    max_tokens = min(int(body.get("max_tokens") or 512), 768)
    temperature = float(body.get("temperature", 0.2) or 0.0)
    prompt = _tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    prompt_ids = _tok(prompt, add_special_tokens=False)["input_ids"]
    rf = body.get("response_format") or {}
    json_mode = isinstance(rf, dict) and rf.get("type") == "json_object"
    wants_events = json_mode and '"events"' in prompt
    job = _Job(
        prompt_ids=prompt_ids, max_tokens=max_tokens, temperature=temperature,
        done=threading.Event(), json_mode=json_mode, wants_events=wants_events,
    )
    _q.put(job)
    job.done.wait()
    if job.error:
        return {"error": {"message": job.error, "type": "internal_error"}}
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model", "extract"),
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": job.text},
            "logprobs": None,
        }],
        "usage": {
            "prompt_tokens": job.n_in,
            "completion_tokens": job.n_out,
            "total_tokens": job.n_in + job.n_out,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def _send_ok(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._send_ok(200, {"object": "list", "data": [{"id": "extract", "object": "model"}]})
        else:
            self._send_ok(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if "/chat/completions" not in self.path:
            self._send_ok(400, {"error": {"message": "only /v1/chat/completions", "type": "invalid_request_error"}})
            return
        n = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(n) or b"{}")
        try:
            resp = handle_chat(payload)
            code = 500 if "error" in resp else 200
        except Exception as e:  # noqa: BLE001
            print(f"[serve] 生成失败：{type(e).__name__}: {e}", file=sys.stderr)
            resp, code = {"error": {"message": str(e), "type": "internal_error"}}, 500
        try:
            self._send_ok(code, resp)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # 客户端超时已断开（OpenAI SDK 重试会再入队）

    def _send_ok(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # 静音访问日志
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=r"train\models\qwen3-1.7b-sft-bf16")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()

    global _q
    _q = queue.Queue()
    load(args.model)
    threading.Thread(target=_infer_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"OpenAI 兼容端点：http://127.0.0.1:{args.port}/v1 （模型：{args.model}，动态批 ≤{_MAX_BATCH}）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
