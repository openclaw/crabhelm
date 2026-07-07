import WebSocket from "ws";
import type { IncomingMessage } from "node:http";
import type { TerminalDialer, TerminalSocket } from "../worker/bootstrap.js";

const handshakeTimeoutMs = 15_000;
const maxTerminalMessageBytes = 1024 * 1024;

export const awsTerminalDialer: TerminalDialer = async (
  attachUrl: string,
  brokerToken: string,
): Promise<TerminalSocket> => {
  const url = terminalUrl(attachUrl);
  const token = bearerToken(brokerToken);

  return new Promise<TerminalSocket>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, {
      followRedirects: false,
      handshakeTimeout: handshakeTimeoutMs,
      maxPayload: maxTerminalMessageBytes,
      perMessageDeflate: false,
      headers: { authorization: `Bearer ${token}` },
    });

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(error);
    };

    socket.once("open", () => {
      if (settled) return;
      settled = true;
      resolve(socket as unknown as TerminalSocket);
    });
    socket.once("error", fail);
    socket.once("unexpected-response", (_request, response: IncomingMessage) => {
      response.resume();
      fail(new Error(`Crabbox terminal upgrade failed (HTTP ${response.statusCode ?? 502})`));
    });
  });
};

function terminalUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Crabbox terminal URL is invalid");
  }
  if (
    url.protocol !== "wss:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Crabbox terminal URL must use WSS without credentials or a fragment");
  }
  return url;
}

function bearerToken(value: string): string {
  const token = value.trim();
  if (!token || !/^[\u0021-\u007e]+$/u.test(token)) {
    throw new Error("Crabbox terminal bearer token is invalid");
  }
  return token;
}
