# Codex 修改规则

先读取 AGENTS.md，再用 UTF-8 读取 PROJECT_HISTORY.md。
严格按 AGENTS.md 的规则做。
这次只改我接下来要求的功能，不要重构，不要删除旧功能。
修改前先告诉我准备改哪些文件，改完后更新 PROJECT_HISTORY.md。

每次开始前必须先做：
1. 用 UTF-8 读取 PROJECT_HISTORY.md
2. 理解当前项目功能
3. 不允许删除旧功能
4. 不允许大规模重构
5. 不允许随意改数据库结构
6. 不允许随意改合同模板
7. 修改中文内容必须保持 UTF-8，避免乱码
8. 每次只改用户本次明确要求的功能
9. 修改前先说明计划修改哪些文件
10. 修改后必须更新 PROJECT_HISTORY.md

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

# 每次完成后记录格式

在 PROJECT_HISTORY.md 末尾追加：

================================================================
YYYY-MM-DD HH:mm
本次改动记录（标题）
- 修改了什么
- 修复了什么
- 是否影响数据库
- 本次读取/编辑本文件使用解码：UTF-8

改动文件
- xxx