<script setup lang="ts">
import {
  computed,
} from "vue";
import {
  X,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
} from "lucide-vue-next";
import type { DiscoveryDetail } from "../model/discovery";
import { kindLabel } from "../lib/visibility";

const props = defineProps<{
  detail: DiscoveryDetail;
}>();
defineEmits<{ close: []; interview: []; save: []; move: [step: number] }>();

/** 过期成员不能被当成新热点收藏。 */
const live = computed(() => props.detail.live);
const canSave = computed(() => props.detail.live && !props.detail.saved);
</script>

<template>
  <aside
    class="detail-card"
    :class="{ 'is-historical': !live }"
    role="dialog"
    aria-label="热点详情"
  >
    <button class="close" aria-label="关闭热点" @click="$emit('close')">
      <X />
    </button>
    <small
      >{{ kindLabel(detail.hotspot.kind) }} / FIELD NOTES<span
        v-if="!live"
        class="history-badge"
        ><Clock3 :size="10" /> 历史记录</span
      ></small
    >
    <h2>{{ detail.hotspot.title }}</h2>
    <p>{{ detail.hotspot.summary }}</p>
    <p v-if="!live" class="history-note" role="status">
      这个热点已离开当前时间窗。正在阅读的内容会保留历史状态，但不能作为新发现收藏。
    </p>
    <div v-if="detail.total > 1" class="detail-pager">
      <button
        aria-label="上一个热点"
        :disabled="!detail.canPrev"
        @click="$emit('move', -1)"
      >
        <ChevronLeft :size="14" />
      </button>
      <span>{{ detail.index + 1 }} / {{ detail.total }}</span>
      <button
        aria-label="下一个热点"
        :disabled="!detail.canNext"
        @click="$emit('move', 1)"
      >
        <ChevronRight :size="14" />
      </button>
    </div>
    <button v-if="detail.hotspot.personId" class="primary" @click="$emit('interview')">
      进入人物访谈 <ArrowUpRight :size="16" />
    </button>
    <button
      class="text-button"
      :disabled="!canSave"
      @click="$emit('save')"
    >
      {{
        detail.saved
          ? "已加入探索记录"
          : detail.live
            ? "＋ 收藏这个发现"
            : "已过期，无法收藏"
      }}
    </button>
  </aside>
</template>
