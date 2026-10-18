"""Private, pinned-account ChatGPT HTTP transport. Credentials never leave this process.

RPC stdout is reserved for responses; credentials never appear in the protocol.
Errors never echo headers, tokens or response bodies.
No browser, desktop tool pipe, Codex inference, or global authentication changes.
"""
import base64
import json
import os
import re
import sys
import subprocess
import time
import uuid
from pathlib import Path

from curl_cffi import requests

BASE = "https://chatgpt.com/backend-api"


def accounts_root():
    """共享凭据库根目录；GPTACCOUNTS_HOME 仅供测试覆盖。"""
    return Path(os.environ.get("GPTACCOUNTS_HOME") or (Path.home() / ".gptaccounts"))


def config_path():
    return accounts_root() / "config.json"


def load_config():
    """配置缺失返回 None，由调用方决定报错方式。"""
    try:
        return json.loads(config_path().read_text())
    except Exception:
        return None


def load_email():
    """确定本次使用的账号。

    优先级：环境变量 GPTNATIVE_ACCOUNT > 配置 activeProfile.account。
    没有显式配置时退化为库内单账号；多账号则要求明确指定，不做猜测。
    """
    forced = os.environ.get("GPTNATIVE_ACCOUNT")
    if forced:
        return forced.strip().lower()
    config = load_config()
    if not config:
        raise TransportError("NOT_CONFIGURED")
    profile_name = os.environ.get("GPTNATIVE_PROFILE") or config.get("activeProfile")
    profile = (config.get("profiles") or {}).get(profile_name)
    if not profile or not profile.get("account"):
        raise TransportError("PROFILE_ACCOUNT_MISSING", profile=profile_name)
    return profile["account"].strip().lower()


def credential_path(email):
    if not re.fullmatch(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", email):
        raise TransportError("EMAIL_INVALID")
    return accounts_root() / "credentials" / (email + ".json")


class TransportError(Exception):
    def __init__(self, code, status=None, **details):
        self.data = {"code": code, **details}
        if status is not None:
            self.data["httpStatus"] = status


def decode_claims(token):
    return json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))


def credential():
    """从共享凭据库读取并完整校验一份 Codex 标准格式凭据。

    校验项与原实现一致，未做任何放宽：邮箱、邮箱已验证、账号 ID 自洽、
    有效期。任何一项不符直接报错，不回退其他账号。
    """
    email = load_email()
    path = credential_path(email)
    if not path.exists():
        raise TransportError("CREDENTIAL_NOT_FOUND", email=email)
    try:
        auth = json.loads(path.read_text())
    except Exception:
        raise TransportError("CREDENTIAL_UNREADABLE", email=email)
    tokens = auth.get("tokens") or {}
    if auth.get("auth_mode") != "chatgpt":
        raise TransportError("UNSUPPORTED_AUTH_MODE", authMode=auth.get("auth_mode"))
    if not tokens.get("access_token") or not tokens.get("refresh_token"):
        raise TransportError("CREDENTIAL_TOKENS_MISSING", email=email)
    try:
        identity = decode_claims(tokens["id_token"])
        access = decode_claims(tokens["access_token"])
    except Exception:
        raise TransportError("CREDENTIAL_UNREADABLE", email=email)
    claims = access.get("https://api.openai.com/auth", {})
    if (identity.get("email") or "").lower() != email or identity.get("email_verified") is not True:
        raise TransportError("CREDENTIAL_EMAIL_MISMATCH")
    if access.get("exp", 0) <= time.time() + 30:
        raise TransportError("SELECTED_CREDENTIAL_EXPIRED", email=email)
    if claims.get("chatgpt_account_id") != tokens.get("account_id") or not claims.get("chatgpt_user_id"):
        raise TransportError("CREDENTIAL_PRINCIPAL_MISMATCH")
    return tokens["access_token"], claims, email


