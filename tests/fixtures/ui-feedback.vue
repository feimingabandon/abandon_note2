<script setup>
import { ref, nextTick, onBeforeUnmount } from 'vue'
import NoteDurationField from '../../src/renderer/src/components/note/NoteDurationField.vue'
import StyledSelect from '../../src/renderer/src/components/ui/StyledSelect.vue'
import FontSizeInput from '../../src/renderer/src/components/ui/FontSizeInput.vue'
import TagSelector from '../../src/renderer/src/components/ui/TagSelector.vue'
import ChinaAreaCascader from '../../src/renderer/src/components/weather/ChinaAreaCascader.vue'
import MonthCalendarToolbar from '../../src/renderer/src/components/month/MonthCalendarToolbar.vue'
import QuickNoteContentEditor from '../../src/renderer/src/components/note/QuickNoteContentEditor.vue'
import AppModalShell from '../../src/renderer/src/components/ui/AppModalShell.vue'
import ScreenshotPicker from '../../src/renderer/src/components/note/ScreenshotPicker.vue'
import { createMessageProvider } from '../../src/renderer/src/composables/useMessage.js'
import { useNotePresenceMotion } from '../../src/renderer/src/composables/useNotePresenceMotion.js'
createMessageProvider()
window.api = {
  listTags: async () =>
    Array.from({ length: 18 }, (_, i) => ({
      id: i + 1,
      name: i === 0 ? '重要' : '标签 ' + (i + 1),
      color: '#32a852'
    })),
  getAlmanacDay: async () => null,
  onTagsChanged: () => () => {},
  getSetting: async () => null
}
const mode = ref('duration'),
  kind = ref('single_day'),
  days = ref(2),
  scale = ref(1),
  size = ref(17)
const tags = ref([]),
  list = ref(null),
  cards = ref(Array.from({ length: 20 }, (_, i) => i))
const modal = ref(false)
const picker = ref(null)
const motion = useNotePresenceMotion(() => list.value, {
  cardSelector: '.test-card',
  idAttribute: 'data-id',
  rootSelector: '.presence-host'
})
onBeforeUnmount(motion.disposePresenceMotion)
const areas = [
  { code: '11', name: '北京市', children: [] },
  {
    code: '44',
    name: '广东省',
    children: [
      {
        code: '4401',
        name: '广州市',
        children: [
          {
            code: '440103',
            name: '荔湾区',
            candidate: { id: 440103, name: '荔湾区', admin1: '广东省', admin2: '广州市' }
          },
          {
            code: '440104',
            name: '越秀区',
            candidate: { id: 440104, name: '越秀区', admin1: '广东省', admin2: '广州市' }
          }
        ]
      }
    ]
  }
]
window.feedback = {
  mode,
  kind,
  days,
  scale,
  modal,
  picker,
  motion,
  nextTick,
  async filter() {
    const before = motion.captureVisibleCardLayout()
    cards.value = cards.value.filter((i) => i % 2)
    await nextTick()
    motion.animateRetainedCards(before)
  }
}
</script>
<template>
  <main>
    <AppModalShell
      v-if="mode === 'image-memory' || mode === 'image-draft'"
      :visible="true"
      title="截图附件"
    >
      <ScreenshotPicker ref="picker" :mode="mode === 'image-draft' ? 'draft' : 'memory'" />
    </AppModalShell>
    <div v-if="mode === 'duration'" style="width: 440px">
      <NoteDurationField v-model:kind="kind" v-model:days="days" visible />
    </div>
    <div v-if="mode === 'scale'" style="font-size: 13.94px; --fs-secondary: 13.94px">
      <StyledSelect
        v-model="scale"
        width="68px"
        size="sm"
        :options="
          [0.9, 1, 1.1, 1.25, 1.5].map((v) => ({ value: v, label: Math.round(v * 100) + '%' }))
        "
      />
    </div>
    <FontSizeInput v-if="mode === 'font'" v-model="size" width="90px" />
    <AppModalShell v-if="mode === 'tags'" :visible="true" title="表单中的标签">
      <textarea placeholder="正文" style="width: 100%; border-radius: 8px" />
      <TagSelector v-model="tags" />
    </AppModalShell>
    <ChinaAreaCascader
      v-if="mode === 'area'"
      :options="areas"
      :model-value="{
        id: 440104,
        name: '越秀区',
        admin1: '广东省',
        admin2: '广州市',
        countryCode: 'CN'
      }"
      display-value="广东省 · 广州市 · 越秀区"
    />
    <MonthCalendarToolbar
      v-if="mode === 'month' || mode === 'week'"
      :key="mode"
      :view-mode="mode"
      :year="2026"
      :month="9"
      week-start="2026-09-28"
      week-end="2026-10-04"
      selected-key="2026-09-30"
      style="width: 100%"
    />
    <QuickNoteContentEditor
      v-if="mode === 'quick'"
      :note="{ id: 1, content: '测试正文', remark: '测试备注', attachment_count: 0 }"
      :anchor-rect="{ left: 50, top: 100, right: 200, bottom: 200, width: 150, height: 100 }"
    />
    <div
      v-if="mode === 'presence'"
      class="presence-host"
      style="
        position: fixed;
        left: 30px;
        top: 160px;
        width: 400px;
        height: 300px;
        overflow: hidden;
        --fs-body: 14px;
      "
    >
      <!-- Disable browser scroll anchoring here so the test can inspect exit clones before scrolling. -->
      <div ref="list" style="height: 100%; overflow: auto; overflow-anchor: none">
        <div
          v-for="i in cards"
          :key="i"
          class="test-card"
          :data-id="i"
          style="
            height: 70px;
            border-radius: 8px;
            background: #fafafa;
            font-size: var(--fs-body);
            margin-bottom: 10px;
          "
        >
          便签 {{ i }}
        </div>
      </div>
      <span class="nl-footer-count">便签总数 {{ cards.length }}</span>
    </div>
    <AppModalShell v-if="modal" :visible="true" title="首次挂载弹窗"><p>内容</p></AppModalShell>
  </main>
</template>
