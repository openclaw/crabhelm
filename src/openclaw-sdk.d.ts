declare module "openclaw/plugin-sdk/core" {
  import type { TSchema } from "typebox";

  export type AgentToolResult = {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  };

  export type AnyAgentTool = {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute(toolCallId: string, params: unknown): Promise<AgentToolResult>;
  };

  export function jsonResult(value: unknown): AgentToolResult;
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { AnyAgentTool } from "openclaw/plugin-sdk/core";

  type OperatorScope =
    | "operator.admin"
    | "operator.read"
    | "operator.write"
    | "operator.approvals"
    | "operator.pairing"
    | "operator.talk.secrets";

  type KeyedStore<T> = {
    register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
    lookup(key: string): Promise<T | undefined>;
    delete(key: string): Promise<boolean>;
    entries(): Promise<Array<{ key: string; value: T; createdAt: number; expiresAt?: number }>>;
  };

  type GatewayContext = {
    params?: Record<string, unknown>;
    respond(ok: boolean, payload?: unknown, error?: unknown): void;
  };

  type PluginApi = {
    rootDir?: string;
    pluginConfig?: Record<string, unknown>;
    runtime: {
      version: string;
      config: {
        current(): Record<string, unknown>;
        mutateConfigFile<T>(params: {
          afterWrite: { mode: "auto" };
          mutate(
            draft: Record<string, unknown>,
            context: { previousHash: string | null },
          ): Promise<T> | T;
        }): Promise<{ result?: T }>;
      };
      state: {
        resolveStateDir(env?: NodeJS.ProcessEnv): string;
        openKeyedStore<T>(options: { namespace: string; maxEntries: number }): KeyedStore<T>;
      };
      nodes: {
        list(params?: { connected?: boolean }): Promise<{
          nodes: Array<{
            nodeId: string;
            displayName?: string;
            connected?: boolean;
            caps?: string[];
            commands?: string[];
          }>;
        }>;
        invoke(params: {
          nodeId: string;
          command: string;
          params?: unknown;
          timeoutMs?: number;
          idempotencyKey?: string;
        }): Promise<unknown>;
      };
    };
    logger: {
      warn?(message: string): void;
      error?(message: string): void;
      info?(message: string): void;
    };
    registerTool(tool: AnyAgentTool): void;
    registerNodeHostCommand(command: {
      command: string;
      cap?: string;
      dangerous?: boolean;
      handle(paramsJSON?: string | null): Promise<string>;
    }): void;
    registerNodeInvokePolicy(policy: {
      commands: string[];
      defaultPlatforms?: Array<"linux" | "macos" | "windows" | "ios" | "android" | "unknown">;
      dangerous?: boolean;
      handle(context: {
        nodeId: string;
        params: unknown;
        node?: { displayName?: string };
        invokeNode(): Promise<unknown>;
      }): Promise<unknown>;
    }): void;
    on(
      event: "before_tool_call",
      handler: (event: { toolName: string; params: unknown }) => Promise<unknown> | unknown,
    ): void;
    registerGatewayMethod(
      name: string,
      handler: (context: GatewayContext) => Promise<void> | void,
      options?: { scope?: OperatorScope },
    ): void;
    registerHttpRoute(options: {
      path: string;
      auth: "gateway" | "plugin";
      match?: "exact" | "prefix";
      gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
      handler(
        req: IncomingMessage,
        res: ServerResponse,
      ): Promise<boolean | void> | boolean | void;
    }): void;
    registerService(service: {
      id: string;
      start(): Promise<void> | void;
      stop?(): Promise<void> | void;
    }): void;
    session: {
      controls: {
        registerControlUiDescriptor(descriptor: {
          id: string;
          surface: "session" | "tool" | "run" | "settings";
          label: string;
          description?: string;
          placement?: string;
          requiredScopes?: OperatorScope[];
        }): void;
      };
    };
  };

  export function definePluginEntry(definition: {
    id: string;
    name: string;
    description?: string;
    register(api: PluginApi): void;
  }): unknown;
}

declare module "openclaw/plugin-sdk/secret-input-runtime" {
  export function resolveConfiguredSecretInputString(params: {
    config: Record<string, unknown>;
    env: NodeJS.ProcessEnv;
    value: unknown;
    path: string;
    unresolvedReasonStyle?: "generic" | "detailed";
  }): Promise<{ value?: string; unresolvedRefReason?: string }>;
}
