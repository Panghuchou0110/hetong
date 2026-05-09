# Codex 修改规则

默认先读取：
1. AGENTS.md（UTF-8）
2. PROJECT_STATE.md（UTF-8）

严格按 AGENTS.md 和 PROJECT_STATE.md 的规则做。
默认不要读取 PROJECT_HISTORY.md。

只有以下情况才允许读取 PROJECT_HISTORY.md：
- 用户明确要求查历史
- 用户提到历史日期
- 当前逻辑无法从 PROJECT_STATE.md 理解
- 需要恢复旧设计

每次只改用户本次明确要求的功能，不要重构，不要删除旧功能。
修改前先告诉用户准备改哪些文件。
修改后优先更新 PROJECT_STATE.md，保持“当前最终状态”。
PROJECT_HISTORY.md 是历史归档文件，不作为默认上下文，不要无限追加；只有用户明确要求写历史归档或确有必要时才更新。

项目基础信息（这里保持最新）
- 项目名称：hetong
- 服务器运行方式：PM2 + Node
- 服务器代码目录：/root/hetong
- 服务器数据目录（数据库/日志）：/root/hetong_data
- 本地项目目录：D:\hetong
- 文件解码要求：每次阅读/修改本文件时，写明使用的解码（当前为 UTF-8）。
- 
每次开始前必须先做：
1. 读取 AGENTS.md 和 PROJECT_STATE.md
2. 理解当前项目功能
3. 不允许删除旧功能
4. 不允许大规模重构
5. 不允许随意改数据库结构
6. 不允许随意改合同模板
7. 修改中文内容必须保持 UTF-8，避免乱码
8. 每次只改用户本次明确要求的功能
9. 修改前先说明计划修改哪些文件
10. 修改后优先更新 PROJECT_STATE.md

# 项目信息

项目名称：hetong  
本地目录：D:\hetong  
服务器目录：/root/hetong  
服务器数据目录：/root/hetong_data  
运行方式：Node.js + Express + EJS + SQLite + PM2  
主要页面：views/index.ejs  
数据库：/root/hetong_data/orders.sqlite  

# 重要保护

views/index.ejs 是核心文件，修改时只能做局部修改，不能整页重写。

合同生成功能、订单管理、导出、筛选、预警、登录验证都是已有功能，不能破坏。

# PROJECT_HISTORY.md 定位

PROJECT_HISTORY.md 是历史归档文件。默认开发不要读取；默认也不要把每次修改无限追加进去。

只有用户明确要求更新历史归档时，才在 PROJECT_HISTORY.md 末尾追加：

================================================================
YYYY-MM-DD HH:mm
本次改动记录（标题）
- 修改了什么
- 修复了什么
- 是否影响数据库
- 本次读取/编辑本文件使用解码：UTF-8

改动文件
- xxx
