<div align="center">

# ⚽ 英超预测引擎 v16.0
**Premier League Prediction Engine**

[![Version](https://img.shields.io/badge/version-v16.0-ff9f43?style=for-the-badge&logo=git&logoColor=white)](https://github.com/cyberJason1/premier-league-prediction-skill)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Groq](https://img.shields.io/badge/Powered_by-Groq-8b5cf6?style=for-the-badge)](#)
[![GitHub Actions](https://img.shields.io/badge/Automated_by-Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)](#)

> ⚽ **英超 2026/27 AI 比分预测引擎**
> 提示词工程 + 真实数据 + GitHub Actions 全自动更新 · 18 维深度分析 · 1539 张球员照片 · 免费开源零成本

<h3>
  <a href="https://cyberJason1.github.io/premier-league-prediction-skill/">🚀 在线体验 Demo</a> · 
  <a href="https://cyberJason1.github.io/premier-league-prediction-skill/about.html">📖 关于项目</a>
</h3>

</div>

---

## 🌟 核心亮点

*   🧠 **AI 深度推演**：结合规则工程与 Groq 大模型，精准输出 JSON 契约。
*   🔒 **赛前定案防线**：独创防作弊机制，禁止事后预测，保证真实命中率统计。
*   📊 **18 维战绩分析**：包含大小球、BTTS、概率校准、盲盒投注模拟等深度数据。
*   🎮 **FPL 梦幻英超**：基于实时 API 与官方球员身价，自动计算每周最优 15 人阵容。
*   📸 **极致视觉体验**：1539 张官方球员照片，雷达图、粒子动效、赛前印章全量覆盖。
*   ⚙️ **完全自动化**：基于 GitHub Actions + `update.js` 定时抓取，零服务器成本。

---

## 🛠️ 技术架构

*   **前端**：原生 HTML / CSS / JS（单文件零依赖，极致的首屏加载体验）
*   **推理**：Groq API（`openai/gpt-oss-120b` 模型）
*   **数据层**：football-data.org (积分/赛程) + FPL 官方 API (球员数据) + ESPN CDN (队徽)
*   **部署**：GitHub Pages + Service Worker (离线可访问)
*   **自动化**：GitHub Actions 每日定时抓取数据并推送

---

## 🚦 快速开始

1. 克隆本仓库到本地：
   ```bash
   git clone https://github.com/cyberJason1/premier-league-prediction-skill.git
