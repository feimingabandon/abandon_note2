<script setup>
defineProps({
  viewMode: { type: String, default: 'month' }
})

const days = [
  { weekday: '周一', day: 10, lunar: '十七', weather: '☀ 31°', note: '整理周报', count: 1 },
  { weekday: '周二', day: 11, lunar: '十八', weather: '☁ 30°', note: '', count: 0 },
  { weekday: '周三', day: 12, lunar: '十九', weather: '☂ 28°', note: '产品评审', count: 2 },
  { weekday: '周四', day: 13, lunar: '二十', weather: '☁ 29°', note: '', count: 0 },
  {
    weekday: '周五',
    day: 14,
    lunar: '廿一',
    weather: '☀ 32°',
    note: '提交版本',
    count: 3,
    today: true
  },
  {
    weekday: '周六',
    day: 15,
    lunar: '廿二',
    weather: '☀ 33°',
    note: '采购清单',
    count: 1,
    holiday: '休'
  },
  { weekday: '周日', day: 16, lunar: '廿三', weather: '☁ 31°', note: '', count: 0, holiday: '休' }
]
</script>

<template>
  <div class="mcs-grid" :class="{ 'is-week': viewMode === 'week' }">
    <div v-for="item in days" :key="item.day" class="mcs-column">
      <div class="mcs-weekday">{{ item.weekday }}</div>
      <div class="mcs-day" :class="{ 'is-today': item.today }">
        <header>
          <strong>{{ item.day }}</strong>
          <span>{{ item.lunar }}</span>
          <i v-if="item.holiday" class="is-holiday">{{ item.holiday }}</i>
          <i v-if="item.today" class="is-today-badge">今</i>
        </header>
        <small>{{ item.weather }}</small>
        <div v-if="item.note" class="mcs-event">{{ item.note }}</div>
        <footer>
          <b>＋</b><em v-if="item.count > 1">•••</em><span>{{ item.count }}</span>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mcs-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  width: 100%;
  overflow: hidden;
  border-top: 1px solid var(--ui-border-divider);
  border-left: 1px solid var(--ui-border-divider);
  border-radius: 10rem;
}
.mcs-column {
  min-width: 0;
}
.mcs-weekday {
  padding: 5rem 2rem;
  border-right: 1px solid var(--ui-border-divider);
  border-bottom: 1px solid var(--ui-border-divider);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.7);
  text-align: center;
}
.mcs-day {
  display: flex;
  flex-direction: column;
  gap: 4rem;
  min-height: 92rem;
  padding: 6rem;
  border-right: 1px solid var(--ui-border-divider);
  border-bottom: 1px solid var(--ui-border-divider);
  background: transparent;
}
.mcs-grid.is-week .mcs-day {
  min-height: 138rem;
}
.mcs-day.is-today {
  box-shadow: inset 0 0 0 1px var(--ui-accent);
}
.mcs-day header {
  display: flex;
  align-items: center;
  gap: 3rem;
  min-width: 0;
}
.mcs-day header strong {
  font-size: calc(var(--fs-secondary) * 0.86);
}
.mcs-day header span {
  min-width: 0;
  overflow: hidden;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.62);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcs-day header i {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 14rem;
  height: 14rem;
  border-radius: 50%;
  font-style: normal;
  font-size: calc(var(--fs-secondary) * 0.55);
}
.mcs-day .is-holiday {
  color: #30d158;
}
.mcs-day .is-today-badge {
  background: var(--ui-accent);
  color: #fff;
}
.mcs-day small {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.62);
}
.mcs-event {
  overflow: hidden;
  padding: 3rem 5rem;
  border-radius: 5rem;
  background: var(--ui-accent-subtle);
  color: var(--ui-accent);
  font-size: calc(var(--fs-secondary) * 0.62);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcs-day footer {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  margin-top: auto;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.62);
}
.mcs-day footer b {
  font-weight: 500;
}
.mcs-day footer em {
  font-style: normal;
  letter-spacing: 1rem;
}
.mcs-day footer span {
  justify-self: end;
  min-width: 15rem;
  padding: 1rem 4rem;
  border-radius: 5rem;
  background: var(--ui-fill-passive);
  text-align: center;
}
@container (max-width: 620px) {
  .mcs-day {
    padding: 4rem 2rem;
  }
  .mcs-day header span,
  .mcs-day small,
  .mcs-day footer b {
    display: none;
  }
  .mcs-day header {
    justify-content: center;
  }
  .mcs-event {
    padding-inline: 2rem;
    text-align: center;
  }
}
</style>
