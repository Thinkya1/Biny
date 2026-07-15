import type { DesktopApi } from "../../protocol.js";

declare global {
  interface Window {
    biny: DesktopApi;
  }
}

export {};
