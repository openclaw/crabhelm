interface Env {
  CRABBOX_TOKEN: string;
  BOOTSTRAP_SIGNING_SECRET: string;
  SESSION_SIGNING_SECRET: string;
  INVOCATION_SIGNING_SECRET: string;
  RUNTIME_SIGNING_SECRET: string;
  VAULT_MASTER_KEY: string;
  OPENAI_API_KEY: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  SLACK_SIGNING_SECRET: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_ADMIN_EMAILS: string;
  CF_ACCESS_ADMIN_GROUPS?: string;
  RUNTIME_URL: string;
}

declare namespace Cloudflare {
  interface Env {
    CRABBOX_TOKEN: string;
    BOOTSTRAP_SIGNING_SECRET: string;
    SESSION_SIGNING_SECRET: string;
    INVOCATION_SIGNING_SECRET: string;
    RUNTIME_SIGNING_SECRET: string;
    VAULT_MASTER_KEY: string;
    OPENAI_API_KEY: string;
    SLACK_BOT_TOKEN?: string;
    SLACK_APP_TOKEN?: string;
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUD: string;
    CF_ACCESS_ADMIN_EMAILS: string;
    CF_ACCESS_ADMIN_GROUPS?: string;
  }
}
