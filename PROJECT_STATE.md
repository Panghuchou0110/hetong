# hetong 当前核心状态

## 基础
- Node.js + Express + EJS + SQLite + PM2。
- 入口 `app.js`，主页面 `views/index.ejs`，模板 `templates/0113.docx`，无独立 `routes` 目录。
- 代码/数据：`/root/hetong`、`/root/hetong_data`、`/root/hetong_data/orders.sqlite`。
- 本地目录 `D:\hetong`，当前工作区可能是 `D:\HUISHOU\hetong`。
- 中文文件统一 UTF-8。

## 模块与页面
- 模块：登录、合同生成、订单管理、对账表、跑路哥、安全功能、机型配置。
- 页面：`home`、`runaway`、`contract`、`orders-table`、`orders`、`add`、`safety`、`config`。

## 当前 UI
- 主页面 `views/index.ejs` 已升级为现代暗黑科技 SaaS Dashboard 风格。
- 视觉特征：深蓝黑渐变背景、左侧深色导航栏、顶部信息栏、半透明玻璃卡片、大数字 KPI、蓝紫/青绿色按钮高亮、紧凑表格和行 hover 高亮。
- 本次仅调整 CSS/视觉样式，不修改业务逻辑、接口、数据库、字段名、计算公式或合同生成逻辑。

## 数据库
- `state(key,value)`：配置 JSON，只存 `sources/defaultSource/models/modelColors/authRememberHours`。
- `orders(id,payload,created_at,hash)`、`trash(id,payload,created_at,hash)`：业务字段都在 `payload`。
- `auth_users(username,salt,hash,created_at)`：页面账号。
- 不随意改 SQLite 表结构。

## 订单字段
- 基本：`id`(10001+)、`createdAt`、`order_date`。
- 客户：`seller_name/seller_id/seller_phone`。
- 设备：`model/memory/color/actual_model_color/sf_no`。
- 金额：`buy_price`、`settle_price`。
- 分类：`source`、`status`、`settlement`、`remark`、`activation`。
- `status`：`signed`、`group`、`stored`、`stored_mismatch`、`runaway`、`refunded`、`unsigned`。
- `settlement`：`unsettled`、`settled`。
- `activation`：未激活、预激活、仅激活（直结/待补差/已补差）。
- 跑路字段：`runaway_amount`、`runaway_returned_amount`、`runaway_returned_to_me_amount`、`runaway_wanshun_returned_amount`。

## 订单规则
- `unsigned` 自动 `settle_price=0`。
- `refunded` 自动 `settle_price=0`、`settlement=settled`，备注追加“已结算xxx，已退款”。
- `actual_model_color` 与下单型号不一致时转 `stored_mismatch` 并补 `【待补差！】`；清空实际型号可回 `group`。
- 仅激活（待补差）自动补 `【待补差！】`，已有 `【已补差】`/`【待补差！】` 不重复。
- 预警：已签超 3 天未拉群、超 7 天未入库、仅激活待补差、型号不对待补差、已入库未填实际型号。

## 跑路哥
- 数据源：`orders` 中 `status==="runaway"`，按当前子入口固定 `source`。
- 金额输入支持数字、`3000+6000`、`3000+6000=9000`，统计取最终值。
- 默认按时间从新到旧排序；快捷筛选：全部/当月/前月/前前月；支持清除筛选后一键恢复所有跑路哥列表；可按时间或金额排序并导出当前筛选 Excel/CSV。

### 皖顺模式
- 字段：`settle_price`=已给皖顺结算；`runaway_amount`=客户已拿；`runaway_returned_amount`=客户退皖顺；`runaway_returned_to_me_amount`=客户退我；`runaway_wanshun_returned_amount`=皖顺已退我。
- 公式：客户总已退=客户退皖顺+客户退我；客户还欠=客户已拿-客户总已退；皖顺还差我=已给皖顺结算-客户还欠金额-皖顺已退我。
- 默认：客户退皖顺/客户退我/皖顺已退我未填按 0；客户已拿未填显示未填写。
- 显示：客户总已退 0 显示 `0`；客户还欠 <=0 显示“已结清”；皖顺还差我 >0 直接显示金额，=0 显示“已结清”，<0 显示“皖顺多退我：xxx”（取绝对值）。
- 表格列：时间、来源、客户、手机、已结算金额、跑路金额、客户退皖顺、客户退我、客户总退（自动）、客户还欠（自动）、皖顺已退我、皖顺还差我（自动）、备注。
- 可编辑：备注、客户已拿、客户退皖顺、客户退我、皖顺已退我、结算价。

### 成都模式
- 字段：`runaway_amount`=已转客户/客户已拿；`runaway_returned_amount`=客户已退。
- 公式：客户还欠=客户已拿-客户已退；还欠 >0 显示“追回中”，否则“已结清”。
- 默认：客户已拿、客户已退未填按 0。
- 表格列：时间、来源、客户、手机、客户已拿、客户已退、客户还欠、状态、备注。
- 对账表筛成都时显示“已转客户金额”，写回同一个 `runaway_amount`。

## 导出
- 前端 `xlsx-js-style` + CSV(BOM)。
- 导出文件名统一包含日期或日期范围，并标明导出内容类型与范围/筛选，例如全部订单备份、分时段订单备份、对账表格当前筛选、批量导出、跑路哥当前筛选、垃圾桶备份、导入模板备份、买卖合同。
- 安全功能：全部订单 Excel、分时段 Excel、订单 CSV、垃圾桶 CSV、导入模板 CSV。
- 对账表：当前筛选导出；成都相关视图额外导出“已转客户金额”。
- 批量导出：选中/当前筛选/全部，Excel/CSV 可选。
- 跑路哥导出：皖顺/成都列不同，导出当前计算结果。
- Excel 样式：自动列宽、表头深色、行高、状态/激活/结算颜色；“已补差”优先绿色。

## 开发规则
- 默认只读 `AGENTS.md` 和本文件，不读 `PROJECT_HISTORY.md`。
- 只有明确查历史、提到历史日期、本文件无法解释当前逻辑、或需要恢复旧设计时才读 `PROJECT_HISTORY.md`。
- `views/index.ejs` 只能局部改，不整页重写。
- 不删除旧功能，不大规模重构，不随意改数据库结构，不随意改合同模板。
- 功能变更后优先更新本文件，只写当前最终状态，不写演变过程。
