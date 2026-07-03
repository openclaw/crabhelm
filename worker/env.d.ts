interface Env {
  OPERATOR_TOKEN: string;
  CRABBOX_TOKEN: string;
  BOOTSTRAP_SIGNING_SECRET: string;
  SESSION_SIGNING_SECRET: string;
  INVOCATION_SIGNING_SECRET: string;
  RUNTIME_SIGNING_SECRET: string;
  VAULT_MASTER_KEY: string;
  OPENAI_API_KEY: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    OPERATOR_TOKEN: string;
    CRABBOX_TOKEN: string;
    BOOTSTRAP_SIGNING_SECRET: string;
    SESSION_SIGNING_SECRET: string;
    INVOCATION_SIGNING_SECRET: string;
    RUNTIME_SIGNING_SECRET: string;
    VAULT_MASTER_KEY: string;
    OPENAI_API_KEY: string;
    SLACK_BOT_TOKEN?: string;
    SLACK_APP_TOKEN?: string;
  }
}