class Client:
    def progress(self, **data):
        print(json.dumps({"event": "progress", "data": data}), flush=True)

    def __init__(self):
        token, self.principal, expected_email = credential()
        self.session = requests.Session(impersonate="chrome")
        self.headers = {"Authorization": "Bearer " + token,
                        "ChatGPT-Account-Id": self.principal["chatgpt_account_id"],
                        "Accept": "application/json"}
        self.device_ready = False
        me = self.get("/me")
        if me.get("email", "").lower() != expected_email or me.get("id") != self.principal["chatgpt_user_id"]:
            raise TransportError("REMOTE_IDENTITY_MISMATCH")
        self.identity = {"email": expected_email, "userId": me["id"],
                         "accountId": self.principal["chatgpt_account_id"],
                         "source": "gptaccounts", "remoteVerified": True}

    def check_response(self, response, submitted=False):
        state = response.headers.get("X-OAI-IS-Update")
        if isinstance(state, str) and re.fullmatch(r"ois1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", state) and len(state) <= 2048:
            self.headers["X-OAI-IS"] = state
        if response.status_code != 200:
            code = "HTTP_ERROR"
            if response.headers.get("cf-mitigated") == "challenge":
                code = "HTTP_CLIENT_CHALLENGE"
            server_code, error_shape = None, None
            if "json" in response.headers.get("Content-Type", ""):
                try:
                    data = response.json()
                    error_shape = {key: ({k: type(v).__name__ for k, v in value.items()} if isinstance(value, dict) else type(value).__name__) for key, value in data.items()}
                    detail = data.get("detail", data.get("error", {}))
                    candidate = detail.get("code") if isinstance(detail, dict) else detail
                    if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9_. -]{1,120}", candidate):
                        server_code = candidate
                except Exception:
                    pass
            if submitted and response.status_code in [400, 401, 403, 404, 422, 429]:
                submitted = False
            raise TransportError(code, response.status_code, submitted=submitted,
                                 serverCode=server_code, errorShape=error_shape,
                                 retryAfterSeconds=int(response.headers["Retry-After"]) if response.headers.get("Retry-After", "").isdigit() else None,
                                 retryAutomatically=False)

    def get(self, path):
        allowed = (path == "/me" or path.startswith("/models") or
                   re.fullmatch(r"/conversations\?[^#]*", path) or
                   re.fullmatch(r"/conversation/[0-9a-f-]{36}", path) or
                   re.fullmatch(r"/gizmos/snorlax/sidebar\?[^#]*", path) or
                   re.fullmatch(r"/gizmos/[\w-]{1,100}/conversations\?[^#]*", path))
        if not allowed or ".." in path or "\\" in path:
            raise TransportError("UNSUPPORTED_READ_PATH")
        response = self.session.get(BASE + path, headers=self.headers, timeout=30,
                                    allow_redirects=False)
        self.check_response(response)
        return response.json()

    def ask(self, args):
        prompt = args.get("prompt", "")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 100000:
            raise TransportError("INVALID_PROMPT", submitted=False)
        integrity = self.device_probe()
        timeout_ms = args.get("timeoutMs", 1200000)
        if not isinstance(timeout_ms, int) or not 1000 <= timeout_ms <= 3600000:
            raise TransportError("INVALID_ASK_TIMEOUT", submitted=False)
        # A fresh request omits conversation_id. This is the App's actual
        # temporary-chat flag, not a local-only ephemeral Codex thread.
        body = {"action": "next", "messages": [{"id": str(uuid.uuid4()),
                 "author": {"role": "user"}, "create_time": time.time(),
                 "content": {"content_type": "text", "parts": [prompt]}, "metadata": {}}],
                "model": args.get("model", "auto"), "parent_message_id": str(uuid.uuid4()),
                "history_and_training_disabled": True, "is_do_not_remember": True,
                "conversation_mode": {"kind": "primary_assistant"},
                "app_attest_challenge": self.app_challenge,
                "timezone": "Asia/Shanghai", "timezone_offset_min": -480}
        if args.get("search"):
            body["force_use_search"] = True
        messages = {}
        conversation_id = None
        search_evidence = {}
        response = None
        started = time.monotonic()
        last_progress = 0
        self.progress(phase="dispatching", userMessageId=body["messages"][0]["id"])
        try:
            response = self.session.post(BASE + "/f/conversation", headers={**self.headers,
                 "Accept": "text/event-stream", "Content-Type": "application/json"},
                 json=body, stream=True, timeout=(20, timeout_ms / 1000), allow_redirects=False)
            self.check_response(response, submitted="unknown")
            for line in response.iter_lines():
                line = line.decode("utf-8") if isinstance(line, bytes) else line
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    final = [m for m in messages.values() if m.get("author", {}).get("role") == "assistant"
                             and m.get("recipient", "all") == "all" and m.get("channel") in [None, "final"]
                             and m.get("content", {}).get("content_type") == "text"]
                    completed = [m for m in final if m.get("status") == "finished_successfully" and m.get("end_turn") is True]
                    answer = "\n\n".join(p for m in completed for p in m.get("content", {}).get("parts", []) if isinstance(p, str))
                    if not answer:
                        raise TransportError("NO_COMPLETED_ASSISTANT_ANSWER", submitted=True, retryAutomatically=False)
                    return {"conversationId": conversation_id, "answer": answer, "streamDone": True,
                            "temporaryRequested": True, "device": integrity,
                            "assistantMessages": completed, "searchEvidence": search_evidence}
                try:
                    event = json.loads(data)
                except ValueError:
                    continue
                # Resume credentials and other control tokens are deliberately
                # discarded, never returned, logged or saved with the answer.
                if not isinstance(event, dict):
                    continue
                if event.get("error") or event.get("error_code"):
                    raise TransportError("CHATGPT_STREAM_ERROR", submitted=True, retryAutomatically=False)
                conversation_id = event.get("conversation_id", conversation_id)
                message = event.get("message")
                if isinstance(message, dict) and message.get("id"):
                    messages[message["id"]] = message
                if event.get("type") == "server_ste_metadata":
                    meta = event.get("metadata", {})
                    search_evidence = {k: meta.get(k) for k in ["product_experience", "model_slug", "tool_invoked", "is_search", "search_tool_call_count"]}
                if conversation_id and (time.monotonic() - last_progress >= 2):
                    partial = "\n\n".join(p for m in messages.values()
                        if m.get("author", {}).get("role") == "assistant"
                        and m.get("recipient", "all") == "all" and m.get("channel") in [None, "final"]
                        and m.get("content", {}).get("content_type") == "text"
                        for p in m.get("content", {}).get("parts", []) if isinstance(p, str))
                    self.progress(phase="streaming", conversationId=conversation_id,
                                  partialAnswer=partial, elapsedMs=int((time.monotonic() - started) * 1000))
                    last_progress = time.monotonic()
            raise TransportError("STREAM_ENDED_WITHOUT_DONE", submitted="unknown", retryAutomatically=False)
        except TransportError:
            raise
        except Exception:
            raise TransportError("SEND_OUTCOME_UNKNOWN", submitted="unknown", retryAutomatically=False)
        finally:
            if response is not None:
                response.close()

    def requirements_probe(self):
        response = self.session.post(BASE + "/sentinel/chat-requirements/prepare",
                    headers=self.headers, json={"p": ""}, timeout=30, allow_redirects=False)
        self.check_response(response)
        data = response.json()
        # Integrity tokens stay in memory. This diagnostic returns flags only.
        return {"keys": list(data), "forceLogin": data.get("force_login"),
                "hasToken": bool(data.get("token") or data.get("prepare_token")),
                "proofRequired": data.get("proofofwork", {}).get("required"),
                "turnstileRequired": data.get("turnstile", {}).get("required")}

    def device_token(self):
        # Use the unmodified official signed runtime and its public native addon
        # API. Apple generates the real proof; no fabricated integrity tokens.
        script = """(async()=>{try{const d=require('/Applications/ChatGPT.app/Contents/Resources/native/devicecheck.node');const r=await d.generateToken();if(!r.supported||!r.tokenBase64)process.exit(1);process.stdout.write(r.tokenBase64)}catch{process.exit(1)}})()"""
        process = subprocess.run(["/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
                                  "--input-type=commonjs", "-e", script],
                                 capture_output=True, timeout=20)
        if process.returncode != 0 or not process.stdout:
            raise TransportError("OFFICIAL_DEVICE_PROOF_UNAVAILABLE", submitted=False)
        return process.stdout.decode("ascii")

    def device_probe(self):
        if not self.device_ready:
            self.headers.update({"oai-did": str(uuid.uuid4()), "originator": "Codex Desktop",
                                 "User-Agent": "Codex Desktop/26.1007.71326 (Mac OS; arm64)",
                                 "x-openai-web-frontend": "codex_webview",
                                 "x-oai-mcp-form-version": "2", "x-openai-codex-window-type": "electron"})
            token = self.device_token()
            response = self.session.post(BASE + "/devicecheck", headers=self.headers,
                       json={"bundle_id": "com.openai.codex", "device_token": token},
                       timeout=30, allow_redirects=False)
            self.check_response(response)
            if not self.session.cookies.get("_devicecheck"):
                raise TransportError("DEVICE_REGISTRATION_COOKIE_MISSING", submitted=False)
            self.device_ready = True
        response = self.session.get(BASE + "/ios/attestation_challenge", headers={**self.headers,
                    "x-sentinel-dc": json.dumps({"token": self.device_token()}),
                    "OAI-Package-Name": "com.openai.codex"}, timeout=30, allow_redirects=False)
        self.check_response(response)
        data = response.json()
        self.app_challenge = data.get("attestation_challenge")
        if not isinstance(self.app_challenge, str) or not self.app_challenge:
            raise TransportError("APP_ATTESTATION_CHALLENGE_MISSING", submitted=False)
        return {"deviceRegistered": True, "realAppleProofUsed": True, "hasAppAttestationChallenge": True,
                "hasIntegrityState": "X-OAI-IS" in self.headers}

    def conversation_preflight(self):
        proof = self.device_probe()
        # Deliberately invalid action: only test the request gate, never a model.
        response = self.session.post(BASE + "/f/conversation", headers=self.headers,
                     json={"action": "__schema_probe__", "history_and_training_disabled": True,
                           "app_attest_challenge": self.app_challenge},
                     timeout=30, allow_redirects=False)
        try:
            self.check_response(response)
        except TransportError as error:
            return {"device": proof, "gate": error.data, "modelRequest": False}
        raise TransportError("UNEXPECTED_PREFLIGHT_RESPONSE", submitted=False)


def main():
    try:
        client = Client()
        print(json.dumps({"ready": True, "identity": client.identity}), flush=True)
    except TransportError as error:
        print(json.dumps({"ready": False, "error": error.data}), flush=True)
        sys.exit(1)
    except Exception:
        print(json.dumps({"ready": False, "error": {"code": "CREDENTIAL_OR_IDENTITY_READ_FAILED"}}), flush=True)
        sys.exit(1)

    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            method, args = request["method"], request.get("params", {})
            if method == "get":
                result = client.get(args["path"])
            elif method == "temporary-ask":
                result = client.ask(args)
            elif method == "requirements-probe":
                result = client.requirements_probe()
            elif method == "device-probe":
                result = client.device_probe()
            elif method == "conversation-preflight":
                result = client.conversation_preflight()
            else:
                raise TransportError("UNKNOWN_METHOD")
            print(json.dumps({"id": request["id"], "result": result}), flush=True)
        except TransportError as error:
            print(json.dumps({"id": request.get("id"), "error": error.data}), flush=True)
        except Exception:
            print(json.dumps({"id": request.get("id"), "error": {"code": "TRANSPORT_FAILED"}}), flush=True)


if __name__ == "__main__":
    main()
