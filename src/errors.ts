export type CrabhelmOperationalErrorCode =
  | "CRABBOX_UNCONFIGURED"
  | "DEPLOYMENT_TARGET_UNAVAILABLE"
  | "CRABBOX_UNREACHABLE"
  | "CRABBOX_CREATE_HTTP"
  | "CRABBOX_CREATE_STATE"
  | "CRABBOX_INSPECT_HTTP"
  | "CRABBOX_DELETE_HTTP"
  | "CRABBOX_IDENTITY_MISMATCH"
  | "CRABBOX_WORKSPACE_FAILED"
  | "CLAWROUTER_UNCONFIGURED"
  | "CLAWROUTER_UNREACHABLE"
  | "CLAWROUTER_REJECTED"
  | "CLAWROUTER_STATUS_INVALID"
  | "CHILD_CONTROL_FAILED"
  | "CHILD_COMMAND_MISSING"
  | "CHILD_IDENTITY_MISMATCH"
  | "CHILD_STATUS_INVALID"
  | "CHILD_HEALTH_INVALID"
  | "CHILD_DRAIN_INVALID"
  | "CHILD_POLICY_CAS_CONFLICT"
  | "SLACK_CREDENTIALS_UNRESOLVED"
  | "CHILD_INGRESS_DISABLE_FAILED"
  | "CHILD_PROVISION_FAILED"
  | "CHILD_RECONCILE_FAILED"
  | "CHILD_REMOVAL_FAILED";

export class CrabhelmOperationalError extends Error {
  readonly code: CrabhelmOperationalErrorCode;
  readonly operatorMessage: string;

  constructor(
    code: CrabhelmOperationalErrorCode,
    operatorMessage: string,
    options: { cause?: unknown } = {},
  ) {
    super(operatorMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CrabhelmOperationalError";
    this.code = code;
    this.operatorMessage = operatorMessage;
  }
}

export class CrabhelmRequestError extends Error {
  readonly publicMessage: string;

  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "CrabhelmRequestError";
    this.publicMessage = publicMessage;
  }
}

export function operationalError(
  code: CrabhelmOperationalErrorCode,
  operatorMessage: string,
  cause?: unknown,
): CrabhelmOperationalError {
  return new CrabhelmOperationalError(code, operatorMessage, { cause });
}

export function requestError(message: string): CrabhelmRequestError {
  return new CrabhelmRequestError(message);
}

export function publicRequestFailure(
  error: unknown,
): { status: number; message: string; unexpected: boolean } {
  if (error instanceof SyntaxError) {
    return { status: 400, message: "request body must contain valid JSON", unexpected: false };
  }
  if (error instanceof CrabhelmRequestError) {
    return { status: 422, message: error.publicMessage, unexpected: false };
  }
  return { status: 500, message: "request failed", unexpected: true };
}

const operationalErrorCopy: Partial<Record<CrabhelmOperationalErrorCode, string>> = {
  CRABBOX_UNCONFIGURED: "Crabbox provisioning is unconfigured",
  DEPLOYMENT_TARGET_UNAVAILABLE: "The deployment target is unavailable",
  CRABBOX_UNREACHABLE: "Crabbox is unreachable",
  CRABBOX_CREATE_HTTP: "Crabbox rejected workspace creation",
  CRABBOX_CREATE_STATE: "Crabbox returned invalid workspace creation state",
  CRABBOX_INSPECT_HTTP: "Crabbox workspace inspection failed",
  CRABBOX_DELETE_HTTP: "Crabbox workspace removal failed",
  CRABBOX_IDENTITY_MISMATCH: "Crabbox workspace identity does not match the claw",
  CRABBOX_WORKSPACE_FAILED: "Crabbox reports a failed workspace",
  CLAWROUTER_UNCONFIGURED: "ClawRouter is unconfigured",
  CLAWROUTER_UNREACHABLE: "ClawRouter is unreachable",
  CLAWROUTER_REJECTED: "ClawRouter rejected the control-plane request",
  CLAWROUTER_STATUS_INVALID: "ClawRouter returned invalid status",
  CHILD_CONTROL_FAILED: "Child control command failed",
  CHILD_INGRESS_DISABLE_FAILED: "Child ingress disable did not complete",
};

export function safeOperationalFailure(
  error: unknown,
  fallback: { code: CrabhelmOperationalErrorCode; message: string },
): { code: CrabhelmOperationalErrorCode; message: string } {
  if (error instanceof CrabhelmOperationalError) {
    return {
      code: error.code,
      message: operationalErrorCopy[error.code] ?? childErrorCopy[error.code] ?? fallback.message,
    };
  }
  return fallback;
}

const childErrorCopy: Partial<Record<CrabhelmOperationalErrorCode, string>> = {
  CHILD_COMMAND_MISSING: "Child does not advertise a required Crabhelm command",
  CHILD_IDENTITY_MISMATCH: "Child node identity does not match the enrolled claw",
  CHILD_STATUS_INVALID: "Child returned invalid status evidence",
  CHILD_HEALTH_INVALID: "Child returned invalid operational health evidence",
  CHILD_DRAIN_INVALID: "Child returned invalid active-run drain evidence",
  CHILD_POLICY_CAS_CONFLICT: "Child policy changed during managed configuration apply",
  SLACK_CREDENTIALS_UNRESOLVED: "Child-local Slack credentials are unresolved",
};

export function operationalErrorFromChildCode(value: unknown): CrabhelmOperationalError {
  const code = typeof value === "string" ? value as CrabhelmOperationalErrorCode : undefined;
  const operatorMessage = code ? childErrorCopy[code] : undefined;
  return operatorMessage
    ? operationalError(code as CrabhelmOperationalErrorCode, operatorMessage)
    : operationalError("CHILD_CONTROL_FAILED", "Child control command failed");
}
