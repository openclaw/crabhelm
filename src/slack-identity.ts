export type SlackUserProfile = {
  real_name?: string;
  name?: string;
  profile?: { email?: string; display_name?: string; real_name?: string };
};

export function slackIdentity(userId: string, user?: SlackUserProfile): { email?: string; label: string } {
  const profile = user?.profile;
  const email = profile?.email?.trim().toLowerCase();
  const label = profile?.display_name?.trim()
    || profile?.real_name?.trim()
    || user?.real_name?.trim()
    || user?.name?.trim()
    || userId;
  return { ...(email ? { email } : {}), label: label.slice(0, 120) };
}
