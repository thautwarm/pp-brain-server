// @might/chat
//
// 根入口：消费方只装本包就拿到会话事实层的全部公开面，不必知道 v1 这层目录。
// v1 的 README 里写的就是 `import { ChatAgent } from "@might/chat"`，这里把它兑现。
//
// adapter 走命名空间转出去（`deepseek.prepare`）：它是"把凭据变成模型"的那一层，
// 和 ChatAgent 这种不认模型从哪来的事实层不是一回事，平铺出来会让人误以为 ChatAgent 也管模型选择。

export type { Credential, ModelAuth } from "./auth.ts";
export * from "./v1/abstraction/index.ts";
export * as deepseek from "./v1/adapter/deepseek-compatible.ts";
