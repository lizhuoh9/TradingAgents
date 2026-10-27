"""Read the installed project's model options without network access."""

import json
import sys
from urllib.parse import urlsplit

from tradingagents.llm_clients.api_key_env import PROVIDER_API_KEY_ENV
from tradingagents.llm_clients.model_catalog import MODEL_OPTIONS, get_model_options
from tradingagents.llm_clients.openai_client import OPENAI_COMPATIBLE_PROVIDERS


def _endpoint(url):
    try:
        parts = urlsplit(url)
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            return None
        return parts.hostname.lower(), parts.port if parts.port is not None else 443, parts.path.rstrip("/")
    except ValueError:
        return None


def resolve_provider(provider, base_url):
    provider = str(provider or "").strip().lower()
    if provider != "openai_compatible" or not base_url:
        return provider
    endpoint = _endpoint(base_url)
    if endpoint is None:
        return provider
    matches = []
    for name, spec in OPENAI_COMPATIBLE_PROVIDERS.items():
        if name in {"openai_compatible", "ollama", "chatgpt"} or not spec.base_url or not PROVIDER_API_KEY_ENV.get(name):
            continue
        reference = _endpoint(spec.base_url)
        if not reference or endpoint[:2] != reference[:2]:
            continue
        if endpoint[2] == reference[2] or (endpoint[2] in {"", "/v1"} and reference[2] in {"", "/v1"}):
            matches.append(name)
    return matches[0] if len(matches) == 1 else provider


def list_models(provider, base_url):
    detected = resolve_provider(provider, base_url)
    models = []
    seen = set()
    if detected in MODEL_OPTIONS:
        for mode in ("quick", "deep"):
            for label, model_id in get_model_options(detected, mode):
                if model_id != "custom" and model_id not in seen:
                    models.append({"id": model_id, "label": label})
                    seen.add(model_id)
    compatible_base_url = ""
    spec = OPENAI_COMPATIBLE_PROVIDERS.get(provider)
    if spec is not None and provider != "chatgpt":
        compatible_base_url = base_url or spec.base_url or ""
        if not compatible_base_url:
            from cli.prompts import provider_default_url

            compatible_base_url = provider_default_url(provider) or ""
    return {"models": models, "detectedProvider": detected if detected != provider else "",
            "compatibleBaseUrl": compatible_base_url}


if __name__ == "__main__":
    request = json.load(sys.stdin)
    json.dump(list_models(request.get("provider", ""), request.get("baseUrl", "")), sys.stdout, ensure_ascii=False)
