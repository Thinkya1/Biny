/**
 * 渲染进程入口。
 *
 * 只做挂载：找到 root 节点并渲染 `App`，不放任何业务逻辑。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Biny renderer root is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
