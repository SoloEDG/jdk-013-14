<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import {
  UserRound,
  Files,
  AudioLines,
  Layers3,
  BookmarkCheck,
  Clock3,
  X,
} from "lucide-vue-next";
import type { Camera, Hotspot } from "../../../shared/types";
import { clamp } from "../../../shared/format";
import type { Discovery } from "../model/discovery";
import type {
  ClusterMemberView,
  HotspotClusterView,
} from "../model/groups";
import { kindLabel } from "../lib/visibility";

const props = defineProps<{
  discovery: Discovery;
  camera: Camera;
  enabled: boolean;
  /** 已收藏的热点 id，随手记变化。 */
  savedIds: ReadonlySet<string>;
}>();

const host = ref<HTMLElement>();
const size = ref({ width: 1000, height: 470 });
const expanded = computed(() => props.discovery.expansion.value);
let observer: ResizeObserver | undefined;
let frame = 0;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 每次同步后，分组可能还在等“稳定延迟”（合并 / 移出）。用户停止
 * 转动或缩放后不会再有新帧，因此按最早到期时间补一次同步。
 */
function armSettle() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = undefined;
  const until = props.discovery.pendingUntil();
  if (!Number.isFinite(until)) return;
  const delay = Math.max(0, until - performance.now()) + 24;
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    schedule();
  }, Math.min(delay, 1000));
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    props.discovery.sync(props.camera, size.value);
    armSettle();
  });
}

/** 标记位置直接使用投影结果：不做边缘吸附，否则两个远处的标记会在边缘叠在一起。 */
function at(x: number, y: number) {
  return { left: `${x}px`, top: `${y}px` };
}

/** 中心点进入舞台才显示；半出屏幕的标记会被裁掉，不如不显示。 */
function inView(cluster: { x: number; y: number }) {
  return (
    cluster.x >= 0 &&
    cluster.x <= size.value.width &&
    cluster.y >= 0 &&
    cluster.y <= size.value.height
  );
}

const POPOVER_WIDTH = 268;

/** 展开列表固定在聚合标记旁，并始终完整落在舞台内。 */
function popoverStyle(cluster: HotspotClusterView) {
  const width = Math.min(POPOVER_WIDTH, Math.max(size.value.width - 24, 180));
  const height = Math.min(
    56 * cluster.members.length + 46,
    size.value.height - 24,
  );
  // 优先放在标记右侧；右侧放不下时翻到左侧，避免盖住右侧的详情卡。
  const toRight = cluster.x + 28 + width <= size.value.width - 12;
  const left = toRight ? cluster.x + 28 : cluster.x - width - 28;
  return {
    left: `${clamp(left, 12, Math.max(12, size.value.width - width - 12))}px`,
    top: `${clamp(cluster.y - height / 2, 12, Math.max(12, size.value.height - height - 12))}px`,
    width: `${width}px`,
    maxHeight: `${size.value.height - 24}px`,
  };
}

function liveCount(cluster: HotspotClusterView) {
  return cluster.liveMembers.length;
}

/** 只统计仍有效的成员：聚合符号上的“剩余数量 / 是否收藏”都指有效内容。 */
function savedCount(cluster: HotspotClusterView) {
  return cluster.liveMembers.filter((member) => props.savedIds.has(member.id))
    .length;
}

function allSaved(cluster: HotspotClusterView) {
  return (
    cluster.liveMembers.length > 0 &&
    cluster.liveMembers.every((member) => props.savedIds.has(member.id))
  );
}

function partiallySaved(cluster: HotspotClusterView) {
  const saved = savedCount(cluster);
  return saved > 0 && saved < liveCount(cluster);
}

function iconOf(hotspot: Hotspot) {
  return hotspot.kind === "person"
    ? UserRound
    : hotspot.kind === "archive"
      ? Files
      : AudioLines;
}

function clusterLabel(cluster: HotspotClusterView) {
  const first = cluster.liveMembers[0] ?? cluster.members[0];
  if (!first) return "故事热点";
  return cluster.isGroup ? `${first.hotspot.title} 等` : first.hotspot.title;
}

function clusterSummary(cluster: HotspotClusterView) {
  if (!cluster.isGroup) return clusterLabel(cluster);
  const saved = savedCount(cluster);
  const suffix = saved
    ? `，已收藏 ${saved} 个`
    : "";
  return `聚合热点：${clusterLabel(cluster)} ${liveCount(cluster)} 个故事${suffix}`;
}

