import type { Hotspot } from "../../../shared/types";
import { distance, type PlacedHotspot } from "../lib/clustering";

/**
 * 持久化、带迟滞的热点聚合。
 *
 * 三条原则：
 * 1. 旧分组优先稳定。已加入的成员只有持续远离同伴一小段时间后才离开；
 *    “加入 < 保留”两档阈值让镜头来回微调不会让按钮在单个与聚合之间抖动。
 * 2. 新出现的成员立即分配。新热点（尤其是 person 类型的重要人物）不受
 *    稳定延迟影响：要么马上成为独立标记，要么立刻计入附近聚合的成员数。
 * 3. 分组只按热点 id 记录，同一热点在接缝两侧的重复投影不会重复计数。
 */

export interface GroupsOptions {
  /** 两个标记应该聚在一起的距离。 */
  mergeRadius: number;
  /** 新成员加入已有分组的距离（小于 mergeRadius，形成迟滞）。 */
  joinRadius: number;
  /** 成员留在分组内的距离（大于 joinRadius，形成迟滞）。 */
  retainRadius: number;
  /** 两个已有分组持续接近多久后才合并。 */
  mergeDelay: number;
  /** 成员远离同伴多久后才离开分组。 */
  dropDelay: number;
  /** 新出现的人物保持“新鲜”提示的时长。 */
  freshFor: number;
}

export const GROUPING: GroupsOptions = {
  // 标记连同标题约 150px 宽，两个标记中心距小于 260px 时标签开始互相遮挡。
  // 默认视角（fov 70）下章节内相隔 42–48° 的热点保持独立；缩到广角
  // （fov→95）或舞台变矮时，间距相似的标记会合并成组。
  mergeRadius: 260,
  // 加入比保留更严格：已经在组里的成员不会因一次轻微转头被踢出去。
  joinRadius: 260 * 0.85,
  retainRadius: 260 * 1.15,
  mergeDelay: 240,
  dropDelay: 220,
  freshFor: 3,
};

export interface ClusterMemberView {
  id: string;
  hotspot: Hotspot;
  x: number;
  y: number;
  /** 内容顺序，键盘与触摸共用同一顺序。 */
  order: number;
  /** 仍处于播放时间窗内。 */
  live: boolean;
  /** 已离开时间窗，但因为正在阅读而保留的历史成员。 */
  historical: boolean;
  /** 刚刚进入时间窗的人物。 */
  fresh: boolean;
}

export interface HotspotClusterView {
  id: string;
  x: number;
  y: number;
  /** 按内容顺序排列，包含正在阅读的历史成员。 */
  members: ClusterMemberView[];
  /** 仍有效的成员。 */
  liveMembers: ClusterMemberView[];
  /** 多于一个有效成员才显示为聚合符号。 */
  isGroup: boolean;
  /** 聚合里有刚出现的人物。 */
  hasFreshPerson: boolean;
  /** 已无有效成员，仅因正在阅读而保留。 */
  historical: boolean;
  /** 稳定排序键：内容顺序。 */
  navigationKey: number;
}

export interface GroupingInput {
  chapterId: string;
  time: number;
  placed: PlacedHotspot[];
  /** 已过期但仍在阅读、需要保留历史状态的成员 id。 */
  pinnedIds: string[];
  /** 用户正在查看的分组；合并时保留它的 id，避免阅读中突然折叠。 */
  stableClusterId?: string | null;
  now?: number;
}

interface MemberState {
  id: string;
  hotspot: Hotspot;
  x: number;
  y: number;
  order: number;
  live: boolean;
  /** 该成员仍落在舞台（含内边距）内，可用来承载聚合按钮。 */
  retained: boolean;
  /** 该成员完整落在舞台内，优先作为聚合按钮的锚点。 */
  onScreen: boolean;
  /** 离开时间窗时冻结的屏幕位置，历史成员不会被移回“当前朝向”。 */
  frozen: { x: number; y: number } | null;
}

interface ClusterState {
  id: string;
  members: Map<string, MemberState>;
  /** 成员等待移出 / 分组等待合并的起始时间。 */
  dropSince: Map<string, number>;
  /** 粘滞锚点：聚合按钮固定表示这个成员，直到它真正离开分组。 */
  anchorId: string | null;
}

const clock = () =>
  typeof performance === "undefined" ? Date.now() : performance.now();

function liveOf(cluster: ClusterState) {
  return [...cluster.members.values()].filter((member) => member.live);
}

/**
 * 聚合锚点固定在内容顺序最靠前的成员上，成员增减时按钮不会来回跳。
 * 只有锚点自己离开舞台时才换人 —— 换的那一下正好是用户预期它挪走的时候。
 */
function primaryOf(cluster: ClusterState) {
  const live = liveOf(cluster);
  if (!live.length) return [...cluster.members.values()][0];
  const visible = live.filter((member) => member.onScreen);
  const pool = visible.length ? visible : live;
  if (cluster.anchorId) {
    const anchored = pool.find((member) => member.id === cluster.anchorId);
    if (anchored) return anchored;
  }
  const primary = pool.reduce((best, member) =>
    member.order < best.order ? member : best,
  );
  cluster.anchorId = primary.id;
  return primary;
}

