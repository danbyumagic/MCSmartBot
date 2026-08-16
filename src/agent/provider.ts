/**
 * Reasoning backends supported by SmartBotMC.
 *
 * `codex` and `anthropic` use their respective signed-in CLIs. `openrouter`
 * uses an OpenAI-compatible HTTP API and is authenticated with an API key.
 */
export const AGENT_PROVIDERS = ["codex", "anthropic", "openrouter"] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function agentProviderLabel(provider: AgentProvider): string {
  switch (provider) {
    case "codex": return "Codex";
    case "anthropic": return "Claude";
    case "openrouter": return "OpenRouter";
  }
}
