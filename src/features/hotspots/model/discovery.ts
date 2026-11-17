import { computed, ref, shallowRef } from "vue";
import type { Camera, Hotspot } from "../../../shared/types";
import { hotspots } from "../../../shared/content";
import { activeHotspots } from "../lib/visibility";
import {
  DEFAULT_CLUSTERING,
  placeHotspots,
  type ClusteringOptions,
  type Viewport,
} from "../lib/clustering";
import {
  createGrouping,
  type GroupsOptions,
  type HotspotClusterView,
} from "./groups";

export interface DiscoveryDetail {
  hotspot: Hotspot;
  saved: boolean;
  /** 成员仍在播放时间窗内。 */
  live: boolean;
  /** 已离开时间窗，但因为正在阅读而保留的历史状态。 */
  historical: boolean;
  /** 所在分组内的位置，用于逐条浏览。 */
  index: number;
  total: number;
  /** 相邻方向是否还有有效成员可浏览（历史成员会被跳过）。 */
  canPrev: boolean;
  canNext: boolean;
}

export interface SelectionSnapshot {
  hotspotId: string;
  /** 打开时的分组；恢复时分组可能已经重组。 */
  groupId: string | null;
}

export function createDiscovery(
  position: () => { chapterId: string; time: number },
  isSaved: (id: string) => boolean,
  options: Partial<GroupsOptions> & Partial<ClusteringOptions> = {},
) {
  const enabled = ref(true),
    expandedGroupId = ref<string | null>(null),
    selectedId = ref<string | null>(null),
    clusters = shallowRef<HotspotClusterView[]>([]);
  const mergeRadius = options.mergeRadius ?? 260;
  const grouping = createGrouping({
    ...options,
    mergeRadius,
    joinRadius: options.joinRadius ?? mergeRadius * 0.85,
    retainRadius: options.retainRadius ?? mergeRadius * 1.15,
  });
  const clustering: ClusteringOptions = {
    edgePadding: options.edgePadding ?? DEFAULT_CLUSTERING.edgePadding,
    retainPadding:
      options.retainPadding ?? Math.max(mergeRadius * 1.15, 168),
  };
  let syncedChapter = position().chapterId;
  let lastViewport: Viewport = { width: 960, height: 470 };

  /** 让层组件建立响应依赖：时间、章节或阅读中的选择变化时重新分组。 */
  const revision = computed(
    () =>
      `${position().chapterId}|${position().time}|${selectedId.value ?? ""}`,
  );
  const pinnedIds = computed(() => (selectedId.value ? [selectedId.value] : []));

  function clusterOf(hotspotId: string) {
    return clusters.value.find((cluster) =>
      cluster.members.some((member) => member.id === hotspotId),
    );
  }

  function isLive(id: string) {
    const p = position();
    return activeHotspots(hotspots, p.chapterId, p.time).some(
      (hotspot) => hotspot.id === id,
    );
  }

  const detail = computed<DiscoveryDetail | undefined>(() => {
    const id = selectedId.value;
    if (!id) return undefined;
    const hotspot = hotspots.find((item) => item.id === id);
    if (!hotspot) return undefined;
    const cluster = clusterOf(id);
    const index = cluster
      ? cluster.members.findIndex((member) => member.id === id)
      : -1;
    const live = isLive(id);
    const nextLive = (step: number) => {
      if (!cluster) return false;
      for (let i = 1; i <= cluster.members.length; i += 1) {
        const next = cluster.members[index + step * i];
        if (!next) return false;
        if (next.live) return true;
      }
      return false;
    };
    return {
      hotspot,
      saved: isSaved(id),
      live,
      historical: !live,
      index: Math.max(index, 0),
      total: Math.max(cluster?.members.length ?? 1, 1),
      canPrev: index > 0 && nextLive(-1),
      canNext: index >= 0 && nextLive(1),
    };
  });

  const expansion = computed(() => {
    const id = expandedGroupId.value;
    return id ? clusters.value.find((cluster) => cluster.id === id) : undefined;
  });

  function sync(camera: Camera, viewport: Viewport) {
    const p = position();
    if (p.chapterId !== syncedChapter) {
      // 换章后旧分组与旧选择一并失效。
      syncedChapter = p.chapterId;
      grouping.reset();
      clusters.value = [];
      expandedGroupId.value = null;
      selectedId.value = null;
    }
    // 访谈返回时可能还没有测量到舞台尺寸；沿用上一次的有效布局。
    if (viewport.width > 0 && viewport.height > 0) lastViewport = viewport;
    const placed = placeHotspots(
      activeHotspots(hotspots, p.chapterId, p.time),
      camera,
      lastViewport,
      clustering,
    );
    clusters.value = grouping.update({
      chapterId: p.chapterId,
      time: p.time,
      placed,
      pinnedIds: pinnedIds.value,
      stableClusterId: expandedGroupId.value,
    });

    // 正在阅读的过期成员由分组保留；其余消失的选择立即清理。
    if (selectedId.value) {
      const kept = !!clusterOf(selectedId.value) || isLive(selectedId.value);
      if (!kept) {
        selectedId.value = null;
        expandedGroupId.value = null;
      }
    }
    // 选择仍在，但详情里的成员可能被合并到别组：保持展开列表指向新分组。
    if (selectedId.value && expandedGroupId.value) {
      const cluster = clusterOf(selectedId.value);
      if (cluster && cluster.id !== expandedGroupId.value) {
        expandedGroupId.value = cluster.members.length > 1 ? cluster.id : null;
      }
    }
    if (
      expandedGroupId.value &&
      !clusters.value.some((cluster) => cluster.id === expandedGroupId.value)
    ) {
      expandedGroupId.value = null;
    }
  }

  function collapse() {
    expandedGroupId.value = null;
    selectedId.value = null;
  }

  /** 只收起展开列表，保留正在阅读的详情卡。 */
  function closeList() {
    expandedGroupId.value = null;
  }

  function toggleGroup(id: string) {
    if (expandedGroupId.value === id) {
      collapse();
      return;
    }
    expandedGroupId.value = id;
    selectedId.value = null;
  }

  function selectMember(groupId: string, hotspotId: string) {
    const cluster = clusters.value.find((item) => item.id === groupId);
    if (!cluster?.members.some((member) => member.id === hotspotId)) return;
    // 只有多成员分组才展开列表；单独的标记直接进入详情，不会多出一层。
    expandedGroupId.value =
      cluster.members.length > 1 ? groupId : null;
    selectedId.value = hotspotId;
  }

  /** 直接打开一个热点（单击标记、手记回访）。 */
  function select(hotspotId: string) {
    if (!hotspots.some((hotspot) => hotspot.id === hotspotId)) return;
    const cluster = clusterOf(hotspotId);
    expandedGroupId.value =
      cluster && cluster.members.length > 1 ? cluster.id : null;
    selectedId.value = hotspotId;
  }

  /** 在同一分组内逐条浏览（详情卡的上一条 / 下一条）。 */
  function move(step: number) {
    const id = selectedId.value;
    if (!id) return;
    const cluster = clusterOf(id);
    if (!cluster) return;
    const index = cluster.members.findIndex((member) => member.id === id);
    // 只浏览有效成员：历史成员是阅读中保留的状态，不参与“下一个”。
    for (let i = 1; i <= cluster.members.length; i += 1) {
      const next = cluster.members[index + step * i];
      if (!next) break;
      if (next.live) {
        selectedId.value = next.id;
        return;
      }
    }
  }

  function snapshot(): SelectionSnapshot | null {
    if (!selectedId.value) return null;
    return {
      hotspotId: selectedId.value,
      groupId: clusterOf(selectedId.value)?.id ?? null,
    };
  }

  /**
   * 访谈返回后恢复选择：只有热点仍在当前时间窗内（有效）时才恢复，
   * 否则保持清空，避免把已经失效的成员当成新热点展示。
   * 分组延迟到下一次 sync 后按最新布局重新关联。
   */
  function restore(saved: SelectionSnapshot | null) {
    if (!saved) return;
    selectedId.value = null;
    expandedGroupId.value = null;
    if (!isLive(saved.hotspotId)) return;
    const cluster = clusterOf(saved.hotspotId);
    expandedGroupId.value = cluster && cluster.members.length > 1 ? cluster.id : null;
    selectedId.value = saved.hotspotId;
  }

  return {
    enabled,
    clusters,
    expandedGroupId,
    selectedId,
    detail,
    expansion,
    revision,
    pinnedIds,
    sync,
    /** 分组还有多久需要重新计算（合并 / 移出延迟）。 */
    pendingUntil: () => grouping.pendingUntil,
    toggleGroup,
    selectMember,
    select,
    move,
    collapse,
    closeList,
    snapshot,
    restore,
    close: collapse,
  };
}

export type Discovery = ReturnType<typeof createDiscovery>;
