import tempfile, os
from backend.agent_core import SessionManager
from backend.agent_core import generate_intake_with_model, generate_plan_with_model
from backend.response import ModelResponse

class FakeModel:
    available = True
    model = "fake"
    def __init__(self):
        self.calls = 0
    def stream_complete(self, messages, tools, on_delta=None, early_stop=None):
        self.calls += 1
        n = self.calls
        if n == 1:
            content = ("需要澄清。\n```json\n"
                       '{"kind":"clarify","confidence":0.5,"questions":['
                       '{"id":"q1","text":"优先做哪些小游戏？","required":true,"choices":["贪吃蛇","问答"]}],'
                       '"assumptions":[],"ready":false}\n```')
        elif n == 2:
            content = ("信息足够了。\n```json\n"
                       '{"kind":"plan","confidence":0.9,"questions":[],"assumptions":[],"ready":true}\n```')
        else:
            content = "1. 搭建响应式首页\n2. 实现贪吃蛇小游戏\n3. 积分统计与随机事件\n4. 运行 smoke test"
        if on_delta:
            for i in range(0, len(content), 30):
                on_delta(content[i:i+30])
        return ModelResponse(content=content)

tmp = tempfile.mkdtemp()
store = os.path.join(tmp, "sessions.db")
manager = SessionManager(default_workspace=tmp, store_path=store)
session = manager.create(workspace=tmp, task="把项目改成上岸测试游戏", mode="plan")
sid = session.id
fake = FakeModel()

# Phase 1: clarification (ask a question)
r1 = manager.handle_turn(session, "把项目改成上岸测试游戏", model=fake,
                         planner_fn=generate_plan_with_model, intake_fn=generate_intake_with_model)
assert session.phase == "clarifying", session.phase

# Phase 2: submit an answer. turn must now only SIGNAL plan, not generate it.
r2 = manager.handle_turn(session, "", answers={"q1": "贪吃蛇"}, model=fake,
                         planner_fn=generate_plan_with_model, intake_fn=generate_intake_with_model)
assert r2.next_action == "plan", r2.next_action
assert session.phase == "awaiting_approval", session.phase
assert session.intake.answers.get("q1") == "贪吃蛇", session.intake.answers
print("turn signaled plan_ready; no plan generated yet: steps=%d" % len(session.plan.steps))

# Phase 3: separate action="plan" request generates the plan.
r3 = manager._plan_result(session, model=fake, increment_version=False, planner_fn=generate_plan_with_model)
assert r3.status == "awaiting_approval", r3.status
assert len(session.plan.steps) == 4, session.plan.steps
assert r3.next_action == "", r3.next_action
print("separate plan request OK: steps=%d phase=%s" % (len(session.plan.steps), session.phase))
print("SPLIT_FLOW_OK")