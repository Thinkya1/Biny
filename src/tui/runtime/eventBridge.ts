/**
 * TUI 事件桥模块。
 *
 * TUI 当前直接复用通用 AgentEventBus，保留这个类名是为了不扩散改动范围。
 */
import { AgentEventBus } from "../../runtime/AgentEventBus.js";

export class TuiEventBridge extends AgentEventBus {}
