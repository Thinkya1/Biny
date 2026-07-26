/**
 * 消息里内联图片的加载。
 *
 * 图片由主进程读成 data URL（渲染进程的 CSP 不放行 file://）。同一张图在时间线里会随流式渲染
 * 反复挂载，所以按「项目 + 路径」缓存请求，只真正读一次；缓存有上限，避免一个长会话把几十张
 * 图的 base64 一直挂在内存里。
 */
import { useEffect, useState } from "react";

const cacheLimit = 32;
const cache = new Map<string, Promise<string | undefined>>();

export function useInlineImage(projectId: string, path: string): string | undefined {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    setSource(undefined);
    if (!path) return;
    let active = true;
    const key = `${projectId}:${path}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = window.biny.readInlineImage(projectId, path).catch(() => undefined);
      // 先淘汰最早写入的，再放新的：Map 的迭代顺序就是插入顺序。
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value ?? "");
      cache.set(key, pending);
    }
    void pending.then((value) => {
      if (active) setSource(value);
    });
    return () => {
      active = false;
    };
  }, [projectId, path]);
  return source;
}
