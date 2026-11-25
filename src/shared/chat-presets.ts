import type { ChatPresetId } from "./contracts.js";

export const chatPresets = {
  ollama: { name: "Ollama", baseUrl: "http://localhost:11434/v1", description: "Chat with models installed in Ollama.", requiresKey: false },
  freellmapi: { name: "FreeLLMAPI", baseUrl: "http://localhost:3001/v1", description: "Connect to a FreeLLMAPI gateway with its unified key.", requiresKey: true },
  "lm-studio": { name: "LM Studio", baseUrl: "http://localhost:1234/v1", description: "Connect to the LM Studio local server.", requiresKey: false },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", description: "Access hosted models from multiple providers.", requiresKey: true },
  gemini: { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", description: "Access Gemini with a Google AI Studio API key.", requiresKey: true },
  "llama-cpp": { name: "llama.cpp", baseUrl: "http://localhost:8080/v1", description: "Connect to a running llama-server.", requiresKey: false },
  vllm: { name: "vLLM", baseUrl: "http://localhost:8000/v1", description: "Connect to a running vLLM server.", requiresKey: false },
  custom: { name: "Custom OpenAI-compatible", baseUrl: "", description: "Enter the base URL of an OpenAI-compatible chat API.", requiresKey: false },
} satisfies Record<ChatPresetId, { name: string; baseUrl: string; description: string; requiresKey: boolean }>;

export function isChatPreset(value: unknown): value is ChatPresetId {
  return typeof value === "string" && Object.hasOwn(chatPresets, value);
}
