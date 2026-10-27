"""Keep the configured FRED credential out of model-visible tool results."""

from urllib.parse import urlsplit


def safe_fred_get(url, *, params, timeout, secret, passthrough=()):
    import requests

    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != "api.stlouisfed.org"
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.query or parsed.fragment or not parsed.path.startswith("/fred/")):
        raise RuntimeError("FRED 数据服务地址无效")
    # FRED places the credential in the URL; redirects must never forward it.
    try:
        response = requests.get(url, params=params, timeout=timeout, allow_redirects=False)
        if 300 <= response.status_code < 400:
            raise RuntimeError("FRED 数据服务不支持重定向")
        if response.status_code not in passthrough:
            response.raise_for_status()
        return response
    except requests.RequestException:
        raise RuntimeError("FRED 数据获取失败，请检查密钥、配置或网络。") from None

def guarded_fred(source, key):
    def call(*args, **kwargs):
        try:
            result = source(*args, **kwargs)
            if not isinstance(result, str):
                raise TypeError("unexpected FRED result")
            return result.replace(key, "[REDACTED]")
        except Exception:
            raise RuntimeError("FRED 数据获取失败，请检查密钥、配置或网络。") from None
    return call


def install_fred_guard(key):
    from tradingagents.dataflows import router
    from tradingagents.dataflows.vendors import fred
    try:
        vendors = router.VENDOR_METHODS["get_macro_indicators"]
        source = vendors["fred"]
        if (source is not fred.get_macro_data or not callable(fred.get_scrubbed)
                or "get_scrubbed" not in fred._request.__code__.co_names):
            raise TypeError("unexpected vendor")
        vendors["fred"] = guarded_fred(source, key)
        fred.get_scrubbed = safe_fred_get
    except (AttributeError, KeyError, TypeError):
        raise RuntimeError("官方数据服务接口已改变，无法安全使用 FRED 密钥；请更新桌面程序") from None
