import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from model_catalog_bridge import list_models, resolve_provider


class ModelCatalogTests(unittest.TestCase):
    def test_official_endpoint_is_matched_only_exactly(self):
        self.assertEqual(resolve_provider("openai_compatible", "https://api.deepseek.com/v1"), "deepseek")
        for url in ("https://api.deepseek.com.evil.example/v1", "http://api.deepseek.com/v1",
                    "https://api.deepseek.com:444/v1", "https://api.deepseek.com:0/v1", "https://api.deepseek.com/other",
                    "https://name:secret@api.deepseek.com/v1"):
            self.assertEqual(resolve_provider("openai_compatible", url), "openai_compatible")
        self.assertEqual(resolve_provider("openai_compatible", "http://localhost:11434/v1"), "openai_compatible")

    def test_catalog_comes_from_official_options(self):
        data = list_models("openai_compatible", "https://api.deepseek.com/v1")
        self.assertEqual(data["detectedProvider"], "deepseek")
        ids = [model["id"] for model in data["models"]]
        self.assertIn("deepseek-flash", ids)
        self.assertIn("deepseek-v4-pro", ids)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn("custom", ids)
        self.assertEqual(list_models("openai_compatible", "https://other.example/v1")["models"], [])

    def test_provider_resolution_precedes_default_config_import(self):
        code = (
            "import os; from model_catalog_bridge import resolve_provider; "
            "os.environ['TRADINGAGENTS_LLM_PROVIDER']=resolve_provider('openai_compatible','https://api.deepseek.com/v1'); "
            "from tradingagents.default_config import DEFAULT_CONFIG; "
            "assert DEFAULT_CONFIG['llm_provider']=='deepseek'"
        )
        result = subprocess.run([sys.executable, "-c", code], env={**os.environ, "PYTHON_DOTENV_DISABLED": "1"},
                                cwd=os.path.dirname(__file__), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_official_client_keeps_selected_endpoint(self):
        from tradingagents.llm_clients.factory import create_llm_client
        from tradingagents.llm_clients.openai_client import DeepSeekChatOpenAI

        endpoint = "https://api.deepseek.com/v1"
        provider = resolve_provider("openai_compatible", endpoint)
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-only-key"}):
            client = create_llm_client(provider, "deepseek-flash", base_url=endpoint).get_llm()
        self.assertIsInstance(client, DeepSeekChatOpenAI)
        self.assertEqual(client.openai_api_base, endpoint)


if __name__ == "__main__":
    unittest.main()
