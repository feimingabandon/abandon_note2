<script setup>
import { ref, nextTick } from 'vue'
import BaseButton from '../../src/renderer/src/components/ui/BaseButton.vue'
import AppToggle from '../../src/renderer/src/components/ui/AppToggle.vue'
import StyledSelect from '../../src/renderer/src/components/ui/StyledSelect.vue'
import FontSizeInput from '../../src/renderer/src/components/ui/FontSizeInput.vue'
import DateTimePicker from '../../src/renderer/src/components/ui/DateTimePicker.vue'
import TimePicker from '../../src/renderer/src/components/ui/TimePicker.vue'
import MonthDayPicker from '../../src/renderer/src/components/ui/MonthDayPicker.vue'
import DatePicker from '../../src/renderer/src/components/ui/DatePicker.vue'
import DateRangePicker from '../../src/renderer/src/components/ui/DateRangePicker.vue'
import { createMessageProvider } from '../../src/renderer/src/composables/useMessage.js'
import ChinaAreaCascader from '../../src/renderer/src/components/weather/ChinaAreaCascader.vue'
import { enterPopover, leavePopover } from '../../src/renderer/src/utils/popoverMotion.js'
const size = ref(17),
  disabled = ref(false),
  toggled = ref(false),
  selected = ref('a')
createMessageProvider()
window.uiFixture = { nextTick, enterPopover, leavePopover, size, disabled, selected }
const areas = [
  {
    code: 'p',
    name: '省',
    children: [
      { code: 'c', name: '市', children: [{ code: 'd', name: '区', candidate: { name: '区' } }] }
    ]
  }
]
</script>
<template>
  <main>
    <BaseButton id="base">普通按钮</BaseButton>
    <BaseButton id="primary" variant="primary">确认</BaseButton>
    <BaseButton id="danger" variant="danger">删除</BaseButton>
    <AppToggle id="toggle" v-model="toggled" aria-label="测试开关" />
    <div id="select-host">
      <StyledSelect
        v-model="selected"
        :disabled="disabled"
        size="sm"
        :options="[
          { value: 'a', label: '当天' },
          { value: 'b', label: '持续到完成' }
        ]"
      />
    </div>
    <div id="font-host" style="height: 40px; overflow: auto"><FontSizeInput v-model="size" /></div>
    <div id="time-host"><TimePicker /></div>
    <div id="month-host"><MonthDayPicker :model-value="[{ month: 1, day: 1 }]" /></div>
    <div id="area-host"><ChinaAreaCascader :options="areas" /></div>
    <div><DatePicker model-value="2026-09-30" /></div>
    <div><DateRangePicker start="2026-09-01" end="2026-09-30" /></div>
    <div id="date-host" style="position: fixed; bottom: 20px; left: 10px">
      <DateTimePicker model-value="2026-09-30 12:00:00" />
    </div>
  </main>
</template>
