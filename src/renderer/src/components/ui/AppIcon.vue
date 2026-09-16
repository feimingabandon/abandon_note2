<script setup>
import dailyReportBlack from '@/resources/icons/daily-report.svg'
import dailyReportWhite from '@/resources/icons/daily-report-white.svg'
import recurrenceBlack from '@/resources/icons/recurrence.svg'
import recurrenceWhite from '@/resources/icons/recurrence-white.svg'
import settingsBlack from '@/resources/icons/settings.svg'
import settingsWhite from '@/resources/icons/settings-white.svg'
import helpBlack from '@/resources/icons/help.svg'
import helpWhite from '@/resources/icons/help-white.svg'
import pinBlack from '@/resources/icons/pin.svg'
import pinWhite from '@/resources/icons/pin-white.svg'
import lockBlack from '@/resources/icons/lock.svg'
import lockWhite from '@/resources/icons/lock-white.svg'
import closeBlack from '@/resources/icons/close.svg'
import closeWhite from '@/resources/icons/close-white.svg'
import tagBlack from '@/resources/icons/tag.svg'
import tagWhite from '@/resources/icons/tag-white.svg'
import taijiBlack from '@/resources/icons/taiji.svg'
import taijiWhite from '@/resources/icons/taiji-white.svg'
import cloverBlack from '@/resources/icons/clover.svg'
import cloverWhite from '@/resources/icons/clover-white.svg'
import switchViewBlack from '@/resources/icons/switch-view.svg'
import switchViewWhite from '@/resources/icons/switch-view-white.svg'
import locateCurrentBlack from '@/resources/icons/locate-current.svg'
import locateCurrentWhite from '@/resources/icons/locate-current-white.svg'
import moveToTodayBlack from '@/resources/icons/move-to-today.svg'
import moveToTodayWhite from '@/resources/icons/move-to-today-white.svg'
import datePanelBlack from '@/resources/icons/date-panel.svg'
import datePanelWhite from '@/resources/icons/date-panel-white.svg'

const ICON_SOURCES = Object.freeze({
  'daily-report': { black: dailyReportBlack, white: dailyReportWhite },
  recurrence: { black: recurrenceBlack, white: recurrenceWhite },
  settings: { black: settingsBlack, white: settingsWhite },
  help: { black: helpBlack, white: helpWhite },
  pin: { black: pinBlack, white: pinWhite },
  lock: { black: lockBlack, white: lockWhite },
  close: { black: closeBlack, white: closeWhite },
  tag: { black: tagBlack, white: tagWhite },
  taiji: { black: taijiBlack, white: taijiWhite },
  clover: { black: cloverBlack, white: cloverWhite },
  'switch-view': { black: switchViewBlack, white: switchViewWhite },
  'locate-current': { black: locateCurrentBlack, white: locateCurrentWhite },
  'move-to-today': { black: moveToTodayBlack, white: moveToTodayWhite },
  'date-panel': { black: datePanelBlack, white: datePanelWhite }
})

defineProps({
  name: {
    type: String,
    required: true,
    validator: (value) =>
      [
        'daily-report',
        'recurrence',
        'settings',
        'help',
        'pin',
        'lock',
        'close',
        'tag',
        'taiji',
        'clover',
        'switch-view',
        'locate-current',
        'move-to-today',
        'date-panel'
      ].includes(value)
  },
  alt: { type: String, default: '' }
})
</script>

<template>
  <span
    class="app-icon"
    :data-icon-name="name"
    :role="alt ? 'img' : undefined"
    :aria-label="alt || undefined"
    :aria-hidden="alt ? undefined : 'true'"
  >
    <img
      class="app-icon__asset app-icon__asset--black"
      :src="ICON_SOURCES[name].black"
      alt=""
      draggable="false"
    />
    <img
      class="app-icon__asset app-icon__asset--white"
      :src="ICON_SOURCES[name].white"
      alt=""
      draggable="false"
    />
  </span>
</template>

<style scoped>
.app-icon {
  position: relative;
  display: inline-block;
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
}

.app-icon__asset {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
  user-select: none;
}

.app-icon__asset--white {
  display: none;
}

:global(html[data-icon-color='white'] .app-icon__asset--black) {
  display: none;
}

:global(html[data-icon-color='white'] .app-icon__asset--white) {
  display: block;
}
</style>
