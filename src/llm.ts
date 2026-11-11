import Anthropic from "@anthropic-ai/sdk";

// Resolves credentials from ANTHROPIC_API_KEY (or an `ant auth login` profile).
// The SDK retries 408/409/429/5xx and connection errors twice by default.
export const anthropic = new Anthropic({ maxRetries: 2 });