function clusterHint(cluster: HotspotClusterView) {
  if (cluster.historical) return "正在阅读 · 已过期";
  const saved = savedCount(cluster);
  if (cluster.isGroup) {
    if (saved === liveCount(cluster) && saved > 0) return "全部已收藏 · 展开";
    if (saved > 0) return `已收藏 ${saved} / ${liveCount(cluster)} · 展开`;
    return `${liveCount(cluster)} 个故事 · 点击展开`;
  }
  const member = cluster.liveMembers[0]!;
  if (props.savedIds.has(member.id)) return "已收藏 · 查看";
  return member.fresh ? "新出现的人物 · 点击探索" : "点击探索 ↗";
}

function memberHints(member: ClusterMemberView) {
  const hints: string[] = [kindLabel(member.hotspot.kind)];
  if (member.historical) hints.push("已过期 · 历史");
  else if (member.fresh) hints.push("新出现");
  if (props.savedIds.has(member.id)) hints.push("已收藏");
  return hints.join(" · ");
}

function memberLabel(member: ClusterMemberView) {
  const saved = props.savedIds.has(member.id) ? "，已收藏" : "";
  const historical = member.historical ? "，已过期仅作历史" : "";
  return `${kindLabel(member.hotspot.kind)}：${member.hotspot.title}${saved}${historical}`;
}

function activate(cluster: HotspotClusterView) {
  if (cluster.isGroup) {
    props.discovery.toggleGroup(cluster.id);
    return;
  }
  const member = cluster.liveMembers[0] ?? cluster.members[0];
  if (member) props.discovery.selectMember(cluster.id, member.id);
}

function openMember(cluster: HotspotClusterView, member: ClusterMemberView) {
  props.discovery.selectMember(cluster.id, member.id);
}

/** 键盘移动顺序与 DOM 顺序一致，也就是内容顺序，和触摸选择完全相同。 */
function moveFocus(step: number) {
  const buttons = Array.from(
    host.value?.querySelectorAll<HTMLButtonElement>(
      ".hotspot-marker, .hotspot-member",
    ) ?? [],
  ).filter((button) => button.offsetParent !== null);
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = clamp(
    current < 0 ? (step > 0 ? 0 : buttons.length - 1) : current + step,
    0,
    buttons.length - 1,
  );
  buttons[next]?.focus();
}

function onKeydown(event: KeyboardEvent) {  // 键盘顺序完全按 DOM 顺序，也就是内容顺序；触摸点击的是同一批按钮，
  // 因此两种输入的选择顺序一致。
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      event.preventDefault();
      moveFocus(1);
      break;
    case "ArrowLeft":
    case "ArrowUp":
      event.preventDefault();
      moveFocus(-1);
      break;
    case "Home":
      event.preventDefault();
      moveFocus(-Number.MAX_SAFE_INTEGER);
      break;
    case "End":
      event.preventDefault();
      moveFocus(Number.MAX_SAFE_INTEGER);
      break;
    case "Enter":
    case " ":
      // 原生 button 会处理激活；这里只确保列表内的空格不被页面滚动。
      if ((event.target as HTMLElement)?.closest(".hotspot-member"))
        event.stopPropagation();
      break;
    case "Escape":
      if (props.discovery.expandedGroupId.value) {
        event.stopPropagation();
        const groupId = props.discovery.expandedGroupId.value;
        props.discovery.collapse();
        // 焦点回到刚才的聚合按钮。
        nextTick(() => {
          host.value
            ?.querySelector<HTMLButtonElement>(
              `.hotspot-marker[data-cluster="${groupId}"]`,
            )
            ?.focus();
        });
      }
      break;
  }
}

function onFocusOut(event: FocusEvent) {
  // 焦点离开整个热点层时只收起列表；正在阅读的详情卡保持打开，
  // 避免键盘用户在浮层里切换焦点时内容莫名消失。
  if (!host.value?.contains(event.relatedTarget as Node | null))
    props.discovery.closeList();
}

watch(
  () => [
    props.camera.yaw,
    props.camera.pitch,
    props.camera.fov,
    size.value.width,
    size.value.height,
    props.discovery.revision.value,
    props.enabled,
  ],
  schedule,
);

