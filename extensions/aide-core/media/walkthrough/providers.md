# Connect an AI provider

AIDE works fully without AI. To enable AI features, add at least one provider in **AIDE Settings → Providers**:

- **Local**: Ollama, LM Studio, llama.cpp, vLLM. Nothing leaves your machine and there is no cost.
- **Cloud**: Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, or any OpenAI-compatible endpoint.

API keys are stored in your OS keychain. They are never written to settings files, never sent to models, and never exported.

Then use **Routing** to choose which model handles each kind of task, for example a fast local model for autocomplete and a strong model for coding.
