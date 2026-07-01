import type { DiagramToHost, HostToDiagram } from "../../src/shared/types";

interface VsCodeApi {
  postMessage(msg: DiagramToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export function post(msg: DiagramToHost) {
  vscode.postMessage(msg);
}

export function onHostMessage(handler: (msg: HostToDiagram) => void) {
  const listener = (event: MessageEvent<HostToDiagram>) => handler(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
