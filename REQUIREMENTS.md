# 便签模块需求文档

> 版本：v2.0  
> 最后更新：2026-07-06  
> 状态：需求确认完成，待进入开发

---

## 目录

1. [概述与背景](#1-概述与背景)
2. [核心概念模型](#2-核心概念模型)
3. [数据库设计](#3-数据库设计)
4. [功能需求](#4-功能需求)
5. [技术方案](#5-技术方案)
6. [IPC 接口设计](#6-ipc-接口设计)
7. [开发分期规划](#7-开发分期规划)
8. [附录：术语表](#8-附录术语表)

---

## 1. 概述与背景

### 1.1 项目现状

当前项目是基于 Electron + Vue 3 + SQLite 的桌面便签应用，已具备：
- 无边框透明窗口
- 贴边隐藏 / 系统托盘
- 窗口置顶控制
- 系统级毛玻璃（Windows C++ DLL）
- 设置面板（模糊参数、开机自启、锁定等）

**当前不具备任何便签内容功能**，`app_settings` 表仅用于存储窗口配置（key-value 模式）。

### 1.2 核心目标

构建完整的便签管理模块，支持：
- **一次性便签**：手动创建，执行一次后归档
- **循环便签**：按规则自动生成便签实例（每天 / 隔天 / 每周 / 每月）
- **富媒体内容**：Markdown 正文 + 图片 / 视频 / 语音附件
- **灵活组织**：置顶、拖拽排序、多标签筛选、全文搜索
- **智能提醒**：系统通知、邮件每日总结

---

## 2. 核心概念模型

### 2.1 便签类型

| 类型 | 标识 | 说明 |
|------|------|------|
| 一次性便签 | `note_type = 'one_time'` | 手动创建，执行一次，完成后归档 |
| 循环生成的实例 | `note_type = 'one_time'`（同一次性） | 由循环模板自动生成，本质也是普通便签 |

> **关键设计**：循环便签本身不直接参与展示，它只是一个**生成规则模板**。到点后自动生成一条普通的便签实例。这条实例除了关联一个 `template_id` 外，与手动创建的一次性便签完全相同——可独立编辑、可独立完成、可独立归档。

### 2.2 状态机

```
           ┌─────────┐
           │ active  │  创建（默认状态）
           └────┬─────┘
                │ 用户开始处理
                ▼
        ┌──────────────┐
        │ in_progress  │  进行中
        └──────┬───────┘
               │ 用户标记完成
               ▼
          ┌───────────┐
          │ completed │  完成（软归档，保留不删除）
          └───────────┘

任意非终态 ──────→ cancelled   取消（软删除，保留不删除）

active / in_progress ──→ expired    过期（循环便签新周期生成时，上一周期实例未完成则自动标记）
```

| 状态 | 值 | 含义 | 后续操作 |
|------|-----|------|---------|
| 创建 | `active` | 便签已生成，等待处理 | 可转为进行中或完成 |
| 进行中 | `in_progress` | 用户正在处理 | 可转为完成或退回创建 |
| 完成 | `completed` | 已处理完毕（软归档） | 默认视图中隐藏，可在「已完成」筛选查看 |
| 取消 | `cancelled` | 用户主动取消（软删除） | 默认视图中隐藏，可在「已取消」筛选查看 |
| 过期 | `expired` | 循环便签新周期已生成，上一周期实例未完成 | 自动标记，不可逆，进入过期区 |

> **规则**：
> - 只有 `active` 和 `in_progress` 状态的便签显示在活跃列表中
> - `completed`、`cancelled` 和 `expired` 属于归档态，不计入活跃列表
> - 不物理删除，所有数据可追溯

### 2.3 时间模型

每条便签涉及三个时间：

| 字段 | 含义 | 默认值 | 是否可编辑 |
|------|------|--------|-----------|
| `created_at` | 便签创建时间戳 | 系统当前时间 | 否（自动） |
| `effective_at` | 便签生效 / 触发提醒的时间 | 等于 `created_at` | 是 |
| `updated_at` | 最后修改时间戳 | 自动更新 | 否（自动） |

**时间线列表的排序依据**：先按 `is_pinned` 置顶优先，再按 `effective_at` 降序（最新生效的在前）。

---

## 3. 数据库设计

### 3.1 ER 关系图

```
note_templates（循环模板）
    │
    │ 1 : N（template_id 外键）
    │
    ▼
notes（所有便签实例）────── note_tags ────── tags（标签）
    │                        M : N
    │
    │ 1 : N
    │
    ▼
note_attachments（附件：图片/视频/语音）
```

### 3.2 建表语句

```sql
-- ============================================================
-- 1. 循环便签模板表
-- 存储循环便签的生成规则，不直接参与便签列表展示
-- ============================================================
CREATE TABLE IF NOT EXISTS note_templates (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 模板默认正文（Markdown），生成实例时复制此内容
    content             TEXT    NOT NULL DEFAULT '',
    -- 循环规则，JSON 字符串，结构见 3.3 节
    recurrence_rule     TEXT    NOT NULL,
    -- 是否暂停生成（1=暂停，0=正常）
    is_paused           INTEGER NOT NULL DEFAULT 0,
    -- 是否已软删除（1=已删除，0=正常）
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    -- 生成实例时是否触发系统通知（1=通知，0=静默）
    notify_enabled      INTEGER NOT NULL DEFAULT 1,
    -- 上次生成实例的时间戳（毫秒），用于防止重复生成
    last_generated_at   INTEGER,
    -- 创建时间戳
    created_at          INTEGER NOT NULL,
    -- 最后修改时间戳
    updated_at          INTEGER NOT NULL
);

-- ============================================================
-- 2. 便签实例表（核心表）
-- 存储所有便签：手动创建的一次性便签 + 循环模板自动生成的实例
-- ============================================================
CREATE TABLE IF NOT EXISTS notes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 关联的循环模板 ID，NULL 表示手动创建的一次性便签
    template_id         INTEGER REFERENCES note_templates(id) ON DELETE SET NULL,
    -- 便签类型：'one_time' 一次性
    note_type           TEXT    NOT NULL DEFAULT 'one_time'
                        CHECK(note_type IN ('one_time')),
    -- 便签正文（Markdown 格式），内容即标题，无独立标题字段
    content             TEXT    NOT NULL DEFAULT '',
    -- 便签状态：active=活跃, in_progress=进行中, completed=已完成, cancelled=已取消, expired=已过期
    status              TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'in_progress', 'completed', 'cancelled', 'expired')),
    -- 是否置顶（1=置顶，0=不置顶），置顶便签在列表中优先展示
    is_pinned           INTEGER NOT NULL DEFAULT 0,
    -- 是否启用系统通知（1=启用，0=禁用），针对单条便签
    notify_enabled      INTEGER NOT NULL DEFAULT 1,
    -- 生效时间戳（毫秒），到了此时间提醒用户，默认等于 created_at
    effective_at        INTEGER NOT NULL,
    -- 手动排序权重，使用 INTEGER + 大间距策略，详见 5.2 节
    sort_order          INTEGER NOT NULL DEFAULT 0,
    -- 创建时间戳（毫秒）
    created_at          INTEGER NOT NULL,
    -- 最后修改时间戳（毫秒）
    updated_at          INTEGER NOT NULL
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_effective_at ON notes(effective_at);
CREATE INDEX IF NOT EXISTS idx_notes_template_id ON notes(template_id);
CREATE INDEX IF NOT EXISTS idx_notes_is_pinned ON notes(is_pinned);
-- 复合索引：自定义模式按置顶+排序权重分区域查询
CREATE INDEX IF NOT EXISTS idx_notes_status_pinned_sort ON notes(status, is_pinned, sort_order);

-- ============================================================
-- 3. 附件表
-- 存储便签中的图片、视频、音频文件引用
-- ============================================================
CREATE TABLE IF NOT EXISTS note_attachments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 所属便签 ID
    note_id             INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    -- 媒体类型：image=图片, video=视频, audio=音频
    media_type          TEXT    NOT NULL
                        CHECK(media_type IN ('image', 'video', 'audio')),
    -- 文件相对路径（相对于 userData 目录）
    file_path           TEXT    NOT NULL,
    -- 文件大小（字节）
    file_size           INTEGER,
    -- 语音转文字结果（仅 media_type='audio' 时有值）
    transcription       TEXT,
    -- 附件在便签内的排列顺序
    sort_order          INTEGER NOT NULL DEFAULT 0,
    -- 创建时间戳
    created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON note_attachments(note_id);

-- ============================================================
-- 4. 标签表
-- 用户自定义标签，支持颜色标记
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 标签名称，全局唯一
    name                TEXT    NOT NULL UNIQUE,
    -- 标签颜色（十六进制，如 '#FF5733'），可选
    color               TEXT,
    -- 创建时间戳
    created_at          INTEGER NOT NULL
);

-- ============================================================
-- 5. 便签-标签关联表
-- 多对多关系
-- ============================================================
CREATE TABLE IF NOT EXISTS note_tags (
    note_id             INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id              INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);

-- ============================================================
-- 6. 全文搜索虚拟表（FTS5）
-- 对便签正文建立全文索引
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    content,
    content=notes,
    content_rowid=id
);

-- 插入便签时自动同步 FTS 索引
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
END;

-- 更新便签时自动同步 FTS 索引
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
END;

-- 删除便签时自动同步 FTS 索引
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- ============================================================
-- 7. 用户设置扩展（在现有 app_settings 表基础上新增键值）
-- app_settings 表已存在，以下为新增的键值规划
-- ============================================================
-- key: 'email'              → 用户邮箱地址
-- key: 'email_summary_enabled' → 邮件每日总结开关（'true'/'false'）
-- key: 'email_summary_time' → 每日总结发送时间（如 '20:00'）
-- key: 'whisper_model_path' → Whisper 模型文件本地路径
```

### 3.3 `recurrence_rule` JSON 结构

```json
{
  "frequency": "daily",
  "interval": 1,
  "days_of_week": [1, 3, 5],
  "days_of_month": [1, 15],
  "time_of_day": "08:00"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `frequency` | string | `daily` 每天 / `every_other_day` 隔天 / `weekly` 每周 / `monthly` 每月 |
| `interval` | number | 间隔乘数（如 `daily` + `interval=2` = 每 2 天） |
| `days_of_week` | number[] | 仅 `weekly` 有效，星期几（1=周一 … 7=周日） |
| `days_of_month` | number[] | 仅 `monthly` 有效，每月几号（1-31） |
| `time_of_day` | string | 具体触发生成的时间点，`HH:mm` 格式，默认 `"00:00"` |

### 3.4 字段命名规范

| 规范 | 示例 |
|------|------|
| 主键统一 `id` | `id INTEGER PRIMARY KEY` |
| 时间戳统一 `_at` 后缀，毫秒 | `created_at`, `effective_at` |
| 布尔值统一 `is_` 前缀，0/1 | `is_pinned`, `is_paused` |
| 外键 `_id` 后缀 | `template_id`, `note_id`, `tag_id` |
| 枚举值 `_type` 后缀 | `note_type`, `media_type` |
| 可空字段无 `NOT NULL` 约束 | `last_generated_at`, `transcription` |

---

## 4. 功能需求

### 4.1 便签 CRUD

#### 4.1.1 创建便签
- 用户点击「新建便签」按钮或快捷键
- 默认创建一条 `status=active` 的便签
- `effective_at` 默认等于 `created_at`
- `note_type` 固定为 `'one_time'`
- 内容为空，光标自动聚焦到编辑区

#### 4.1.2 编辑便签
- 正文支持 Markdown 实时渲染（编辑 ↔ 预览切换）
- 修改任意字段后自动保存（防抖 500ms）
- `updated_at` 自动更新

#### 4.1.3 状态流转
- `active` → `in_progress`：用户点击「开始处理」
- `in_progress` → `completed`：用户点击「完成」
- 任意非终态 → `cancelled`：用户点击「取消」

#### 4.1.4 便签归档
- `status IN ('completed', 'cancelled', 'expired')` 的便签不出现在活跃列表
- 可通过「归档」筛选视图查看（含已完成、已取消、已过期三种）
- 不从数据库物理删除

### 4.2 循环便签管理

#### 4.2.1 创建循环模板
- 用户选择频率（每天 / 隔天 / 每周 / 每月）
- 根据频率填写具体参数（星期几 / 几号）
- 可选填写默认正文（生成实例时复制）
- 可选设置通知开关

#### 4.2.2 暂停 / 恢复
- 暂停：`is_paused = 1`，已生成的实例不受影响，不再生成新实例
- 恢复：`is_paused = 0`，恢复定时生成

#### 4.2.3 删除
- 软删除：`is_deleted = 1`
- 已生成的实例保留，不做级联删除

#### 4.2.4 编辑模板
- 修改模板正文**只影响后续生成的实例**
- 已生成的实例内容不变
- 修改循环规则后重新计算下次执行时间

#### 4.2.5 上周期未完成便签处理
- 循环模板生成新实例时，检查该模板的上一周期实例
- 若上一周期实例的 `status` 为 `active` 或 `in_progress`（即未完成），自动将其标记为 `expired`
- 此操作在生成新实例的同一事务中完成，保证原子性
- `expired` 状态不可逆，表示"已过期，上一周期未完成"
- 过期便签进入自定义模式的「过期区」展示

### 4.3 附件管理

#### 4.3.1 支持类型
| 类型 | 扩展名 | 备注 |
|------|--------|------|
| 图片 | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | 支持粘贴、拖拽、选择文件 |
| 视频 | `.mp4`, `.webm` | 内联播放 |
| 音频 | `.mp3`, `.wav`, `.ogg`, `.m4a` | 内联播放 + 语音转文字 |

#### 4.3.2 存储策略
- 文件复制到 `userData/attachments/{note_id}/` 目录
- 数据库存储相对路径
- 删除便签时级联删除附件文件

#### 4.3.3 数量限制
- 单个便签附件总数上限：**50 个**（避免性能问题）
- 单文件大小上限：统一 **500MB**（所有类型）

### 4.4 标签系统

#### 4.4.1 标签管理
- 创建 / 编辑 / 删除标签
- 标签名全局唯一
- 可选设置颜色（预设 12 色）

#### 4.4.2 标签筛选
- 多标签 AND 筛选（同时包含所选标签）
- 点击标签即加入筛选条件
- 支持「所有标签」和「无标签」快捷筛选

### 4.5 排序功能

#### 4.5.1 排序模式
| 模式 | 说明 | 默认排序规则 |
|------|------|-------------|
| 时间线 | 按生效时间自动排列 | 置顶→今天→昨天→更早（仅活跃便签） |
| 自定义 | 手动拖拽排列，三区域 | 置顶区 → 日常区 → 过期区 |

#### 4.5.2 自定义模式三区域
- **置顶区**（`is_pinned=1`, `status IN ('active','in_progress')`）：始终在最前，区域内可拖拽
- **日常区**（`is_pinned=0`, `status IN ('active','in_progress')`）：活跃便签，区域内可拖拽
- **过期区**（`status IN ('completed','cancelled','expired')`）：归档便签，只读展示，不可拖拽，按完成时间降序排列
- 拖拽仅限置顶区和日常区各自内部，跨区域不可拖拽

#### 4.5.3 排序作用域与精度保障（详见 5.2 节）
- `sort_order` 仅在「自定义拖拽」模式下生效，时间线模式下按 `effective_at` 排序
- 置顶区和日常区各为独立的排序域，互不干扰
- 进入自定义模式时触发全局重排（以 65536 步长重新分配所有活跃便签）
- 拖拽插入时取中间值；间距耗尽时触发局部重排

### 4.6 全文搜索

- 基于 SQLite FTS5 引擎
- 搜索便签正文内容
- 支持中文分词（FTS5 内置 Unicode 分词器）
- 搜索结果高亮显示匹配片段

### 4.7 通知系统

#### 4.7.1 单条便签通知
- 默认启用：便签到生效时间时弹出系统通知
- 可针对单条便签关闭通知（`notify_enabled = 0`）
- 通知内容：便签正文摘要（前 50 字符）

#### 4.7.2 循环便签通知
- 模板设置 `notify_enabled` 控制生成的实例是否默认启用通知
- 生成实例时自动弹出系统通知

### 4.8 批量操作

| 操作 | 说明 |
|------|------|
| 批量归档 | 选中多条便签 → 标记为 `completed` |
| 批量取消 | 选中多条便签 → 标记为 `cancelled` |
| 批量置顶 | 选中多条便签 → `is_pinned = 1` |
| 批量取消置顶 | 选中多条便签 → `is_pinned = 0` |
| 批量打标签 | 选中多条便签 → 统一添加标签 |
| 批量修改生效时间 | 选中多条便签 → 统一修改 `effective_at` |

交互：列表每行左侧出现复选框，顶部出现批量操作工具栏。

### 4.9 展示模式（分期实现）

| 展示模式 | 说明 | 分期 |
|---------|------|------|
| 列表-时间线 | 按生效时间分组（置顶 / 今天 / 昨天 / 更早） | P0 |
| 列表-自定义拖拽 | 置顶区 + 日常区 + 过期区，手动拖拽排序 | P0 |
| 月视图 | 大日历，每天展示便签数量 | P2 |
| 极简贴 | 桌面小方块，单条便签独立显示 | P3 |

### 4.10 邮件每日总结（P2）

- 用户填写邮箱地址
- 设置每日发送时间（默认 20:00）
- 邮件内容：今日完成的便签 + 待处理便签摘要
- 技术：`nodemailer` + SMTP

### 4.11 语音转文字（P2）

- 独立解耦模块，不随应用打包
- 用户首次使用时下载 Whisper 模型（~466MB small 模型）
- 基于 `whisper.cpp` C++ DLL 集成（与现有 `native_blur` 架构一致）
- 录音 → 转文字 → 写入 `note_attachments.transcription`
- 完全离线，免费，支持中文

---

## 5. 技术方案

### 5.1 拖拽排序：vuedraggable

**选型**：`vuedraggable`（基于 SortableJS，Vue 3 适配）

**安装**：
```bash
npm install vuedraggable
```

**核心用法**：
```vue
<!-- 置顶区域 -->
<draggable v-model="pinnedNotes" group="pinned" item-key="id">
  <template #item="{ element }">
    <NoteCard :note="element" />
  </template>
</draggable>

<!-- 日常区域 -->
<draggable v-model="normalNotes" group="normal" item-key="id">
  <template #item="{ element }">
    <NoteCard :note="element" />
  </template>
</draggable>
```

**关键设计**：
- 两个 `<draggable>` 组件使用不同的 `group` 名称，实现区域隔离
- 拖拽结束后更新所有受影响便签的 `sort_order`

### 5.2 排序策略：分区作用域 + 模式切换重排

**核心问题**：`sort_order` 是否全局？

如果对所有便签全局递增编号，随着便签数量增长（可达数十万条），编号会无限膨胀。而且已完成/已取消的归档便签不应继续占据排序空间。

**方案**：`sort_order` 仅在「自定义拖拽」模式下生效，且按区域独立编号。

#### 三条独立的排序域

```
┌──────────────────────────────────┐
│  📌 置顶域（is_pinned=1, active/in_progress）│
│  sort_order: 65536, 131072...    │
│  独立序列，只在此区域内可拖拽       │
├──────────────────────────────────┤
│  📋 日常域（is_pinned=0, active/in_progress）│
│  sort_order: 65536, 131072...    │
│  独立序列，只在此区域内可拖拽       │
├──────────────────────────────────┤
│  📦 过期区（completed/cancelled/expired）    │
│  只读展示，不可拖拽，不参与排序     │
│  按 updated_at 降序排列            │
└──────────────────────────────────┘
```

- 置顶域和日常域各自独立编号，各自从 65536 起步
- 过期区不分配 `sort_order`，直接按 `updated_at` 降序展示
- 已完成、已取消和已过期的便签不参与前两个域的排序
- 时间线模式下直接忽略 `sort_order`，按 `effective_at` 降序排列

#### 模式切换时触发全局重排

当用户从「时间线模式」切换到「自定义拖拽模式」时：

1. 查询当前活跃便签（`status IN ('active', 'in_progress')`）
2. 按当前显示顺序，为置顶域和日常域分别重新分配 `sort_order`
3. 步长 65536，保证插入空间充裕

这样每次进入自定义模式都是一次"干净开局"，值永远不会累积膨胀。

#### 拖拽插入：整数中值策略

```
插入 A（sort_order=65536）和 B（sort_order=131072）之间：
  new_order = floor((65536 + 131072) / 2) = 98304
```

#### 间距耗尽：局部重排

当相邻两项差值 ≤ 1 时，触发**该域**内所有便签的局部重排（以 65536 步长重新分配）。由于仅在自定义模式下且对活跃便签操作，重排范围始终可控。

#### 为什么不用 REAL

IEEE 754 双精度理论上约 53 次连续中值插入后精度耗尽。虽然个人便签几乎不会触发，但 INTEGER 方案的语义更清晰、无浮点舍入隐患。

### 5.3 统一调度器：自建 Scheduler 类（零依赖）

**设计原则**：整个应用有且仅有一个定时调度中枢，所有周期性任务统一注册、统一管理。

#### 长期运行保障：双计时器看门狗

递归 `setTimeout` 单链路依赖有一个致命缺陷：**如果某次 `scheduleTick()` 自身抛出未捕获异常，整条调用链断裂且不会自愈**。虽然概率极低（`Date.now()` 和 `setTimeout` 几乎不会失败），但作为需要运行数月的桌面应用，必须有兜底。

**方案**：**主链路（递归 setTimeout）+ 独立看门狗（setInterval）**

```
主线（递归 setTimeout）：  每小时精确执行 60 次 tick，整分对齐
看门狗（setInterval 5min）：每 5 分钟检查"上次 tick 是否超过 2 分钟"
                           → 若超时，立即补一次 tick + 重启主线
                           → 完全独立于主线，不依赖其工作状态
```

这样即使主线因任何原因失活，**最多 5 分钟后自动恢复**。两条链路独立运行，互不依赖。

#### 代数去重：防止系统休眠恢复时产生多条主线

**问题**：系统休眠时，`setTimeout` 和 `setInterval` 都会冻结。恢复后两者可能同时在事件队列中苏醒：
- 旧主线的 `setTimeout` 回调已经入队
- 看门狗的 `setInterval` 也同时触发 → 检测到超时 → 启动新主线
- `clearTimeout` **无法取消已经入队的回调** → 两条主线并行跑

**方案**：`_mainGeneration` 代计数器。每条主线在闭包中持有自己的代数 `myGen`，每次回调前检查 `this._mainGeneration !== myGen` 则立即返回。

```
时间线：
  启动时:  gen=1, 主线A(gen=1) 开始递归
  系统休眠:  两个定时器都冻结
  系统恢复:  看门狗先触发 → gen++ → 2, 启动主线B(gen=2)
            主线A(gen=1) 的回调也在队列中 → 执行时发现 gen≠1 → return（自杀）
            主线B(gen=2) 正常继续
```

**结论**：无论旧主线回调以什么顺序执行，代数校验保证**永远只有最新代数的主线在运行**，不存在线程泄漏。

#### 计时精度：递归 setTimeout 对齐整分

`setInterval` 有两个致命缺陷：一是初始时刻随机（取决于应用启动时刻），永远打不中 "08:00" 整点；二是事件循环延迟会累积漂移，运行数小时后偏差可能达到数秒甚至分钟级。

**方案**：使用递归 `setTimeout` 自校正到整分边界：

```javascript
start() {
  const scheduleTick = () => {
    const now = Date.now()
    const msToNextMinute = 60000 - (now % 60000)  // 距下一个整分的毫秒数
    this.timerId = setTimeout(() => {
      this.tick()           // 在整分时刻执行
      scheduleTick()        // 递归调度下一次，每次都重新对齐
    }, msToNextMinute)
  }
  // 首次启动立即执行一次（补偿关闭期间的遗漏）
  this.tick()
  scheduleTick()
}
```

这样每次 tick 都发生在 **HH:MM:00**，无论运行多久漂移为零。

#### 注册方式：两种模式

**模式一：条件式注册**（适用于复杂判断逻辑）
```javascript
scheduler.register({
  name: '循环便签生成',
  shouldRun: () => { /* 遍历模板，计算是否到点 */ },
  execute: () => { /* 生成实例 + 通知 */ }
})
```

**模式二：定时式注册**（适用于「每天几点执行」的简单场景）
```javascript
scheduler.scheduleAt('08:00', () => {
  // 每天 08:00 执行的逻辑
})

// scheduleAt 是语法糖，内部自动生成 shouldRun：
scheduleAt(timeStr, callback) {
  const [h, m] = timeStr.split(':').map(Number)
  this.register({
    name: `at_${timeStr}`,
    shouldRun: () => {
      const now = new Date()
      return now.getHours() === h && now.getMinutes() === m
    },
    execute: callback
  })
}
```

#### 完整 Scheduler 实现

```javascript
// src/main/scheduler.js
export class Scheduler {
  tasks = []
  _mainTimerId = null      // 主线递归 setTimeout 句柄
  _watchdogId = null       // 看门狗 setInterval 句柄
  _ticking = false         // 防止重叠执行
  _mainGeneration = 0      // 主线代数（每次重启主线 +1，用于废弃旧主线）
  _recoveryFailures = 0   // 看门狗连续恢复失败计数（成功 tick 后清零）
  lastTickAt = null        // 上次 tick 完成的时间戳（用于看门狗诊断）

  register(task) {
    this.tasks.push({
      ...task,
      failures: 0,         // 连续失败计数
      lastError: null       // 最后一次错误信息
    })
  }

  scheduleAt(timeStr, callback) {
    const [h, m] = timeStr.split(':').map(Number)
    this.register({
      name: `at_${timeStr}`,
      shouldRun: () => {
        const now = new Date()
        return now.getHours() === h && now.getMinutes() === m
      },
      execute: callback
    })
  }

  start() {
    this.lastTickAt = Date.now()  // 初始化，防止首次 tick 失败导致看门狗永不触发
    this.tick() // 启动补偿

    // === 主线：递归 setTimeout 精确到整分 ===
    // 每条主线闭包持有自己的代数 myGen，每次回调前校验是否仍是最新代数
    const myGen = ++this._mainGeneration
    const scheduleTick = () => {
      if (this._mainGeneration !== myGen) return  // 已被新主线替代，停止
      const ms = 60000 - (Date.now() % 60000)
      this._mainTimerId = setTimeout(() => {
        if (this._mainGeneration !== myGen) return  // 二次校验（系统恢复时防竞态）
        this.tick()
        scheduleTick()
      }, ms)
    }
    scheduleTick()

    // === 看门狗：每 5 分钟独立检查 ===
    this._watchdogId = setInterval(() => {
      if (this.lastTickAt && (Date.now() - this.lastTickAt > 2 * 60 * 1000)) {
        this._recoveryFailures++
        console.warn(`[scheduler] 看门狗检测到主线失活（距上次 tick 超过2分钟），第${this._recoveryFailures}次恢复尝试`)

        // 连续 3 次恢复失败（即 15 分钟）→ 终极告警：通知用户重启
        if (this._recoveryFailures >= 3) {
          const { Notification } = require('electron')
          new Notification({
            title: '便签调度器异常',
            body: '定时任务引擎连续恢复失败，请重启应用以恢复正常。',
            urgency: 'critical'
          }).show()
          console.error('[scheduler] 终极告警：所有恢复手段已耗尽，已通知用户重启')
          this._recoveryFailures = 0  // 重置，避免重复弹通知
        }

        // 递增代数，使所有旧主线回调自检失败
        const newGen = ++this._mainGeneration
        this.tick()             // 补偿执行
        // 清除旧主线 timer（能清掉未入队的大部分回调）
        clearTimeout(this._mainTimerId)
        // 启动新代数的主线
        const rebuild = () => {
          if (this._mainGeneration !== newGen) return
          const ms = 60000 - (Date.now() % 60000)
          this._mainTimerId = setTimeout(() => {
            if (this._mainGeneration !== newGen) return
            this.tick()
            rebuild()
          }, ms)
        }
        rebuild()
      }
    }, 5 * 60 * 1000)
  }

  tick() {
    if (this._ticking) return  // 上一轮未结束，跳过本轮
    this._ticking = true
    try {
      for (const task of this.tasks) {
        try {
          if (task.shouldRun()) {
            task.execute()
            task.failures = 0    // 执行成功，重置失败计数
          }
        } catch (err) {
          task.failures++
          task.lastError = err.message
          console.error(`[scheduler] "${task.name}" 失败 (${task.failures}次):`, err)
          // 连续失败 10 次以上，自动禁用并告警
          if (task.failures >= 10) {
            console.error(`[scheduler] "${task.name}" 已自动禁用（连续失败10次）`)
            task._disabled = true
          }
        }
      }
    } finally {
      this._ticking = false
      this.lastTickAt = Date.now()     // 记录本次完成时间
      this._recoveryFailures = 0       // 成功 tick，重置恢复失败计数
    }
  }

  stop() {
    if (this._mainTimerId) { clearTimeout(this._mainTimerId); this._mainTimerId = null }
    if (this._watchdogId) { clearInterval(this._watchdogId); this._watchdogId = null }
  }
}
```

#### 性能分析

| 指标 | 分析 |
|------|------|
| CPU 开销 | 每 60 秒执行一次 `shouldRun()` 遍历（通常 < 10 个任务），几乎为零 |
| 内存开销 | tasks 数组通常 < 10 个对象，可忽略 |
| 事件循环影响 | tick 执行时长 < 50ms（均为 DB 查询 + 简单逻辑），不会阻塞 |
| 长期稳定性 | 递归 setTimeout 零漂移 + 看门狗 5 分钟兜底，可保障**数月不间断运行** |

#### 容错与恢复机制

1. **单个任务崩溃不影响其他**：每个任务独立 try/catch
2. **连续失败自动熔断**：同一任务连续失败 10 次后自动禁用（`_disabled = true`），不再执行
3. **日志完整**：每次失败记录 `task.lastError`，可通过 IPC 暴露给渲染进程展示
4. **无状态依赖**：调度器不持久化状态，重启即全新开始
5. **启动补偿**：`start()` 立即执行一轮 `tick()`，弥补关闭期间的遗漏
6. **看门狗兜底**：独立 `setInterval` 每 5 分钟检查主线是否存活，失活则自动重启主线，最多 5 分钟自愈
7. **双链路隔离**：看门狗与主线互不依赖，主线异常不影响看门狗运行
8. **终极告警**：若看门狗连续 3 次恢复失败（15 分钟），通过 `electron.Notification` 弹出系统通知告知用户重启应用

### 5.4 语音转文字：Whisper.cpp + 按需下载

| 项目 | 详情 |
|------|------|
| 引擎 | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| 推荐模型 | `ggml-small.bin`（466MB），中文准确度足够 |
| 许可证 | MIT（完全免费商用） |
| 集成方式 | 同 `native_blur`，C++ DLL → koffi FFI |
| 下载策略 | 应用打包不带模型，用户首次启用时从 HuggingFace 下载 |

**下载地址**：
```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

**存储路径**：`{userData}/models/ggml-small.bin`

### 5.5 循环便签生成判断算法

#### 核心思路

不使用 cron 表达式匹配（"现在是不是 08:00？"），而是计算"最近一次应当生成的时刻"，然后与 `last_generated_at` 比较。这样即使调度器因关机错过了整点，也能在下一次 tick 时正确补偿生成。

```
关键公式：
  应当生成 = (最近一次应生成时刻 > last_generated_at) 或 (last_generated_at 为 NULL)
```

#### 算法实现

```javascript
/**
 * 判断模板是否应当生成实例
 * @param {Object} rule - recurrence_rule JSON
 * @param {number|null} lastGeneratedAt - 上次生成时间戳（毫秒），NULL 表示从未生成
 * @param {number} now - 当前时间戳（毫秒）
 * @returns {{ should: boolean, effectiveAt: number|null }}
 */
function shouldGenerate(rule, lastGeneratedAt, now) {
  const scheduledAt = calcMostRecentScheduledTime(rule, now)
  if (scheduledAt === null) return { should: false, effectiveAt: null }

  // 从未生成过，第一次必须生成
  if (lastGeneratedAt === null) return { should: true, effectiveAt: scheduledAt }

  // 最近应生成时刻晚于上次生成时刻 → 有新周期
  return {
    should: scheduledAt > lastGeneratedAt,
    effectiveAt: scheduledAt
  }
}

/**
 * 计算「最近一次应当生成的时刻」
 * 返回的时间戳 ≤ now，是该规则下最近一次触发点
 */
function calcMostRecentScheduledTime(rule, now) {
  const [hour, minute] = (rule.time_of_day || '00:00').split(':').map(Number)

  switch (rule.frequency) {
    case 'daily':
    case 'every_other_day':
      return calcDaily(now, hour, minute, rule.frequency === 'every_other_day' ? 2 : (rule.interval || 1))

    case 'weekly':
      return calcWeekly(now, hour, minute, rule.days_of_week || [])

    case 'monthly':
      return calcMonthly(now, hour, minute, rule.days_of_month || [])

    default:
      return null
  }
}

// --- 每日 / 隔日 ---
function calcDaily(now, hour, minute, interval) {
  // 今天的目标时刻
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)

  // 如果今天的目标时刻已过，回退到最近一个匹配日
  while (d.getTime() > now) {
    d.setDate(d.getDate() - interval)
  }
  // 向前推进到 ≤ now 的最近一个匹配日
  while (d.getTime() <= now) {
    const next = new Date(d)
    next.setDate(next.getDate() + interval)
    if (next.getTime() > now) break
    d.setDate(d.getDate() + interval)
  }
  return d.getTime()
}

// --- 每周几 ---
function calcWeekly(now, hour, minute, daysOfWeek) {
  if (!daysOfWeek.length) return null

  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)

  // 从今天往回找最近的匹配星期
  for (let i = 0; i < 7; i++) {
    const dow = d.getDay() === 0 ? 7 : d.getDay() // 周日=7，周一=1
    if (daysOfWeek.includes(dow) && d.getTime() <= now) {
      return d.getTime()
    }
    d.setDate(d.getDate() - 1)
  }
  return null
}

// --- 每月几号 ---
function calcMonthly(now, hour, minute, daysOfMonth) {
  if (!daysOfMonth.length) return null

  const current = new Date(now)
  current.setHours(hour, minute, 0, 0)

  // 从当月往回找最近匹配日期
  for (let m = 0; m < 2; m++) {
    const year = current.getFullYear()
    const month = current.getMonth()

    // 按日号降序检查，找 ≤ now 的最大日号
    const sorted = [...daysOfMonth].sort((a, b) => b - a)
    for (const day of sorted) {
      const maxDay = new Date(year, month + 1, 0).getDate()
      const actualDay = Math.min(day, maxDay) // 处理 2 月 30 号等无效日
      const candidate = new Date(year, month, actualDay, hour, minute, 0, 0)
      if (candidate.getTime() <= now) {
        return candidate.getTime()
      }
    }
    // 当月没有匹配，回退一个月
    current.setMonth(current.getMonth() - 1)
  }
  return null
}
```

#### 生成流程（在 Scheduler tick 中执行）

```
for each 活跃模板 (is_paused=0, is_deleted=0):
  1. 解析 recurrence_rule
  2. 计算 mostRecentScheduledTime
  3. 若 shouldGenerate:
     a. 开启事务
     b. 将该模板上一周期 status IN ('active','in_progress') 的实例 → expired
     c. INSERT 新便签实例（content=模板.content, effective_at=scheduledAt, template_id=模板.id）
     d. UPDATE 模板.last_generated_at = scheduledAt
     e. 若模板.notify_enabled → 弹出系统通知
     f. 提交事务
```

#### 边界情况处理

| 场景 | 处理方式 |
|------|---------|
| 应用关机错过了 3 天 | 启动补偿 `tick()` 会连续生成 3 次（每次只生成最近一次），不会一次生成 3 条 |
| 用户手动修改了 `last_generated_at` | 以数据库当前值为准，不会重复生成 |
| 模板暂停后恢复 | 恢复后的第一个周期正常生成，之前暂停期间的不会补偿 |
| 无效日期（如 2 月 30 号） | `calcMonthly` 自动回退到当月最后一天 |
| 修改模板的 `time_of_day` | 下次 `tick` 按新时间计算，`last_generated_at` 不变，可能在当天立即触发新生成 |
| days_of_week 为空数组 | `calcWeekly` 返回 null，不生成 |

---

## 6. IPC 接口设计

> 以下为规划中的 IPC 通道，沿用现有 `ipcMain.handle` / `ipcMain.on` 模式

### 6.1 便签 CRUD

| 通道名 | 方向 | 参数 | 返回值 |
|--------|------|------|--------|
| `notes:create` | 渲染→主 | `{ content?, effective_at? }` | 新便签对象 |
| `notes:update` | 渲染→主 | `{ id, content?, status?, is_pinned?, notify_enabled?, effective_at?, sort_order? }` | 更新后便签对象 |
| `notes:delete` | 渲染→主 | `{ id }` | `true` |
| `notes:get` | 渲染→主 | `{ id }` | 便签对象（含附件列表） |
| `notes:list` | 渲染→主 | `{ status?, tag_ids?, search?, sort_mode?, limit?, offset? }` | 便签列表 + 总数 |

### 6.2 循环模板

| 通道名 | 方向 | 参数 | 返回值 |
|--------|------|------|--------|
| `templates:create` | 渲染→主 | `{ content?, recurrence_rule, notify_enabled? }` | 模板对象 |
| `templates:update` | 渲染→主 | `{ id, content?, recurrence_rule?, is_paused?, notify_enabled? }` | 更新后模板对象 |
| `templates:delete` | 渲染→主 | `{ id }` | `true`（软删除） |
| `templates:list` | 渲染→主 | `{}` | 模板列表 |

### 6.3 附件

| 通道名 | 方向 | 参数 | 返回值 |
|--------|------|------|--------|
| `attachments:add` | 渲染→主 | `{ note_id, file_path }` | 附件对象 |
| `attachments:remove` | 渲染→主 | `{ id }` | `true` |
| `attachments:list` | 渲染→主 | `{ note_id }` | 附件列表 |

### 6.4 标签

| 通道名 | 方向 | 参数 | 返回值 |
|--------|------|------|--------|
| `tags:create` | 渲染→主 | `{ name, color? }` | 标签对象 |
| `tags:update` | 渲染→主 | `{ id, name?, color? }` | 更新后标签对象 |
| `tags:delete` | 渲染→主 | `{ id }` | `true` |
| `tags:list` | 渲染→主 | `{}` | 标签列表 |
| `tags:bind` | 渲染→主 | `{ note_id, tag_id }` | `true` |
| `tags:unbind` | 渲染→主 | `{ note_id, tag_id }` | `true` |

### 6.5 批量操作

| 通道名 | 方向 | 参数 | 返回值 |
|--------|------|------|--------|
| `notes:batch-update` | 渲染→主 | `{ ids[], status?, is_pinned?, effective_at? }` | 受影响行数 |
| `notes:batch-tag` | 渲染→主 | `{ ids[], tag_id }` | 受影响行数 |

### 6.6 搜索

| 通道名 | 方向 | 参数 | 返回值 |
|--------|------|------|--------|
| `notes:search` | 渲染→主 | `{ query, limit?, offset? }` | 搜索结果列表 + 总数 |

### 6.7 调度器诊断

| 通道名 | 方向 | 参数 | 返回值 |
|--------|------|------|--------|
| `scheduler:health` | 渲染→主 | — | `{ lastTickAt, recoveryFailures, mainGeneration, tasks: [{name, failures, lastError, _disabled}] }` |

> `scheduler:health` 用于渲染进程「诊断面板」展示调度器运行状态，便于排查问题。
> `notes:list` 的 `sort_mode` 合法值为 `'timeline'`（按 `effective_at`）或 `'custom'`（按 `sort_order` 分区域）。

---

## 7. 开发分期规划

### P0（核心功能，首期交付）

| 功能 | 涉及表 | 预计工作量 |
|------|--------|-----------|
| `notes` 表建表 + 迁移 | `notes`, `notes_fts`, 触发器 | 小 |
| 便签 CRUD + 状态流转 | `notes` | 中 |
| 便签列表-时间线展示 | `notes` | 中 |
| 便签列表-自定义拖拽排序 | `notes` | 大 |
| 附件（图片/视频/音频）上传与展示 | `note_attachments` | 大 |
| Markdown 编辑与渲染 | — | 中 |
| 标签 CRUD + 绑定 + 多标签筛选 | `tags`, `note_tags` | 中 |
| 全文搜索（FTS5） | `notes_fts` | 小 |
| 系统通知（单条 + 循环） | `notes.notify_enabled` | 中 |

### P1（循环 + 调度）

| 功能 | 涉及表 | 预计工作量 |
|------|--------|-----------|
| 循环模板 CRUD | `note_templates` | 中 |
| 统一调度器（自建 Scheduler 类） | — | 大 |
| 实例生成逻辑 | `notes` | 中 |
| 应用启动补偿生成 | — | 小 |

### P2（增强功能）

| 功能 | 说明 |
|------|------|
| 邮件每日总结 | `nodemailer` + SMTP |
| 语音转文字（Whisper.cpp） | C++ DLL + koffi FFI + 按需下载 |
| 月视图 | 日历组件 |
| 批量操作 UI | 复选框 + 批量工具栏 |

### P3（远期）

| 功能 | 说明 |
|------|------|
| 极简便签贴 | 桌面独立小窗口 |
| 数据导出 | Markdown / JSON |
| 云同步 | 待定 |

---

## 8. 附录：术语表

| 术语 | 英文 | 说明 |
|------|------|------|
| 便签 | Note | 一条记录，包含正文和附件 |
| 循环便签 | Recurring Template | 按规则自动生成便签的模板 |
| 一次性便签 | One-time Note | 手动创建或由模板生成的普通便签 |
| 生效时间 | Effective Time | 便签应当提醒/展示的时间点 |
| 置顶 | Pin | 便签固定在列表顶部 |
| 软归档 | Soft Archive | 标记为完成但不从数据库删除 |
| 软删除 | Soft Delete | 标记为取消但不从数据库删除 |
| 过期 | Expired | 循环便签新周期生成时，上一周期未完成实例被自动标记 |
| 附件 | Attachment | 图片/视频/音频文件 |
| 标签 | Tag | 用户自定义的分类标记 |
| FTS | Full-Text Search | SQLite 全文搜索引擎 |
