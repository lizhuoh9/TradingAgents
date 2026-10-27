import sys
import os
from pathlib import Path

def analyst_selection(ticker):
    from cli.models import AssetType
    from cli.prompts import detect_asset_type

    if detect_asset_type(ticker) == AssetType.CRYPTO:
        return "market,news"
    return "market,news,fundamentals"


def configure_local_preferences():
    import cli.prefs

    if not hasattr(cli.prefs, "_PREFS_PATH"):
        raise RuntimeError("官方偏好配置接口已改变，无法确认本地保存路径；请更新桌面程序")
    cli.prefs._PREFS_PATH = Path(os.environ["TRADING_DESKTOP_STATE_DIR"]) / "cli_prefs.json"


if __name__ == "__main__":
    from memory_transaction import MemoryTransaction

    transaction = MemoryTransaction(
        os.environ["TRADINGAGENTS_MEMORY_LOG_PATH"],
        Path(os.environ["TRADINGAGENTS_RESULTS_DIR"]) / "memory" / "trading_memory.md",
    )
    os.environ["TRADINGAGENTS_MEMORY_LOG_PATH"] = str(transaction.working)
    from tradingagents.llm_clients.api_key_env import PROVIDER_API_KEY_ENV

    key = os.environ.pop("TRADING_DESKTOP_API_KEY", "")
    provider = os.environ["TRADINGAGENTS_LLM_PROVIDER"]
    from model_catalog_bridge import resolve_provider

    provider = resolve_provider(provider, os.environ.get("TRADINGAGENTS_LLM_BACKEND_URL", ""))
    os.environ["TRADINGAGENTS_LLM_PROVIDER"] = provider
    if provider not in PROVIDER_API_KEY_ENV or provider in {"azure", "bedrock", "chatgpt"}:
        raise SystemExit("不支持此 API 供应商代码，请检查配置")
    for env_name in PROVIDER_API_KEY_ENV.values():
        if env_name:
            os.environ.pop(env_name, None)
    env_name = PROVIDER_API_KEY_ENV[provider]
    if key and env_name:
        os.environ[env_name] = key
    fred_key = os.environ.pop("TRADING_DESKTOP_FRED_API_KEY", "")
    if fred_key:
        from fred_guard import install_fred_guard
        install_fred_guard(fred_key)
        os.environ["FRED_API_KEY"] = fred_key
    configure_local_preferences()
    from cli.main import app

    ticker, date = sys.argv[1:]
    sys.argv = [sys.argv[0], "--ticker", ticker, "--date", date, "--analysts",
                analyst_selection(ticker), "--save", "--no-show", "--html"]
    try:
        app()
    except SystemExit as exc:
        if exc.code not in (None, 0):
            raise