// 键盘打开列表后把焦点交给该组第一项；收起后回到刚才的聚合按钮。
// 鼠标 / 触摸点击不抢夺焦点，避免列表刚展开就被滚走。
watch(
  () => props.discovery.expandedGroupId.value,
  async (id, previous) => {
    await nextTick();
    const active = document.activeElement as HTMLElement | null;
    if (id) {
      if (active?.classList.contains("hotspot-marker")) {
        host.value
          ?.querySelector<HTMLButtonElement>(
            `.cluster-popover[data-cluster="${id}"] .hotspot-member`,
          )
          ?.focus();
      }
    } else if (previous) {
      host.value
        ?.querySelector<HTMLButtonElement>(
          `.hotspot-marker[data-cluster="${previous}"]`,
        )
        ?.focus();
    }
  },
);

// 进入访谈时折叠，返回后按快照恢复。
watch(
  () => props.enabled,
  (value) => {
    if (!value) props.discovery.collapse();
  },
);

onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    size.value = {
      width: entry.contentRect.width,
      height: entry.contentRect.height,
    };
    schedule();
  });
  observer.observe(host.value!);
  schedule();
});

onUnmounted(() => {
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
  if (settleTimer) clearTimeout(settleTimer);
});
</script>

<template>
  <div
    ref="host"
    class="hotspot-layer"
    :class="{ 'is-hidden': !enabled }"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <template v-if="enabled">
      <template v-for="cluster in discovery.clusters.value" :key="cluster.id">
        <button
          v-show="inView(cluster) || expanded?.id === cluster.id"
          class="hotspot hotspot-marker"
          :class="{
            'is-cluster': cluster.isGroup,
            'is-historical': cluster.historical,
            'is-fresh': cluster.hasFreshPerson,
            'is-saved': allSaved(cluster),
            'is-partly-saved': partiallySaved(cluster),
            'is-expanded': expanded?.id === cluster.id,
          }"
          :style="at(cluster.x, cluster.y)"
          :data-cluster="cluster.id"
          :aria-expanded="cluster.isGroup ? expanded?.id === cluster.id : undefined"
          :aria-label="clusterSummary(cluster)"
          @pointerdown.stop
          @click.stop="activate(cluster)"
        >
          <span class="marker">
            <b v-if="cluster.isGroup" class="marker-count">{{
              liveCount(cluster)
            }}</b>
            <component v-else :is="iconOf(cluster.liveMembers[0]?.hotspot ?? cluster.members[0]!.hotspot)" />
            <i
              v-if="savedCount(cluster)"
              class="marker-saved"
              aria-hidden="true"
            >
              <BookmarkCheck :size="10" />
            </i>
            <i v-if="cluster.hasFreshPerson" class="marker-fresh" aria-hidden="true" />
          </span>
          <strong>{{ clusterLabel(cluster) }}</strong>
          <small>{{ clusterHint(cluster) }}</small>
        </button>

        <section
          v-if="expanded?.id === cluster.id"
          class="cluster-popover"
          :style="popoverStyle(cluster)"
          :data-cluster="cluster.id"
          :aria-label="`${liveCount(cluster)} 个故事的分组`"
          @pointerdown.stop
        >
          <header>
            <span>
              <Layers3 :size="13" />
              {{ liveCount(cluster) }} 个故事
            </span>
            <span v-if="savedCount(cluster)" class="cluster-saved">
              <BookmarkCheck :size="12" /> 已收藏 {{ savedCount(cluster) }}
            </span>
            <button
              class="cluster-close"
              aria-label="收起分组"
              @click="discovery.collapse()"
            >
              <X :size="13" />
            </button>
          </header>
          <div class="cluster-members" role="list">
            <button
              v-for="(member, index) in cluster.members"
              :key="member.id"
              class="hotspot-member"
              :class="{
                'is-selected': discovery.selectedId.value === member.id,
                'is-historical': member.historical,
                'is-fresh': member.fresh,
                'is-saved': savedIds.has(member.id),
              }"
              role="listitem"
              :aria-label="memberLabel(member)"
              :aria-current="
                discovery.selectedId.value === member.id ? 'true' : undefined
              "
              @click.stop="openMember(cluster, member)"
            >
              <span class="member-index">{{ index + 1 }}</span>
              <span class="member-icon">
                <component :is="iconOf(member.hotspot)" :size="14" />
              </span>
              <span class="member-text">
                <b>{{ member.hotspot.title }}</b>
                <small>{{ memberHints(member) }}</small>
              </span>
              <BookmarkCheck
                v-if="savedIds.has(member.id)"
                class="member-saved"
                :size="13"
              />
              <Clock3
                v-else-if="member.historical"
                class="member-history"
                :size="13"
              />
            </button>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
