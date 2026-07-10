type SlackEnvironment = Pick<
  Env,
  "CRABHELM_SLACK" | "SLACK_BOT_TOKEN" | "SLACK_SIGNING_SECRET"
>;

/** Missing mode preserves the existing Slack-on contract outside locked profiles. */
export function slackIngressEnabled(env: Pick<SlackEnvironment, "CRABHELM_SLACK">): boolean {
  return env.CRABHELM_SLACK !== "off";
}

export function slackIntegrationConfigured(env: SlackEnvironment): boolean {
  return slackIngressEnabled(env) && Boolean(
    env.SLACK_SIGNING_SECRET?.trim() && env.SLACK_BOT_TOKEN?.trim(),
  );
}
