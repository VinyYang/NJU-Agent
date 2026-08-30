"""Answer the current clarification questions (UI-equivalent payload)."""
import json
import urllib.request

sid = "18d1ba24366c4fc29f27aadeb61513ef"

answers = {
    "q1": "只需任务名称，保持简洁，不需要备注/优先级/分类/截止时间",
    "q2": "支持按日期查看和切换，包括之前日期的历史任务",
    "q3": "支持添加、删除、完成/取消完成，编辑功能可选",
    "q4": "是，按日期分别保存，刷新或切换日期后数据不混乱",
    "q5": "百分比数字 + 进度条，直观展示今日完成进度",
    "q6": "不需要筛选排序功能，保持简洁",
    "q7": "是，适配手机和平板，响应式布局",
    "q8": "不需要深色模式，保持浅色南大紫主题即可",
    "q9": "不需要预置示例任务",
    "q10": "在 DailyTasksPlay 目录新建 index.html、style.css、script.js 三个文件即可，不改动其他文件",
}

# load from env file properly
env = {}
for line in open(r"C:\Users\viny\Desktop\AAA-MIS\21.考核内容存档\NJU-SE\.env", encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()

body = {
    "message": "",
    "answers": answers,
    "api_key": env["OPENAI_API_KEY"],
    "base_url": env["OPENAI_BASE_URL"],
    "model": env["CODING_AGENT_MODEL"],
    "wire_api": env.get("MODEL_WIRE_API", "auto"),
    "reasoning_effort": env.get("MODEL_REASONING_EFFORT", "medium"),
}

req = urllib.request.Request(
    "http://127.0.0.1:8124/api/sessions/%s/turn" % sid,
    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.loads(r.read().decode("utf-8"))
    print("HTTP 200")
    print("phase:", data.get("workflow", {}).get("phase"))
    print("next_action:", data.get("workflow", {}).get("next_action"))
    print("message:", (data.get("message") or "")[:1500])
    plan = data.get("plan", [])
    print("plan steps:", len(plan))
    for i, st in enumerate(plan, 1):
        print("  %d. %s [%s]" % (i, st.get("title"), st.get("status")))
except Exception as e:
    print("ERR", e)
    if hasattr(e, "read"):
        print(e.read().decode("utf-8", errors="replace")[:2000])
