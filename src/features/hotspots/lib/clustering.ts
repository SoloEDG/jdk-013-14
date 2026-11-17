import type { Camera, Hotspot } from "../../../shared/types";
import { project } from "../../panorama/lib/projection";

/**
 * 屏幕空间布局。
 *
 * 距离刻意用像素而不是角度来度量：同样的两个热点，在缩小视野或舞台变小时
 * 会合并成一组，视野放开后再拆开。投影内部已经用 wrap() 归一化 yaw，跨越
 * ±180° 接缝的热点只会得到一个屏幕坐标；下面的所有函数再按热点 id 去重，
 * 保证同一个热点不会在接缝两侧被数两次。
 */

export interface Viewport {
  width: number;
  height: number;
}

export interface PlacedHotspot {
  hotspot: Hotspot;
  x: number;
  y: number;
  /** 朝向镜头且落在宽松的可视范围内。 */
  visible: boolean;
  /** 落在较紧的边缘内边距内，有资格新加入分组。 */
  onScreen: boolean;
  /** 落在更宽的保留内边距内，已在组里的成员可以继续留下。 */
  retained: boolean;
  /** 相对镜头的归一化 yaw。 */
  relativeYaw: number;
  /** 在内容列表中的稳定序号，不随镜头变化。 */
  order: number;
}

export interface ClusteringOptions {
  /** 新成员加入分组的边缘内边距。 */
  edgePadding: number;
  /** 已有成员被移出分组前的边缘内边距。 */
  retainPadding: number;
}

export const DEFAULT_CLUSTERING: ClusteringOptions = {
  edgePadding: 40,
  retainPadding: 168,
};

export function placeHotspots(
  items: Hotspot[],
  camera: Camera,
  viewport: Viewport,
  options: ClusteringOptions = DEFAULT_CLUSTERING,
): PlacedHotspot[] {
  const seen = new Set<string>();
  const placed: PlacedHotspot[] = [];
  for (const [order, hotspot] of items.entries()) {
    // 接缝两侧的重复条目只保留第一个。
    if (seen.has(hotspot.id)) continue;
    seen.add(hotspot.id);
    const point = project(
      hotspot.yaw,
      hotspot.pitch,
      camera,
      viewport.width,
      viewport.height,
    );
    const inside = (padding: number) =>
      point.x >= -padding &&
      point.x <= viewport.width + padding &&
      point.y >= -padding &&
      point.y <= viewport.height + padding;
    placed.push({
      hotspot,
      x: point.x,
      y: point.y,
      visible: point.visible,
      onScreen: point.visible && inside(options.edgePadding),
      retained: point.visible && inside(options.retainPadding),
      relativeYaw: relativeYaw(hotspot.yaw, camera.yaw),
      order,
    });
  }
  return placed.sort((a, b) => a.relativeYaw - b.relativeYaw);
}

export function relativeYaw(yaw: number, cameraYaw: number) {
  return ((((yaw - cameraYaw + 180) % 360) + 360) % 360) - 180;
}

export function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
