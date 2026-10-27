function cleanEnvironment(source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (/^(TRADINGAGENTS_|TRADING_DESKTOP_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|OLLAMA_|LANGCHAIN_|LANGSMITH_)/.test(upper) || upper.endsWith('_API_KEY') || upper === 'SEC_EDGAR_USER_AGENT') delete env[name];
  }
  env.PYTHONUTF8 = '1';
  env.PYTHON_DOTENV_DISABLED = '1';
  env.LANGCHAIN_TRACING = 'false';
  env.LANGCHAIN_TRACING_V2 = 'false';
  env.LANGSMITH_TRACING = 'false';
  env.LANGSMITH_TRACING_V2 = 'false';
  return env;
}
module.exports = { cleanEnvironment };
