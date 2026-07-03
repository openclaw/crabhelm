const retryableCodes = new Set(["fatal_error", "internal_error", "ratelimited", "request_timeout", "service_unavailable"]);

export function slackDeliveryRetryable(status: number, code?: string): boolean {
  return status === 429 || status >= 500 || retryableCodes.has(code ?? "");
}
