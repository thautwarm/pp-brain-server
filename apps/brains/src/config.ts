/**
 * config.toml：哪些 brain 可用、各自什么音色。
 *
 * 形状就是一张表，键是 brain_id（客户端手输的那个名字）：
 *
 *   [example-a]
 *   voice = "voice-2"
 *
 * 这张表不只是"默认值"，它就是**访问名单**：不在这里面的 brain_id 一律不认（路由回 404）。
 * 所以别把它当可有可无的东西——没有它一个 brain 都起不来。
 */
import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";

export interface BrainConfig {
  readonly id: string;
  readonly voice: string;
}

/**
 * 读 + 校验。任何问题都抛带路径和原因的 Error，交给启动时那一处统一报错退出——
 * 配置错要在启动时说，不要等到第一个请求才炸成 502。
 */
export async function loadBrainConfig(path: string): Promise<BrainConfig[]> {
  const text = await readFile(path, "utf8");
  const table = parseToml(path, text);

  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error(`${path} 的顶层应当是一张表（[brain_id]），实际是 ${typeof table}`);
  }

  const brains: BrainConfig[] = [];
  for (const [id, section] of Object.entries(table)) {
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw new Error(`${path} 里 [${id}] 应当是一张表`);
    }
    const voice = (section as Record<string, unknown>).voice;
    if (typeof voice !== "string" || voice.trim() === "") {
      throw new Error(`${path} 里 [${id}] 缺 voice（应该写成 voice = "..."）`);
    }
    brains.push({ id, voice });
  }

  if (brains.length === 0) {
    throw new Error(`${path} 里一个 brain 都没有（至少写一个 [brain_id]）`);
  }

  return brains;
}

function parseToml(path: string, text: string): unknown {
  try {
    return parse(text);
  } catch (cause) {
    throw new Error(
      `${path} 不是合法的 TOML：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
