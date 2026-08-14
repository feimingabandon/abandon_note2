<template>
  <div class="mtm-menu">
    <div class="mtm-item">打开主窗口</div>
    <div class="mtm-item">
      <span>当前视图：便签列表</span>
      <b>›</b>
    </div>
    <div class="mtm-divider"></div>
    <div class="mtm-item">显示全部便利贴（3）</div>
    <div class="mtm-item">
      <span>便利贴总览（3）</span>
      <b>›</b>
    </div>
    <div class="mtm-item mtm-item--danger">关闭全部便利贴</div>
    <div class="mtm-divider"></div>
    <div class="mtm-item">退出应用</div>
  </div>
</template>

<style scoped>
.mtm-menu {
  width: min(100%, 230rem);
  padding: 5rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  box-shadow: 0 8rem 24rem rgb(0 0 0 / 0.16);
}
.mtm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 26rem;
  padding: 4rem 9rem;
  border-radius: 6rem;
  color: var(--text-color);
  font-size: calc(var(--fs-secondary) * 0.9);
}
.mtm-item b {
  color: var(--text-color-secondary);
  font-size: var(--fs-body);
  font-weight: 400;
}
.mtm-item--danger {
  color: #ff453a;
}
.mtm-divider {
  height: 1px;
  margin: 4rem 7rem;
  background: var(--ui-border-divider);
}
</style>