function anchorOf(cluster: ClusterState) {
  const primary = primaryOf(cluster);
  if (!primary) return { x: 0, y: 0 };
  return primary.frozen ?? { x: primary.x, y: primary.y };
}

function orderOf(cluster: ClusterState) {
  const pool = liveOf(cluster);
  const primary = (pool.length ? pool : [...cluster.members.values()]).reduce<
    MemberState | undefined
  >(
    (best, member) => (!best || member.order < best.order ? member : best),
    undefined,
  );
  return primary?.order ?? Number.POSITIVE_INFINITY;
}

function nearestGap(a: ClusterState, b: ClusterState) {
  let nearest = Infinity;
  for (const left of liveOf(a)) {
    for (const right of liveOf(b)) {
      nearest = Math.min(nearest, distance(left, right));
    }
  }
  return nearest;
}

function isFreshPerson(hotspot: Hotspot, time: number, options: GroupsOptions) {
  return (
    hotspot.kind === "person" &&
    time >= hotspot.start &&
    time < hotspot.start + options.freshFor
  );
}

export function createGrouping(options: Partial<GroupsOptions> = {}) {
  const config: GroupsOptions = { ...GROUPING, ...options };
  let clusters: ClusterState[] = [];
  let chapterId = "";
  let sequence = 0;
  let pendingMerges = new Map<string, number>();
  /** 下一次延迟合并 / 移出生效的时间点；没有待办时为 Infinity。 */
  let pendingUntil = Number.POSITIVE_INFINITY;

  function reset() {
    clusters = [];
    pendingMerges = new Map();
    pendingUntil = Number.POSITIVE_INFINITY;
    sequence = 0;
  }

  function accepts(cluster: ClusterState, placed: PlacedHotspot) {
    const live = liveOf(cluster);
    if (!live.length) return false;
    // 必须紧挨着组内某个成员，同时与每个成员都不超过合并半径，
    // 避免“邻近链”把整屏热点串成一组。
    if (Math.min(...live.map((m) => distance(placed, m))) > config.joinRadius)
      return false;
    return live.every((m) => distance(placed, m) <= config.mergeRadius);
  }

  function add(cluster: ClusterState, placed: PlacedHotspot) {
    cluster.members.set(placed.hotspot.id, {
      id: placed.hotspot.id,
      hotspot: placed.hotspot,
      x: placed.x,
      y: placed.y,
      order: placed.order,
      live: true,
      retained: placed.retained,
      onScreen: placed.onScreen,
      frozen: null,
    });
    cluster.dropSince.delete(placed.hotspot.id);
  }

  function seed(placed: PlacedHotspot) {
    const cluster: ClusterState = {
      id: `cluster-${++sequence}`,
      members: new Map(),
      dropSince: new Map(),
      anchorId: null,
    };
    add(cluster, placed);
    clusters.push(cluster);
  }

  function update(input: GroupingInput): HotspotClusterView[] {
    const now = input.now ?? clock();
    if (input.chapterId !== chapterId) {
      chapterId = input.chapterId;
      reset();
    }
    pendingUntil = Number.POSITIVE_INFINITY;
    const due = (at: number) => {
      pendingUntil = Math.min(pendingUntil, at);
    };

    // 同一 id 只取第一次投影，接缝两侧不会重复。
    const placedById = new Map<string, PlacedHotspot>();
    for (const placed of input.placed) {
      if (!placedById.has(placed.hotspot.id)) {
        placedById.set(placed.hotspot.id, placed);
      }
    }
    const pinned = new Set(input.pinnedIds);

    // 1. 同步已有成员。离开时间窗的成员立即移出；正在阅读的成员转为历史状态。
    for (const cluster of clusters) {
      for (const member of [...cluster.members.values()]) {
        const placed = placedById.get(member.id);
        if (placed) {
          member.x = placed.x;
          member.y = placed.y;
          member.live = true;
          member.retained = placed.retained;
          member.onScreen = placed.onScreen;
          member.frozen = null;
          continue;
        }
        if (pinned.has(member.id)) {
          // 冻结在最后一次有效出现的位置，历史成员不会随镜头漂移。
          member.live = false;
          member.frozen = { x: member.x, y: member.y };
          continue;
        }
        // 未在阅读的过期成员立即移出，不占用聚合数量。
        cluster.members.delete(member.id);
        cluster.dropSince.delete(member.id);
      }
    }

    // 2. 带迟滞的成员保留：只有持续远离同伴才移出分组。
    for (const cluster of clusters) {
      const live = liveOf(cluster);
      for (const member of live) {
        const placed = placedById.get(member.id);
        if (!placed || !placed.retained) {
          cluster.members.delete(member.id);
          cluster.dropSince.delete(member.id);
          continue;
        }
        const others = live.filter((other) => other.id !== member.id);
        if (!others.length) {
          cluster.dropSince.delete(member.id);
          continue;
        }
        const supported = others.some(
          (other) => distance(placed, other) <= config.retainRadius,
        );
        if (supported) {
          cluster.dropSince.delete(member.id);
          continue;
        }
        const since = cluster.dropSince.get(member.id);
        if (since === undefined) {
          cluster.dropSince.set(member.id, now);
          due(now + config.dropDelay);
        } else if (now - since >= config.dropDelay) {
          cluster.members.delete(member.id);
          cluster.dropSince.delete(member.id);
        } else {
          due(since + config.dropDelay);
        }
      }
    }
    clusters = clusters.filter((cluster) => cluster.members.size > 0);

    // 3. 新成员立即分配。人物优先，保证新出现的重要人物马上可达。
    const assigned = new Set<string>();
    for (const cluster of clusters)
      for (const member of liveOf(cluster)) assigned.add(member.id);
    const newcomers = input.placed
      .filter((placed) => !assigned.has(placed.hotspot.id) && placed.onScreen)
      .sort((a, b) => {
        const priority =
          Number(b.hotspot.kind === "person") -
          Number(a.hotspot.kind === "person");
        return priority || a.order - b.order;
      });
    for (const placed of newcomers) {
      let best: ClusterState | undefined;
      let bestGap = Infinity;
      for (const cluster of clusters) {
        if (!accepts(cluster, placed)) continue;
        const gap = distance(placed, anchorOf(cluster));
        if (gap < bestGap) {
          best = cluster;
          bestGap = gap;
        }
      }
      if (best) add(best, placed);
      else seed(placed);
    }

    // 4. 两个已有分组持续靠近后才合并，避免镜头扫过时反复重排。
    //    阈值与“新成员加入”一致：只要任意两名成员接近到 joinRadius 以内，
    //    并且这种状态持续 mergeDelay，就合并成一个聚合符号。
    const nextMerges = new Map<string, number>();
    const candidates: { a: ClusterState; b: ClusterState; gap: number }[] = [];
    for (let i = 0; i < clusters.length; i += 1)
      for (let j = i + 1; j < clusters.length; j += 1) {
        const a = clusters[i]!,
          b = clusters[j]!;
        const gap = nearestGap(a, b);
        if (gap <= config.joinRadius) candidates.push({ a, b, gap });
      }
    candidates.sort((left, right) => left.gap - right.gap);
    const used = new Set<string>();
    for (const candidate of candidates) {
      if (used.has(candidate.a.id) || used.has(candidate.b.id)) continue;
      const key = [candidate.a.id, candidate.b.id].sort().join("|");
      const since = pendingMerges.get(key);
      if (since === undefined) {
        nextMerges.set(key, now);
        due(now + config.mergeDelay);
        continue;
      }
      if (now - since < config.mergeDelay) {
        nextMerges.set(key, since);
        due(since + config.mergeDelay);
        continue;
      }
      used.add(candidate.a.id);
      used.add(candidate.b.id);
      const target =
        candidate.a.id === input.stableClusterId
          ? candidate.a
          : candidate.b.id === input.stableClusterId
            ? candidate.b
            : orderOf(candidate.a) <= orderOf(candidate.b)
              ? candidate.a
              : candidate.b;
      const source = target === candidate.a ? candidate.b : candidate.a;
      for (const member of source.members.values()) {
        if (!target.members.has(member.id)) target.members.set(member.id, member);
      }
      clusters = clusters.filter((cluster) => cluster !== source);
    }
    pendingMerges = nextMerges;

    // 5. 输出：键盘与触摸都按内容顺序走，镜头转动不会改变顺序。
    return clusters
      .map((cluster): HotspotClusterView => {
        const live = liveOf(cluster).sort((a, b) => a.order - b.order);
        const anchor = anchorOf(cluster);
        const members = [...cluster.members.values()]
          .sort((a, b) => a.order - b.order)
          .map((member): ClusterMemberView => ({
            id: member.id,
            hotspot: member.hotspot,
            x: member.frozen?.x ?? member.x,
            y: member.frozen?.y ?? member.y,
            order: member.order,
            live: member.live,
            historical: !member.live,
            fresh: isFreshPerson(member.hotspot, input.time, config),
          }));
        return {
          id: cluster.id,
          x: anchor.x,
          y: anchor.y,
          members,
          liveMembers: members.filter((member) => member.live),
          isGroup: live.length > 1,
          hasFreshPerson: live.some((member) =>
            isFreshPerson(member.hotspot, input.time, config),
          ),
          historical: live.length === 0,
          navigationKey: orderOf(cluster),
        };
      })
      .sort((a, b) => a.navigationKey - b.navigationKey);
  }

  return {
    update,
    reset,
    config,
    /** 无待办时为 Infinity；层组件据此安排一次延迟重新分组。 */
    get pendingUntil() {
      return pendingUntil;
    },
  };
}

export type Grouping = ReturnType<typeof createGrouping>;
